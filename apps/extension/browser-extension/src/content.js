/**
 * Content script — Coffre v2.
 *
 * Améliorations vs v1 :
 *  - Picker inline avec favicon Google (même logique que l'app desktop).
 *  - Détection des champs TOTP (`autocomplete="one-time-code"`) et remplissage
 *    automatique du code 2FA depuis les custom_fields de l'entrée sélectionnée.
 *  - Support `<input type="email">` explicitement dans la priorité de détection.
 *  - Toast reprend le thème clair/sombre de la page (prefers-color-scheme).
 *  - Bouton 🔑 plus discret (outline, pas d'image externe si CSP bloque).
 *  - Pas de re-injection si le script a déjà tourné (guard global).
 */

if (window.__coffre_content_v2) {
  // Déjà injecté (rechargement à chaud en dev ou injection multiple)
} else {
  window.__coffre_content_v2 = true;
  initContentScript();
}

function initContentScript() {

const ATTR     = 'data-coffre-injected';
const ICON_URL = (() => { try { return chrome.runtime.getURL('icons/icon16.png'); } catch { return ''; } })();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isVisible(el) {
  const r = el.getBoundingClientRect();
  const s = window.getComputedStyle(el);
  return r.width > 0 && r.height > 0 &&
    s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}

function getFaviconUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=24`;
  } catch { return null; }
}

// ─── Détection des champs de connexion ───────────────────────────────────────

function findLoginFields() {
  const pwFields = Array.from(
    document.querySelectorAll('input[type="password"]:not([data-coffre-skip])')
  ).filter(isVisible);

  if (pwFields.length === 0) return null;
  const pwField = pwFields[0];

  const scope = pwField.form ?? document;
  const usernameField =
    scope.querySelector('input[type="email"]:not([data-coffre-skip])') ??
    scope.querySelector('input[autocomplete~="username"]:not([data-coffre-skip])') ??
    scope.querySelector('input[autocomplete~="email"]:not([data-coffre-skip])') ??
    scope.querySelector('input[type="text"]:not([data-coffre-skip])') ??
    null;

  // Champ TOTP (optionnel — présent sur certains formulaires unifiés)
  const totpField =
    scope.querySelector('input[autocomplete="one-time-code"]:not([data-coffre-skip])') ??
    scope.querySelector('input[name*="otp"]:not([data-coffre-skip])') ??
    scope.querySelector('input[name*="totp"]:not([data-coffre-skip])') ??
    scope.querySelector('input[name*="2fa"]:not([data-coffre-skip])') ??
    null;

  return { username: usernameField, password: pwField, totp: totpField };
}

// ─── Remplissage compatible React / Vue / Angular ────────────────────────────

function setNativeValue(input, value) {
  const proto = Object.getPrototypeOf(input);
  const descriptor =
    Object.getOwnPropertyDescriptor(proto, 'value') ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value);
  else input.value = value;
  ['keydown', 'keypress', 'input', 'keyup', 'change'].forEach((name) =>
    input.dispatchEvent(new Event(name, { bubbles: true, cancelable: true }))
  );
}

// ─── TOTP (RFC 6238 en pur Web Crypto) ───────────────────────────────────────

async function computeTotp(base32Secret) {
  try {
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const s = base32Secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, val = 0;
    const bytes = [];
    for (const c of s) {
      val = (val << 5) | B32.indexOf(c);
      bits += 5;
      if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    const counter = Math.floor(Date.now() / 1000 / 30);
    const cv = new DataView(new ArrayBuffer(8));
    cv.setUint32(4, counter, false);
    const key = await crypto.subtle.importKey(
      'raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sig    = new Uint8Array(await crypto.subtle.sign('HMAC', key, cv.buffer));
    const offset = sig[sig.length - 1] & 0xf;
    const code   = (((sig[offset] & 0x7f) << 24) | (sig[offset+1] << 16) | (sig[offset+2] << 8) | sig[offset+3]) % 1_000_000;
    return String(code).padStart(6, '0');
  } catch { return null; }
}

// ─── Picker inline ────────────────────────────────────────────────────────────

function removePicker() { document.getElementById('coffre-picker')?.remove(); }

function showEntryPicker(pickerEntries, anchorEl, callback) {
  removePicker();

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  const picker = document.createElement('div');
  picker.id = 'coffre-picker';
  picker.setAttribute('data-coffre-ui', '');

  Object.assign(picker.style, {
    position:      'absolute',
    zIndex:        '2147483647',
    background:    dark ? '#11161d' : '#ffffff',
    border:        `1px solid ${dark ? '#23282e' : '#cddef2'}`,
    borderRadius:  '10px',
    boxShadow:     '0 8px 24px rgba(0,0,0,.25)',
    minWidth:      '230px',
    maxWidth:      '320px',
    padding:       '5px 0',
    fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    fontSize:      '13px',
    color:         dark ? '#fbf7f0' : '#0f172a',
    pointerEvents: 'all',
    overflow:      'hidden',
  });

  // Header discret
  const header = document.createElement('div');
  Object.assign(header.style, {
    padding:      '5px 12px 4px',
    fontSize:     '10px',
    color:        dark ? '#948d85' : '#5a6c86',
    borderBottom: `1px solid ${dark ? '#23282e' : '#cddef2'}`,
    display:      'flex',
    alignItems:   'center',
    gap:          '5px',
  });
  if (ICON_URL) {
    const ico = document.createElement('img');
    ico.src = ICON_URL; ico.width = 12; ico.height = 12;
    header.appendChild(ico);
  }
  header.appendChild(document.createTextNode(`Coffre — ${pickerEntries.length} entrée${pickerEntries.length > 1 ? 's' : ''}`));
  picker.appendChild(header);

  pickerEntries.forEach((entry, idx) => {
    const row = document.createElement('button');
    Object.assign(row.style, {
      display:     'flex',
      alignItems:  'center',
      gap:         '10px',
      width:       '100%',
      background:  'none',
      border:      'none',
      cursor:      'pointer',
      padding:     '8px 12px',
      color:       dark ? '#fbf7f0' : '#0f172a',
      textAlign:   'left',
      outline:     'none',
    });
    row.onmouseenter  = () => { row.style.background = dark ? '#1a212b' : '#e0ecfa'; };
    row.onmouseleave  = () => { row.style.background = 'none'; };

    // Favicon
    const avatarWrap = document.createElement('div');
    Object.assign(avatarWrap.style, {
      width: '26px', height: '26px', flexShrink: '0',
      borderRadius: '6px',
      background: dark ? '#1a212b' : '#e0ecfa',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '11px', fontWeight: '700', color: dark ? '#c99a5b' : '#1d5ab0',
      overflow: 'hidden',
    });
    const faviconUrl = getFaviconUrl(entry.url);
    if (faviconUrl) {
      const img = document.createElement('img');
      img.src = faviconUrl; img.width = 16; img.height = 16;
      img.style.objectFit = 'contain';
      img.onerror = () => { img.remove(); avatarWrap.textContent = (entry.label || entry.username || '?').slice(0, 2).toUpperCase(); };
      avatarWrap.appendChild(img);
    } else {
      avatarWrap.textContent = (entry.label || entry.username || '?').slice(0, 2).toUpperCase();
    }

    const textWrap = document.createElement('div');
    textWrap.style.minWidth = '0';
    const label = document.createElement('div');
    label.textContent = entry.label || entry.username || '(sans titre)';
    label.style.cssText = 'font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const sub = document.createElement('div');
    sub.textContent = entry.username ?? '';
    sub.style.cssText = `font-size:11px;color:${dark ? '#948d85' : '#5a6c86'};margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
    textWrap.append(label, sub);

    // Badge favori
    if (entry.favorite) {
      const fav = document.createElement('span');
      fav.textContent = '⭐';
      fav.style.cssText = 'font-size:10px;margin-left:auto;flex-shrink:0';
      row.append(avatarWrap, textWrap, fav);
    } else {
      row.append(avatarWrap, textWrap);
    }

    row.addEventListener('click', () => { removePicker(); callback(entry); });
    picker.appendChild(row);
  });

  // Positionnement sous le champ ancre
  const rect = anchorEl.getBoundingClientRect();
  picker.style.left = `${rect.left + window.scrollX}px`;
  picker.style.top  = `${rect.bottom + window.scrollY + 4}px`;

  document.addEventListener('click', removePicker, { once: true, capture: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') removePicker(); }, { once: true });
  document.body.appendChild(picker);

  // Focus sur la première entrée (navigation clavier)
  const firstRow = picker.querySelector('button');
  firstRow?.focus();
}

// ─── Bouton 🔑 injecté dans le champ mot de passe ────────────────────────────

function injectButton(pwField) {
  if (pwField.getAttribute(ATTR)) return;
  pwField.setAttribute(ATTR, '1');

  const wrapper = pwField.parentElement;
  if (window.getComputedStyle(wrapper).position === 'static') {
    wrapper.style.position = 'relative';
  }

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  const btn = document.createElement('button');
  btn.setAttribute('data-coffre-ui', '');
  btn.type  = 'button';
  btn.title = 'Remplir depuis Coffre (⌨ identifiant + mot de passe)';
  Object.assign(btn.style, {
    position:       'absolute',
    right:          '6px',
    top:            '50%',
    transform:      'translateY(-50%)',
    zIndex:         '9999',
    background:     dark ? 'rgba(17,22,29,0.85)' : 'rgba(255,255,255,0.9)',
    border:         `1px solid ${dark ? '#334155' : '#cddef2'}`,
    borderRadius:   '5px',
    padding:        '2px 5px',
    cursor:         'pointer',
    display:        'flex',
    alignItems:     'center',
    gap:            '3px',
    color:          dark ? '#c99a5b' : '#1d5ab0',
    fontSize:       '12px',
    lineHeight:     '1',
    opacity:        '0.75',
    transition:     'opacity .15s, box-shadow .15s',
    backdropFilter: 'blur(4px)',
  });
  btn.onmouseenter = () => { btn.style.opacity = '1'; btn.style.boxShadow = '0 2px 6px rgba(0,0,0,.15)'; };
  btn.onmouseleave = () => { btn.style.opacity = '0.75'; btn.style.boxShadow = 'none'; };

  if (ICON_URL) {
    const img = document.createElement('img');
    img.src = ICON_URL; img.width = 14; img.height = 14; img.style.flexShrink = '0';
    btn.appendChild(img);
  }
  const label = document.createElement('span');
  label.textContent = 'Coffre';
  btn.appendChild(label);

  pwField.style.paddingRight = '62px'; // espace pour le bouton

  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fetchAndFill(pwField); });

  wrapper.appendChild(btn);
}

// ─── Requête credentials + remplissage ───────────────────────────────────────

async function fetchAndFill(pwField) {
  const url      = window.location.origin;
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'GET_CREDENTIALS', url });
  } catch {
    // Service worker inactif (MV3) ou extension déconnectée
    showToast('🔒 Coffre non disponible — ouvrez l\'extension pour le déverrouiller.', 'warn');
    return;
  }

  if (response.status === 'locked') {
    showToast('🔒 Coffre verrouillé — ouvrez l\'extension pour le déverrouiller.', 'warn');
    return;
  }
  if (response.status === 'not_found' || !response.entries?.length) {
    showToast('Aucune entrée enregistrée pour ce site.', 'info');
    return;
  }
  if (response.status === 'error') {
    showToast(response.error ?? 'Erreur inconnue.', 'error');
    return;
  }

  const pickerEntries = response.entries;

  const fill = async (entry) => {
    const fields = findLoginFields();
    if (fields?.username && entry.username) setNativeValue(fields.username, entry.username);
    if (fields?.password && entry.password) setNativeValue(fields.password, entry.password);
    // Remplissage TOTP automatique si le champ est présent et l'entrée a un TOTP
    if (fields?.totp) {
      const totpField = (entry.custom_fields ?? []).find(f => f.field_type === 'totp' && f.value);
      if (totpField) {
        const code = await computeTotp(totpField.value);
        if (code) { setNativeValue(fields.totp, code); showToast(`Code 2FA ${code} rempli automatiquement`); }
      }
    }
    chrome.runtime.sendMessage({ type: 'MARK_ITEM_USED', itemId: entry.id }).catch(() => {});
  };

  if (pickerEntries.length === 1) {
    await fill(pickerEntries[0]);
  } else {
    showEntryPicker(pickerEntries, pwField, fill);
  }
}

// ─── Toast discret adapté au thème de la page ─────────────────────────────────

function showToast(text, level = 'info') {
  document.querySelector('[data-coffre-toast]')?.remove();
  const dark    = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const colors  = { info: '#3b82f6', warn: '#f59e0b', error: '#ef4444', ok: '#16a34a' };
  const t       = document.createElement('div');
  t.setAttribute('data-coffre-ui', '');
  t.setAttribute('data-coffre-toast', '');
  Object.assign(t.style, {
    position:      'fixed',
    bottom:        '20px',
    right:         '20px',
    zIndex:        '2147483647',
    background:    dark ? '#11161d' : '#ffffff',
    color:         dark ? '#fbf7f0' : '#0f172a',
    borderLeft:    `4px solid ${colors[level] ?? colors.info}`,
    border:        `1px solid ${dark ? '#23282e' : '#cddef2'}`,
    borderLeftWidth: '4px',
    borderRadius:  '8px',
    padding:       '10px 14px',
    fontSize:      '12px',
    maxWidth:      '280px',
    boxShadow:     '0 4px 14px rgba(0,0,0,.2)',
    fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    transition:    'opacity .3s',
    opacity:       '1',
    lineHeight:    '1.5',
  });
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3500);
}

// ─── Écoute des messages du background ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'FILL_CREDENTIALS') return;
  const entry  = message.entry;
  const fields = findLoginFields();
  if (!fields) { sendResponse({ ok: false, error: 'Champs introuvables.' }); return; }
  if (entry.username && fields.username) setNativeValue(fields.username, entry.username);
  if (entry.password && fields.password) setNativeValue(fields.password, entry.password);
  // TOTP auto si champ présent
  if (fields.totp) {
    const totpField = (entry.custom_fields ?? []).find(f => f.field_type === 'totp' && f.value);
    if (totpField) {
      computeTotp(totpField.value).then(code => {
        if (code && fields.totp) setNativeValue(fields.totp, code);
      });
    }
  }
  sendResponse({ ok: true });
});

// ─── Initialisation + MutationObserver pour les SPA ──────────────────────────

function scan() {
  const fields = findLoginFields();
  if (fields?.password) injectButton(fields.password);
}

scan();

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });

} // fin initContentScript
