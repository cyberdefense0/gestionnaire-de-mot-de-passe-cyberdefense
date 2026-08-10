/**
 * Content script — injecté dans toutes les pages.
 *
 * Responsabilités :
 *  1. Détecter les champs de connexion (y compris dans les SPA qui les
 *     insèrent dynamiquement).
 *  2. Injecter un bouton 🔑 non-intrusif dans le champ mot de passe.
 *  3. Afficher un mini-sélecteur inline si plusieurs entrées correspondent.
 *  4. Remplir les champs d'une façon compatible React, Vue et Angular
 *     (qui interceptent les setters natifs des inputs).
 *
 * Sécurité :
 *  - Jamais de mot de passe stocké dans le DOM ou dans window.
 *  - Les credentials ne transitent que dans le message FILL_CREDENTIALS,
 *    traité immédiatement et sans persistance.
 */

const ATTR = 'data-coffre-injected';
const ICON_SIZE = 20;
const ICON_URL  = chrome.runtime.getURL('icons/icon16.png');

// ─── Détection des champs ─────────────────────────────────────────────────────

/**
 * Trouve les champs username/password dans la page entière (pas seulement
 * dans un <form>). Gère les cas où username et password sont dans des
 * formulaires distincts (pattern fréquent sur les SPA type Gmail step-by-step).
 */
function findLoginFields() {
  const pwFields = Array.from(
    document.querySelectorAll('input[type="password"]:not([data-coffre-skip])')
  ).filter((el) => isVisible(el));

  if (pwFields.length === 0) return null;

  const pwField = pwFields[0];

  // Cherche d'abord dans le même formulaire, puis dans la page entière.
  const scope = pwField.form ?? document;
  const usernameField =
    scope.querySelector('input[type="email"]:not([data-coffre-skip])') ??
    scope.querySelector('input[type="text"]:not([data-coffre-skip])') ??
    scope.querySelector('input[autocomplete~="username"]:not([data-coffre-skip])') ??
    null;

  return { username: usernameField, password: pwField };
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0'
  );
}

// ─── Remplissage compatible React/Vue/Angular ─────────────────────────────────

/**
 * Assigne `value` à `input` en court-circuitant les getters/setters natifs
 * interceptés par React. Sans ça, React ne voit pas le changement et l'état
 * du composant reste vide même si le DOM affiche la valeur.
 */
function setNativeValue(input, value) {
  const proto = Object.getPrototypeOf(input);
  const descriptor =
    Object.getOwnPropertyDescriptor(proto, 'value') ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }

  // Déclencher les événements qu'attendent les frameworks.
  ['keydown', 'keypress', 'input', 'keyup', 'change'].forEach((name) => {
    input.dispatchEvent(new Event(name, { bubbles: true, cancelable: true }));
  });
}

// ─── Sélecteur inline d'entrées ───────────────────────────────────────────────

function showEntryPicker(entries, pwField, callback) {
  removePicker();

  const picker = document.createElement('div');
  picker.id = 'coffre-picker';
  picker.setAttribute('data-coffre-ui', '');
  Object.assign(picker.style, {
    position:        'absolute',
    zIndex:          '2147483647',
    background:      '#1e293b',
    border:          '1px solid #334155',
    borderRadius:    '8px',
    boxShadow:       '0 8px 24px rgba(0,0,0,.45)',
    minWidth:        '220px',
    maxWidth:        '320px',
    padding:         '6px 0',
    fontFamily:      'system-ui, sans-serif',
    fontSize:        '13px',
    color:           '#e2e8f0',
    pointerEvents:   'all',
  });

  // Positionnement sous le champ mot de passe.
  const rect = pwField.getBoundingClientRect();
  picker.style.left = `${rect.left + window.scrollX}px`;
  picker.style.top  = `${rect.bottom + window.scrollY + 4}px`;

  entries.forEach((entry) => {
    const row = document.createElement('button');
    Object.assign(row.style, {
      display:    'flex',
      alignItems: 'center',
      gap:        '10px',
      width:      '100%',
      background: 'none',
      border:     'none',
      cursor:     'pointer',
      padding:    '8px 14px',
      color:      '#e2e8f0',
      textAlign:  'left',
    });
    row.onmouseenter = () => { row.style.background = '#334155'; };
    row.onmouseleave = () => { row.style.background = 'none'; };

    const icon = document.createElement('img');
    icon.src = ICON_URL;
    icon.width = 14;
    icon.height = 14;
    icon.style.flexShrink = '0';

    const text = document.createElement('div');
    const label = document.createElement('div');
    label.textContent = entry.label || entry.username;
    label.style.fontWeight = '500';
    const sub = document.createElement('div');
    sub.textContent = entry.username;
    sub.style.cssText = 'font-size:11px;opacity:.6;margin-top:1px';
    text.append(label, sub);

    row.append(icon, text);
    row.addEventListener('click', () => {
      removePicker();
      callback(entry);
    });
    picker.appendChild(row);
  });

  document.addEventListener('click', removePicker, { once: true, capture: true });
  document.body.appendChild(picker);
}

function removePicker() {
  document.getElementById('coffre-picker')?.remove();
}

// ─── Injection du bouton 🔑 ────────────────────────────────────────────────────

function injectButton(pwField) {
  if (pwField.getAttribute(ATTR)) return; // déjà injecté
  pwField.setAttribute(ATTR, '1');

  // Wrapper relatif pour positionner le bouton en absolu à l'intérieur.
  const wrapper = pwField.parentElement;
  const wrapperPos = window.getComputedStyle(wrapper).position;
  if (wrapperPos === 'static') wrapper.style.position = 'relative';

  const btn = document.createElement('button');
  btn.setAttribute('data-coffre-ui', '');
  btn.type = 'button';
  btn.title = 'Remplir depuis le coffre';
  Object.assign(btn.style, {
    position:        'absolute',
    right:           '6px',
    top:             '50%',
    transform:       'translateY(-50%)',
    zIndex:          '9999',
    background:      'none',
    border:          'none',
    padding:         '2px',
    cursor:          'pointer',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    borderRadius:    '4px',
    opacity:         '0.7',
    transition:      'opacity .15s',
  });
  btn.onmouseenter = () => { btn.style.opacity = '1'; };
  btn.onmouseleave = () => { btn.style.opacity = '0.7'; };

  const img = document.createElement('img');
  img.src = ICON_URL;
  img.width = ICON_SIZE;
  img.height = ICON_SIZE;
  btn.appendChild(img);

  // Ajouter suffisamment de padding pour que le texte ne passe pas sous l'icône.
  pwField.style.paddingRight = `${ICON_SIZE + 14}px`;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fetchAndFill(pwField);
  });

  wrapper.appendChild(btn);
}

// ─── Requête au background et remplissage ─────────────────────────────────────

async function fetchAndFill(pwField) {
  const url = window.location.origin;
  const response = await chrome.runtime.sendMessage({ type: 'GET_CREDENTIALS', url });

  if (response.status === 'locked') {
    showToast('Coffre verrouillé — ouvrez l\'application pour le déverrouiller.', 'warn');
    return;
  }
  if (response.status === 'not_found') {
    showToast('Aucune entrée enregistrée pour ce site.', 'info');
    return;
  }
  if (response.status === 'error') {
    showToast(response.error ?? 'Erreur inconnue.', 'error');
    return;
  }

  const entries = response.entries ?? [];
  if (entries.length === 0) {
    showToast('Aucune entrée trouvée.', 'info');
    return;
  }

  const fill = (entry) => {
    const fields = findLoginFields();
    if (fields?.username) setNativeValue(fields.username, entry.username);
    setNativeValue(pwField, entry.password);
  };

  if (entries.length === 1) {
    fill(entries[0]);
  } else {
    showEntryPicker(entries, pwField, fill);
  }
}

// ─── Toast de notification discret ────────────────────────────────────────────

function showToast(msg, level = 'info') {
  const colors = { info: '#3b82f6', warn: '#f59e0b', error: '#ef4444' };
  const t = document.createElement('div');
  t.setAttribute('data-coffre-ui', '');
  Object.assign(t.style, {
    position:     'fixed',
    bottom:       '20px',
    right:        '20px',
    zIndex:       '2147483647',
    background:   '#1e293b',
    color:        '#e2e8f0',
    borderLeft:   `4px solid ${colors[level] ?? colors.info}`,
    borderRadius: '6px',
    padding:      '10px 14px',
    fontSize:     '13px',
    maxWidth:     '280px',
    boxShadow:    '0 4px 12px rgba(0,0,0,.4)',
    fontFamily:   'system-ui, sans-serif',
    transition:   'opacity .3s',
    opacity:      '1',
  });
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

// ─── Écoute des messages du background (fill déclenché depuis le popup) ───────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'FILL_CREDENTIALS') return;
  const fields = findLoginFields();
  if (!fields) return;
  const entry = message.entry;
  if (entry.username && fields.username) setNativeValue(fields.username, entry.username);
  if (entry.password && fields.password) setNativeValue(fields.password, entry.password);
});

// ─── Initialisation + MutationObserver pour SPA ───────────────────────────────

function scan() {
  const fields = findLoginFields();
  if (fields?.password) injectButton(fields.password);
}

// Scan initial.
scan();

// Ré-scanner à chaque modification du DOM (SPA, chargement dynamique…).
const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });
