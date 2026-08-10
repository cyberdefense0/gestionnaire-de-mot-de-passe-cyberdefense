/**
 * offscreen.js — Page offscreen MV3 pour les opérations WASM (argon2id).
 *
 * Le service worker ne peut pas exécuter WebAssembly (CSP MV3 stricte).
 * Cette page offscreen est créée à la demande, reçoit les paramètres argon2
 * via chrome.runtime.onMessage, calcule le hash, et répond.
 *
 * La page offscreen est une vraie page d'extension : WASM y est autorisé.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'ARGON2_HASH') return false;

  const { pass, salt, mem, time, parallelism, hashLen } = msg;

  // pass et salt arrivent comme arrays plain (JSON), on les reconvertit
  const passU8  = new Uint8Array(pass);
  const saltU8  = new Uint8Array(salt);

  argon2.hash({
    pass:        passU8,
    salt:        saltU8,
    type:        argon2.ArgonType.Argon2id,
    mem,
    time,
    parallelism,
    hashLen,
  })
  .then(result => {
    // result.hash est un Uint8Array — on le sérialise en Array pour JSON
    sendResponse({ ok: true, hash: Array.from(result.hash) });
  })
  .catch(err => {
    sendResponse({ ok: false, error: err.message });
  });

  return true; // garder le canal ouvert pour la réponse async
});
