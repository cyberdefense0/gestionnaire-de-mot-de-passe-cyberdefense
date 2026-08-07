// Connexion au Native Host (le binaire Rust)
const HOST_NAME = 'com.cyberdefense.coffre'; // Identifiant déclaré dans le registre OS

let port = null;

function connectToNative() {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(() => {
      console.warn('Native Host déconnecté, tentative de reconnexion...');
      port = null;
      setTimeout(connectToNative, 3000);
    });
    console.log('✅ Connecté au coffre-fort (Native Host)');
  } catch (e) {
    console.error('❌ Impossible de se connecter au Native Host', e);
  }
}

function onNativeMessage(message) {
  console.log('📨 Réception du Native Host :', message);
  // Si le message contient un password, on peut le stocker temporairement
  // ou le transmettre au content script via une event.
  if (message.action === 'fill') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'FILL_CREDENTIALS',
        payload: message
      });
    });
  }
}

// Appelé par le Content Script pour demander des identifiants
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_CREDENTIALS') {
    const { url } = request;
    if (!port) {
      sendResponse({ error: 'Native Host non connecté' });
      return true;
    }
    // Envoyer la requête au Native Host (qui la transmettra à Tauri)
    port.postMessage({
      action: 'get',
      url: url,
      tabId: sender.tab.id
    });
    // La réponse viendra asynchrone via onNativeMessage
    sendResponse({ status: 'pending' });
    return true;
  }
  return true;
});

// Initialisation
connectToNative();

// Garder le service worker actif (heartbeat)
setInterval(() => {
  if (port) {
    port.postMessage({ ping: true });
  }
}, 20000);
