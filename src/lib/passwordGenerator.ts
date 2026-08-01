import type { GeneratorOptions } from "../types";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NUMS = "0123456789";
const SYMS = "!@#$%^&*()-_=+[]{}?";

/**
 * Génère un mot de passe côté client avec crypto.getRandomValues (CSPRNG du
 * navigateur/webview). Utilisé pour le mode Cloud (web) ; en mode desktop
 * local, la commande Tauri `generate_password` (Rust/OsRng) est équivalente
 * et préférée quand disponible.
 */
export function generatePassword(opts: GeneratorOptions): string {
  let pool = "";
  if (opts.lowercase) pool += LOWER;
  if (opts.uppercase) pool += UPPER;
  if (opts.numbers) pool += NUMS;
  if (opts.symbols) pool += SYMS;
  if (pool.length === 0) pool = LOWER;

  const length = Math.max(4, opts.length);
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += pool[values[i] % pool.length];
  }
  return out;
}
