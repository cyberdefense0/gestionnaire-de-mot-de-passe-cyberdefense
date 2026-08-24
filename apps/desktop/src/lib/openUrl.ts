/**
 * Ouvre une URL dans le navigateur par défaut du système.
 *
 * Dans Tauri v2, `window.open(url, "_blank")` est intercepté par WebKit et
 * délégué au navigateur par défaut de l'OS — sans plugin supplémentaire
 * (`tauri-plugin-opener` n'est pas requis pour ce cas d'usage simple).
 *
 * Sécurité : on n'ouvre que des URLs http/https pour éviter d'exécuter des
 * schémas arbitraires (file://, javascript:, etc.) depuis le coffre.
 */
export function openUrl(url: string): void {
  if (!url.trim()) return;
  const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  window.open(safe, "_blank", "noopener,noreferrer");
}

/** Retourne true si la chaîne ressemble à une URL web valide. */
export function isWebUrl(url: string): boolean {
  if (!url.trim()) return false;
  try {
    const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const parsed = new URL(withProto);
    return parsed.hostname.includes(".");
  } catch {
    return false;
  }
}
