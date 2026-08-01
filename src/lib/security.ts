import type { VaultItem } from "../types";
import { estimateStrengthLabel } from "./passwordStrength";
import { checkPasswordPwned } from "./hibp";

export interface AuditFinding {
  item: VaultItem;
  reasons: string[];
}

const OLD_THRESHOLD_DAYS = 180;

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

  for (let i = 0; i < passwordItems.length; i++) {
    const item = passwordItems[i];
    const strength = estimateStrengthLabel(item.password);
    if (strength === "faible") addReason(item, "Mot de passe faible");
    else if (strength === "moyen") addReason(item, "Mot de passe moyen");

    if (daysSince(passwordLastChangedAt(item)) > OLD_THRESHOLD_DAYS) {
      addReason(item, `Mot de passe inchangé depuis plus de ${OLD_THRESHOLD_DAYS} jours`);
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
