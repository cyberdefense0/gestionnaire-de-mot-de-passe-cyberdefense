/**
 * Biométrie via trousseau OS — couche d'abstraction frontend.
 *
 * ARCHITECTURE :
 *   Le master password est stocké dans le trousseau OS natif via la crate
 *   Rust `keyring` (Windows Credential Manager, macOS Keychain, libsecret
 *   Linux). L'OS peut conditionner l'accès à un geste biométrique
 *   (Windows Hello, Touch ID) si l'utilisateur l'a configuré sur son compte.
 *
 * CE QUE CE N'EST PAS :
 *   L'app n'appelle pas directement les APIs biométriques. Elle délègue
 *   entièrement à l'OS la décision d'exiger ou non un geste biométrique.
 *   Sur une machine sans biométrie configurée, le trousseau est déverrouillé
 *   par la session utilisateur (mot de passe de session / écran de verrouillage).
 *
 * DIFFÉRENCE AVEC LE PIN :
 *   - PIN : hash PBKDF2 en localStorage + master password en sessionStorage.
 *     Disponible jusqu'à la fermeture de l'onglet/app.
 *   - Trousseau OS : master password stocké côté OS, persisté entre les
 *     redémarrages. Protégé par les droits de session OS.
 *   Les deux peuvent coexister. Si le trousseau OS est disponible, il est
 *   préféré au PIN. Le PIN reste le fallback si le trousseau échoue.
 *
 * STOCKAGE localStorage (préférences uniquement — jamais de secret) :
 *   `coffre:biometry:enabled`  — "true" si l'utilisateur a activé la biométrie.
 */

import { vaultApi } from "./tauri";

const ENABLED_KEY = "coffre:biometry:enabled";

export function isBiometryEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === "true";
}

function setBiometryEnabled(value: boolean) {
  if (value) localStorage.setItem(ENABLED_KEY, "true");
  else localStorage.removeItem(ENABLED_KEY);
}

/**
 * Active la biométrie : enregistre le master password dans le trousseau OS.
 * Doit être appelé après vérification du master password (verify_master_password_cmd).
 */
export async function enableBiometry(masterPassword: string): Promise<void> {
  await vaultApi.keyring.save(masterPassword);
  setBiometryEnabled(true);
}

/**
 * Désactive la biométrie : supprime le master password du trousseau OS.
 */
export async function disableBiometry(): Promise<void> {
  await vaultApi.keyring.delete();
  setBiometryEnabled(false);
}

/**
 * Tente de récupérer le master password depuis le trousseau OS.
 * Retourne null si non configuré, si l'accès est refusé, ou si le trousseau
 * n'est pas disponible sur cette plateforme.
 * N'affiche AUCUN dialogue — l'appelant gère le fallback.
 */
export async function getBiometryMasterPassword(): Promise<string | null> {
  if (!isBiometryEnabled()) return null;
  try {
    return await vaultApi.keyring.get();
  } catch {
    return null;
  }
}

/**
 * Vérifie la cohérence entre le flag localStorage et le trousseau réel.
 * Si le trousseau ne contient plus rien (réinstallation OS, etc.),
 * remet le flag à false pour éviter de proposer un déverrouillage qui
 * échouerait silencieusement.
 */
export async function syncBiometryState(): Promise<void> {
  if (!isBiometryEnabled()) return;
  try {
    const configured = await vaultApi.keyring.isConfigured();
    if (!configured) setBiometryEnabled(false);
  } catch {
    // Erreur d'accès au trousseau — conserver l'état actuel.
  }
}
