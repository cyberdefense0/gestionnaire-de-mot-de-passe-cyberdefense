import type { VaultItem } from "../types";

/**
 * Export chiffré natif indépendant du fichier `.vault` (roadmap README §2.2).
 * Contrairement à l'export/sauvegarde existant ("Export / sauvegarde" dans
 * Paramètres, qui copie tel quel le `.vault` déjà chiffré avec le master
 * password), ce format :
 *  - utilise un mot de passe d'export dédié, différent du master password ;
 *  - ne contient qu'un JSON chiffré (items + albums), pas la structure
 *    complète du fichier `.vault` (kit de récupération, checksum, etc.) —
 *    utile pour migrer seulement les données vers une autre instance.
 *
 * Chiffrement: AES-256-GCM (Web Crypto, `crypto.subtle`), clé dérivée du
 * mot de passe d'export via PBKDF2-SHA256 (600 000 itérations — repère
 * OWASP 2023 pour PBKDF2-SHA256). C'est volontairement PBKDF2 et non
 * Argon2id : `vault-core` réserve Argon2id au master password réel (protégé
 * côté Rust) ; ici tout doit rester exécutable en Web Crypto pur, sans
 * dépendance native, pour un format d'échange simple.
 */

const PBKDF2_ITERATIONS = 600_000;
export const ENCRYPTED_EXPORT_VERSION = 1;

export interface EncryptedExportEnvelope {
  format: "coffre-encrypted-export";
  version: number;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt_b64: string;
  iv_b64: string;
  ciphertext_b64: string;
  exported_at: string;
}

interface ExportPayload {
  items: VaultItem[];
  categories: string[];
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Chiffre items+albums avec un mot de passe d'export dédié. Retourne le JSON prêt à écrire sur disque. */
export async function createEncryptedExport(
  items: VaultItem[],
  categories: string[],
  exportPassword: string
): Promise<string> {
  if (!exportPassword || exportPassword.length < 8) {
    throw new Error("Le mot de passe d'export doit contenir au moins 8 caractères.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(exportPassword, salt);

  const payload: ExportPayload = { items, categories };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext);

  const envelope: EncryptedExportEnvelope = {
    format: "coffre-encrypted-export",
    version: ENCRYPTED_EXPORT_VERSION,
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    salt_b64: toBase64(salt),
    iv_b64: toBase64(iv),
    ciphertext_b64: toBase64(ciphertext),
    exported_at: new Date().toISOString(),
  };
  return JSON.stringify(envelope, null, 2);
}

export class EncryptedExportError extends Error {}

/**
 * Déchiffre un export produit par `createEncryptedExport`. Lève une erreur
 * lisible (mot de passe incorrect OU fichier corrompu/invalide — AES-GCM ne
 * permet pas de distinguer les deux, le tag d'authentification échoue dans
 * les deux cas) plutôt qu'une exception brute de Web Crypto.
 */
export async function readEncryptedExport(fileContent: string, exportPassword: string): Promise<ExportPayload> {
  let envelope: EncryptedExportEnvelope;
  try {
    envelope = JSON.parse(fileContent);
  } catch {
    throw new EncryptedExportError("Ce fichier n'est pas un export chiffré valide (JSON invalide).");
  }
  if (envelope.format !== "coffre-encrypted-export" || !envelope.ciphertext_b64) {
    throw new EncryptedExportError("Ce fichier n'est pas un export chiffré reconnu par cette application.");
  }

  const salt = fromBase64(envelope.salt_b64);
  const iv = fromBase64(envelope.iv_b64);
  const ciphertext = fromBase64(envelope.ciphertext_b64);
  const key = await deriveKey(exportPassword, salt);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as ExportPayload;
    if (!Array.isArray(payload.items)) throw new Error("payload invalide");
    return payload;
  } catch {
    throw new EncryptedExportError("Mot de passe d'export incorrect, ou fichier corrompu.");
  }
}
