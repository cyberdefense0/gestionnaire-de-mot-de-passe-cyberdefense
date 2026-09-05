/**
 * vault-page.js — Page de gestion complète du coffre, refonte v2.
 *
 * Nouveautés vs v1 :
 *  - Tags filtrables dans la sidebar et éditables dans le formulaire
 *  - Expiration par entrée (badge dans la liste + champ dans le formulaire)
 *  - Tri A→Z / Z→A / Récent / Favoris (select dans la topbar)
 *  - Historique des mots de passe avec diff visuel (longueur + types de caractères)
 *  - Score de sécurité global + résultats groupés par catégorie dans l'audit
 *  - Favicons Google dans la liste (même logique que l'app desktop)
 *  - Générateur de phrase de passe (EFF Diceware simplifié, 7776 mots)
 *  - Suppression avec undo (toast 5s avec bouton Annuler, comme l'app desktop)
 *  - Recherche dans tags et notes (en plus de titre/username/url)
 *  - Design thème app desktop (variables CSS cohérentes)
 */

import { parseVaultFile, newItemId } from './vault.js';

const msg = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

// ─── État ─────────────────────────────────────────────────────────────────────

let items             = [];
let categories        = ['Général'];
let editingId         = null;
let activeTab         = 'all';
let activeTagFilter   = null;
let sortMode          = 'favorites';
let pendingFile       = null;
let overlayUseRecovery = false;
let csvParsed         = [];
let totpInterval      = null;
let undoTimeout       = null;
let pendingDeleteId   = null;

let workingCustomFields = [];
let workingTags         = [];
let draftFieldIds       = new Set();
let totpLockedIds       = new Set();

const CUSTOM_FIELD_TYPES = [
  { value: 'text',     label: 'Texte' },
  { value: 'password', label: 'Mot de passe' },
  { value: 'email',    label: 'Email' },
  { value: 'url',      label: 'URL' },
  { value: 'totp',     label: 'Code 2FA (TOTP)' },
];

// ─── Utilitaires ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const esc = s => (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

let toastUndoCleanup = null;

function showToast(text, opts = {}) {
  $('toast-text').textContent = text;
  const undoBtn = $('toast-undo');
  undoBtn.style.display = opts.onUndo ? 'inline' : 'none';
  if (opts.onUndo) {
    if (toastUndoCleanup) toastUndoCleanup();
    const handler = () => { opts.onUndo(); hideToast(); };
    undoBtn.addEventListener('click', handler, { once: true });
    toastUndoCleanup = () => undoBtn.removeEventListener('click', handler);
  }
  $('toast').className = `show${opts.level === 'error' ? ' error' : ''}`;
  clearTimeout(undoTimeout);
  undoTimeout = setTimeout(() => { hideToast(); opts.onTimeout?.(); }, opts.duration ?? 2500);
}

function hideToast() {
  $('toast').className = '';
  clearTimeout(undoTimeout);
  if (toastUndoCleanup) { toastUndoCleanup(); toastUndoCleanup = null; }
}

function modal(id, show) { $(id).classList.toggle('hidden', !show); }

function getFaviconUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=24`;
  } catch { return null; }
}

function relativeDate(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)    return 'À l\'instant';
  if (s < 3600)  return `Il y a ${Math.floor(s/60)} min`;
  if (s < 86400) return `Il y a ${Math.floor(s/3600)} h`;
  if (s < 86400*30) return `Il y a ${Math.floor(s/86400)} j`;
  return new Date(iso).toLocaleDateString('fr-FR');
}

function daysUntil(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

// ─── Initialisation ───────────────────────────────────────────────────────────

async function init() {
  const hash = location.hash;
  const status = await msg('GET_STATUS');
  if (status.unlocked) {
    unlockPageContent();
    await loadItems();
    updateLockUI(true);
  } else {
    const stored = await chrome.storage.local.get('vaultFile');
    if (stored.vaultFile) {
      pendingFile = JSON.parse(stored.vaultFile);
      showOverlayUnlock();
    } else {
      modal('modal-new-vault', true);
    }
  }
  if (hash === '#add') setTimeout(() => openForm(null), 300);
}

async function loadItems() {
  const res = await msg('GET_ALL_ITEMS');
  if (res.error) return;
  items      = res.items ?? [];
  categories = res.categories ?? ['Général'];
  renderActiveTab();
  updateCounts();
  renderSidebarTags();
}

// ─── Lock UI ──────────────────────────────────────────────────────────────────

function updateLockUI(unlocked) {
  $('lock-dot').classList.toggle('ok', unlocked);
  $('lock-label').textContent = unlocked ? `Déverrouillé (${items.length})` : 'Verrouillé';
  ['btn-import','btn-new-vault','btn-export'].forEach(id => {
    const b = $(id); if (b) { b.disabled = !unlocked; }
  });
}

$('btn-lock').addEventListener('click', async () => {
  await msg('LOCK');
  updateLockUI(false); items = [];
  renderActiveTab(); lockPageContent();
  const stored = await chrome.storage.local.get('vaultFile');
  if (stored.vaultFile) { pendingFile = JSON.parse(stored.vaultFile); showOverlayUnlock(); }
  else modal('modal-new-vault', true);
});

// ─── Overlay déverrouillage ───────────────────────────────────────────────────

function showOverlayUnlock(recovery = false) {
  overlayUseRecovery = recovery;
  $('overlay-unlock-desc').textContent = recovery ? 'Entrez votre kit de récupération.' : 'Entrez votre master password pour continuer.';
  $('overlay-pw').type = recovery ? 'text' : 'password';
  $('overlay-pw').placeholder = recovery ? 'XXXX-XXXX-XXXX-XXXX-XXXX' : 'Master password';
  $('overlay-recovery-btn').textContent = recovery ? '← Master password' : 'Utiliser le kit de récupération →';
  $('overlay-error').textContent = '';
  $('overlay-pw').value = '';
  modal('overlay-unlock', true);
  setTimeout(() => $('overlay-pw').focus(), 50);
}

$('overlay-recovery-btn').addEventListener('click', () => showOverlayUnlock(!overlayUseRecovery));
$('overlay-unlock-btn').addEventListener('click', doOverlayUnlock);
$('overlay-pw').addEventListener('keydown', e => {
  if (e.key === 'Enter') doOverlayUnlock();
  $('overlay-pw').style.borderColor = '';
  $('overlay-error').textContent = '';
});

async function doOverlayUnlock() {
  const value = $('overlay-pw').value.trim();
  if (!value) return;
  $('overlay-error').textContent = '';
  $('overlay-unlock-btn').textContent = 'Déchiffrement…';
  $('overlay-unlock-btn').disabled = true;
  try {
    const type  = overlayUseRecovery ? 'UNLOCK_RECOVERY' : 'UNLOCK';
    const field = overlayUseRecovery ? { recoveryCode: value } : { masterPassword: value };
    const res   = await msg(type, { file: pendingFile, ...field });
    if (!res.ok) throw new Error(res.error ?? 'Mot de passe incorrect.');
    modal('overlay-unlock', false);
    unlockPageContent(); updateLockUI(true); await loadItems();
  } catch (e) {
    $('overlay-pw').style.borderColor = 'var(--red)';
    $('overlay-error').textContent = e.message;
  } finally {
    $('overlay-unlock-btn').textContent = 'Déverrouiller';
    $('overlay-unlock-btn').disabled = false;
  }
}

// ─── Nouveau vault ────────────────────────────────────────────────────────────

$('new-pw1').addEventListener('input', () => {
  const s = strengthScore($('new-pw1').value);
  $('new-strength-fill').style.width = `${s.pct}%`;
  $('new-strength-fill').style.background = s.color;
  $('new-strength-label').textContent = s.label;
  $('new-strength-label').style.color = s.color;
});
$('btn-cancel-new').addEventListener('click', () => modal('modal-new-vault', false));
$('btn-confirm-new').addEventListener('click', async () => {
  const pw1 = $('new-pw1').value, pw2 = $('new-pw2').value;
  $('new-vault-error').textContent = '';
  if (pw1.length < 10) { $('new-vault-error').textContent = 'Master password trop court (min. 10 caractères).'; return; }
  if (pw1 !== pw2)    { $('new-vault-error').textContent = 'Les mots de passe ne correspondent pas.'; return; }
  $('btn-confirm-new').textContent = 'Création…'; $('btn-confirm-new').disabled = true;
  try {
    const res = await msg('CREATE_VAULT', { masterPassword: pw1 });
    if (!res.ok) throw new Error(res.error);
    await chrome.storage.local.set({ vaultFile: res.fileJson });
    modal('modal-new-vault', false);
    $('recovery-code-display').textContent = res.recoveryCode;
    modal('modal-recovery', true);
    updateLockUI(true); await loadItems();
  } catch (e) { $('new-vault-error').textContent = e.message; }
  finally { $('btn-confirm-new').textContent = 'Créer →'; $('btn-confirm-new').disabled = false; }
});

$('btn-copy-recovery').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('recovery-code-display').textContent);
  showToast('Kit de récupération copié !');
});
$('btn-close-recovery').addEventListener('click', () => modal('modal-recovery', false));

// ─── Import .vault ────────────────────────────────────────────────────────────

$('btn-import').addEventListener('click', () => modal('modal-import', true));
$('btn-cancel-import').addEventListener('click', () => modal('modal-import', false));
$('btn-confirm-import').addEventListener('click', async () => {
  const file = $('import-file-input').files[0];
  if (!file) return;
  $('import-error').textContent = '';
  try {
    const vaultFile = parseVaultFile(await file.text());
    await chrome.storage.local.set({ vaultFile: JSON.stringify(vaultFile) });
    pendingFile = vaultFile;
    modal('modal-import', false);
    showOverlayUnlock();
  } catch (e) { $('import-error').textContent = `Fichier invalide : ${e.message}`; }
});

// Bouton paramètres → importer vault
$('settings-import-vault').addEventListener('click', () => modal('modal-import', true));

// ─── Export ───────────────────────────────────────────────────────────────────

async function exportVault() {
  const { fileJson } = await msg('GET_FILE_JSON');
  if (!fileJson) { showToast('Coffre verrouillé.', { level: 'error' }); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([fileJson], { type: 'application/json' }));
  a.download = 'coffre.vault'; a.click();
  URL.revokeObjectURL(a.href);
}
$('btn-export').addEventListener('click', exportVault);
$('settings-export').addEventListener('click', exportVault);

// ─── Changement master password ───────────────────────────────────────────────

$('change-pw1').addEventListener('input', () => {
  const s = strengthScore($('change-pw1').value);
  $('change-strength-fill').style.width = `${s.pct}%`;
  $('change-strength-fill').style.background = s.color;
});
$('settings-change-pw').addEventListener('click', () => modal('modal-change-pw', true));
$('btn-cancel-change-pw').addEventListener('click', () => modal('modal-change-pw', false));
$('btn-confirm-change-pw').addEventListener('click', async () => {
  const pw1 = $('change-pw1').value, pw2 = $('change-pw2').value;
  $('change-pw-error').textContent = '';
  if (pw1.length < 10) { $('change-pw-error').textContent = 'Mot de passe trop court (min. 10 car.).'; return; }
  if (pw1 !== pw2)     { $('change-pw-error').textContent = 'Les mots de passe ne correspondent pas.'; return; }
  const res = await msg('CHANGE_MASTER_PW', { newPassword: pw1 });
  if (!res.ok) { $('change-pw-error').textContent = res.error; return; }
  await chrome.storage.local.set({ vaultFile: res.fileJson });
  modal('modal-change-pw', false);
  showToast('Master password mis à jour !');
});

// ─── Effacer ─────────────────────────────────────────────────────────────────

$('settings-clear').addEventListener('click', async () => {
  if (!confirm('Supprimer toutes les données locales (coffre et .vault) ? Cette action est irréversible.')) return;
  await msg('LOCK'); await chrome.storage.local.clear();
  items = []; categories = ['Général']; pendingFile = null;
  renderActiveTab(); updateCounts(); updateLockUI(false);
  modal('modal-new-vault', true);
});

// ─── Navigation sidebar ───────────────────────────────────────────────────────

document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    activeTagFilter = null;
    closeDetail();
    renderActiveTab();
  });
});

function renderSidebarTags() {
  const wrap = $('sidebar-tags');
  const allTags = [...new Set(items.flatMap(i => i.tags ?? []))].sort();
  wrap.innerHTML = '';
  allTags.forEach(tag => {
    const btn = document.createElement('button');
    btn.className = `tag-nav-item${activeTagFilter === tag ? ' active' : ''}`;
    btn.textContent = `# ${tag}`;
    btn.addEventListener('click', () => {
      activeTagFilter = activeTagFilter === tag ? null : tag;
      document.querySelectorAll('.tag-nav-item').forEach(b => b.classList.remove('active'));
      if (activeTagFilter) btn.classList.add('active');
      renderActiveTab();
    });
    wrap.appendChild(btn);
  });
}

function renderActiveTab() {
  document.querySelectorAll('.tab-content').forEach(t => {
    t.classList.remove('visible');
    t.style.display = '';
  });
  const tab = $(`tab-${activeTab === 'all' || activeTab === 'favorites' || activeTab === 'passwords' || activeTab === 'notes' || activeTab === 'expiring' ? 'list' : activeTab}`);
  if (tab) { tab.classList.add('visible'); tab.style.display = 'flex'; }

  let its = items;
  if (activeTagFilter) its = its.filter(i => (i.tags ?? []).includes(activeTagFilter));
  switch (activeTab) {
    case 'favorites':  its = its.filter(i => i.favorite); break;
    case 'passwords':  its = its.filter(i => (i.item_type ?? 'password') === 'password'); break;
    case 'notes':      its = its.filter(i => i.item_type === 'note'); break;
    case 'expiring':   its = its.filter(i => { const d = daysUntil(i.expires_at); return d !== null && d <= 30; }); break;
    case 'audit':      return;
    case 'generator':  initGenerator(); return;
    case 'import-csv': return;
    case 'settings':   return;
  }
  renderItemList(sortItems(filterSearch(its)));
}

function filterSearch(its) {
  const q = ($('search')?.value ?? '').toLowerCase().trim();
  if (!q) return its;
  return its.filter(i =>
    i.title?.toLowerCase().includes(q) ||
    i.username?.toLowerCase().includes(q) ||
    i.url?.toLowerCase().includes(q) ||
    i.notes?.toLowerCase().includes(q) ||
    (i.tags ?? []).some(t => t.toLowerCase().includes(q))
  );
}

function sortItems(its) {
  const mode = $('sort-select')?.value ?? sortMode;
  return [...its].sort((a, b) => {
    if (mode === 'name')      return (a.title ?? '').localeCompare(b.title ?? '');
    if (mode === 'name-desc') return (b.title ?? '').localeCompare(a.title ?? '');
    if (mode === 'recent')    return new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime();
    // favorites : favoris d'abord, puis alpha
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return (a.title ?? '').localeCompare(b.title ?? '');
  });
}

$('sort-select')?.addEventListener('change', () => renderActiveTab());
$('search')?.addEventListener('input', () => renderActiveTab());
$('btn-add')?.addEventListener('click', () => openForm(null));

// ─── Counts et expiring ───────────────────────────────────────────────────────

function updateCounts() {
  $('count-all').textContent  = items.length;
  $('count-fav').textContent  = items.filter(i => i.favorite).length;
  const expiring = items.filter(i => { const d = daysUntil(i.expires_at); return d !== null && d <= 30; });
  const cntEl = $('count-expiring');
  if (expiring.length > 0) { cntEl.textContent = expiring.length; cntEl.style.display = ''; }
  else cntEl.style.display = 'none';
  updateLockUI(true);
  renderSidebarTags();
}

// ─── Rendu de la liste ────────────────────────────────────────────────────────

function renderItemList(its) {
  const list = $('item-list');
  if (its.length === 0) {
    list.innerHTML = '<div class="empty-list">Aucune entrée.<br>Cliquez sur <strong>＋ Ajouter</strong> pour commencer.</div>';
    return;
  }
  list.innerHTML = '';
  for (const item of its) {
    if (item.id === pendingDeleteId) continue; // undo pending
    const row = document.createElement('div');
    row.className = `item-row${editingId === item.id ? ' selected' : ''}`;
    row.dataset.id = item.id;

    // Avatar avec favicon
    const avatar = document.createElement('div');
    avatar.className = 'item-avatar';
    const faviconUrl = item.item_type !== 'note' ? getFaviconUrl(item.url) : null;
    if (faviconUrl) {
      const img = document.createElement('img');
      img.src = faviconUrl;
      img.onerror = () => { img.remove(); avatar.textContent = (item.title ?? '?').slice(0,2).toUpperCase(); };
      avatar.appendChild(img);
    } else {
      avatar.textContent = item.item_type === 'note' ? '📝' : (item.title ?? '?').slice(0,2).toUpperCase();
    }

    // Corps
    const body = document.createElement('div');
    body.className = 'item-body';
    const titleRow = document.createElement('div');
    titleRow.className = 'item-title';
    titleRow.innerHTML = esc(item.title || item.url || '(sans titre)');
    if (item.item_type === 'note')    titleRow.innerHTML += ' <span class="item-badge">note</span>';
    if (item.item_type === 'passkey') titleRow.innerHTML += ' <span class="item-badge">passkey</span>';

    // Badge expiration
    const d = daysUntil(item.expires_at);
    if (d !== null && d <= 30) {
      const cls = d < 0 ? 'danger' : d <= 7 ? 'warn' : 'ok';
      const label = d < 0 ? 'Expiré' : d === 0 ? 'Auj.' : `${d}j`;
      titleRow.innerHTML += ` <span class="item-expiry ${cls}">${label}</span>`;
    }

    const sub = document.createElement('div');
    sub.className = 'item-sub';
    sub.textContent = item.username || (item.item_type === 'note' ? 'Note sécurisée' : '');

    body.appendChild(titleRow);
    body.appendChild(sub);

    if (item.favorite) {
      const fav = document.createElement('div');
      fav.className = 'fav-star'; fav.textContent = '⭐';
      row.appendChild(avatar); row.appendChild(body); row.appendChild(fav);
    } else {
      row.appendChild(avatar); row.appendChild(body);
    }

    row.addEventListener('click', () => openForm(item.id));
    list.appendChild(row);
  }
}

// ─── Formulaire de détail ─────────────────────────────────────────────────────

function openForm(id) {
  editingId = id;
  const item = id ? items.find(i => i.id === id) : null;
  $('detail-title').textContent = item ? 'Modifier l\'entrée' : 'Nouvelle entrée';
  $('btn-delete-item').style.display = item ? 'block' : 'none';
  $('btn-save-item').disabled = false;
  $('detail-panel').classList.remove('hidden');
  document.querySelectorAll('.item-row').forEach(r => r.classList.toggle('selected', r.dataset.id === id));

  workingCustomFields = (item?.custom_fields ?? []).map(f => ({ ...f }));
  workingTags = [...(item?.tags ?? [])];
  draftFieldIds = new Set();
  totpLockedIds = new Set(workingCustomFields.filter(f => f.field_type === 'totp' && f.value.trim()).map(f => f.id));

  renderFormBody(item, item?.item_type ?? 'password');
  if (totpLockedIds.size > 0) startTotpTicker();
}

function renderFormBody(item, type) {
  const body = $('detail-body');
  const cats = categories.map(c => `<option value="${esc(c)}" ${(item?.category ?? 'Général') === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const expiresAt = item?.expires_at ?? '';
  const expiresEnabled = !!expiresAt;

  body.innerHTML = `
    <div class="form-group">
      <label>Type</label>
      <select id="f-type">
        <option value="password" ${type === 'password' ? 'selected' : ''}>Mot de passe</option>
        <option value="note"     ${type === 'note'     ? 'selected' : ''}>Note sécurisée</option>
      </select>
    </div>
    <div class="form-group">
      <label>Titre <span style="color:var(--red)">*</span></label>
      <input type="text" id="f-title" value="${esc(item?.title ?? '')}" placeholder="Ex: Gmail, Banque…" autocomplete="off">
    </div>
    ${type !== 'note' ? `
    <div class="form-group">
      <label>Identifiant / Email</label>
      <input type="text" id="f-username" value="${esc(item?.username ?? '')}" autocomplete="off" placeholder="ex: mon@email.com">
    </div>
    <div class="form-group">
      <label>Mot de passe</label>
      <div class="pw-wrap">
        <input type="password" id="f-password" value="${esc(item?.password ?? '')}" autocomplete="off">
        <div class="pw-actions">
          <button id="btn-toggle-pw" title="Afficher / Masquer">👁</button>
          <button id="btn-gen-pw"    title="Générer un mot de passe fort">⚡</button>
          <button id="btn-copy-pw"   title="Copier">📋</button>
        </div>
      </div>
      <div class="strength-bar"><div class="strength-fill" id="pw-strength-fill"></div></div>
      <div class="strength-label" id="pw-strength-label"></div>
    </div>
    <div class="form-group">
      <label>Adresse du site</label>
      <input type="url" id="f-url" value="${esc(item?.url ?? '')}" placeholder="https://example.com">
    </div>
    ` : ''}
    <div class="form-group">
      <label>${type === 'note' ? 'Contenu' : 'Notes'}</label>
      <textarea id="f-notes" rows="3">${esc(item?.notes ?? '')}</textarea>
    </div>
    <div class="form-group" id="custom-fields-section"></div>
    <div class="form-group">
      <label>Tags</label>
      <div class="tags-container" id="tags-container"></div>
    </div>
    <div class="form-group">
      <label>Album</label>
      <select id="f-category">${cats}</select>
    </div>
    <div class="form-group">
      <label>Date d'expiration</label>
      ${expiresEnabled ? `
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="date" id="f-expires" value="${esc(expiresAt)}" style="flex:1;">
        <button id="btn-clear-expiry" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;" title="Supprimer l'expiration">✕</button>
      </div>` : `
      <button id="btn-enable-expiry" style="background:none;border:1px solid var(--edge);border-radius:8px;color:var(--muted);cursor:pointer;padding:7px 10px;font-size:12px;text-align:left;width:100%;transition:border-color .12s,color .12s;" onmouseover="this.style.borderColor='var(--brand)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='';this.style.color=''">
        + Définir une date d'expiration
      </button>`}
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:2px 0;">
      <input type="checkbox" id="f-favorite" ${item?.favorite ? 'checked' : ''}> ⭐ Favori
    </label>
    ${item?.password_history?.length > 0 ? `
    <div class="form-group">
      <label>Historique des mots de passe</label>
      <div class="pw-history" id="pw-history-list"></div>
    </div>` : ''}`;

  // Listeners
  $('f-type')?.addEventListener('change', () => renderFormBody(item, $('f-type').value));
  $('f-password')?.addEventListener('input', updatePwStrength);
  updatePwStrength();

  $('btn-toggle-pw')?.addEventListener('click', () => {
    const inp = $('f-password');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  $('btn-gen-pw')?.addEventListener('click', () => {
    const pw = generatePassword(20);
    $('f-password').value = pw; $('f-password').type = 'text'; updatePwStrength();
  });
  $('btn-copy-pw')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText($('f-password')?.value ?? '');
    showToast('Mot de passe copié !');
  });

  // Tags
  renderTagsInput();

  // Expiration
  $('btn-enable-expiry')?.addEventListener('click', () => {
    // Pré-remplir +1 an
    const next = new Date(); next.setFullYear(next.getFullYear() + 1);
    const val = next.toISOString().slice(0,10);
    renderFormBody({ ...item, expires_at: val, item_type: type, tags: workingTags, custom_fields: workingCustomFields }, type);
  });
  $('btn-clear-expiry')?.addEventListener('click', () => {
    renderFormBody({ ...item, expires_at: '', item_type: type, tags: workingTags, custom_fields: workingCustomFields }, type);
  });

  // Historique des mots de passe avec diff visuel
  if (item?.password_history?.length > 0) {
    renderPasswordHistory(item.password_history, item.password ?? '');
  }

  refreshCustomFieldsSection();
}

// ─── Tags input ───────────────────────────────────────────────────────────────

function renderTagsInput() {
  const container = $('tags-container');
  if (!container) return;
  container.innerHTML = '';
  workingTags.forEach(tag => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.innerHTML = `${esc(tag)} <button class="tag-remove" title="Retirer le tag">×</button>`;
    pill.querySelector('.tag-remove').addEventListener('click', () => {
      workingTags = workingTags.filter(t => t !== tag);
      renderTagsInput();
    });
    container.appendChild(pill);
  });
  const input = document.createElement('input');
  input.className = 'tag-input';
  input.placeholder = workingTags.length === 0 ? 'Ajouter un tag…' : '';
  input.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      const tag = input.value.trim().toLowerCase().replace(/,/g, '');
      if (tag && !workingTags.includes(tag)) { workingTags.push(tag); renderTagsInput(); }
      else input.value = '';
    }
    if (e.key === 'Backspace' && !input.value && workingTags.length > 0) {
      workingTags.pop(); renderTagsInput();
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) {
      const tag = input.value.trim().toLowerCase();
      if (!workingTags.includes(tag)) { workingTags.push(tag); renderTagsInput(); }
    }
  });
  container.appendChild(input);
  container.addEventListener('click', () => input.focus());
}

// ─── Historique des mots de passe avec diff visuel ────────────────────────────

function analyzePassword(pwd) {
  return {
    length:    pwd.length,
    hasLower:  /[a-z]/.test(pwd),
    hasUpper:  /[A-Z]/.test(pwd),
    hasDigit:  /\d/.test(pwd),
    hasSymbol: /[^a-zA-Z0-9]/.test(pwd),
  };
}

function renderPasswordHistory(history, currentPassword) {
  const list = $('pw-history-list');
  if (!list) return;
  list.innerHTML = '';

  const renderEntry = (pwd, date, label, isCurrent) => {
    const info = analyzePassword(pwd);
    const entry = document.createElement('div');
    entry.className = `pw-history-entry${isCurrent ? ' current' : ''}`;
    let revealed = false;
    entry.innerHTML = `
      <div class="pw-history-meta">
        <span class="pw-history-label ${isCurrent ? 'current' : 'old'}">${esc(label)}</span>
        ${date ? `<span class="pw-history-date">${relativeDate(date)}</span>` : ''}
      </div>
      <div class="pw-history-value">
        <span class="pw-history-text masked" id="ph-text-${date ?? 'cur'}">••••••••••</span>
        <button style="background:none;border:1px solid var(--edge);border-radius:5px;color:var(--muted);cursor:pointer;padding:3px 7px;font-size:11px;" id="ph-toggle-${date ?? 'cur'}">Voir</button>
        <button style="background:none;border:1px solid var(--edge);border-radius:5px;color:var(--muted);cursor:pointer;padding:3px 7px;font-size:11px;" id="ph-copy-${date ?? 'cur'}">Copier</button>
      </div>
      <div class="pw-diff">
        <span class="diff-badge ${info.length >= 12 ? 'on' : 'off'}">${info.length} car.</span>
        <span class="diff-badge ${info.hasLower  ? 'on' : 'off'}">a-z</span>
        <span class="diff-badge ${info.hasUpper  ? 'on' : 'off'}">A-Z</span>
        <span class="diff-badge ${info.hasDigit  ? 'on' : 'off'}">0-9</span>
        <span class="diff-badge ${info.hasSymbol ? 'on' : 'off'}">!@#</span>
      </div>`;
    const textEl   = entry.querySelector(`#ph-text-${date ?? 'cur'}`);
    const toggleEl = entry.querySelector(`#ph-toggle-${date ?? 'cur'}`);
    const copyEl   = entry.querySelector(`#ph-copy-${date ?? 'cur'}`);
    toggleEl.addEventListener('click', () => {
      revealed = !revealed;
      textEl.textContent = revealed ? pwd : '••••••••••';
      textEl.className = `pw-history-text${revealed ? '' : ' masked'}`;
      toggleEl.textContent = revealed ? 'Masquer' : 'Voir';
    });
    copyEl.addEventListener('click', async () => {
      await navigator.clipboard.writeText(pwd);
      showToast('Mot de passe copié !');
    });
    list.appendChild(entry);
  };

  if (currentPassword) renderEntry(currentPassword, null, 'Actuel', true);
  [...history].reverse().forEach(h => renderEntry(h.password ?? '', h.changed_at, 'Ancien', false));
}

// ─── Champs personnalisés ─────────────────────────────────────────────────────
// (identique à v1, conservé intact)

function renderCustomFieldsSection() {
  return `
    <div class="cf-header">
      <span>Champs personnalisés</span>
      <button type="button" id="btn-add-cfield">+ Ajouter</button>
    </div>
    <div class="cf-list">${workingCustomFields.map(renderCustomFieldRow).join('')}</div>`;
}

function renderCustomFieldRow(field) {
  if (draftFieldIds.has(field.id)) {
    const opts = CUSTOM_FIELD_TYPES.map(t => `<option value="${t.value}" ${field.field_type === t.value ? 'selected' : ''}>${t.label}</option>`).join('');
    return `<div class="cf-item cf-item-draft" data-id="${field.id}">
      <select class="cf-type-select">${opts}</select>
      <input type="text" class="cf-label-input" placeholder="Nom du champ (ex : Code PIN)" value="${esc(field.label)}" autofocus>
      <div class="cf-draft-actions">
        <button type="button" class="cf-cancel-btn">Annuler</button>
        <button type="button" class="cf-confirm-btn" ${field.label.trim() ? '' : 'disabled'}>Valider</button>
      </div></div>`;
  }
  return `<div class="cf-item" data-id="${field.id}">
    <div class="cf-item-head"><span class="cf-name">${esc(field.label)||'(sans nom)'}</span><button type="button" class="cf-remove-btn">✕</button></div>
    ${renderCustomFieldValue(field)}</div>`;
}

function renderCustomFieldValue(field) {
  if (field.field_type === 'totp') {
    if (!totpLockedIds.has(field.id)) {
      return `<div class="cf-totp-entry"><input type="text" class="cf-totp-input" placeholder="Secret TOTP (base32 ou otpauth://)" value="${esc(field.value)}" autocomplete="off" spellcheck="false"><button type="button" class="cf-totp-confirm-btn" ${extractTotpSecret(field.value) ? '' : 'disabled'}>Valider</button></div>`;
    }
    return `<div class="cf-totp-live"><div class="cf-totp-code-wrap"><div class="cf-totp-code" data-secret="${esc(field.value)}">——————</div><div class="cf-totp-cd">—</div><button type="button" class="cf-totp-copy-btn">📋</button></div><p class="cf-totp-invalid" style="display:none;color:var(--red);font-size:12px;margin:0;">Secret invalide.</p></div>`;
  }
  if (field.field_type === 'password') {
    return `<div class="pw-wrap-cf"><div class="pw-wrap" style="flex:1"><input type="password" class="cf-value-input cf-secret-input" value="${esc(field.value)}" placeholder="Valeur" autocomplete="off"><div class="pw-actions"><button type="button" class="cf-reveal-btn">👁</button><button type="button" class="cf-copy-btn">📋</button></div></div></div>`;
  }
  const t = field.field_type === 'email' ? 'email' : field.field_type === 'url' ? 'url' : 'text';
  return `<input type="${t}" class="cf-value-input" value="${esc(field.value)}" placeholder="Valeur">`;
}

function refreshCustomFieldsSection() {
  const c = $('custom-fields-section');
  if (!c) return;
  c.innerHTML = renderCustomFieldsSection();
  attachCustomFieldsListeners();
}

function attachCustomFieldsListeners() {
  $('btn-add-cfield')?.addEventListener('click', () => {
    const id = newItemId();
    workingCustomFields.push({ id, label: '', value: '', field_type: 'text' });
    draftFieldIds.add(id);
    refreshCustomFieldsSection();
  });
  document.querySelectorAll('.cf-item').forEach(row => {
    const id = row.dataset.id;
    const field = workingCustomFields.find(f => f.id === id);
    if (!field) return;
    row.querySelector('.cf-type-select')?.addEventListener('change', e => { field.field_type = e.target.value; refreshCustomFieldsSection(); });
    row.querySelector('.cf-label-input')?.addEventListener('input', e => { field.label = e.target.value; const b = row.querySelector('.cf-confirm-btn'); if (b) b.disabled = !field.label.trim(); });
    row.querySelector('.cf-cancel-btn')?.addEventListener('click', () => { workingCustomFields = workingCustomFields.filter(f => f.id !== id); draftFieldIds.delete(id); refreshCustomFieldsSection(); });
    row.querySelector('.cf-confirm-btn')?.addEventListener('click', () => { if (!field.label.trim()) return; draftFieldIds.delete(id); refreshCustomFieldsSection(); });
    row.querySelector('.cf-remove-btn')?.addEventListener('click', () => { workingCustomFields = workingCustomFields.filter(f => f.id !== id); draftFieldIds.delete(id); totpLockedIds.delete(id); refreshCustomFieldsSection(); });
    row.querySelector('.cf-value-input:not(.cf-secret-input)')?.addEventListener('input', e => { field.value = e.target.value; });
    const si = row.querySelector('.cf-secret-input');
    si?.addEventListener('input', e => { field.value = e.target.value; });
    row.querySelector('.cf-reveal-btn')?.addEventListener('click', () => { if (si) si.type = si.type === 'password' ? 'text' : 'password'; });
    row.querySelector('.cf-copy-btn')?.addEventListener('click', async () => { if (field.value) { await navigator.clipboard.writeText(field.value); showToast('Copié !'); } });
    row.querySelector('.cf-totp-input')?.addEventListener('input', e => { field.value = e.target.value; const b = row.querySelector('.cf-totp-confirm-btn'); if (b) b.disabled = !extractTotpSecret(field.value); });
    row.querySelector('.cf-totp-confirm-btn')?.addEventListener('click', () => { const n = extractTotpSecret(field.value); if (!n) return; field.value = n; totpLockedIds.add(id); refreshCustomFieldsSection(); startTotpTicker(); });
    row.querySelector('.cf-totp-copy-btn')?.addEventListener('click', async () => { const el = row.querySelector('.cf-totp-code'); const c = el?.textContent?.trim(); if (c && c !== '——————') { await navigator.clipboard.writeText(c); showToast('Code copié !'); } });
  });
}

function startTotpTicker() {
  if (totpInterval) return;
  async function tick() {
    for (const el of document.querySelectorAll('.cf-totp-code[data-secret]')) {
      const live = el.closest('.cf-totp-live');
      const cdEl = live?.querySelector('.cf-totp-cd');
      const invalidEl = live?.querySelector('.cf-totp-invalid');
      try {
        const res = await computeTotp(el.dataset.secret);
        if (!res) { live?.querySelector('.cf-totp-code-wrap')?.style.setProperty('display','none'); if (invalidEl) invalidEl.style.display=''; continue; }
        live?.querySelector('.cf-totp-code-wrap')?.style.removeProperty('display'); if (invalidEl) invalidEl.style.display='none';
        el.textContent = res.code;
        if (cdEl) cdEl.textContent = `${res.remainingSeconds}s`;
      } catch { live?.querySelector('.cf-totp-code-wrap')?.style.setProperty('display','none'); if (invalidEl) invalidEl.style.display=''; }
    }
  }
  tick(); totpInterval = setInterval(tick, 1000);
}

// ─── Force du mot de passe ────────────────────────────────────────────────────

function updatePwStrength() {
  const fill = $('pw-strength-fill'); const labelEl = $('pw-strength-label');
  if (!fill) return;
  const s = strengthScore($('f-password')?.value ?? '');
  fill.style.width = `${s.pct}%`; fill.style.background = s.color;
  if (labelEl) { labelEl.textContent = s.label; labelEl.style.color = s.color; }
}

function strengthScore(pw) {
  if (!pw) return { pct: 0, color: 'var(--edge)', label: '' };
  let score = 0;
  if (pw.length >= 10) score += 20; if (pw.length >= 16) score += 15; if (pw.length >= 24) score += 15;
  if (/[A-Z]/.test(pw)) score += 10; if (/[a-z]/.test(pw)) score += 10;
  if (/[0-9]/.test(pw)) score += 10; if (/[^A-Za-z0-9]/.test(pw)) score += 20;
  const pct = Math.min(score, 100);
  if (pct < 35) return { pct, color: 'var(--red)',   label: '⚠ Trop simple' };
  if (pct < 60) return { pct, color: 'var(--amber)', label: '~ Correct, améliorable' };
  if (pct < 80) return { pct, color: 'var(--green)', label: '✓ Bon mot de passe' };
  return { pct, color: 'var(--green)', label: '✓✓ Excellent' };
}

// ─── Sauvegarde ───────────────────────────────────────────────────────────────

$('btn-save-item').addEventListener('click', saveItem);
$('btn-cancel-item').addEventListener('click', closeDetail);
$('btn-close-detail').addEventListener('click', closeDetail);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });

async function saveItem() {
  const type  = $('f-type')?.value ?? 'password';
  const title = $('f-title')?.value?.trim() ?? '';
  if (!title) { $('f-title')?.focus(); showToast('Donnez un titre à cette entrée.', { level: 'error' }); return; }

  const customFields = workingCustomFields.filter(f => !draftFieldIds.has(f.id) && (f.label.trim() || f.value.trim()));

  // Normalisation des tags via le background (identique à normalize_tags Rust)
  const tagsRes = await msg('NORMALIZE_TAGS', { tags: workingTags });
  const normalizedTags = tagsRes.tags ?? workingTags;

  $('btn-save-item').disabled = true;

  if (editingId) {
    // Édition : déléguer au background via UPDATE_ITEM
    // La gestion de password_history est faite côté background,
    // comme update_item() dans src-tauri/src/lib.rs — pas dans le frontend.
    const item = items.find(i => i.id === editingId);
    const updatedItem = {
      ...item, // préserve created_at, last_used_at, password_history, attachments
      item_type:      type,
      title,
      username:       $('f-username')?.value ?? '',
      password:       $('f-password')?.value ?? '',
      url:            $('f-url')?.value ?? '',
      notes:          $('f-notes')?.value ?? '',
      category:       $('f-category')?.value ?? 'Général',
      favorite:       $('f-favorite')?.checked ?? false,
      expires_at:     $('f-expires')?.value ?? '',
      custom_fields:  customFields,
      tags:           normalizedTags,
      // attachments préservés via le spread de item
    };
    const res = await msg('UPDATE_ITEM', { item: updatedItem });
    $('btn-save-item').disabled = false;
    if (!res.ok) { showToast(res.error ?? 'Erreur.', { level: 'error' }); return; }
    // Recharger les items depuis le background pour avoir l'état cohérent
    // (password_history mis à jour côté background)
    await loadItems();
    await chrome.storage.local.set({ vaultFile: res.fileJson });
  } else {
    // Création : ADD_ITEM (background gère la normalisation et les timestamps)
    const draft = {
      item_type: type, title,
      username:       $('f-username')?.value ?? '',
      password:       $('f-password')?.value ?? '',
      url:            $('f-url')?.value ?? '',
      notes:          $('f-notes')?.value ?? '',
      category:       $('f-category')?.value ?? 'Général',
      tags:           normalizedTags,
      favorite:       $('f-favorite')?.checked ?? false,
      expires_at:     $('f-expires')?.value ?? '',
      custom_fields:  customFields,
      attachments:    [],
      passkey:        null,
      generation_rule: null,
    };
    const res = await msg('ADD_ITEM', { item: draft });
    $('btn-save-item').disabled = false;
    if (!res.ok) { showToast(res.error ?? 'Erreur.', { level: 'error' }); return; }
    await chrome.storage.local.set({ vaultFile: res.fileJson });
    await loadItems(); // recharger pour avoir l'état cohérent avec le background
  }

  showToast(`« ${title} » enregistré.`);
  closeDetail(); renderActiveTab(); updateCounts();
}

// Suppression avec undo (5s)
$('btn-delete-item').addEventListener('click', async () => {
  if (!editingId) return;
  const id = editingId;
  const item = items.find(i => i.id === id);
  if (!item) return;
  pendingDeleteId = id;
  closeDetail(); renderActiveTab();
  showToast(`« ${item.title} » supprimé.`, {
    duration: 5000,
    onUndo: () => { pendingDeleteId = null; renderActiveTab(); },
    onTimeout: async () => {
      if (pendingDeleteId !== id) return; // annulé
      items = items.filter(i => i.id !== id);
      pendingDeleteId = null;
      const res = await msg('SAVE_ITEMS', { items, categories });
      if (res.ok) { await chrome.storage.local.set({ vaultFile: res.fileJson }); updateCounts(); }
    },
  });
});

function closeDetail() {
  $('detail-panel').classList.add('hidden');
  editingId = null;
  if (totpInterval) { clearInterval(totpInterval); totpInterval = null; }
  document.querySelectorAll('.item-row').forEach(r => r.classList.remove('selected'));
}

// ─── Audit de sécurité ────────────────────────────────────────────────────────

$('btn-run-audit').addEventListener('click', runAudit);

async function runAudit() {
  const results = $('audit-results');
  results.innerHTML = '<div style="padding:32px;display:flex;justify-content:center;"><div class="spinner"></div></div>';

  const issues = [];
  const pwMap  = new Map();
  let totalPw  = 0;

  for (const item of items) {
    if ((item.item_type ?? 'password') !== 'password' || !item.password) continue;
    totalPw++;
    const s = strengthScore(item.password);
    if (s.pct < 35) issues.push({ icon: '🔴', label: item.title || item.url, sub: 'Mot de passe trop simple', tag: 'red', category: item.category ?? 'Général' });
    else if (s.pct < 60) issues.push({ icon: '🟡', label: item.title || item.url, sub: 'Mot de passe moyen — peut être amélioré', tag: 'amber', category: item.category ?? 'Général' });
    const existing = pwMap.get(item.password);
    if (existing) issues.push({ icon: '🔄', label: item.title || item.url, sub: `Mot de passe identique à « ${existing} »`, tag: 'red', category: item.category ?? 'Général' });
    else pwMap.set(item.password, item.title || item.url);
    // Expiration
    const d = daysUntil(item.expires_at);
    if (d !== null && d < 0) issues.push({ icon: '📅', label: item.title || item.url, sub: 'Mot de passe expiré', tag: 'red', category: item.category ?? 'Général' });
    else if (d !== null && d <= 7) issues.push({ icon: '📅', label: item.title || item.url, sub: `Expire dans ${d} jour${d > 1 ? 's' : ''}`, tag: 'amber', category: item.category ?? 'Général' });
    // HIBP
    try {
      const breached = await checkHibp(item.password);
      if (breached > 0) issues.push({ icon: '💥', label: item.title || item.url, sub: `Compromis — trouvé ${breached.toLocaleString('fr-FR')} fois dans des fuites de données`, tag: 'red', category: item.category ?? 'Général' });
    } catch {}
  }

  // Score global
  const score = totalPw === 0 ? 100 : Math.max(0, Math.round(((totalPw - Math.min(issues.filter(i => i.tag === 'red').length, totalPw)) / totalPw) * 100));
  const scoreColor = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
  const scoreEmoji = score >= 80 ? '✓' : score >= 50 ? '~' : '⚠';

  if (issues.length === 0) {
    results.innerHTML = `
      <div class="audit-score-bar">
        <div class="audit-score-val" style="color:var(--green);">✓ 100%</div>
        <div style="flex:1"><div style="font-size:13px;font-weight:500;color:var(--green);">Aucun problème détecté</div><div style="font-size:12px;color:var(--muted);">${totalPw} mot${totalPw > 1 ? 's' : ''} de passe analysé${totalPw > 1 ? 's' : ''}</div></div>
      </div>`;
    return;
  }

  // Grouper par catégorie
  const byCat = new Map();
  issues.forEach(i => {
    if (!byCat.has(i.category)) byCat.set(i.category, []);
    byCat.get(i.category).push(i);
  });

  let html = `
    <div class="audit-score-bar">
      <div class="audit-score-val" style="color:${scoreColor};">${scoreEmoji} ${score}%</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500;">${issues.length} problème${issues.length > 1 ? 's' : ''} détecté${issues.length > 1 ? 's' : ''}</div>
        <div style="font-size:12px;color:var(--muted);">${totalPw} mot${totalPw > 1 ? 's' : ''} de passe analysé${totalPw > 1 ? 's' : ''}</div>
      </div>
    </div>`;

  for (const [cat, catIssues] of byCat) {
    html += `<div class="audit-category">${esc(cat)} (${catIssues.length})</div>`;
    html += catIssues.map(i => `
      <div class="audit-item">
        <div class="audit-icon">${i.icon}</div>
        <div>
          <div class="audit-label">${esc(i.label)} <span class="tag tag-${i.tag}">${i.tag === 'red' ? 'Critique' : 'Attention'}</span></div>
          <div class="audit-sub">${esc(i.sub)}</div>
        </div>
      </div>`).join('');
  }
  results.innerHTML = html;
}

async function checkHibp(password) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
  const res = await fetch(`https://api.pwnedpasswords.com/range/${hex.slice(0,5)}`);
  const match = (await res.text()).split('\n').find(l => l.startsWith(hex.slice(5)));
  return match ? parseInt(match.split(':')[1]) : 0;
}

// ─── Générateur ───────────────────────────────────────────────────────────────

let genMode = 'random';

function initGenerator() {
  // Anti-doublon
  if ($('btn-generate')._listenerAdded) return;
  $('btn-generate')._listenerAdded = true;

  $('gen-tab-random').addEventListener('click', () => {
    genMode = 'random';
    $('gen-options-random').style.display = 'flex';
    $('gen-options-passphrase').style.display = 'none';
    $('gen-tab-random').style.background = 'var(--brand)';
    $('gen-tab-random').style.color = 'var(--on-brand)';
    $('gen-tab-passphrase').style.background = '';
    $('gen-tab-passphrase').style.color = '';
  });
  $('gen-tab-passphrase').addEventListener('click', () => {
    genMode = 'passphrase';
    $('gen-options-random').style.display = 'none';
    $('gen-options-passphrase').style.display = 'flex';
    $('gen-tab-passphrase').style.background = 'var(--brand)';
    $('gen-tab-passphrase').style.color = 'var(--on-brand)';
    $('gen-tab-random').style.background = '';
    $('gen-tab-random').style.color = '';
  });

  $('gen-length').addEventListener('input', () => { $('gen-length-val').textContent = $('gen-length').value; });
  $('gen-words').addEventListener('input', () => { $('gen-words-val').textContent = $('gen-words').value; });

  $('btn-generate').addEventListener('click', () => {
    const result = genMode === 'passphrase' ? generatePassphrase() : generatePassword(parseInt($('gen-length').value));
    $('gen-result').textContent = result;
  });
  $('btn-copy-gen').addEventListener('click', async () => {
    const t = $('gen-result').textContent;
    if (t === '—') return;
    await navigator.clipboard.writeText(t);
    showToast('Mot de passe copié !');
  });

  // Générer au démarrage
  $('gen-result').textContent = generatePassword(20);
  $('gen-tab-random').style.background = 'var(--brand)';
  $('gen-tab-random').style.color = 'var(--on-brand)';
}

function generatePassword(len = 20) {
  const upper   = $('gen-upper')?.checked !== false ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '';
  const lower   = $('gen-lower')?.checked !== false ? 'abcdefghijklmnopqrstuvwxyz' : '';
  const digits  = $('gen-digits')?.checked !== false ? '0123456789' : '';
  const symbols = $('gen-symbols')?.checked !== false ? '!@#$%^&*()_+-=[]{}|;:,.<>?' : '';
  const exclude = $('gen-exclude')?.value ?? '';
  let pool = (upper + lower + digits + symbols).split('').filter(c => !exclude.includes(c)).join('');
  if (!pool) pool = 'abcdefghijklmnopqrstuvwxyz';
  const arr = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(arr).map(v => pool[v % pool.length]).join('');
}

// Liste de 100 mots courants en anglais (sous-ensemble EFF pour la démo ;
// l'app desktop charge la liste complète de 7776 mots depuis eff-diceware-passphrase)
const WORDS = ['apple','bridge','castle','dragon','eagle','forest','garden','harbor','island','jungle','kernel','lemon','marble','napkin','orange','palace','quarry','rabbit','silver','temple','umbra','velvet','walnut','xylem','yellow','zebra','anchor','butter','cherry','donkey','empire','falcon','gentle','hammer','infant','jasper','kitten','lantern','mango','nebula','onion','pepper','quartz','radish','salmon','turtle','urban','violet','wonder','xenon','yogurt','zipper','alpine','basket','candle','dolphin','emerald','fresco','goblin','helmet','igloo','jigsaw','koala','locket','mustard','noodle','oyster','pillow','quantum','rocket','sunset','tundra','uncle','vortex','walrus','xylophone','yarn','zeal','amber','bison','cobalt','dagger','ember','frenzy','gravel','haven','indigo','jewel','kneel','lavender','mortar','nimble','osprey','parrot','quill','riddle','sphinx','throne','ultra','vapor','warden','xenial','yonder','zealot'];

function generatePassphrase() {
  const n   = parseInt($('gen-words')?.value ?? '5');
  const sep = $('gen-sep')?.value ?? '-';
  const cap = $('gen-capitalize')?.checked ?? false;
  const num = $('gen-number')?.checked ?? false;
  const arr = crypto.getRandomValues(new Uint32Array(n));
  let words = Array.from(arr).map(v => WORDS[v % WORDS.length]);
  if (cap) words = words.map(w => w[0].toUpperCase() + w.slice(1));
  let result = words.join(sep);
  if (num) {
    const d = crypto.getRandomValues(new Uint8Array(1))[0] % 100;
    result += sep + d;
  }
  return result;
}

// ─── Import CSV ───────────────────────────────────────────────────────────────

$('csv-file').addEventListener('change', async () => {
  const file = $('csv-file').files[0]; if (!file) return;
  $('csv-error').textContent = '';
  try {
    csvParsed = parseCSV(await file.text());
    const preview = $('csv-preview');
    preview.style.display = '';
    preview.textContent = `${csvParsed.length} entrée(s) détectée(s) — cliquez sur Importer pour les ajouter.`;
    $('btn-import-csv').style.display = csvParsed.length ? '' : 'none';
    $('btn-cancel-csv-import').style.display = '';
  } catch (e) { $('csv-error').textContent = e.message; }
});

$('btn-cancel-csv-import').addEventListener('click', () => {
  csvParsed = []; $('csv-file').value = '';
  $('csv-preview').style.display = 'none';
  $('btn-import-csv').style.display = 'none';
  $('btn-cancel-csv-import').style.display = 'none';
});

$('btn-import-csv').addEventListener('click', async () => {
  if (!csvParsed.length) return;
  $('btn-import-csv').disabled = true;
  $('btn-import-csv').textContent = 'Import…';
  let imported = 0;
  for (const row of csvParsed) {
    const draft = {
      item_type: 'password',
      title:    row.title || row.name || row.url || '(sans titre)',
      username: row.username || row.login || row.email || '',
      password: row.password || '',
      url:      row.url || row.website || row.login_uri || '',
      notes:    row.notes || row.extra || '',
      category: 'Général', tags: [], favorite: false, expires_at: '',
      custom_fields: [], attachments: [], passkey: null, generation_rule: null,
    };
    const res = await msg('ADD_ITEM', { item: draft });
    if (res.ok) { imported++; await chrome.storage.local.set({ vaultFile: res.fileJson }); }
  }
  $('btn-import-csv').disabled = false;
  $('btn-import-csv').textContent = 'Importer';
  showToast(`${imported} entrée${imported > 1 ? 's' : ''} importée${imported > 1 ? 's' : ''} !`);
  csvParsed = []; $('csv-file').value = '';
  $('csv-preview').style.display = 'none';
  $('btn-import-csv').style.display = 'none';
  $('btn-cancel-csv-import').style.display = 'none';
  await loadItems(); updateCounts(); renderActiveTab();
});

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('CSV vide ou sans en-têtes.');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g,''));
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitCsvLine(line);
    const obj = {};
    headers.forEach((h,i) => { obj[h] = (vals[i] ?? '').trim().replace(/^"|"$/g,''); });
    return obj;
  });
}

function splitCsvLine(line) {
  const result = []; let cur = '', inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; } else if (c === ',' && !inQ) { result.push(cur); cur = ''; } else cur += c;
  }
  result.push(cur); return result;
}

// ─── TOTP ─────────────────────────────────────────────────────────────────────

function extractTotpSecret(input) {
  const t = (input ?? '').trim();
  if (t.startsWith('otpauth://')) {
    try { return new URL(t).searchParams.get('secret') ?? t; } catch { return t; }
  }
  return t;
}

function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g,'');
  let bits = 0, acc = 0; const out = [];
  for (const c of s) { const v = A.indexOf(c); if (v < 0) continue; acc = (acc << 5) | v; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  return new Uint8Array(out);
}

async function computeTotp(secretBase32, period = 30, digits = 6) {
  const secret = extractTotpSecret(secretBase32);
  if (!secret) return null;
  const keyBytes = base32Decode(secret);
  if (!keyBytes.length) return null;
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / period);
  const remainingSeconds = period - (epoch % period);
  const cv = new DataView(new ArrayBuffer(8)); cv.setUint32(4, counter, false);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, cv.buffer));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset+1] << 16) | (hmac[offset+2] << 8) | hmac[offset+3];
  return { code: (binary % 10**digits).toString().padStart(digits,'0'), remainingSeconds };
}

// ─── Verrouillage page ────────────────────────────────────────────────────────

function lockPageContent() {
  const layout = document.querySelector('.layout');
  if (layout) layout.style.visibility = 'hidden';
  $('locked-banner')?.classList.add('visible');
  ['btn-import','btn-new-vault','btn-export'].forEach(id => { const b=$(id); if(b){b.disabled=true;} });
}
function unlockPageContent() {
  const layout = document.querySelector('.layout');
  if (layout) layout.style.visibility = 'visible';
  $('locked-banner')?.classList.remove('visible');
  ['btn-import','btn-new-vault','btn-export'].forEach(id => { const b=$(id); if(b){b.disabled=false;} });
}

// Watchdog session (si le service worker expire)
async function startSessionWatchdog() {
  setInterval(async () => {
    try {
      const status = await msg('GET_STATUS');
      if (!status.unlocked && items.length > 0) {
        updateLockUI(false); items = []; renderActiveTab(); lockPageContent();
        const stored = await chrome.storage.local.get('vaultFile');
        if (stored.vaultFile) { pendingFile = JSON.parse(stored.vaultFile); showOverlayUnlock(); }
      }
    } catch {}
  }, 15000);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

$('btn-new-vault').addEventListener('click', () => modal('modal-new-vault', true));
init();
startSessionWatchdog();
