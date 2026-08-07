import { platform } from "@tauri-apps/plugin-os";

/**
 * Détection de plateforme (voir src-tauri/src/lib.rs, plugin `os`).
 *
 * Sert à adapter l'UI aux limites de la première passe mobile (Android) :
 * pas de sélecteur de fichier natif façon desktop, donc le vault vit dans
 * le répertoire privé de l'app (voir mobileVault.ts) et toutes les
 * fonctionnalités qui dépendent d'un choix d'emplacement fichier
 * (sauvegardes vers un dossier, export/import CSV, export chiffré .json,
 * kit de récupération en PNG/QR, mise à jour automatique — qui sur mobile
 * passe de toute façon par le store) sont masquées plutôt que proposées
 * puis silencieusement en échec.
 *
 * `platform()` lève si le plugin `os` n'est pas encore prêt (ex: appelé
 * avant le premier tick dans un contexte non-Tauri type `npm run dev` dans
 * un navigateur classique) — capturé pour retomber sur "desktop" par
 * défaut, comportement historique de l'app avant cette détection.
 */
export type AppPlatform = "android" | "ios" | "desktop";

let cached: AppPlatform | null = null;

export function resolvePlatform(): AppPlatform {
  if (cached) return cached;
  try {
    const p = platform();
    cached = p === "android" ? "android" : p === "ios" ? "ios" : "desktop";
  } catch {
    cached = "desktop";
  }
  return cached;
}

export function isMobilePlatform(): boolean {
  const p = resolvePlatform();
  return p === "android" || p === "ios";
}
