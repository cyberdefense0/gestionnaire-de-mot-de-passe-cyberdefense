/**
 * Service Worker MV3 — arrière-plan de l'extension Coffre.
 *
 * Flux principal :
 *   content.js → [GET_CREDENTIALS] → background → NativeHost (stdin/stdout)
 *                                  → NativeHost → [réponse JSON] → background
 *   background → [FILL_CREDENTIALS | SHOW_PICKER] → content.js
 *
 * Corrélation requête/réponse : chaque requête porte un `requestId` (UUID v4)
 * que le NativeHost (main.rs, mode --native-host) renvoie tel quel dans sa
 * réponse. Ça évite les race conditions quand plusieurs onglets demandent
 * des identifiants en même temps.
 *
 * Heartbeat MV3 : les `setInterval` sont tués quand le SW se suspend.
 * On utilise `chrome.alarms` (déclenche une alarme périodique toutes les
 * ~20 s), ce qui réveille le SW si nécessaire et maintient la connexion native.
 */

const HOST_NAME = 'com.coffre.native_host';

let port = null;
// requestId → { tabId, resolve }
const pending = new Map();

// ─── Connexion au Native Host ─────────────────────────────────────────────────

function connectToNative() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message ?? 'inconnue';
      console.warn(`[Coffre] Native Host déconnecté (${reason}).`);
      port = null;
      // Rejeter toutes les requêtes en attente pour ne pas les laisser expirer.
      for (const [id, { resolve }] of pending) {
        resolve({ status: 'error', error: 'Native Host déconnecté.', entries: [] });
      }
      pending.clear();
    });
    console.log('[Coffre] ✅ Connecté au Native Host.');
  } catch (e) {
    console.error('[Coffre] ❌ Impossible de se connecter au Native Host :', e);
  }
}

// ─── Réception des réponses du Native Host ────────────────────────────────────

function onNativeMessage(msg) {
  const rid = msg.request_id;
  if (rid && pending.has(rid)) {
    const { resolve } = pending.get(rid);
    pending.delete(rid);
    resolve(msg);
    return;
  }
  // Message non corrélé (ex : push du coffre). Ignoré pour l'instant.
  console.debug('[Coffre] Message non corrélé :', msg);
}

// ─── Envoi d'une requête au Native Host (avec corrélation) ────────────────────

function queryNativeHost(payload) {
  return new Promise((resolve) => {
    if (!port) connectToNative();
    if (!port) {
      resolve({ status: 'error', error: 'Native Host non disponible.', entries: [] });
      return;
    }
    const requestId = crypto.randomUUID();
    pending.set(requestId, { resolve });
    // Timeout de sécurité : si le native host ne répond pas en 5 s, on rejette.
    const timer = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        resolve({ status: 'error', error: "Délai d'attente dépassé (5 s).", entries: [] });
      }
    }, 5000);
    // On annule le timer dès la résolution.
    pending.set(requestId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
    });
    port.postMessage({ ...payload, request_id: requestId });
  });
}

// ─── Messages depuis le content script et le popup ───────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.type) {

    // Le content script (ou le popup) demande les identifiants pour une URL.
    case 'GET_CREDENTIALS': {
      queryNativeHost({ action: 'get', url: request.url }).then(sendResponse);
      return true; // réponse asynchrone
    }

    // L'utilisateur a sélectionné une entrée dans le sélecteur inline ou le popup.
    // On transmet au content script de l'onglet concerné.
    case 'FILL_SELECTED': {
      const tabId = request.tabId ?? sender.tab?.id;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: 'FILL_CREDENTIALS',
          entry: request.entry,
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    // Le popup demande l'URL de l'onglet actif.
    case 'GET_ACTIVE_TAB_URL': {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendResponse({ url: tabs[0]?.url ?? '' });
      });
      return true;
    }
  }
});

// ─── Heartbeat MV3 (via chrome.alarms, compatible SW) ────────────────────────

chrome.alarms.create('coffre-heartbeat', { periodInMinutes: 0.35 }); // ~21 s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'coffre-heartbeat' && port) {
    port.postMessage({ action: 'ping', url: '' });
  }
});

// ─── Init au démarrage du SW ──────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(connectToNative);
chrome.runtime.onStartup.addListener(connectToNative);
connectToNative();
