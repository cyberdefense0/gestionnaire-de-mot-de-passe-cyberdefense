/**
 * popup.js — Logique du popup compact de l'extension Coffre.
 */

import { parseVaultFile } from './vault.js';

const msg = (type, payload = {}) =>
  chrome.runtime.sendMessage({ type, ...payload });

// ─── Éléments DOM ─────────────────────────────────────────────────────────────

const panels = {
  loading: document.getElementById('panel-loading'),
  setup:   document.getElementById('panel-setup'),
  unlock:  document.getElementById('panel-unlock'),
  list:    document.getElementById('panel-list'),
};
const statusDot   = document.getElementById('status-dot');
const lockBtn     = document.getElementById('lock-btn');

// Setup
const btnImport   = document.getElementById('btn-import-file');
const fileInput   = document.getElementById('file-input');
const btnNewPage  = document.getElementById('btn-open-vault-page');
const setupError  = document.getElementById('setup-error');

// Unlock
const masterPwInput = document.getElementById('master-pw');
const unlockError   = document.getElementById('unlock-error');
const btnUnlock     = document.getElementById('btn-unlock');
const btnRecovery   = document.getElementById('btn-use-recovery');
const unlockDesc    = document.getElementById('unlock-desc');

// List
const search    = document.getElementById('search');
const entries   = document.getElementById('entries');
const btnManage = document.getElementById('btn-manage');
const btnAdd    = document.getElementById('btn-add');
const btnSave   = document.getElementById('btn-save');

// ─── État local ───────────────────────────────────────────────────────────────

let allItems = [];
let allCategories = [];
let pendingFile = null; // VaultFile en attente de déverrouillage
let useRecovery = false;
let activeTabUrl = '';

// ─── Navigation entre panels ──────────────────────────────────────────────────

function showPanel(name) {
  for (const [k, el] of Object.entries(panels)) {
    el.classList.toggle('active', k === name);
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
      // Déjà déverrouillé : charger et afficher
      await loadAndShowList();
      return;
    }

    // Chercher un vault sauvegardé en storage
    const stored = await chrome.storage.local.get('vaultFile');
    if (stored.vaultFile) {
      pendingFile = JSON.parse(stored.vaultFile);
      showUnlock();
    } else {
      showPanel('setup');
    }
  } catch (e) {
    console.error(e);
    showPanel('setup');
  }
}

function showUnlock(recovery = false) {
  useRecovery = recovery;
  unlockError.textContent = '';
  masterPwInput.value = '';
  unlockDesc.textContent = recovery
    ? 'Entrez votre kit de récupération (format XXXX-XXXX-…).'
    : 'Entrez votre master password pour accéder au coffre.';
  masterPwInput.placeholder = recovery ? 'XXXX-XXXX-XXXX-XXXX-XXXX' : '••••••••';
  masterPwInput.type = recovery ? 'text' : 'password';
  btnRecovery.textContent = recovery
    ? 'Utiliser le master password…'
    : 'Utiliser le kit de récupération…';
  showPanel('unlock');
  setTimeout(() => masterPwInput.focus(), 50);
}

async function loadAndShowList() {
  const { items, categories, error } = await msg('GET_ALL_ITEMS');
  if (error) { showPanel('setup'); return; }
  allItems      = items ?? [];
  allCategories = categories ?? ['Général'];

  statusDot.classList.add('ok');
  statusDot.title = 'Coffre déverrouillé';
  lockBtn.style.display = 'block';

  renderList(allItems);
  showPanel('list');

  // Pré-filtrer sur l'URL active
  if (activeTabUrl) {
    const domain = new URL(activeTabUrl).hostname;
    search.value = domain;
    filterList(domain);
  }
}

// ─── Déverrouillage ───────────────────────────────────────────────────────────

btnUnlock.addEventListener('click', doUnlock);
masterPwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });

async function doUnlock() {
  const value = masterPwInput.value.trim();
  if (!value) return;
  unlockError.textContent = '';
  btnUnlock.disabled = true;
  btnUnlock.textContent = 'Déchiffrement…';
  try {
    const type   = useRecovery ? 'UNLOCK_RECOVERY' : 'UNLOCK';
    const field  = useRecovery ? { recoveryCode: value } : { masterPassword: value };
    const result = await msg(type, { file: pendingFile, ...field });
    if (!result.ok) throw new Error(result.error ?? 'Mot de passe incorrect.');
    await loadAndShowList();
  } catch (e) {
    unlockError.textContent = e.message;
  } finally {
    btnUnlock.disabled = false;
    btnUnlock.textContent = 'Déverrouiller';
  }
}

btnRecovery.addEventListener('click', () => showUnlock(!useRecovery));

// ─── Verrou ───────────────────────────────────────────────────────────────────

lockBtn.addEventListener('click', async () => {
  await msg('LOCK');
  statusDot.classList.remove('ok');
  statusDot.title = 'Coffre verrouillé';
  lockBtn.style.display = 'none';
  allItems = [];
  pendingFile = (await chrome.storage.local.get('vaultFile')).vaultFile
    ? JSON.parse((await chrome.storage.local.get('vaultFile')).vaultFile)
    : null;
  if (pendingFile) showUnlock();
  else showPanel('setup');
});

// ─── Import d'un fichier .vault ───────────────────────────────────────────────

btnImport.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  setupError.textContent = '';
  try {
    const text = await file.text();
    const vaultFile = parseVaultFile(text);
    await chrome.storage.local.set({ vaultFile: JSON.stringify(vaultFile) });
    pendingFile = vaultFile;
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

// ─── Rendu de la liste ────────────────────────────────────────────────────────

function initials(label) {
  return label?.slice(0, 2).toUpperCase() ?? '?';
}

function renderList(items) {
  if (items.length === 0) {
    entries.innerHTML = '<div class="empty-msg">Aucune entrée.<br>Ajoutez-en une depuis la page de gestion.</div>';
    return;
  }
  entries.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `
      <div class="entry-avatar">${initials(item.title || item.username)}</div>
      <div class="entry-body">
        <div class="entry-label">${escHtml(item.title || item.url || '(sans titre)')}</div>
        <div class="entry-user">${escHtml(item.username || '')}</div>
      </div>
      <div class="entry-actions">
        <button class="icon-btn" data-action="fill"  title="Remplir le formulaire">⌨</button>
        <button class="icon-btn" data-action="copy"  title="Copier le mot de passe">📋</button>
      </div>`;

    row.querySelector('[data-action="fill"]').addEventListener('click', () => fillEntry(item));
    row.querySelector('[data-action="copy"]').addEventListener('click', () => copyPassword(item));
    entries.appendChild(row);
  }
}

function filterList(q) {
  const lq = q.toLowerCase();
  const filtered = allItems.filter(it =>
    it.title?.toLowerCase().includes(lq) ||
    it.username?.toLowerCase().includes(lq) ||
    it.url?.toLowerCase().includes(lq)
  );
  renderList(filtered);
}

search.addEventListener('input', () => filterList(search.value));

// ─── Actions ──────────────────────────────────────────────────────────────────

async function fillEntry(entry) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (!tabId) return;
  await msg('FILL_SELECTED', { tabId, entry });
  window.close();
}

async function copyPassword(item) {
  try {
    await navigator.clipboard.writeText(item.password);
    showToast('Mot de passe copié !');
  } catch {
    showToast('Impossible de copier.', 'error');
  }
}

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
  a.href = url;
  a.download = 'coffre.vault';
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(text, level = 'ok') {
  const t = document.createElement('div');
  const color = level === 'error' ? '#f85149' : '#3fb950';
  Object.assign(t.style, {
    position: 'fixed', bottom: '10px', left: '50%',
    transform: 'translateX(-50%)',
    background: '#161b22', border: `1px solid ${color}`,
    color: '#e6edf3', borderRadius: '6px',
    padding: '6px 12px', fontSize: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,.4)',
    zIndex: 9999, whiteSpace: 'nowrap',
    transition: 'opacity .3s', opacity: '1',
  });
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2000);
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

init();
