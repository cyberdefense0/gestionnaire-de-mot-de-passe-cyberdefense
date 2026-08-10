/**
 * vault.js — Lecture / écriture / création du format .vault.
 *
 * Structure du fichier .vault (JSON) — identique à VaultFile dans lib.rs :
 * {
 *   version            : number   (2)
 *   master_salt        : string   (base64, 16 octets)
 *   recovery_salt      : string   (base64, 16 octets)
 *   wrapped_dek_master : string   (base64, nonce+ciphertext AES-GCM de la DEK)
 *   wrapped_dek_recovery: string  (idem, clé dérivée du recovery code)
 *   encrypted_vault    : string   (base64, nonce+ciphertext du JSON du vault)
 *   checksum_sha256    : string   (SHA-256 hex de encrypted_vault, vide si v1)
 *   recovery_kit_confirmed_at : string|null
 * }
 */

import {
  deriveKey, aesEncrypt, aesDecrypt, sha256hex,
  fromB64, toB64, randomBytes,
  formatRecoveryCode, parseRecoveryCode,
  DEK_LEN, SALT_LEN,
} from './crypto.js';

// ─── Déverrouillage ───────────────────────────────────────────────────────────

/**
 * Vérifie le checksum avant tout déchiffrement coûteux (Argon2).
 * Retourne false uniquement si le checksum est présent ET invalide.
 */
async function verifyChecksum(file) {
  if (!file.checksum_sha256) return true; // fichier v1, pas de checksum
  const computed = await sha256hex(file.encrypted_vault);
  return computed === file.checksum_sha256;
}

/**
 * Déverrouille avec le master password.
 * Retourne { vault, dek } ou lève une Error.
 * `vault` est le contenu JS en clair ; `dek` (Uint8Array) permet de sauvegarder
 * sans redemander le mot de passe.
 */
export async function unlockWithMasterPassword(file, masterPassword) {
  if (!(await verifyChecksum(file))) {
    throw new Error('Fichier .vault corrompu ou modifié (checksum invalide).');
  }
  const salt   = fromB64(file.master_salt);
  const secret = new TextEncoder().encode(masterPassword);
  const kek    = await deriveKey(secret, salt);
  const dekRaw = await aesDecrypt(kek, file.wrapped_dek_master);
  if (dekRaw.length !== DEK_LEN) throw new Error('DEK invalide');
  const vaultJson = await aesDecrypt(dekRaw, file.encrypted_vault);
  const vault = JSON.parse(new TextDecoder().decode(vaultJson));
  return { vault, dek: dekRaw };
}

/**
 * Déverrouille avec le kit de récupération.
 */
export async function unlockWithRecoveryCode(file, recoveryCode) {
  if (!(await verifyChecksum(file))) {
    throw new Error('Fichier .vault corrompu ou modifié (checksum invalide).');
  }
  const salt   = fromB64(file.recovery_salt);
  const secret = parseRecoveryCode(recoveryCode);
  const kek    = await deriveKey(secret, salt);
  const dekRaw = await aesDecrypt(kek, file.wrapped_dek_recovery);
  if (dekRaw.length !== DEK_LEN) throw new Error('DEK invalide');
  const vaultJson = await aesDecrypt(dekRaw, file.encrypted_vault);
  const vault = JSON.parse(new TextDecoder().decode(vaultJson));
  return { vault, dek: dekRaw };
}

// ─── Sauvegarde ───────────────────────────────────────────────────────────────

/**
 * Met à jour encrypted_vault + checksum dans `file` (mutation en place).
 * Ne touche pas aux DEK ni aux sels — le master password n'est pas nécessaire.
 */
export async function saveVault(file, vault, dek) {
  const vaultJson  = new TextEncoder().encode(JSON.stringify(vault));
  const encrypted  = await aesEncrypt(dek, vaultJson);
  file.encrypted_vault  = encrypted;
  file.checksum_sha256  = await sha256hex(encrypted);
}

// ─── Création d'un nouveau vault ──────────────────────────────────────────────

/**
 * Crée un vault vide protégé par `masterPassword`.
 * Retourne { file, recoveryCode }.
 * Identique à create_vault() dans lib.rs.
 */
export async function createVault(masterPassword) {
  const dek = randomBytes(DEK_LEN);

  // Wrap DEK avec master password
  const masterSalt  = randomBytes(SALT_LEN);
  const masterKey   = await deriveKey(new TextEncoder().encode(masterPassword), masterSalt);
  const wrappedDekMaster = await aesEncrypt(masterKey, dek);

  // Wrap DEK avec recovery code
  const recoveryRaw  = randomBytes(18); // 18 octets → code lisible
  const recoveryCode = formatRecoveryCode(recoveryRaw);
  const recoverySalt = randomBytes(SALT_LEN);
  const recoveryKey  = await deriveKey(parseRecoveryCode(recoveryCode), recoverySalt);
  const wrappedDekRecovery = await aesEncrypt(recoveryKey, dek);

  // Vault vide
  const emptyVault  = { items: [], categories: ['Général'] };
  const vaultJson   = new TextEncoder().encode(JSON.stringify(emptyVault));
  const encryptedVault = await aesEncrypt(dek, vaultJson);
  const checksum    = await sha256hex(encryptedVault);

  const file = {
    version: 2,
    master_salt:          toB64(masterSalt),
    recovery_salt:        toB64(recoverySalt),
    wrapped_dek_master:   wrappedDekMaster,
    wrapped_dek_recovery: wrappedDekRecovery,
    encrypted_vault:      encryptedVault,
    checksum_sha256:      checksum,
    recovery_kit_confirmed_at: null,
  };

  return { file, recoveryCode };
}

// ─── Changement de master password ───────────────────────────────────────────

/**
 * Re-wrap la DEK avec un nouveau master password.
 * Ne re-chiffre pas le contenu du vault (identique à l'app Rust).
 */
export async function changeMasterPassword(file, dek, newPassword) {
  const newSalt = randomBytes(SALT_LEN);
  const newKey  = await deriveKey(new TextEncoder().encode(newPassword), newSalt);
  file.master_salt        = toB64(newSalt);
  file.wrapped_dek_master = await aesEncrypt(newKey, dek);
}

// ─── Sérialisation / désérialisation du fichier ───────────────────────────────

export function serializeVaultFile(file) {
  return JSON.stringify(file, null, 2);
}

export function parseVaultFile(jsonStr) {
  let file;
  try {
    file = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('Fichier .vault corrompu (JSON invalide).');
  }
  // Validation stricte des champs obligatoires (identiques à VaultFile dans lib.rs)
  const required = ['version', 'master_salt', 'recovery_salt',
                    'wrapped_dek_master', 'wrapped_dek_recovery', 'encrypted_vault'];
  const missing = required.filter(k => !file[k]);
  if (missing.length > 0) {
    throw new Error(`Format de fichier .vault invalide. Champs manquants : ${missing.join(', ')}`);
  }
  // S'assurer que les champs optionnels ont des valeurs par défaut (compatibilité v1)
  if (!file.checksum_sha256) file.checksum_sha256 = '';
  if (file.recovery_kit_confirmed_at === undefined) file.recovery_kit_confirmed_at = null;
  return file;
}

// ─── Utilitaires entrées ──────────────────────────────────────────────────────

export function newItemId() {
  return crypto.randomUUID();
}

export function isoNow() {
  return new Date().toISOString();
}

/** Correspondance domaine (identique à domains_match dans native_messaging.rs) */
export function domainMatches(itemUrl, requestUrl) {
  if (!itemUrl?.trim()) return false;
  const extract = (url) => {
    const withoutScheme = url.split('://').pop() ?? url;
    const host = withoutScheme.split('/')[0];
    return (host.split(':')[0]).toLowerCase();
  };
  const itemDomain = extract(itemUrl);
  const reqDomain  = extract(requestUrl);
  return itemDomain === reqDomain || reqDomain.endsWith(`.${itemDomain}`);
}
