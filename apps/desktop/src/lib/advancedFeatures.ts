import { invoke } from "@tauri-apps/api/core";

/**
 * Shamir Secret Sharing — fragmente un kit de récupération en `n` parts
 * dont `k` suffisent à reconstituer le secret.
 *
 * L'implémentation Rust utilise le crate `shamir` (GF(256), polynôme de
 * degré k-1) : k-1 fragments ne révèlent rien du secret, contrairement à
 * l'ancienne version stub.
 */
export const shamirApi = {
  /** `recoveryCode` : le texte à fragmenter (ex : le kit de récupération du coffre). */
  generateShares: (recoveryCode: string, n: number, k: number): Promise<number[][]> =>
    invoke("generate_shamir_shares", { recoveryCode, n: n as unknown as number, k: k as unknown as number }),

  /**
   * `threshold` DOIT être le `k` utilisé lors de la génération — le
   * déduire du nombre de fragments fournis est incorrect si l'utilisateur
   * en fournit plus que le seuil minimal.
   */
  reconstructSecret: (shares: number[][], threshold: number): Promise<string> =>
    invoke("reconstruct_shamir_secret", { shares, threshold: threshold as unknown as number }),
};

/**
 * Partage web temporaire : chiffrement AES-256-GCM côté Rust, clé uniquement
 * dans le fragment `#` du lien (jamais transmise au serveur). Le lien expire
 * après le TTL choisi et ne peut être lu qu'une seule fois.
 */
export const tempShareApi = {
  create: (plaintext: number[], ttlSeconds: number): Promise<string> =>
    invoke("create_temp_share", { plaintext, ttlSeconds }),

  fetch: (id: string, keyB64: string): Promise<number[]> =>
    invoke("fetch_temp_share", { id, keyB64 }),
};

/** Encode une chaîne UTF-8 en tableau d'octets pour les commandes Rust. */
export function stringToBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

/** Décode un tableau d'octets renvoyé par Rust en chaîne UTF-8. */
export function bytesToString(bytes: number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Décode une chaîne base64 (ex : sortie de `read_binary_file`) en tableau d'octets. */
export function base64ToBytes(b64: string): number[] {
  const binary = atob(b64);
  const bytes = new Array<number>(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode un tableau d'octets en base64 (ex : pour `write_binary_file`). */
export function bytesToBase64(bytes: number[]): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Stéganographie LSB : cache les octets du coffre (déjà chiffré) dans les
 * bits de poids faible des pixels R, G, B d'une image PNG.
 *
 * La longueur du payload est encodée dans les 4 premiers octets cachés dans
 * l'image → l'extraction est entièrement autonome, sans paramètre externe.
 */
export const steganographyApi = {
  embed: (imagePath: string, vaultData: number[], outputPath: string): Promise<void> =>
    invoke("embed_vault_in_image", { imagePath, vaultData, outputPath }),

  /** Extrait le coffre caché dans `imagePath`. La longueur est auto-détectée. */
  extract: (imagePath: string): Promise<number[]> =>
    invoke("extract_vault_from_image", { imagePath }),
};

export interface AutoTypePayload {
  username: string;
  password: string;
  entry_id: string;
}

/**
 * Simule la frappe clavier `username → Tab → password → Entrée` dans la
 * fenêtre actuellement au premier plan via `enigo`.
 */
export const autoTypeApi = {
  run: (payload: AutoTypePayload): Promise<void> => invoke("auto_type", { payload }),
};

/** Entrées du journal d'audit append-only (côté Rust, non modifiable). */
export interface JournalEntry {
  timestamp: number;
  operation: string;
  entry_id: string;
  data_hash_hex: string;
}

export const journalApi = {
  getEntries: (): Promise<JournalEntry[]> => invoke("get_journal_entries"),
  verifyIntegrity: (): Promise<boolean> => invoke("verify_journal_integrity"),
};
