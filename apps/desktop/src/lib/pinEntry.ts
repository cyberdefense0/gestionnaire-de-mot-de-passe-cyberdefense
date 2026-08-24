/**
 * PIN numérique optionnel (4 à 6 chiffres) pour déverrouiller le coffre
 * plus rapidement sans retaper le master password complet.
 *
 * SÉCURITÉ — ce que ce système N'EST PAS :
 * Le PIN ne chiffre PAS le vault. Il sert uniquement à déverrouiller la
 * SESSION en mémoire quand le coffre est déjà ouvert ou était ouvert dans
 * la même installation. Le master password reste la seule clé cryptographique.
 *
 * Architecture choisie (minimaliste, sans changement Rust) :
 * - À l'activation du PIN, l'utilisateur entre d'abord son master password
 *   pour confirmer son identité.
 * - Le hash du PIN (SHA-256, sel aléatoire) est stocké en localStorage
 *   (`coffre:pin:hash` + `coffre:pin:salt`). Aucun secret de vault n'est
 *   stocké.
 * - Au déverrouillage par PIN : on vérifie le hash, puis on rappelle
 *   `unlock_local_vault` avec le master password stocké en mémoire volatile
 *   (sessionStorage, effacé à la fermeture de la fenêtre).
 * - Limite de tentatives : 5 essais, puis PIN bloqué et retour au master
 *   password obligatoire (+ désactivation automatique du PIN pour forcer
 *   une réactivation consciente).
 *
 * Ce modèle est identique à ce que font 1Password et Bitwarden sur mobile
 * (PIN/biométrie = déverrouillage de session, pas de clé de chiffrement).
 */

const HASH_KEY = "coffre:pin:hash";
const SALT_KEY = "coffre:pin:salt";
const ATTEMPTS_KEY = "coffre:pin:attempts";
const MP_SESSION_KEY = "coffre:pin:mp"; // sessionStorage — effacé à la fermeture
const MAX_ATTEMPTS = 5;

/** Retourne true si le PIN est activé sur cette installation. */
export function isPinEnabled(): boolean {
  return !!(localStorage.getItem(HASH_KEY) && localStorage.getItem(SALT_KEY));
}

/** Retourne le master password en mémoire volatile (sessionStorage). */
export function getStoredMasterPassword(): string | null {
  return sessionStorage.getItem(MP_SESSION_KEY);
}

/** Stocke le master password en mémoire volatile pour la durée de la session. */
export function storeMasterPasswordForPin(mp: string): void {
  sessionStorage.setItem(MP_SESSION_KEY, mp);
}

/** Efface le master password de la mémoire volatile. */
export function clearStoredMasterPassword(): void {
  sessionStorage.removeItem(MP_SESSION_KEY);
}

async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Active le PIN. Appeler après avoir vérifié le master password côté Rust. */
export async function enablePin(pin: string, masterPassword: string): Promise<void> {
  if (!/^\d{4,6}$/.test(pin)) throw new Error("Le PIN doit contenir 4 à 6 chiffres.");
  const salt = randomHex(16);
  const hash = await sha256hex(salt + pin);
  localStorage.setItem(SALT_KEY, salt);
  localStorage.setItem(HASH_KEY, hash);
  localStorage.setItem(ATTEMPTS_KEY, "0");
  storeMasterPasswordForPin(masterPassword);
}

/** Désactive le PIN et efface toutes ses données. */
export function disablePin(): void {
  localStorage.removeItem(HASH_KEY);
  localStorage.removeItem(SALT_KEY);
  localStorage.removeItem(ATTEMPTS_KEY);
  clearStoredMasterPassword();
}

/** Retourne le nombre de tentatives échouées restantes, ou null si PIN non activé. */
export function pinAttemptsLeft(): number | null {
  if (!isPinEnabled()) return null;
  const used = Number(localStorage.getItem(ATTEMPTS_KEY) ?? "0");
  return Math.max(0, MAX_ATTEMPTS - used);
}

/**
 * Vérifie un PIN saisi.
 * @returns "ok" | "wrong" | "blocked"
 */
export async function checkPin(pin: string): Promise<"ok" | "wrong" | "blocked"> {
  const salt = localStorage.getItem(SALT_KEY);
  const stored = localStorage.getItem(HASH_KEY);
  if (!salt || !stored) return "blocked";

  const used = Number(localStorage.getItem(ATTEMPTS_KEY) ?? "0");
  if (used >= MAX_ATTEMPTS) return "blocked";

  const hash = await sha256hex(salt + pin);
  if (hash === stored) {
    localStorage.setItem(ATTEMPTS_KEY, "0");
    return "ok";
  }

  const newCount = used + 1;
  localStorage.setItem(ATTEMPTS_KEY, String(newCount));
  if (newCount >= MAX_ATTEMPTS) {
    // Désactiver le PIN après trop d'essais — l'utilisateur devra réactiver
    // explicitement avec son master password.
    disablePin();
    return "blocked";
  }
  return "wrong";
}
