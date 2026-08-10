/**
 * vault-page.js — Logique de la page de gestion complète du coffre.
 */

import { parseVaultFile, serializeVaultFile, newItemId, isoNow } from './vault.js';

const msg = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

// ─── État ─────────────────────────────────────────────────────────────────────

let items      = [];
let categories = ['Général'];
let editingId  = null;    // null = nouvelle entrée
let activeTab  = 'all';
let pendingFile = null;
let overlayUseRecovery = false;
let csvParsed  = [];
let totpInterval = null;

// Champs personnalisés — même modèle que l'appli bureau (types, flux
// "draft" puis validation). État de travail de l'entrée en cours d'édition.
let workingCustomFields = [];
let draftFieldIds = new Set();   // champs pas encore validés (type+nom en cours de saisie)
let totpLockedIds = new Set();   // champs TOTP déjà "verrouillés" sur l'affichage du code live

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

function showToast(text, level = 'ok') {
  const t = $('toast');
  t.textContent = text;
  t.style.borderColor = level === 'error' ? '#f85149' : '#3fb950';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function modal(id, show) {
  $(id).classList.toggle('hidden', !show);
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
    // Charger le vault depuis storage pour le déverouillage
    const stored = await chrome.storage.local.get('vaultFile');
    if (stored.vaultFile) {
      pendingFile = JSON.parse(stored.vaultFile);
      showOverlayUnlock();
    } else if (hash === '#new') {
      modal('modal-new-vault', true);
    } else {
      modal('modal-new-vault', true);
    }
  }

  if (hash === '#add') {
    openForm(null);
  }
}

async function loadItems() {
  const res = await msg('GET_ALL_ITEMS');
  if (res.error) return;
  items      = res.items ?? [];
  categories = res.categories ?? ['Général'];
  renderActiveTab();
  updateCounts();
}

// ─── Lock UI ──────────────────────────────────────────────────────────────────

function updateLockUI(unlocked) {
  $('lock-dot').classList.toggle('ok', unlocked);
  $('lock-label').textContent = unlocked ? 'Déverrouillé' : 'Verrouillé';
}

$('btn-lock').addEventListener('click', async () => {
  await msg('LOCK');
  updateLockUI(false);
  items = [];
  renderActiveTab();
  lockPageContent();
  const stored = await chrome.storage.local.get('vaultFile');
  if (stored.vaultFile) {
    pendingFile = JSON.parse(stored.vaultFile);
    showOverlayUnlock();
  } else {
    modal('modal-new-vault', true);
  }
});

// ─── Overlay déverrouillage ───────────────────────────────────────────────────

function showOverlayUnlock(recovery = false) {
  overlayUseRecovery = recovery;
  $('overlay-unlock-desc').textContent = recovery
    ? 'Entrez votre kit de récupération.'
    : 'Entrez votre master password pour continuer.';
  $('overlay-pw').type = recovery ? 'text' : 'password';
  $('overlay-pw').placeholder = recovery ? 'XXXX-XXXX-XXXX-XXXX-XXXX' : 'Master password';
  $('overlay-recovery-btn').textContent = recovery ? 'Master password' : 'Kit de récupération';
  $('overlay-error').textContent = '';
  $('overlay-pw').value = '';
  modal('overlay-unlock', true);
  setTimeout(() => $('overlay-pw').focus(), 50);
}

$('overlay-recovery-btn').addEventListener('click', () => showOverlayUnlock(!overlayUseRecovery));
$('overlay-unlock-btn').addEventListener('click', doOverlayUnlock);
$('overlay-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doOverlayUnlock(); });

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
    unlockPageContent();
    updateLockUI(true);
    await loadItems();
  } catch (e) {
    $('overlay-error').textContent = e.message;
  } finally {
    $('overlay-unlock-btn').textContent = 'Déverrouiller';
    $('overlay-unlock-btn').disabled = false;
  }
}

// ─── Nouveau vault ────────────────────────────────────────────────────────────

$('new-pw1').addEventListener('input', updateNewStrength);
$('btn-cancel-new').addEventListener('click', () => modal('modal-new-vault', false));
$('btn-confirm-new').addEventListener('click', doCreateVault);

function updateNewStrength() {
  const pw = $('new-pw1').value;
  const s  = strengthScore(pw);
  const fill = $('new-strength-fill');
  fill.style.width = `${s.pct}%`;
  fill.style.background = s.color;
}

async function doCreateVault() {
  const pw1 = $('new-pw1').value;
  const pw2 = $('new-pw2').value;
  $('new-vault-error').textContent = '';
  if (pw1.length < 8) { $('new-vault-error').textContent = 'Master password trop court (min. 8 caractères).'; return; }
  if (pw1 !== pw2)    { $('new-vault-error').textContent = 'Les mots de passe ne correspondent pas.'; return; }
  $('btn-confirm-new').textContent = 'Création…';
  $('btn-confirm-new').disabled = true;
  try {
    const res = await msg('CREATE_VAULT', { masterPassword: pw1 });
    if (!res.ok) throw new Error(res.error);
    await chrome.storage.local.set({ vaultFile: res.fileJson });
    modal('modal-new-vault', false);
    // Afficher le kit de récupération
    $('recovery-code-display').textContent = res.recoveryCode;
    modal('modal-recovery', true);
    updateLockUI(true);
    await loadItems();
  } catch (e) {
    $('new-vault-error').textContent = e.message;
  } finally {
    $('btn-confirm-new').textContent = 'Créer';
    $('btn-confirm-new').disabled = false;
  }
}

$('btn-copy-recovery').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('recovery-code-display').textContent);
  showToast('Kit copié !');
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
    const text = await file.text();
    const vaultFile = parseVaultFile(text);
    await chrome.storage.local.set({ vaultFile: JSON.stringify(vaultFile) });
    pendingFile = vaultFile;
    modal('modal-import', false);
    showOverlayUnlock();
  } catch (e) {
    $('import-error').textContent = `Fichier invalide : ${e.message}`;
  }
});

// ─── Export ───────────────────────────────────────────────────────────────────

async function exportVault() {
  const { fileJson } = await msg('GET_FILE_JSON');
  if (!fileJson) { showToast('Coffre verrouillé.', 'error'); return; }
  const blob = new Blob([fileJson], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'coffre.vault'; a.click();
  URL.revokeObjectURL(url);
}
$('btn-export').addEventListener('click', exportVault);
$('settings-export').addEventListener('click', exportVault);

// ─── Changement de master password ───────────────────────────────────────────

$('settings-change-pw').addEventListener('click', () => modal('modal-change-pw', true));
$('btn-cancel-change-pw').addEventListener('click', () => modal('modal-change-pw', false));
$('btn-confirm-change-pw').addEventListener('click', async () => {
  const pw1 = $('change-pw1').value;
  const pw2 = $('change-pw2').value;
  $('change-pw-error').textContent = '';
  if (pw1.length < 8) { $('change-pw-error').textContent = 'Mot de passe trop court.'; return; }
  if (pw1 !== pw2)    { $('change-pw-error').textContent = 'Les mots de passe ne correspondent pas.'; return; }
  const res = await msg('CHANGE_MASTER_PW', { newPassword: pw1 });
  if (!res.ok) { $('change-pw-error').textContent = res.error; return; }
  await chrome.storage.local.set({ vaultFile: res.fileJson });
  modal('modal-change-pw', false);
  showToast('Master password mis à jour !');
});

// ─── Effacer ─────────────────────────────────────────────────────────────────

$('settings-clear').addEventListener('click', async () => {
  if (!confirm('Supprimer toutes les données locales ? Cette action est irréversible.')) return;
  await msg('LOCK');
  await chrome.storage.local.clear();
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
    document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
    closeDetail();
    renderActiveTab();
  });
});

function renderActiveTab() {
  switch (activeTab) {
    case 'all':        showTabList(items); break;
    case 'favorites':  showTabList(items.filter(i => i.favorite)); break;
    case 'passwords':  showTabList(items.filter(i => (i.item_type ?? 'password') === 'password')); break;
    case 'notes':      showTabList(items.filter(i => i.item_type === 'note')); break;
    case 'audit':      $('tab-audit').style.display = ''; break;
    case 'generator':  $('tab-generator').style.display = ''; break;
    case 'import-csv': $('tab-import-csv').style.display = ''; break;
    case 'settings':   $('tab-settings').style.display = ''; break;
  }
}

function showTabList(its) {
  $('tab-list').style.display = '';
  renderItemList(its);
}

// ─── Rendu de la liste d'items ────────────────────────────────────────────────

function updateCounts() {
  $('count-all').textContent = items.length;
  $('count-fav').textContent = items.filter(i => i.favorite).length;
}

function renderItemList(its) {
  const list = $('item-list');
  if (its.length === 0) {
    list.innerHTML = '<div class="empty-list">Aucune entrée.<br>Cliquez sur <strong>＋ Ajouter</strong> pour commencer.</div>';
    return;
  }
  list.innerHTML = '';
  for (const item of its) {
    const row = document.createElement('div');
    row.className = 'item-row' + (editingId === item.id ? ' selected' : '');
    row.dataset.id = item.id;
    const av = (item.title || item.username || '?').slice(0,2).toUpperCase();
    const type = item.item_type ?? 'password';
    const badge = type === 'note' ? '<span class="item-badge">note</span>'
                : type === 'passkey' ? '<span class="item-badge">passkey</span>' : '';
    row.innerHTML = `
      <div class="item-avatar">${esc(av)}</div>
      <div class="item-body">
        <div class="item-title">${esc(item.title || item.url || '(sans titre)')} ${badge}</div>
        <div class="item-sub">${esc(item.username || (type === 'note' ? 'Note sécurisée' : ''))}</div>
      </div>
      ${item.favorite ? '<div class="fav-star">⭐</div>' : ''}`;
    row.addEventListener('click', () => openForm(item.id));
    list.appendChild(row);
  }
}

$('search').addEventListener('input', () => {
  const q = $('search').value.toLowerCase();
  const filtered = items.filter(i =>
    i.title?.toLowerCase().includes(q) ||
    i.username?.toLowerCase().includes(q) ||
    i.url?.toLowerCase().includes(q) ||
    i.notes?.toLowerCase().includes(q)
  );
  renderItemList(filtered);
});

$('btn-add').addEventListener('click', () => openForm(null));

// ─── Formulaire de détail ─────────────────────────────────────────────────────

function openForm(id) {
  editingId = id;
  const item = id ? items.find(i => i.id === id) : null;
  $('detail-title').textContent = item ? 'Modifier l\'entrée' : 'Nouvelle entrée';
  $('btn-delete-item').style.display = item ? 'block' : 'none';
  $('detail-panel').classList.remove('hidden');

  // Mettre à jour la sélection dans la liste
  document.querySelectorAll('.item-row').forEach(r => r.classList.toggle('selected', r.dataset.id === id));

  // Ré-initialiser l'état de travail des champs personnalisés pour cette entrée.
  workingCustomFields = (item?.custom_fields ?? []).map(f => ({ ...f }));
  draftFieldIds = new Set();
  // Un champ TOTP qui a déjà un secret démarre verrouillé (code live affiché
  // directement) — identique à l'appli bureau.
  totpLockedIds = new Set(workingCustomFields.filter(f => f.field_type === 'totp' && f.value.trim()).map(f => f.id));

  const type = item?.item_type ?? 'password';
  renderFormBody(item, type);
  startTotpTicker();
}

// ─── Champs personnalisés (identique à l'appli bureau) ───────────────────────
// Types : texte / mot de passe / email / url / TOTP. Flux en deux temps pour
// un nouveau champ : d'abord choisir le type + le nom ("draft"), puis valider
// pour passer à la saisie de la valeur — comme dans VaultItemForm.tsx.

function renderCustomFieldsSection() {
  const rows = workingCustomFields.map(renderCustomFieldRow).join('');
  return `
    <div class="cf-header">
      <span>Champs personnalisés</span>
      <button type="button" id="btn-add-cfield">+ Ajouter</button>
    </div>
    <div class="cf-list">${rows}</div>`;
}

function renderCustomFieldRow(field) {
  if (draftFieldIds.has(field.id)) {
    const options = CUSTOM_FIELD_TYPES.map(t =>
      `<option value="${t.value}" ${field.field_type === t.value ? 'selected' : ''}>${t.label}</option>`
    ).join('');
    return `
      <div class="cf-item cf-item-draft" data-id="${field.id}">
        <select class="cf-type-select">${options}</select>
        <input type="text" class="cf-label-input" placeholder="Nom du champ (ex : Code PIN)" value="${esc(field.label)}" autofocus>
        <div class="cf-draft-actions">
          <button type="button" class="cf-cancel-btn">Annuler</button>
          <button type="button" class="cf-confirm-btn" ${field.label.trim() ? '' : 'disabled'}>Valider</button>
        </div>
      </div>`;
  }

  return `
    <div class="cf-item" data-id="${field.id}">
      <div class="cf-item-head">
        <span class="cf-name">${esc(field.label) || '(sans nom)'}</span>
        <button type="button" class="cf-remove-btn" title="Retirer ce champ">&#10005;</button>
      </div>
      ${renderCustomFieldValue(field)}
    </div>`;
}

function renderCustomFieldValue(field) {
  if (field.field_type === 'totp') {
    if (!totpLockedIds.has(field.id)) {
      const normalized = extractTotpSecret(field.value);
      return `
        <div class="cf-totp-entry">
          <input type="text" class="cf-totp-input" placeholder="Secret TOTP (base32, ou coller une URI otpauth://)" value="${esc(field.value)}" autocomplete="off" spellcheck="false">
          <button type="button" class="cf-totp-confirm-btn" ${normalized ? '' : 'disabled'}>Valider</button>
        </div>`;
    }
    return `
      <div class="cf-totp-live">
        <div class="cf-totp-code-wrap">
          <div class="totp-badge cf-totp-code" data-secret="${esc(field.value)}">------</div>
          <div class="totp-countdown cf-totp-cd">—</div>
          <button type="button" class="cf-totp-copy-btn icon-btn" title="Copier">&#128203;</button>
        </div>
        <p class="cf-totp-invalid" style="display:none;color:var(--red,#f85149);font-size:12px;margin:0;">Secret invalide — retirez ce champ et recommencez.</p>
      </div>`;
  }

  if (field.field_type === 'password') {
    return `
      <div class="pw-wrap">
        <input type="password" class="cf-value-input cf-secret-input" value="${esc(field.value)}" placeholder="Valeur" autocomplete="off">
        <div class="pw-actions">
          <button type="button" class="cf-reveal-btn" title="Afficher">&#128065;</button>
          <button type="button" class="cf-copy-btn" title="Copier">&#128203;</button>
        </div>
      </div>`;
  }

  const inputType = field.field_type === 'email' ? 'email' : field.field_type === 'url' ? 'url' : 'text';
  return `<input type="${inputType}" class="cf-value-input" value="${esc(field.value)}" placeholder="Valeur">`;
}

function refreshCustomFieldsSection() {
  const container = $('custom-fields-section');
  if (!container) return;
  container.innerHTML = renderCustomFieldsSection();
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

    // Étape "draft" : type + nom
    row.querySelector('.cf-type-select')?.addEventListener('change', e => {
      field.field_type = e.target.value;
      refreshCustomFieldsSection();
    });
    row.querySelector('.cf-label-input')?.addEventListener('input', e => {
      field.label = e.target.value;
      const confirmBtn = row.querySelector('.cf-confirm-btn');
      if (confirmBtn) confirmBtn.disabled = !field.label.trim();
    });
    row.querySelector('.cf-cancel-btn')?.addEventListener('click', () => {
      workingCustomFields = workingCustomFields.filter(f => f.id !== id);
      draftFieldIds.delete(id);
      refreshCustomFieldsSection();
    });
    row.querySelector('.cf-confirm-btn')?.addEventListener('click', () => {
      if (!field.label.trim()) return;
      draftFieldIds.delete(id);
      refreshCustomFieldsSection();
    });

    // Champ validé : retrait
    row.querySelector('.cf-remove-btn')?.addEventListener('click', () => {
      workingCustomFields = workingCustomFields.filter(f => f.id !== id);
      draftFieldIds.delete(id);
      totpLockedIds.delete(id);
      refreshCustomFieldsSection();
    });

    // Valeur simple (texte / email / url)
    row.querySelector('.cf-value-input:not(.cf-secret-input)')?.addEventListener('input', e => {
      field.value = e.target.value;
    });

    // Mot de passe : révéler / copier
    const secretInput = row.querySelector('.cf-secret-input');
    secretInput?.addEventListener('input', e => { field.value = e.target.value; });
    row.querySelector('.cf-reveal-btn')?.addEventListener('click', () => {
      secretInput.type = secretInput.type === 'password' ? 'text' : 'password';
    });
    row.querySelector('.cf-copy-btn')?.addEventListener('click', async () => {
      if (!field.value) return;
      await navigator.clipboard.writeText(field.value);
      showToast('Copié !');
    });

    // TOTP : saisie du secret puis verrouillage sur l'affichage du code live
    row.querySelector('.cf-totp-input')?.addEventListener('input', e => {
      field.value = e.target.value;
      const btn = row.querySelector('.cf-totp-confirm-btn');
      if (btn) btn.disabled = !extractTotpSecret(field.value);
    });
    row.querySelector('.cf-totp-confirm-btn')?.addEventListener('click', () => {
      const normalized = extractTotpSecret(field.value);
      if (!normalized) return;
      field.value = normalized;
      totpLockedIds.add(id);
      refreshCustomFieldsSection();
      startTotpTicker();
    });
    row.querySelector('.cf-totp-copy-btn')?.addEventListener('click', async () => {
      const codeEl = row.querySelector('.cf-totp-code');
      const code = codeEl?.textContent?.trim();
      if (!code || code === '------') return;
      await navigator.clipboard.writeText(code);
      showToast('Code copié !');
    });
  });
}

function renderFormBody(item, type) {
  const body = $('detail-body');
  const pw   = item?.password ?? '';
  const cats = categories.map(c => `<option value="${esc(c)}" ${(item?.category ?? 'Général') === c ? 'selected' : ''}>${esc(c)}</option>`).join('');

  body.innerHTML = `
    <div class="form-group">
      <label>Type</label>
      <select id="f-type">
        <option value="password" ${type === 'password' ? 'selected' : ''}>Mot de passe</option>
        <option value="note"     ${type === 'note'     ? 'selected' : ''}>Note sécurisée</option>
      </select>
    </div>
    <div class="form-group">
      <label>Titre</label>
      <input type="text" id="f-title" value="${esc(item?.title ?? '')}" placeholder="Ex: Gmail, Banque…">
    </div>
    ${type !== 'note' ? `
    <div class="form-group">
      <label>Identifiant / Email</label>
      <input type="text" id="f-username" value="${esc(item?.username ?? '')}" autocomplete="off">
    </div>
    <div class="form-group">
      <label>Mot de passe</label>
      <div class="pw-wrap">
        <input type="password" id="f-password" value="${esc(pw)}" autocomplete="off">
        <div class="pw-actions">
          <button id="btn-toggle-pw" title="Afficher">👁</button>
          <button id="btn-gen-pw"    title="Générer">⚡</button>
          <button id="btn-copy-pw"   title="Copier">📋</button>
        </div>
      </div>
      <div class="strength-bar"><div class="strength-fill" id="pw-strength-fill"></div></div>
    </div>
    <div class="form-group">
      <label>URL</label>
      <input type="url" id="f-url" value="${esc(item?.url ?? '')}" placeholder="https://example.com">
    </div>
    ` : ''}
    <div class="form-group">
      <label>Notes</label>
      <textarea id="f-notes" rows="3">${esc(item?.notes ?? '')}</textarea>
    </div>
    <div class="form-group" id="custom-fields-section"></div>
    <div class="form-group">
      <label>Album</label>
      <select id="f-category">${cats}</select>
    </div>
    <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
      <input type="checkbox" id="f-favorite" ${item?.favorite ? 'checked' : ''}> Favori ⭐
    </label>`;

  // Listeners dynamiques
  $('f-type')?.addEventListener('change', () => renderFormBody(item, $('f-type').value));
  $('f-password')?.addEventListener('input', updatePwStrength);
  updatePwStrength();

  refreshCustomFieldsSection();

  $('btn-toggle-pw')?.addEventListener('click', () => {
    const inp = $('f-password');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  $('btn-gen-pw')?.addEventListener('click', () => {
    const pw = generatePassword(20);
    $('f-password').value = pw;
    $('f-password').type = 'text';
    updatePwStrength();
  });
  $('btn-copy-pw')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText($('f-password')?.value ?? '');
    showToast('Mot de passe copié !');
  });
}

function updatePwStrength() {
  const fill = $('pw-strength-fill');
  if (!fill) return;
  const s = strengthScore($('f-password')?.value ?? '');
  fill.style.width    = `${s.pct}%`;
  fill.style.background = s.color;
}

// Ticker générique : met à jour tous les champs TOTP "verrouillés" affichés
// dans le formulaire (il peut y en avoir plusieurs, comme dans l'appli bureau).
function startTotpTicker() {
  if (totpInterval) return; // un seul ticker suffit, il re-scanne le DOM à chaque tick
  async function tick() {
    const codes = document.querySelectorAll('.cf-totp-code[data-secret]');
    for (const el of codes) {
      const secret = el.dataset.secret;
      const live = el.closest('.cf-totp-live');
      const wrap = live?.querySelector('.cf-totp-code-wrap');
      const cdEl = live?.querySelector('.cf-totp-cd');
      const invalidEl = live?.querySelector('.cf-totp-invalid');
      try {
        const res = await computeTotp(secret);
        if (!res) {
          if (wrap) wrap.style.display = 'none';
          if (invalidEl) invalidEl.style.display = '';
          continue;
        }
        if (wrap) wrap.style.display = '';
        if (invalidEl) invalidEl.style.display = 'none';
        el.textContent = res.code;
        if (cdEl) cdEl.textContent = `Expire dans ${res.remainingSeconds}s`;
      } catch {
        if (wrap) wrap.style.display = 'none';
        if (invalidEl) invalidEl.style.display = '';
      }
    }
  }
  tick();
  totpInterval = setInterval(tick, 1000);
}

// ─── Sauvegarde d'une entrée ──────────────────────────────────────────────────

$('btn-save-item').addEventListener('click', saveItem);
$('btn-cancel-item').addEventListener('click', closeDetail);
$('btn-close-detail').addEventListener('click', closeDetail);

async function saveItem() {
  const type = $('f-type')?.value ?? 'password';

  // Champs finaux : comme l'appli bureau, on exclut les champs "draft" pas
  // encore validés et ceux totalement vides (ni nom, ni valeur).
  const customFields = workingCustomFields.filter(
    f => !draftFieldIds.has(f.id) && (f.label.trim() || f.value.trim())
  );

  const now = isoNow();
  let item;

  if (editingId) {
    item = items.find(i => i.id === editingId);
    const oldPw = item.password;
    item.title      = $('f-title')?.value ?? '';
    item.username   = $('f-username')?.value ?? '';
    const newPw     = $('f-password')?.value ?? '';
    if (newPw !== oldPw && oldPw) {
      item.password_history = [...(item.password_history ?? []), { password: oldPw, changed_at: now }];
    }
    item.password     = newPw;
    item.url          = $('f-url')?.value ?? '';
    item.notes        = $('f-notes')?.value ?? '';
    item.category     = $('f-category')?.value ?? 'Général';
    item.favorite     = $('f-favorite')?.checked ?? false;
    item.item_type    = type;
    item.custom_fields = customFields;
    item.updated_at   = now;
  } else {
    item = {
      id:               newItemId(),
      item_type:        type,
      title:            $('f-title')?.value ?? '',
      username:         $('f-username')?.value ?? '',
      password:         $('f-password')?.value ?? '',
      url:              $('f-url')?.value ?? '',
      notes:            $('f-notes')?.value ?? '',
      category:         $('f-category')?.value ?? 'Général',
      tags:             [],
      favorite:         $('f-favorite')?.checked ?? false,
      expires_at:       '',
      custom_fields:    customFields,
      attachments:      [],
      password_history: [],
      last_used_at:     null,
      passkey:          null,
      generation_rule:  null,
      created_at:       now,
      updated_at:       now,
    };
    items.push(item);
  }

  const res = await msg('SAVE_ITEMS', { items, categories });
  if (!res.ok) { showToast(res.error ?? 'Erreur.', 'error'); return; }
  await chrome.storage.local.set({ vaultFile: res.fileJson });
  showToast('Entrée enregistrée !');
  closeDetail();
  renderActiveTab();
  updateCounts();
}

$('btn-delete-item').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('Supprimer cette entrée ?')) return;
  items = items.filter(i => i.id !== editingId);
  const res = await msg('SAVE_ITEMS', { items, categories });
  if (!res.ok) { showToast(res.error, 'error'); return; }
  await chrome.storage.local.set({ vaultFile: res.fileJson });
  showToast('Entrée supprimée.');
  closeDetail();
  renderActiveTab();
  updateCounts();
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
  results.innerHTML = '<div style="padding:20px;text-align:center;"><div class="spinner"></div></div>';

  const issues = [];
  const pwMap  = new Map();

  for (const item of items) {
    if ((item.item_type ?? 'password') !== 'password' || !item.password) continue;

    // Mots de passe faibles
    const s = strengthScore(item.password);
    if (s.pct < 40) {
      issues.push({ icon: '🔴', label: item.title || item.url, sub: 'Mot de passe faible', tag: 'red' });
    } else if (s.pct < 60) {
      issues.push({ icon: '🟡', label: item.title || item.url, sub: 'Mot de passe moyen', tag: 'amber' });
    }

    // Réutilisation
    const existing = pwMap.get(item.password);
    if (existing) {
      issues.push({ icon: '🔄', label: item.title || item.url, sub: `Mot de passe réutilisé (identique à "${existing}")`, tag: 'red' });
    } else {
      pwMap.set(item.password, item.title || item.url);
    }

    // Vérification HIBP
    try {
      const breached = await checkHibp(item.password);
      if (breached > 0) {
        issues.push({ icon: '💥', label: item.title || item.url, sub: `Mot de passe trouvé ${breached.toLocaleString()} fois dans des fuites de données`, tag: 'red' });
      }
    } catch { /* HIBP peut être indisponible */ }
  }

  if (issues.length === 0) {
    results.innerHTML = '<div style="padding:32px;text-align:center;color:#3fb950;font-size:15px;">✅ Aucun problème détecté !</div>';
  } else {
    results.innerHTML = issues.map(i => `
      <div class="audit-item">
        <div class="audit-icon">${i.icon}</div>
        <div>
          <div class="audit-label">${esc(i.label)} <span class="tag tag-${i.tag}">${i.tag === 'red' ? 'Critique' : 'Attention'}</span></div>
          <div class="audit-sub">${esc(i.sub)}</div>
        </div>
      </div>`).join('');
  }
}

async function checkHibp(password) {
  const enc    = new TextEncoder();
  const buf    = await crypto.subtle.digest('SHA-1', enc.encode(password));
  const hex    = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
  const prefix = hex.slice(0,5);
  const suffix = hex.slice(5);
  const res    = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
  const text   = await res.text();
  const match  = text.split('\n').find(l => l.startsWith(suffix));
  return match ? parseInt(match.split(':')[1]) : 0;
}

// ─── Générateur de mots de passe ─────────────────────────────────────────────

$('gen-length').addEventListener('input', () => {
  $('gen-length-val').textContent = $('gen-length').value;
});
$('btn-generate').addEventListener('click', () => {
  $('gen-result').textContent = generatePassword(parseInt($('gen-length').value));
});
$('btn-copy-gen').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('gen-result').textContent);
  showToast('Mot de passe copié !');
});

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

// ─── Import CSV ───────────────────────────────────────────────────────────────

$('csv-file').addEventListener('change', async () => {
  const file = $('csv-file').files[0];
  if (!file) return;
  $('csv-error').textContent = '';
  try {
    const text = await file.text();
    csvParsed  = parseCSV(text);
    $('csv-preview').textContent = `${csvParsed.length} entrée(s) détectée(s). Cliquez sur Importer pour les ajouter au coffre.`;
    $('btn-import-csv').style.display = csvParsed.length ? '' : 'none';
  } catch (e) {
    $('csv-error').textContent = e.message;
  }
});

$('btn-import-csv').addEventListener('click', async () => {
  if (!csvParsed.length) return;
  const now = isoNow();
  for (const row of csvParsed) {
    items.push({
      id: newItemId(), item_type: 'password',
      title: row.title || row.name || row.url || '',
      username: row.username || row.login || row.email || '',
      password: row.password || '',
      url: row.url || row.website || '',
      notes: row.notes || row.extra || '',
      category: 'Général', tags: [], favorite: false,
      expires_at: '', custom_fields: [], attachments: [],
      password_history: [], last_used_at: null,
      passkey: null, generation_rule: null,
      created_at: now, updated_at: now,
    });
  }
  const res = await msg('SAVE_ITEMS', { items, categories });
  if (!res.ok) { $('csv-error').textContent = res.error; return; }
  await chrome.storage.local.set({ vaultFile: res.fileJson });
  showToast(`${csvParsed.length} entrée(s) importée(s) !`);
  csvParsed = [];
  $('csv-preview').textContent = '';
  $('btn-import-csv').style.display = 'none';
  $('csv-file').value = '';
  updateCounts();
});

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('CSV vide ou sans en-têtes.');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, ''));
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitCsvLine(line);
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] ?? '').trim(); });
    return obj;
  });
}

function splitCsvLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}

// ─── TOTP (RFC 6238, HMAC-SHA1) ───────────────────────────────────────────────
// Portage exact de l'implémentation de l'appli bureau (src/lib/totp.ts) pour
// un comportement identique — même algorithme, même extraction otpauth://.

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, acc = 0;
  const out = [];
  for (const c of s) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

function intToBytes(num) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(4, num, false);
  return new Uint8Array(buf);
}

async function hmacSha1(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, msgBytes);
  return new Uint8Array(sig);
}

/** Extrait le secret d'une URI otpauth://totp/...?secret=XXXX, ou renvoie la chaîne telle quelle. */
function extractTotpSecret(input) {
  const trimmed = (input ?? '').trim();
  if (trimmed.startsWith('otpauth://')) {
    try {
      const url = new URL(trimmed);
      return url.searchParams.get('secret') ?? trimmed;
    } catch { return trimmed; }
  }
  return trimmed;
}

/** Calcule le code TOTP courant (6 chiffres, période 30s) pour un secret base32. */
async function computeTotp(secretBase32, period = 30, digits = 6) {
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
  const code = (binary % 10 ** digits).toString().padStart(digits, '0');

  return { code, remainingSeconds };
}

// ─── Force du mot de passe ────────────────────────────────────────────────────

function strengthScore(pw) {
  if (!pw) return { pct: 0, color: '#30363d' };
  let score = 0;
  if (pw.length >= 8)  score += 20;
  if (pw.length >= 14) score += 15;
  if (pw.length >= 20) score += 15;
  if (/[A-Z]/.test(pw)) score += 10;
  if (/[a-z]/.test(pw)) score += 10;
  if (/[0-9]/.test(pw)) score += 10;
  if (/[^A-Za-z0-9]/.test(pw)) score += 20;
  const color = score < 40 ? '#f85149' : score < 65 ? '#d29922' : '#3fb950';
  return { pct: Math.min(score, 100), color };
}

// ─── Verrouillage de la page ─────────────────────────────────────────────────

function lockPageContent() {
  const layout = document.querySelector('.layout');
  if (layout) layout.style.visibility = 'hidden';
  const banner = $('locked-banner');
  if (banner) banner.classList.add('visible');
  document.querySelectorAll('.topbar-actions button:not(#btn-lock)').forEach(b => {
    b.disabled = true; b.style.opacity = '0.3';
  });
}

function unlockPageContent() {
  const layout = document.querySelector('.layout');
  if (layout) layout.style.visibility = 'visible';
  const banner = $('locked-banner');
  if (banner) banner.classList.remove('visible');
  document.querySelectorAll('.topbar-actions button').forEach(b => {
    b.disabled = false; b.style.opacity = '';
  });
}

async function startSessionWatchdog() {
  setInterval(async () => {
    try {
      const status = await msg('GET_STATUS');
      if (!status.unlocked && items.length > 0) {
        updateLockUI(false);
        items = [];
        renderActiveTab();
        lockPageContent();
        const stored = await chrome.storage.local.get('vaultFile');
        if (stored.vaultFile) {
          pendingFile = JSON.parse(stored.vaultFile);
          showOverlayUnlock();
        }
      }
    } catch (_) { /* SW suspendu */ }
  }, 15000);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

init();
startSessionWatchdog();
