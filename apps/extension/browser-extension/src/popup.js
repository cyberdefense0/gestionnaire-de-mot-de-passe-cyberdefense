/**
 * popup.js — Logique du popup Coffre, refonte v2.
 *
 * Nouveautés vs v1 :
 *  - Déverrouillage par PIN (compatible avec le PIN de l'app desktop via
 *    localStorage partagé — même origin si l'app expose une page web locale,
 *    sinon gestion autonome dans chrome.storage.local).
 *  - TOTP en temps réel dans la liste (code + barre de progression 30s).
 *  - Favoris épinglés en tête de liste (section séparée).
 *  - Score de sécurité rapide (% d'entrées sans problème évident).
 *  - Favicons via Google favicon service (même logique que l'app desktop).
 *  - Bouton "Ouvrir l'app" dans le header (deep-link via custom protocol).
 *  - Filtre par URL active plus précis (hostname sans www.).
 *  - Toast intégré (utilise #toast du HTML au lieu de créer des divs).
 *  - Entrées filtrées aussi par notes et tags.
 */

import { parseVaultFile } from './vault.js';

const msg = (type, payload = {}) =>
  chrome.runtime.sendMessage({ type, ...payload });

// ─── Éléments DOM ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const panels = {
  loading: $('panel-loading'),
  setup:   $('panel-setup'),
  unlock:  $('panel-unlock'),
  pin:     $('panel-pin'),
  list:    $('panel-list'),
};

const statusDot   = $('status-dot');
const lockBtn     = $('lock-btn');
const openAppBtn  = $('open-app-btn');

// Setup
const btnImport  = $('btn-import-file');
const fileInput  = $('file-input');
const btnNewPage = $('btn-open-vault-page');
const setupError = $('setup-error');

// Unlock
const masterPwInput = $('master-pw');
const unlockError   = $('unlock-error');
const btnUnlock     = $('btn-unlock');
const btnRecovery   = $('btn-use-recovery');
const btnUsePin     = $('btn-use-pin');
const unlockDesc    = $('unlock-desc');

// PIN
const pinDots   = Array.from($('pin-dots').children);
const pinError  = $('pin-error');
const pinKeys   = Array.from(document.querySelectorAll('.pin-key[data-digit]'));
const pinErase  = $('pin-erase');
const btnPinToMp = $('btn-pin-to-mp');

// List
const search       = $('search');
const entryCount   = $('entry-count');
const entries      = $('entries');
const securityBar  = $('security-bar');
const securityScore = $('security-score');
const securityLabel = $('security-label');
const btnManage    = $('btn-manage');
const btnAdd       = $('btn-add');
const btnSave      = $('btn-save');

// Toast
const toastEl = $('toast');

// ─── État local ───────────────────────────────────────────────────────────────

let allItems      = [];
let allCategories = [];
let pendingFile   = null;
let useRecovery   = false;
let activeTabUrl  = '';
let totpIntervals = []; // setInterval handles pour les badges TOTP

// ─── PIN storage (chrome.storage.local, cohérent avec l'app desktop) ─────────

const PIN_HASH_KEY = 'coffre:pin:hash';
const PIN_SALT_KEY = 'coffre:pin:salt';
const PIN_FAIL_KEY = 'coffre:pin:fails';
const PIN_MP_KEY   = 'coffre:pin:mp';   // MP chiffré en session (sessionStorage)
const PIN_MAX_FAILS = 5;

let pinDigits = [];

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function isPinEnabled() {
  const s = await chrome.storage.local.get([PIN_HASH_KEY, PIN_SALT_KEY]);
  return !!(s[PIN_HASH_KEY] && s[PIN_SALT_KEY]);
}

async function getStoredMp() {
  // Dans l'extension, on utilise chrome.storage.session (Chrome 102+)
  // si disponible, sinon chrome.storage.local avec TTL (on efface au lock).
  if (chrome.storage.session) {
    const s = await chrome.storage.session.get(PIN_MP_KEY);
    return s[PIN_MP_KEY] ?? null;
  }
  const s = await chrome.storage.local.get(PIN_MP_KEY);
  return s[PIN_MP_KEY] ?? null;
}

async function storeSessionMp(mp) {
  if (chrome.storage.session) {
    await chrome.storage.session.set({ [PIN_MP_KEY]: mp });
  } else {
    await chrome.storage.local.set({ [PIN_MP_KEY]: mp });
  }
}

async function clearSessionMp() {
  if (chrome.storage.session) {
    await chrome.storage.session.remove(PIN_MP_KEY);
  } else {
    await chrome.storage.local.remove(PIN_MP_KEY);
  }
}

async function checkPin(pin) {
  const s = await chrome.storage.local.get([PIN_HASH_KEY, PIN_SALT_KEY, PIN_FAIL_KEY]);
  const fails = s[PIN_FAIL_KEY] ?? 0;
  if (fails >= PIN_MAX_FAILS) return 'blocked';
  if (!s[PIN_HASH_KEY]) return 'blocked';
  const hash = await sha256hex(s[PIN_SALT_KEY] + pin);
  if (hash === s[PIN_HASH_KEY]) {
    await chrome.storage.local.set({ [PIN_FAIL_KEY]: 0 });
    return 'ok';
  }
  const newFails = fails + 1;
  await chrome.storage.local.set({ [PIN_FAIL_KEY]: newFails });
  if (newFails >= PIN_MAX_FAILS) {
    await chrome.storage.local.remove([PIN_HASH_KEY, PIN_SALT_KEY, PIN_FAIL_KEY]);
    return 'blocked';
  }
  return 'wrong';
}

// ─── Navigation entre panels ──────────────────────────────────────────────────

function showPanel(name) {
  for (const [k, el] of Object.entries(panels)) {
    el.classList.toggle('active', k === name);
  }
  if (name === 'pin') {
    pinDigits = [];
    updatePinDots();
    pinError.textContent = '';
  }
}

// ─── Initialisation ───────────────────────────────────────────────────────────

async function init() {
  showPanel('loading');
  try {
    const { url } = await msg('GET_ACTIVE_TAB_URL');
    activeTabUrl = url;

    const status = await msg('GET_STATUS');
    if (status.unlocked) {
      await loadAndShowList();
      return;
    }

    const stored = await chrome.storage.local.get('vaultFile');
    if (stored.vaultFile) {
      pendingFile = JSON.parse(stored.vaultFile);
      // Vérifier si PIN disponible
      const pinOn = await isPinEnabled();
      const mp    = pinOn ? await getStoredMp() : null;
      if (pinOn && mp) {
        showPanel('pin');
      } else {
        btnUsePin.style.display = pinOn ? 'block' : 'none';
        showUnlock();
      }
    } else {
      showPanel('setup');
    }
  } catch (e) {
    console.error(e);
    showPanel('setup');
  }
}

// ─── Panel unlock (master password / recovery) ────────────────────────────────

function showUnlock(recovery = false) {
  useRecovery = recovery;
  unlockError.textContent = '';
  masterPwInput.value = '';
  masterPwInput.classList.remove('error');
  unlockDesc.textContent = recovery
    ? 'Entrez votre kit de récupération (format XXXX-XXXX-…).'
    : 'Entrez votre master password pour accéder au coffre.';
  masterPwInput.placeholder = recovery ? 'XXXX-XXXX-XXXX-XXXX-XXXX' : '••••••••';
  masterPwInput.type = recovery ? 'text' : 'password';
  btnRecovery.textContent = recovery
    ? '← Utiliser le master password'
    : 'Master password oublié ? Utiliser le kit de récupération →';
  showPanel('unlock');
  setTimeout(() => masterPwInput.focus(), 50);
}

btnUnlock.addEventListener('click', doUnlock);
masterPwInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doUnlock();
  masterPwInput.classList.remove('error');
  unlockError.textContent = '';
});

async function doUnlock() {
  const value = masterPwInput.value.trim();
  if (!value) return;
  unlockError.textContent = '';
  btnUnlock.disabled = true;
  btnUnlock.textContent = 'Déchiffrement…';
  try {
    const type  = useRecovery ? 'UNLOCK_RECOVERY' : 'UNLOCK';
    const field = useRecovery ? { recoveryCode: value } : { masterPassword: value };
    const result = await msg(type, { file: pendingFile, ...field });
    if (!result.ok) throw new Error(result.error ?? 'Mot de passe incorrect.');
    // Stocker le MP pour le PIN si PIN activé
    if (!useRecovery) await storeSessionMp(value);
    await loadAndShowList();
  } catch (e) {
    masterPwInput.classList.add('error');
    unlockError.textContent = e.message;
  } finally {
    btnUnlock.disabled = false;
    btnUnlock.textContent = 'Déverrouiller';
  }
}

btnRecovery.addEventListener('click', () => showUnlock(!useRecovery));
btnUsePin.addEventListener('click', () => showPanel('pin'));

// ─── Panel PIN ────────────────────────────────────────────────────────────────

function updatePinDots() {
  pinDots.forEach((dot, i) => dot.classList.toggle('filled', i < pinDigits.length));
}

pinKeys.forEach(btn => {
  btn.addEventListener('click', () => pushPinDigit(btn.dataset.digit));
});
pinErase.addEventListener('click', () => {
  pinDigits = pinDigits.slice(0, -1);
  updatePinDots();
  pinError.textContent = '';
});
btnPinToMp.addEventListener('click', () => showUnlock(false));

// Clavier physique
document.addEventListener('keydown', (e) => {
  if (!panels.pin.classList.contains('active')) return;
  if (e.key >= '0' && e.key <= '9') pushPinDigit(e.key);
  if (e.key === 'Backspace') { pinDigits = pinDigits.slice(0, -1); updatePinDots(); }
});

async function pushPinDigit(digit) {
  if (pinDigits.length >= 6) return;
  pinDigits.push(digit);
  updatePinDots();
  pinError.textContent = '';
  // Auto-submit à 4 chiffres minimum si l'utilisateur appuie sur Entrée,
  // ou immédiatement à 6 chiffres.
  if (pinDigits.length === 6) await submitPin();
}

async function submitPin() {
  const pin = pinDigits.join('');
  if (pin.length < 4) return;
  pinError.textContent = 'Vérification…';

  const result = await checkPin(pin);
  if (result === 'ok') {
    const mp = await getStoredMp();
    if (!mp) {
      pinError.textContent = 'Session expirée. Ressaisissez votre master password.';
      pinDigits = []; updatePinDots();
      setTimeout(() => showUnlock(false), 1500);
      return;
    }
    // Déverrouiller avec le MP stocké
    btnUnlock.disabled = true;
    try {
      const res = await msg('UNLOCK', { file: pendingFile, masterPassword: mp });
      if (!res.ok) throw new Error(res.error);
      await loadAndShowList();
    } catch (e) {
      pinError.textContent = 'Erreur de déverrouillage. Utilisez votre master password.';
      pinDigits = []; updatePinDots();
    } finally {
      btnUnlock.disabled = false;
    }
  } else if (result === 'blocked') {
    pinError.textContent = 'PIN bloqué après trop d\'essais. Utilisez votre master password.';
    await clearSessionMp();
    setTimeout(() => showUnlock(false), 2000);
  } else {
    const s = await chrome.storage.local.get(PIN_FAIL_KEY);
    const left = Math.max(0, PIN_MAX_FAILS - (s[PIN_FAIL_KEY] ?? 0));
    pinError.textContent = `PIN incorrect. ${left} essai${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''}.`;
    pinDigits = []; updatePinDots();
  }
}

// Entrée clavier pour valider le PIN à 4+ chiffres
document.addEventListener('keydown', async (e) => {
  if (!panels.pin.classList.contains('active')) return;
  if (e.key === 'Enter' && pinDigits.length >= 4) await submitPin();
});

// ─── Chargement et affichage de la liste ─────────────────────────────────────

async function loadAndShowList() {
  clearTotpIntervals();
  const { items, categories, error } = await msg('GET_ALL_ITEMS');
  if (error) { showPanel('setup'); return; }
  allItems      = items ?? [];
  allCategories = categories ?? ['Général'];

  statusDot.classList.add('ok');
  statusDot.title = `Coffre déverrouillé — ${allItems.length} entrée${allItems.length > 1 ? 's' : ''}`;
  lockBtn.style.display = 'block';

  // Bouton "Ouvrir l'app" — deep-link via custom protocol coffre://
  openAppBtn.style.display = 'block';

  // Score de sécurité rapide
  showSecurityScore(allItems);

  showPanel('list');

  // Pré-filtrer sur l'URL active
  if (activeTabUrl) {
    try {
      const hostname = new URL(activeTabUrl).hostname.replace(/^www\./, '');
      if (hostname && hostname !== 'newtab') {
        search.value = hostname;
        renderList(filterItems(hostname));
        return;
      }
    } catch {}
  }
  renderList(allItems);
}

// ─── Score de sécurité rapide ─────────────────────────────────────────────────

function showSecurityScore(items) {
  const pwItems = items.filter(i => i.item_type === 'password' && i.password);
  if (pwItems.length === 0) { securityBar.style.display = 'none'; return; }

  // Problèmes simples détectables sans zxcvbn : mot de passe court ou réutilisé
  const seenPasswords = new Map();
  let issues = 0;
  for (const it of pwItems) {
    if (it.password.length < 8) { issues++; continue; }
    const prev = seenPasswords.get(it.password);
    if (prev) { issues++; }
    else seenPasswords.set(it.password, it.id);
  }

  // Expirations dépassées
  const now = Date.now();
  for (const it of items) {
    if (it.expires_at && new Date(it.expires_at).getTime() < now) issues++;
  }

  const total   = pwItems.length;
  const score   = Math.max(0, Math.round(((total - Math.min(issues, total)) / total) * 100));
  const cls     = score >= 80 ? 'score-good' : score >= 50 ? 'score-medium' : 'score-bad';
  const emoji   = score >= 80 ? '✓' : score >= 50 ? '~' : '⚠';

  securityScore.className = cls;
  securityScore.textContent = `${emoji} ${score}%`;
  securityLabel.textContent = `Sécurité — ${issues > 0 ? `${issues} problème${issues > 1 ? 's' : ''} détecté${issues > 1 ? 's' : ''}` : 'Tout va bien'}`;
  securityBar.style.display = 'flex';
}

// ─── Filtre ───────────────────────────────────────────────────────────────────

function filterItems(q) {
  if (!q.trim()) return allItems;
  const lq = q.toLowerCase();
  return allItems.filter(it =>
    it.title?.toLowerCase().includes(lq)      ||
    it.username?.toLowerCase().includes(lq)   ||
    it.url?.toLowerCase().includes(lq)        ||
    it.notes?.toLowerCase().includes(lq)      ||
    (it.tags ?? []).some(t => t.toLowerCase().includes(lq))
  );
}

search.addEventListener('input', () => {
  const filtered = filterItems(search.value);
  entryCount.textContent = search.value ? `${filtered.length}/${allItems.length}` : '';
  renderList(filtered);
});

// ─── Rendu de la liste ────────────────────────────────────────────────────────

function clearTotpIntervals() {
  totpIntervals.forEach(clearInterval);
  totpIntervals = [];
}

function getFaviconUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
  } catch { return null; }
}

function initials(str) {
  return (str ?? '?').slice(0, 2).toUpperCase();
}

function escHtml(str) {
  return (str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Calcule le code TOTP RFC 6238 (période 30s, SHA-1, 6 chiffres) en pur Web Crypto. */
async function computeTotp(base32Secret) {
  try {
    // Décoder base32
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const s = base32Secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, val = 0;
    const bytes = [];
    for (const c of s) {
      val = (val << 5) | B32.indexOf(c);
      bits += 5;
      if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    const keyBytes = new Uint8Array(bytes);
    const counter = Math.floor(Date.now() / 1000 / 30);
    const counterBuf = new DataView(new ArrayBuffer(8));
    counterBuf.setUint32(4, counter, false);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf.buffer));
    const offset = sig[sig.length - 1] & 0xf;
    const code = (((sig[offset] & 0x7f) << 24) | (sig[offset+1] << 16) | (sig[offset+2] << 8) | sig[offset+3]) % 1_000_000;
    return { code: String(code).padStart(6, '0'), secsLeft: 30 - (Math.floor(Date.now() / 1000) % 30) };
  } catch { return null; }
}

function renderList(items) {
  clearTotpIntervals();
  entryCount.textContent = search.value ? `${items.length}/${allItems.length}` : '';

  if (items.length === 0) {
    entries.innerHTML = search.value
      ? `<div class="empty-msg">Aucun résultat pour « ${escHtml(search.value)} ».<br>Essayez un autre terme.</div>`
      : '<div class="empty-msg">Aucune entrée dans le coffre.<br>Ajoutez-en une via le bouton ＋ Ajouter.</div>';
    return;
  }

  entries.innerHTML = '';

  // Séparer favoris et le reste
  const favs    = items.filter(i => i.favorite);
  const nonFavs = items.filter(i => !i.favorite);

  if (favs.length > 0 && !search.value) {
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = '★ Favoris';
    entries.appendChild(label);
    favs.forEach(item => entries.appendChild(buildEntryRow(item)));

    if (nonFavs.length > 0) {
      const label2 = document.createElement('div');
      label2.className = 'section-label';
      label2.textContent = 'Toutes les entrées';
      entries.appendChild(label2);
    }
  }

  (favs.length > 0 && !search.value ? nonFavs : items).forEach(item => {
    entries.appendChild(buildEntryRow(item));
  });
}

function buildEntryRow(item) {
  const isNote    = item.item_type === 'note';
  const isPasskey = item.item_type === 'passkey';
  const totpField = (item.custom_fields ?? []).find(f => f.field_type === 'totp' && f.value);

  const row = document.createElement('div');
  row.className = 'entry';

  // Avatar (favicon ou initiales)
  const avatar = document.createElement('div');
  avatar.className = 'entry-avatar';
  const faviconUrl = getFaviconUrl(item.url);
  if (faviconUrl && !isNote) {
    const img = document.createElement('img');
    img.src = faviconUrl;
    img.onerror = () => { img.remove(); avatar.textContent = initials(item.title); };
    avatar.appendChild(img);
  } else {
    avatar.textContent = isNote ? '📝' : isPasskey ? '🪪' : initials(item.title);
  }

  // Corps
  const body = document.createElement('div');
  body.className = 'entry-body';

  const titleRow = document.createElement('div');
  titleRow.className = 'entry-title';
  titleRow.innerHTML = escHtml(item.title || item.url || '(sans titre)');
  if (item.favorite) {
    const fav = document.createElement('span');
    fav.className = 'entry-fav';
    fav.textContent = '⭐';
    titleRow.appendChild(fav);
  }
  // Badge expiration
  if (item.expires_at) {
    const d = Math.ceil((new Date(item.expires_at).getTime() - Date.now()) / 86400000);
    if (d <= 30) {
      const badge = document.createElement('span');
      badge.style.cssText = `font-size:10px;padding:1px 4px;border-radius:3px;margin-left:4px;${
        d < 0 ? 'color:var(--red)' : d <= 7 ? 'color:var(--amber)' : 'color:var(--muted)'
      }`;
      badge.textContent = d < 0 ? 'Expiré' : d === 0 ? 'Auj.' : `${d}j`;
      titleRow.appendChild(badge);
    }
  }

  const userRow = document.createElement('div');
  userRow.className = 'entry-user';
  userRow.textContent = item.username || (item.category !== 'Général' ? item.category : '');

  body.appendChild(titleRow);
  body.appendChild(userRow);

  // Badge TOTP live
  let totpBadge = null;
  if (totpField) {
    totpBadge = document.createElement('div');
    totpBadge.className = 'totp-badge';
    totpBadge.innerHTML = `<span class="totp-code">——————</span><div class="totp-bar"><div class="totp-bar-fill" style="width:100%"></div></div>`;

    const updateTotp = async () => {
      const res = await computeTotp(totpField.value);
      if (!res) return;
      const urgent = res.secsLeft <= 7;
      totpBadge.className = `totp-badge${urgent ? ' urgent' : ''}`;
      totpBadge.querySelector('.totp-code').textContent = res.code;
      totpBadge.querySelector('.totp-bar-fill').style.width = `${(res.secsLeft / 30) * 100}%`;
      totpBadge.title = `Code 2FA — expire dans ${res.secsLeft}s`;
    };
    updateTotp();
    const iv = setInterval(updateTotp, 1000);
    totpIntervals.push(iv);

    // Clic sur le badge → copier le code
    totpBadge.style.cursor = 'pointer';
    totpBadge.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await computeTotp(totpField.value);
      if (res) {
        await navigator.clipboard.writeText(res.code);
        showToast(`Code 2FA copié (expire dans ${res.secsLeft}s)`);
      }
    });
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  if (!isNote && !isPasskey) {
    const fillBtn = document.createElement('button');
    fillBtn.className = 'icon-btn';
    fillBtn.title = 'Remplir le formulaire (identifiant + mot de passe)';
    fillBtn.textContent = '⌨';
    fillBtn.addEventListener('click', (e) => { e.stopPropagation(); fillEntry(item); });
    actions.appendChild(fillBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn';
    copyBtn.title = 'Copier le mot de passe';
    copyBtn.textContent = '📋';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(item.password);
      // Notifier le background pour tracker last_used_at
      msg('MARK_ITEM_USED', { itemId: item.id }).catch(() => {});
      showToast('Mot de passe copié — effacé dans 20s');
      // Auto-effacement presse-papiers (best-effort dans l'extension)
      setTimeout(async () => {
        try {
          const current = await navigator.clipboard.readText();
          if (current === item.password) await navigator.clipboard.writeText('');
        } catch {}
      }, 20_000);
    });
    actions.appendChild(copyBtn);
  }

  if (isNote) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn';
    copyBtn.title = 'Copier le contenu';
    copyBtn.textContent = '📋';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(item.notes ?? '');
      showToast('Note copiée');
    });
    actions.appendChild(copyBtn);
  }

  row.appendChild(avatar);
  row.appendChild(body);
  if (totpBadge) row.appendChild(totpBadge);
  row.appendChild(actions);

  return row;
}

// ─── Fill (remplissage dans la page active) ───────────────────────────────────

async function fillEntry(entry) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (!tabId) return;
  await msg('FILL_SELECTED', { tabId, entry });
  msg('MARK_ITEM_USED', { itemId: entry.id }).catch(() => {});
  window.close();
}

// ─── Verrouillage ─────────────────────────────────────────────────────────────

lockBtn.addEventListener('click', async () => {
  clearTotpIntervals();
  await msg('LOCK');
  await clearSessionMp();
  statusDot.classList.remove('ok');
  statusDot.title = 'Coffre verrouillé';
  lockBtn.style.display = 'none';
  openAppBtn.style.display = 'none';
  securityBar.style.display = 'none';
  allItems = [];
  const stored = await chrome.storage.local.get('vaultFile');
  if (stored.vaultFile) {
    pendingFile = JSON.parse(stored.vaultFile);
    const pinOn = await isPinEnabled();
    const mp    = pinOn ? await getStoredMp() : null;
    if (pinOn && mp) showPanel('pin');
    else { btnUsePin.style.display = pinOn ? 'block' : 'none'; showUnlock(); }
  } else {
    showPanel('setup');
  }
});

// ─── Ouvrir l'app desktop ─────────────────────────────────────────────────────

openAppBtn.addEventListener('click', () => {
  // Custom protocol coffre:// enregistré par l'app desktop (Tauri)
  // Tente de l'ouvrir ; si l'app n'est pas installée, rien ne se passe.
  window.open('coffre://open', '_blank');
});

// ─── Import .vault ────────────────────────────────────────────────────────────

btnImport.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  setupError.textContent = '';
  try {
    const text       = await file.text();
    const vaultFile  = parseVaultFile(text);
    await chrome.storage.local.set({ vaultFile: JSON.stringify(vaultFile) });
    pendingFile = vaultFile;
    const pinOn = await isPinEnabled();
    btnUsePin.style.display = pinOn ? 'block' : 'none';
    showUnlock();
  } catch (e) {
    setupError.textContent = `Fichier invalide : ${e.message}`;
  }
  fileInput.value = '';
});

btnNewPage.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/vault.html') + '#new' });
  window.close();
});

// ─── Footer ───────────────────────────────────────────────────────────────────

btnManage.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/vault.html') });
  window.close();
});

btnAdd.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/vault.html') + '#add' });
  window.close();
});

btnSave.addEventListener('click', async () => {
  const { fileJson } = await msg('GET_FILE_JSON');
  if (!fileJson) return;
  const blob = new Blob([fileJson], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'coffre.vault'; a.click();
  URL.revokeObjectURL(url);
});

// ─── Toast (réutilise #toast du HTML) ─────────────────────────────────────────

let toastTimeout;
function showToast(text, level = 'ok') {
  clearTimeout(toastTimeout);
  toastEl.textContent = text;
  toastEl.className   = `show${level === 'error' ? ' error' : ''}`;
  toastTimeout = setTimeout(() => { toastEl.className = ''; }, 2500);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

init();
