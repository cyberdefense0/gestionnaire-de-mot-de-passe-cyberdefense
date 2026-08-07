// Identifie les formulaires de connexion
function findLoginFields() {
  const inputs = document.querySelectorAll('input[type="password"]');
  const usernameInput = inputs[0]?.closest('form')?.querySelector('input[type="text"], input[type="email"]') || null;
  
  return {
    username: usernameInput,
    password: inputs[0] || null,
    form: inputs[0]?.closest('form') || null
  };
}

// S'il y a un champ mot de passe, on demande les identifiants au background
function requestCredentials() {
  const fields = findLoginFields();
  if (!fields.password) return;

  const url = window.location.origin;
  
  // Ajouter une icône de remplissage dans le champ
  const icon = document.createElement('div');
  icon.innerHTML = '🔑';
  icon.style.cssText = `
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    cursor: pointer;
    background: #f0f0f0;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  `;
  fields.password.parentElement.style.position = 'relative';
  fields.password.parentElement.appendChild(icon);

  icon.addEventListener('click', () => {
    // Demander les identifiants au background
    chrome.runtime.sendMessage({ type: 'GET_CREDENTIALS', url: url }, (response) => {
      console.log('Réponse background:', response);
    });
  });

  // Écouter les messages du background (remplissage)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'FILL_CREDENTIALS') {
      const payload = message.payload;
      if (payload.username) {
        const usernameField = fields.username || document.querySelector('input[type="text"]');
        if (usernameField) usernameField.value = payload.username;
      }
      if (payload.password) {
        fields.password.value = payload.password;
        // Déclencher l'événement de validation
        const evt = new Event('input', { bubbles: true });
        fields.password.dispatchEvent(evt);
      }
      // Essayer de soumettre automatiquement
      if (fields.form) {
        // optionnel : fields.form.submit();
      }
    }
  });
}

// Attendre le chargement de la page
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', requestCredentials);
} else {
  requestCredentials();
}
