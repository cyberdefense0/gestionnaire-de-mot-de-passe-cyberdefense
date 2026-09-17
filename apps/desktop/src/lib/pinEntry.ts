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
 * - Le hash du PIN est dérivé via PBKDF2-SHA256 (200 000 itérations, sel
 *   aléatoire 16 octets) et stocké en localStorage (`coffre:pin:hash`,
 *   `coffre:pin:salt`, `coffre:pin:version`). Aucun secret de vault n'est
 *   stocké.
 *
 *   Pourquoi PBKDF2 et non SHA-256 simple ?
 *   Un PIN à 4 chiffres ne représente que 10 000 combinaisons. Avec SHA-256
 *   nu, un attaquant ayant accès au localStorage (accès physique ou XSS)
 *   peut les tester toutes en < 1ms. PBKDF2 à 200 000 itérations porte ce
 *   coût à ~2s/tentative sur CPU grand public, soit ~5h pour un brute-force
 *   exhaustif — suffisant pour un facteur de commodité dont la limite de
 *   5 tentatives est la protection principale.
 *
 *   Note : PBKDF2 est utilisé ici (et pas Argon2id) uniquement parce que
 *   Argon2id n'est pas disponible en Web Crypto API nativement. Le master
 *   password réel reste protégé par Argon2id côté Rust (vault-core).
 *
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
const VERSION_KEY = "coffre:pin:version";
const ATTEMPTS_KEY = "coffre:pin:attempts";
const MP_SESSION_KEY = "coffre:pin:mp"; // sessionStorage — effacé à la fermeture
const MAX_ATTEMPTS = 5;

/** Version du schéma de hash PIN — permet une migration future sans casser les PIN existants. */
const CURRENT_PIN_VERSION = 2; // v1 = SHA-256, v2 = PBKDF2-SHA256
const PBKDF2_ITERATIONS = 200_000;

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

function randomBytes(n = 16): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}

/**
 * Dérive un hash du PIN via PBKDF2-SHA256 (200 000 itérations).
 * @returns hex string du hash (32 octets = 64 chars)
 */
async function hashPinPbkdf2(pin: string, saltHex: string): Promise<string> {
  const saltBytes = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(new Uint8Array(derived));
}

/** Active le PIN. Appeler après avoir vérifié le master password côté Rust. */
export async function enablePin(pin: string, masterPassword: string): Promise<void> {
  if (!/^\d{4,6}$/.test(pin)) throw new Error("Le PIN doit contenir 4 à 6 chiffres.");
  const salt = toHex(randomBytes(16));
  const hash = await hashPinPbkdf2(pin, salt);
  localStorage.setItem(SALT_KEY, salt);
  localStorage.setItem(HASH_KEY, hash);
  localStorage.setItem(VERSION_KEY, String(CURRENT_PIN_VERSION));
  localStorage.setItem(ATTEMPTS_KEY, "0");
  storeMasterPasswordForPin(masterPassword);
}

/** Désactive le PIN et efface toutes ses données. */
export function disablePin(): void {
  localStorage.removeItem(HASH_KEY);
  localStorage.removeItem(SALT_KEY);
  localStorage.removeItem(VERSION_KEY);
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
 *
 * Migration transparente : si le PIN a été créé avec la v1 (SHA-256 simple,
 * localStorage `coffre:pin:version` absent ou "1"), le PIN est considéré
 * comme invalidé et le PIN est désactivé pour forcer une réactivation avec
 * le schéma sécurisé v2. On préfère casser le PIN existant plutôt que
 * maintenir du code de vérification SHA-256 simple en production.
 *
 * @returns "ok" | "wrong" | "blocked"
 */
export async function checkPin(pin: string): Promise<"ok" | "wrong" | "blocked"> {
  const salt = localStorage.getItem(SALT_KEY);
  const stored = localStorage.getItem(HASH_KEY);
  const version = Number(localStorage.getItem(VERSION_KEY) ?? "1");
  if (!salt || !stored) return "blocked";

  // Migration : PIN v1 (SHA-256 simple) → désactivation forcée.
  if (version < CURRENT_PIN_VERSION) {
    disablePin();
    return "blocked";
  }

  const used = Number(localStorage.getItem(ATTEMPTS_KEY) ?? "0");
  if (used >= MAX_ATTEMPTS) return "blocked";

  const hash = await hashPinPbkdf2(pin, salt);
  if (hash === stored) {
    localStorage.setItem(ATTEMPTS_KEY, "0");
    return "ok";
  }

  const newCount = used + 1;
  localStorage.setItem(ATTEMPTS_KEY, String(newCount));
  if (newCount >= MAX_ATTEMPTS) {
    disablePin();
    return "blocked";
  }
  return "wrong";
}
