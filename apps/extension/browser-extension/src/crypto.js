/**
 * crypto.js — Moteur cryptographique de l'extension Coffre.
 *
 * Reproduit fidèlement la logique de vault-core/src/lib.rs :
 *   - Argon2id  : m=19456 KiB, t=2, p=1, outLen=32
 *   - AES-256-GCM : nonce 12 octets aléatoires, préfixé avant le ciphertext
 *   - Encodage  : base64 standard (identique à l'app Rust)
 *
 * Dépendance externe : argon2-browser (chargée via CDN dans vault.html /
 * background.js via importScripts — ce fichier l'utilise via l'objet global
 * `argon2` injecté par la lib).
 *
 * Important : WebCrypto est disponible uniquement en contexte sécurisé
 * (HTTPS ou extension). Dans un service worker MV3, `self.crypto` est
 * accessible directement.
 */

// ─── Constantes (miroir de lib.rs) ───────────────────────────────────────────

export const DEK_LEN   = 32; // AES-256
export const NONCE_LEN = 12; // AES-GCM
export const SALT_LEN  = 16;

// Paramètres Argon2id identiques à ceux de vault-core
const ARGON2_M_COST = 19 * 1024; // 19 456 KiB
const ARGON2_T_COST = 2;
const ARGON2_P_COST = 1;

// ─── Utilitaires base64 ───────────────────────────────────────────────────────

export function toB64(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}

export function fromB64(b64) {
  const str = atob(b64);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

// ─── Génération aléatoire ─────────────────────────────────────────────────────

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// ─── Argon2id ─────────────────────────────────────────────────────────────────

/**
 * Dérive une clé de 32 octets à partir d'un secret et d'un sel.
 * `secret` : Uint8Array (master password ou recovery code en UTF-8)
 * `salt`   : Uint8Array de 16 octets
 * Retourne : Uint8Array de 32 octets
 *
 * Requiert que la lib `argon2-browser` soit chargée (objet global `argon2`).
 */
export async function deriveKey(secret, salt) {
  if (typeof argon2 === 'undefined') {
    throw new Error('argon2-browser non chargé');
  }
  const result = await argon2.hash({
    pass:    secret,
    salt:    salt,
    type:    argon2.ArgonType.Argon2id,
    mem:     ARGON2_M_COST,
    time:    ARGON2_T_COST,
    parallelism: ARGON2_P_COST,
    hashLen: DEK_LEN,
    distrib: false,
  });
  return result.hash; // Uint8Array
}

// ─── AES-256-GCM ──────────────────────────────────────────────────────────────

async function importAesKey(keyBytes) {
  return crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
}

/**
 * Chiffre `plaintext` (Uint8Array) avec `keyBytes` (Uint8Array 32 oct).
 * Retourne une chaîne base64 : nonce(12) || ciphertext+tag.
 * Identique à `aes_encrypt` dans lib.rs.
 */
export async function aesEncrypt(keyBytes, plaintext) {
  const key   = await importAesKey(keyBytes);
  const nonce = randomBytes(NONCE_LEN);
  const ct    = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext);
  const combined = new Uint8Array(NONCE_LEN + ct.byteLength);
  combined.set(nonce);
  combined.set(new Uint8Array(ct), NONCE_LEN);
  return toB64(combined);
}

/**
 * Déchiffre un blob base64 (nonce || ciphertext+tag) avec `keyBytes`.
 * Retourne Uint8Array ou lève une exception si mauvais mot de passe / données corrompues.
 */
export async function aesDecrypt(keyBytes, blobB64) {
  const combined = fromB64(blobB64);
  if (combined.length < NONCE_LEN) throw new Error('Blob trop court');
  const nonce  = combined.slice(0, NONCE_LEN);
  const ct     = combined.slice(NONCE_LEN);
  const key    = await importAesKey(keyBytes);
  const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
  return new Uint8Array(plain);
}

// ─── SHA-256 (pour vérification du checksum du .vault) ───────────────────────

export async function sha256hex(str) {
  const buf  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Kit de récupération (miroir de format_recovery_code / parse_recovery_code) ─

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans O/0/I/1

export function formatRecoveryCode(bytes) {
  // Reproduit exactement format_recovery_code de lib.rs
  let acc = 0, bits = 0;
  const chars = [];
  for (const b of bytes) {
    acc = ((acc << 8) | b) >>> 0;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars.push(ALPHABET[(acc >> bits) & 0x1F]);
    }
  }
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += chars[i];
  }
  return out;
}

export function parseRecoveryCode(code) {
  // Reproduit parse_recovery_code : filtre les tirets, retourne les bytes UTF-8
  return new TextEncoder().encode(code.replace(/-/g, ''));
}
