"use strict";

/**
 * background-bundle.js — Service Worker MV3.
 *
 * Argon2id est délégué à l'Offscreen Document (src/offscreen.html)
 * car MV3 bloque WebAssembly dans les service workers.
 * Toute la logique crypto/vault reste ici.
 */

// ── Offscreen Document helper ─────────────────────────────────────────────────

const OFFSCREEN_URL = chrome.runtime.getURL('src/offscreen.html');
let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) return;
  try {
    // Chrome 116+ : vérifier si un contexte offscreen existe déjà
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [OFFSCREEN_URL],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url:         OFFSCREEN_URL,
        reasons:     ['WORKERS'],
        justification: 'Argon2id WASM interdit dans le service worker MV3',
      });
    }
  } catch (_) {
    // Fallback : tenter de créer, ignorer l'erreur si déjà existant
    try {
      await chrome.offscreen.createDocument({
        url:         OFFSCREEN_URL,
        reasons:     ['WORKERS'],
        justification: 'Argon2id WASM interdit dans le service worker MV3',
      });
    } catch (e) {
      if (!e.message.includes('Only a single offscreen')) throw e;
    }
  }
  offscreenReady = true;
}

// ── Adaptateur argon2 → offscreen ─────────────────────────────────────────────

const ArgonType = { Argon2d: 0, Argon2i: 1, Argon2id: 2 };

async function hash({ pass, salt, type, mem, time, parallelism, hashLen }) {
  if (type !== ArgonType.Argon2id) throw new Error('Seul Argon2id est supporté');

  await ensureOffscreen();

  const passArr = Array.from(typeof pass === 'string' ? new TextEncoder().encode(pass) : pass);
  const saltArr = Array.from(typeof salt === 'string' ? new TextEncoder().encode(salt) : salt);

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type:        'ARGON2_HASH',
      pass:        passArr,
      salt:        saltArr,
      mem,
      time,
      parallelism,
      hashLen,
    }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.ok)  return reject(new Error(response?.error ?? 'Argon2 offscreen error'));
      resolve({ hash: new Uint8Array(response.hash) });
    });
  });
}

const argon2 = { hash, ArgonType };

// crypto.js

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

const DEK_LEN   = 32; // AES-256
const NONCE_LEN = 12; // AES-GCM
const SALT_LEN  = 16;

// Paramètres Argon2id identiques à ceux de vault-core
const ARGON2_M_COST = 19 * 1024; // 19 456 KiB
const ARGON2_T_COST = 2;
const ARGON2_P_COST = 1;

// ─── Utilitaires base64 ───────────────────────────────────────────────────────

function toB64(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}

function fromB64(b64) {
  const str = atob(b64);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

// ─── Génération aléatoire ─────────────────────────────────────────────────────

function randomBytes(n) {
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
async function deriveKey(secret, salt) {
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
async function aesEncrypt(keyBytes, plaintext) {
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
async function aesDecrypt(keyBytes, blobB64) {
  const combined = fromB64(blobB64);
  if (combined.length < NONCE_LEN) throw new Error('Blob trop court');
  const nonce  = combined.slice(0, NONCE_LEN);
  const ct     = combined.slice(NONCE_LEN);
  const key    = await importAesKey(keyBytes);
  const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
  return new Uint8Array(plain);
}

// ─── SHA-256 (pour vérification du checksum du .vault) ───────────────────────

async function sha256hex(str) {
  const buf  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Kit de récupération (miroir de format_recovery_code / parse_recovery_code) ─

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans O/0/I/1

function formatRecoveryCode(bytes) {
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

function parseRecoveryCode(code) {
  // Reproduit parse_recovery_code : filtre les tirets, retourne les bytes UTF-8
  return new TextEncoder().encode(code.replace(/-/g, ''));
}


// vault.js

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
async function unlockWithMasterPassword(file, masterPassword) {
  console.log('[Coffre] unlock: version=', file?.version, 'checksum=', !!file?.checksum_sha256);
  if (!(await verifyChecksum(file))) {
    throw new Error('Fichier .vault corrompu ou modifié (checksum invalide).');
  }
  console.log('[Coffre] checksum OK, Argon2id...');
  const salt   = fromB64(file.master_salt);
  const secret = new TextEncoder().encode(masterPassword);
  const kek    = await deriveKey(secret, salt);
  console.log('[Coffre] KEK OK, déchiffrement DEK...');
  const dekRaw = await aesDecrypt(kek, file.wrapped_dek_master);
  if (dekRaw.length !== DEK_LEN) throw new Error('DEK invalide, longueur=' + dekRaw.length);
  console.log('[Coffre] DEK OK, déchiffrement vault...');
  const vaultJson = await aesDecrypt(dekRaw, file.encrypted_vault);
  const vault = JSON.parse(new TextDecoder().decode(vaultJson));
  console.log('[Coffre] Vault OK —', vault?.items?.length ?? 0, 'entrées');
  return { vault, dek: dekRaw };
}

/**
 * Déverrouille avec le kit de récupération.
 */
async function unlockWithRecoveryCode(file, recoveryCode) {
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
async function saveVault(file, vault, dek) {
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
async function createVault(masterPassword) {
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
async function changeMasterPassword(file, dek, newPassword) {
  const newSalt = randomBytes(SALT_LEN);
  const newKey  = await deriveKey(new TextEncoder().encode(newPassword), newSalt);
  file.master_salt        = toB64(newSalt);
  file.wrapped_dek_master = await aesEncrypt(newKey, dek);
}

// ─── Sérialisation / désérialisation du fichier ───────────────────────────────

function serializeVaultFile(file) {
  return JSON.stringify(file, null, 2);
}

function parseVaultFile(jsonStr) {
  let file;
  try {
    file = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
  } catch (e) {
    throw new Error('Fichier .vault corrompu (JSON invalide).');
  }
  const required = ['version', 'master_salt', 'recovery_salt',
                    'wrapped_dek_master', 'wrapped_dek_recovery', 'encrypted_vault'];
  const missing = required.filter(k => !file[k]);
  if (missing.length > 0) {
    throw new Error(`Format .vault invalide. Champs manquants : ${missing.join(', ')}`);
  }
  if (!file.checksum_sha256) file.checksum_sha256 = '';
  if (file.recovery_kit_confirmed_at === undefined) file.recovery_kit_confirmed_at = null;
  return file;
}

// ─── Utilitaires entrées ──────────────────────────────────────────────────────

function newItemId() {
  return crypto.randomUUID();
}

function isoNow() {
  return new Date().toISOString();
}

/** Correspondance domaine (identique à domains_match dans native_messaging.rs) */
function domainMatches(itemUrl, requestUrl) {
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


// background.js

/**
 * background.js — Service Worker MV3 autonome.
 *
 * L'extension gère désormais le coffre directement, sans avoir besoin de
 * l'application Rust en arrière-plan. Le coffre déchiffré est gardé en
 * mémoire dans `session` pendant la durée de vie du SW (réinitialisé quand
 * le SW se suspend, ce qui verrouille automatiquement le coffre).
 *
 * Messages entrants (depuis popup.js, vault.js, content.js) :
 *   UNLOCK            { file, masterPassword }  → { ok, error }
 *   UNLOCK_RECOVERY   { file, recoveryCode }    → { ok, error }
 *   LOCK              {}                         → { ok }
 *   GET_STATUS        {}                         → { unlocked, hasVault }
 *   GET_CREDENTIALS   { url }                   → { status, entries }
 *   GET_ALL_ITEMS     {}                         → { items, categories }
 *   SAVE_ITEMS        { items, categories }     → { ok, fileJson }
 *   CREATE_VAULT      { masterPassword }        → { ok, fileJson, recoveryCode }
 *   CHANGE_MASTER_PW  { newPassword }           → { ok, fileJson }
 *   GET_FILE_JSON     {}                         → { fileJson }
 *   FILL_SELECTED     { tabId, entry }          → { ok }
 *   GET_ACTIVE_TAB_URL {}                       → { url }
 */

// argon2-browser WASM (chargé depuis le répertoire de l'extension)
// ─── État en mémoire (réinitialisé à chaque suspend du SW) ───────────────────

let session = null;
// session = { file, vault, dek }

// ─── Handlers de messages ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  handleMessage(req, sender).then(sendResponse).catch((e) => {
    const detail = e instanceof DOMException
      ? `DOMException[${e.name}]: ${e.message} (code ${e.code})`
      : (e?.message ?? String(e));
    console.error('[Coffre BG] Type:', req.type, '— Erreur:', detail, e?.stack ?? '');
    const msg = e instanceof DOMException
      ? `Erreur cryptographique (${e.name}) — mot de passe incorrect ou fichier corrompu.`
      : (e?.message ?? String(e));
    sendResponse({ ok: false, error: msg });
  });
  return true; // réponse asynchrone
});

async function handleMessage(req, sender) {
  switch (req.type) {

    case 'UNLOCK': {
      const { vault, dek } = await unlockWithMasterPassword(req.file, req.masterPassword);
      session = { file: req.file, vault, dek };
      return { ok: true };
    }

    case 'UNLOCK_RECOVERY': {
      const { vault, dek } = await unlockWithRecoveryCode(req.file, req.recoveryCode);
      session = { file: req.file, vault, dek };
      return { ok: true };
    }

    case 'LOCK': {
      session = null;
      return { ok: true };
    }

    case 'LOCK_AND_REDIRECT': {
      // Verrouille et indique à la vault.html de passer en mode verrouillé
      session = null;
      return { ok: true, redirect: true };
    }

    case 'SESSION_CHECK': {
      // Utilisé par vault.html pour vérifier si la session est toujours active
      // (le SW peut se suspendre et perdre la session entre les navigations)
      return { unlocked: !!session };
    }

    case 'GET_STATUS': {
      return { unlocked: !!session, hasVault: !!session?.file };
    }

    case 'GET_CREDENTIALS': {
      if (!session) return { status: 'locked', entries: [] };
      const matched = (session.vault.items ?? [])
        .filter(item => domainMatches(item.url, req.url) && item.item_type === 'password');
      if (matched.length === 0) return { status: 'not_found', entries: [] };
      // Favoris d'abord, puis ordre alphabétique
      const sorted = [...matched].sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        return (a.title ?? '').localeCompare(b.title ?? '');
      });
      const entries = sorted.map(item => ({
        id:            item.id,
        label:         item.title || item.url,
        username:      item.username,
        password:      item.password,
        url:           item.url,
        favorite:      item.favorite ?? false,
        custom_fields: item.custom_fields ?? [],
      }));
      return { status: 'ok', entries };
    }

    // Marquer une entrée comme utilisée (met à jour last_used_at)
    case 'MARK_ITEM_USED': {
      if (!session || !req.itemId) return { ok: false };
      const item = (session.vault.items ?? []).find(i => i.id === req.itemId);
      if (item) {
        item.last_used_at = new Date().toISOString();
        await saveVault(session.file, session.vault, session.dek);
      }
      return { ok: true };
    }

    // Calcule et retourne un code TOTP depuis le background (utile pour le popup)
    case 'GET_TOTP_CODE': {
      if (!session || !req.itemId) return { code: null };
      const item = (session.vault.items ?? []).find(i => i.id === req.itemId);
      const totpField = (item?.custom_fields ?? []).find(f => f.field_type === 'totp' && f.value);
      if (!totpField) return { code: null };
      // Le background ne peut pas utiliser Web Crypto directement pour TOTP ;
      // le calcul est fait dans le popup/content via computeTotp() — on renvoie
      // le secret brut pour que le demandeur calcule.
      return { secret: totpField.value };
    }

    case 'GET_ALL_ITEMS': {
      if (!session) return { error: 'Coffre verrouillé.' };
      return { items: session.vault.items ?? [], categories: session.vault.categories ?? ['Général'] };
    }

    // Normalisation des tags côté background — identique à normalize_tags() dans lib.rs :
    // trim, suppression des vides, dédoublonnage, ordre préservé.
    case 'NORMALIZE_TAGS': {
      const seen = new Set();
      const normalized = (req.tags ?? [])
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
      return { tags: normalized };
    }

    case 'SAVE_ITEMS': {
      if (!session) return { ok: false, error: 'Coffre verrouillé.' };
      session.vault.items      = req.items;
      session.vault.categories = req.categories;
      await saveVault(session.file, session.vault, session.dek);
      return { ok: true, fileJson: JSON.stringify(session.file, null, 2) };
    }

    // ADD_ITEM — miroir de add_item() dans src-tauri/src/lib.rs
    case 'ADD_ITEM': {
      if (!session) return { ok: false, error: 'Coffre verrouillé.' };
      const draft = req.item;
      const seenTags = new Set();
      const normalizedTags = (draft.tags ?? [])
        .map(t => t.trim()).filter(t => t)
        .filter(t => { if (seenTags.has(t)) return false; seenTags.add(t); return true; });

      // S'assurer que la catégorie existe dans categories
      if (draft.category && !session.vault.categories.includes(draft.category)) {
        session.vault.categories.push(draft.category);
      }

      const newItem = {
        id:               draft.id ?? crypto.randomUUID(),
        item_type:        draft.item_type ?? 'password',
        title:            draft.title ?? '',
        username:         draft.username ?? '',
        password:         draft.password ?? '',
        url:              draft.url ?? '',
        notes:            draft.notes ?? '',
        category:         draft.category ?? 'Général',
        tags:             normalizedTags,
        favorite:         draft.favorite ?? false,
        expires_at:       draft.expires_at ?? '',
        custom_fields:    draft.custom_fields ?? [],
        attachments:      draft.attachments ?? [],
        password_history: [],
        last_used_at:     null,
        passkey:          draft.passkey ?? null,
        generation_rule:  draft.generation_rule ?? null,
        created_at:       new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      };
      session.vault.items.push(newItem);
      await saveVault(session.file, session.vault, session.dek);
      return { ok: true, fileJson: JSON.stringify(session.file, null, 2), item: newItem };
    }
    // la gestion de password_history se fait ici (côté background/serveur),
    // PAS côté frontend, pour garantir la cohérence même en cas d'échec.
    case 'UPDATE_ITEM': {
      if (!session) return { ok: false, error: 'Coffre verrouillé.' };
      const incoming = req.item;
      const MAX_PW_HISTORY = 20;
      const existing = session.vault.items.find(i => i.id === incoming.id);
      if (!existing) return { ok: false, error: 'Entrée introuvable.' };

      // Gestion password_history : Rust compare AVANT de modifier
      if (
        (existing.item_type ?? 'password') === 'password' &&
        existing.password &&
        existing.password !== incoming.password
      ) {
        existing.password_history = existing.password_history ?? [];
        existing.password_history.push({ password: existing.password, changed_at: new Date().toISOString() });
        if (existing.password_history.length > MAX_PW_HISTORY) {
          existing.password_history.shift(); // enlève le plus ancien
        }
      }

      // Normalisation des tags (identique à normalize_tags Rust)
      const seenTags = new Set();
      const normalizedTags = (incoming.tags ?? [])
        .map(t => t.trim()).filter(t => t)
        .filter(t => { if (seenTags.has(t)) return false; seenTags.add(t); return true; });

      // Mise à jour des champs — même liste que existing.xxx = item.xxx dans Rust
      existing.item_type      = incoming.item_type;
      existing.title          = incoming.title;
      existing.username       = incoming.username;
      existing.password       = incoming.password;
      existing.url            = incoming.url;
      existing.notes          = incoming.notes;
      existing.category       = incoming.category;
      existing.tags           = normalizedTags;
      existing.favorite       = incoming.favorite;
      existing.expires_at     = incoming.expires_at;
      existing.custom_fields  = incoming.custom_fields;
      existing.attachments    = incoming.attachments;
      existing.passkey        = incoming.passkey ?? null;
      existing.generation_rule = incoming.generation_rule ?? null;
      existing.updated_at     = new Date().toISOString();
      // NE PAS toucher à created_at ni last_used_at (géré par MARK_ITEM_USED)

      await saveVault(session.file, session.vault, session.dek);
      return { ok: true, fileJson: JSON.stringify(session.file, null, 2) };
    }

    case 'CREATE_VAULT': {
      const { file, recoveryCode } = await createVault(req.masterPassword);
      session = { file, vault: { items: [], categories: ['Général'] }, dek: null };
      // On déverrouille immédiatement pour récupérer la DEK
      const unlocked = await unlockWithMasterPassword(file, req.masterPassword);
      session.dek = unlocked.dek;
      return { ok: true, fileJson: JSON.stringify(file, null, 2), recoveryCode };
    }

    case 'CHANGE_MASTER_PW': {
      if (!session) return { ok: false, error: 'Coffre verrouillé.' };
      await changeMasterPassword(session.file, session.dek, req.newPassword);
      return { ok: true, fileJson: JSON.stringify(session.file, null, 2) };
    }

    case 'GET_FILE_JSON': {
      if (!session) return { error: 'Coffre verrouillé.' };
      return { fileJson: JSON.stringify(session.file, null, 2) };
    }

    case 'FILL_SELECTED': {
      const tabId = req.tabId ?? sender.tab?.id;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'FILL_CREDENTIALS', entry: req.entry });
      }
      return { ok: true };
    }

    case 'GET_ACTIVE_TAB_URL': {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return { url: tabs[0]?.url ?? '' };
    }

    default:
      return { error: `Type de message inconnu : ${req.type}` };
  }
}
