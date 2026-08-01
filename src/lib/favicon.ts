/** Extrait un nom de domaine affichable/exploitable depuis une URL saisie librement. */
export function extractDomain(url: string): string | null {
  if (!url.trim()) return null;
  try {
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withScheme).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** URL d'icône via le service favicon public de Google (pas de clé requise). */
export function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
}
