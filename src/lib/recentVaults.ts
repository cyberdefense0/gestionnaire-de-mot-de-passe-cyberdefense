const STORAGE_KEY = "coffre:recentVaults";
const MAX_RECENT = 5;

export interface RecentVault {
  path: string;
  /** ISO, date de dernier déverrouillage/création réussi. */
  lastOpened: string;
}

/**
 * Ne stocke QUE des chemins de fichiers et des dates — jamais de mot de
 * passe, jamais de contenu du coffre. C'est l'équivalent d'une liste de
 * "fichiers récents" classique dans n'importe quel logiciel de bureau ;
 * ça ne réduit en rien la sécurité zero-knowledge (le fichier .vault
 * pointé reste aussi chiffré et protégé que si on l'avait sélectionné à
 * la main via le sélecteur de fichiers).
 */
function readAll(): RecentVault[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is RecentVault => typeof v?.path === "string" && typeof v?.lastOpened === "string"
    );
  } catch {
    return [];
  }
}

export function getRecentVaults(): RecentVault[] {
  return readAll().sort((a, b) => new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime());
}

export function rememberVault(path: string): void {
  const withoutThisOne = readAll().filter((v) => v.path !== path);
  const updated = [{ path, lastOpened: new Date().toISOString() }, ...withoutThisOne].slice(0, MAX_RECENT);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function forgetVault(path: string): void {
  const updated = readAll().filter((v) => v.path !== path);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

/** Nom de fichier seul, pour l'affichage (le chemin complet reste visible en title/tooltip). */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
