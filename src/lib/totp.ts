/**
 * Génération de codes TOTP (RFC 6238) purement côté client, via l'API
 * Web Crypto standard (disponible dans la webview Tauri). Aucune dépendance
 * externe : le secret ne quitte jamais la mémoire du processus.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

function intToBytes(num: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  // JS number reste largement suffisant pour un compteur de temps / 30s
  view.setUint32(4, num, false);
  return new Uint8Array(buf);
}

async function hmacSha1(keyBytes: Uint8Array, msgBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes as BufferSource);
  return new Uint8Array(sig);
}

/** Extrait le secret d'une URI `otpauth://totp/...?secret=XXXX...`, ou renvoie la chaîne telle quelle si ce n'en est pas une. */
export function extractTotpSecret(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("otpauth://")) {
    try {
      const url = new URL(trimmed);
      return url.searchParams.get("secret") ?? trimmed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export interface TotpCode {
  code: string;
  remainingSeconds: number;
}

/** Calcule le code TOTP courant (6 chiffres, période 30s) pour un secret base32. */
export async function computeTotp(secretBase32: string, period = 30, digits = 6): Promise<TotpCode | null> {
  const secret = extractTotpSecret(secretBase32);
  if (!secret) return null;
  const keyBytes = base32Decode(secret);
  if (keyBytes.length === 0) return null;

  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / period);
  const remainingSeconds = period - (epoch % period);

  const hmac = await hmacSha1(keyBytes, intToBytes(counter));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = (binary % 10 ** digits).toString().padStart(digits, "0");

  return { code, remainingSeconds };
}
