import type { VaultItem } from "../types";
import { estimateStrengthLabelAsync } from "./passwordStrength";
import { checkPasswordPwned } from "./hibp";

export interface AuditFinding {
  item: VaultItem;
  reasons: string[];
}

const OLD_THRESHOLD_DAYS = 180;
/** Signal distinct de OLD_THRESHOLD_DAYS : celui-ci parle de PERTINENCE du
 * compte (a-t-il encore servi récemment ?), pas de rotation du mot de
 * passe. Seuil plus large pour éviter de signaler trop vite un compte
 * légitimement peu consulté. */
const UNUSED_THRESHOLD_DAYS = 270;

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

function daysUntil(iso: string): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return Infinity;
  return (target - Date.now()) / (1000 * 60 * 60 * 24);
}

/**
 * Date à laquelle le mot de passe ACTUEL de l'entrée est devenu actif.
 * `password_history[i].changed_at` est la date à laquelle l'ANCIEN mot de
 * passe a cessé d'être actif — donc, par définition, celle à laquelle le
 * suivant a pris le relais. Bien plus précis que `updated_at`, qui change
 * dès qu'un champ quelconque (notes, catégorie…) est modifié, même si le
 * mot de passe lui-même n'a pas bougé.
 */
function passwordLastChangedAt(item: VaultItem): string {
  const history = item.password_history;
  if (history.length > 0) return history[history.length - 1].changed_at;
  return item.created_at; // jamais changé depuis la création
}

/** Nombre d'entrées analysées avant de rendre la main au thread principal
 * (laisse l'UI respirer/peindre entre deux tranches). zxcvbn est coûteux et
 * grimpe vite avec la longueur des mots de passe (~800ms pour 48
 * caractères, mesuré) — un vault avec beaucoup d'entrées à mots de passe
 * longs pourrait sinon geler l'ouverture de l'audit pendant plusieurs
 * secondes d'un coup. */
const AUDIT_CHUNK_SIZE = 4;

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Extrait le nom d'hôte normalisé d'une URL (minuscules, sans "www."), ou
 * chaîne vide si l'URL est vide/invalide. Sert à détecter deux entrées qui
 * pointent vers le même site sans dépendre du protocole ou du chemin (ex:
 * "https://gmail.com/mail" et "gmail.com" sont considérés comme le même site). */
function normalizeUrlHost(url: string): string {
  if (!url.trim()) return "";
  try {
    const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `https://${url}`;
    const host = new URL(withProtocol).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}

/** Titre normalisé pour comparaison approximative : minuscules, accents
 * retirés, tout ce qui n'est pas alphanumérique supprimé (espaces,
 * ponctuation) — ainsi "Gmail" et "gmail !" sont détectés comme identiques,
 * mais on reste sur une égalité stricte après normalisation (pas de
 * correspondance floue/Levenshtein, pour éviter les faux positifs qu'une
 * vraie logique de similarité demanderait à calibrer soigneusement). */
function normalizeTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Analyse locale : faible, réutilisé, ancien, expire bientôt. Aucun réseau.
 * Asynchrone et découpée en tranches (voir `AUDIT_CHUNK_SIZE`) à cause du
 * coût de l'estimation de force par entrée. `onProgress`, optionnel, permet
 * d'afficher un état de chargement pour les gros coffres. */
export async function runLocalAudit(
  items: VaultItem[],
  onProgress?: (done: number, total: number) => void
): Promise<AuditFinding[]> {
  const passwordItems = items.filter((i) => i.item_type === "password" && i.password);
  const byPassword = new Map<string, VaultItem[]>();
  for (const item of passwordItems) {
    const list = byPassword.get(item.password) ?? [];
    list.push(item);
    byPassword.set(item.password, list);
  }

  const findings = new Map<string, AuditFinding>();
  const addReason = (item: VaultItem, reason: string) => {
    const existing = findings.get(item.id);
    if (existing) existing.reasons.push(reason);
    else findings.set(item.id, { item, reasons: [reason] });
  };

  // Détection de doublons — rapide et synchrone (pas de zxcvbn ici), donc
  // pas besoin de découpage en tranches. Sur TOUTES les entrées (y compris
  // les notes), pas seulement celles avec un mot de passe.
  const byHost = new Map<string, VaultItem[]>();
  const byTitle = new Map<string, VaultItem[]>();
  for (const item of items) {
    const host = normalizeUrlHost(item.url);
    if (host) {
      const list = byHost.get(host) ?? [];
      list.push(item);
      byHost.set(host, list);
    }
    const title = normalizeTitle(item.title);
    if (title) {
      const list = byTitle.get(title) ?? [];
      list.push(item);
      byTitle.set(title, list);
    }
  }
  for (const [host, group] of byHost) {
    if (group.length < 2) continue;
    for (const item of group) addReason(item, `Doublon probable : même site (${host}) que ${group.length - 1} autre(s) entrée(s)`);
  }
  for (const [, group] of byTitle) {
    if (group.length < 2) continue;
    for (const item of group) addReason(item, `Titre identique à ${group.length - 1} autre(s) entrée(s)`);
  }

  for (let i = 0; i < passwordItems.length; i++) {
    const item = passwordItems[i];
    // Depuis §2.1 (roadmap), le calcul tourne dans un Web Worker : cet
    // `await` n'a plus besoin de "yieldToMainThread" pour rendre la main —
    // il ne bloque déjà plus rien. Le découpage en tranches (`AUDIT_CHUNK_SIZE`)
    // reste utile pour ne mettre à jour `onProgress` qu'à intervalles
    // raisonnables plutôt qu'à chaque entrée.
    const strength = await estimateStrengthLabelAsync(item.password);
    if (strength === "faible") addReason(item, "Mot de passe faible");
    else if (strength === "moyen") addReason(item, "Mot de passe moyen");

    if (daysSince(passwordLastChangedAt(item)) > OLD_THRESHOLD_DAYS) {
      addReason(item, `Mot de passe inchangé depuis plus de ${OLD_THRESHOLD_DAYS} jours`);
    }

    // "Jamais utilisé" = jamais copié depuis le presse-papiers (voir
    // `mark_item_used`), pas juste "pas modifié" — signal de pertinence du
    // compte, distinct de l'ancienneté du mot de passe ci-dessus.
    const referenceDate = item.last_used_at ?? item.created_at;
    if (daysSince(referenceDate) > UNUSED_THRESHOLD_DAYS) {
      addReason(
        item,
        item.last_used_at
          ? `Jamais copié depuis plus de ${UNUSED_THRESHOLD_DAYS} jours`
          : `Jamais utilisé depuis la création (il y a plus de ${UNUSED_THRESHOLD_DAYS} jours)`
      );
    }

    onProgress?.(i + 1, passwordItems.length);
    if ((i + 1) % AUDIT_CHUNK_SIZE === 0) await yieldToMainThread();
  }

  for (const [, group] of byPassword) {
    if (group.length > 1) {
      for (const item of group) addReason(item, `Réutilisé sur ${group.length} entrées`);
    }
  }

  for (const item of items) {
    if (!item.expires_at) continue;
    const remaining = daysUntil(item.expires_at);
    if (remaining < 0) addReason(item, "Expiré");
    else if (remaining <= 7) addReason(item, `Expire dans ${Math.ceil(remaining)}j`);
  }

  return Array.from(findings.values());
}

export interface PwnedResult {
  itemId: string;
  count: number;
}

/**
 * Vérifie chaque mot de passe unique du coffre contre Have I Been Pwned
 * (k-anonymat, voir lib/hibp.ts). Optionnel et déclenché explicitement par
 * l'utilisateur (nécessite une connexion réseau).
 */
export async function runPwnedAudit(
  items: VaultItem[],
  onProgress?: (done: number, total: number) => void
): Promise<PwnedResult[]> {
  const passwordItems = items.filter((i) => i.item_type === "password" && i.password);
  const uniquePasswords = Array.from(new Set(passwordItems.map((i) => i.password)));
  const countByPassword = new Map<string, number>();

  for (let i = 0; i < uniquePasswords.length; i++) {
    const pwd = uniquePasswords[i];
    try {
      countByPassword.set(pwd, await checkPasswordPwned(pwd));
    } catch {
      countByPassword.set(pwd, -1); // -1 = vérification échouée (réseau)
    }
    onProgress?.(i + 1, uniquePasswords.length);
  }

  return passwordItems
    .map((item) => ({ itemId: item.id, count: countByPassword.get(item.password) ?? 0 }))
    .filter((r) => r.count !== 0);
}
