import { appDataDir, join } from "@tauri-apps/api/path";
import { vaultApi } from "./tauri";

/**
 * Première passe mobile (Android) — stockage "simple" choisi volontairement
 * plutôt que le modèle desktop (fichier .vault à un emplacement choisi par
 * l'utilisateur) : Android n'a pas d'équivalent direct de "choisir un
 * fichier n'importe où sur le disque" sans Storage Access Framework
 * (URIs `content://`, que `std::fs` côté Rust ne sait pas lire — voir
 * DEV_NOTES.md pour le détail de cette limitation). `appDataDir()` renvoie
 * en revanche un vrai chemin filesystem classique dans le stockage privé
 * de l'app (`/data/data/<package>/files/...` sur Android), donc les
 * commandes Rust existantes (`create_local_vault`, `unlock_local_vault`,
 * etc., basées sur `std::fs`) fonctionnent sans aucune modification.
 *
 * Limite assumée de cette première passe : un seul coffre par installation
 * (pas de "coffres récents" côté mobile, cet écran n'a pas de sens ici),
 * et pas de bouton "choisir l'emplacement" dans CreateLocalVault/UnlockVault
 * quand ce chemin est utilisé — voir App.tsx.
 */
const MOBILE_VAULT_FILENAME = "coffre.vault";

let cachedPath: string | null = null;

export async function getMobileVaultPath(): Promise<string> {
  if (cachedPath) return cachedPath;
  const dir = await appDataDir();
  cachedPath = await join(dir, MOBILE_VAULT_FILENAME);
  return cachedPath;
}

/** true si un .vault existe déjà à cet emplacement (donc : proposer
 * "Déverrouiller" directement plutôt que "Créer un coffre"). */
export async function mobileVaultExists(path: string): Promise<boolean> {
  return vaultApi.vaultExists(path);
}
