//! Module de remplissage automatique (auto-type) pour applications natives.
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::Deserialize;
use std::sync::Mutex;

/// Ne conserve QUE l'identifiant de la dernière entrée tapée (pour un futur
/// "retaper"), jamais le mot de passe en clair — contrairement à la version
/// précédente qui gardait indéfiniment `username -> password` en mémoire.
#[derive(Default)]
pub struct AutoTypeState(Mutex<Option<String>>);

#[derive(Deserialize)]
pub struct AutoTypePayload {
    pub username: String,
    pub password: String,
    pub entry_id: String,
}

/// Simule la frappe `{USERNAME} {TAB} {PASSWORD} {ENTER}` avec de petits
/// délais entre chaque étape, sans jamais transiter par le presse-papiers.
///
/// Volontairement une commande SYNCHRONE (pas `async fn`) : Tauri exécute les
/// commandes synchrones sur un pool de threads dédié, donc les
/// `thread::sleep` ci-dessous ne bloquent pas l'exécuteur async partagé —
/// contrairement à la version précédente qui était `async` et bloquait un
/// thread du runtime Tokio à chaque frappe.
#[tauri::command]
pub fn auto_type(state: tauri::State<AutoTypeState>, payload: AutoTypePayload) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    enigo.text(&payload.username).map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(15));

    // `Direction::Click` = appui ET relâchement. Utiliser seulement `Press`
    // laisse la touche enfoncée jusqu'à la prochaine frappe, ce qui casse la
    // saisie (ex. Tab resterait actif pendant tout le reste de la séquence).
    enigo.key(Key::Tab, Direction::Click).map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(15));

    enigo.text(&payload.password).map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(15));

    enigo.key(Key::Return, Direction::Click).map_err(|e| e.to_string())?;

    *state.0.lock().unwrap() = Some(payload.entry_id);
    Ok(())
}
