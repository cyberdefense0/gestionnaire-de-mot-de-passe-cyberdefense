use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, State};

use vault_core::{
    Attachment, CustomField, GeneratorOptions, ItemType, PasswordHistoryEntry, Vault, VaultError,
    VaultFile, VaultItem,
};

/// Session active en mémoire pendant que le vault est déverrouillé.
/// La DEK (clé de déchiffrement des données) ne vit QUE ici, côté Rust,
/// et n'est jamais transmise au frontend JS.
struct Session {
    path: String,
    file: VaultFile,
    dek: [u8; vault_core::DEK_LEN],
    vault: Vault,
}

#[derive(Default)]
struct AppState(Mutex<Option<Session>>);

/// Réponse standard renvoyée après toute mutation : le frontend garde son
/// état (items + albums) synchronisé avec ce que Rust a effectivement
/// persisté. Inclut aussi `recoveryKitConfirmedAt`, lue depuis les
/// métadonnées (non chiffrées) du `VaultFile`, pour permettre au frontend
/// d'afficher un rappel périodique sans commande dédiée à chaque écran.
#[derive(Serialize, Clone)]
struct VaultSnapshot {
    items: Vec<VaultItem>,
    categories: Vec<String>,
    #[serde(rename = "recoveryKitConfirmedAt")]
    recovery_kit_confirmed_at: Option<String>,
}

fn snapshot_of(session: &Session) -> VaultSnapshot {
    VaultSnapshot {
        items: session.vault.items.clone(),
        categories: session.vault.categories.clone(),
        recovery_kit_confirmed_at: session.file.recovery_kit_confirmed_at.clone(),
    }
}

#[derive(Serialize)]
struct CreateVaultResponse {
    #[serde(flatten)]
    snapshot: VaultSnapshot,
    #[serde(rename = "recoveryCode")]
    recovery_code: String,
}

/// Champs d'une entrée envoyés par le formulaire (sans id/dates, gérés ici).
#[derive(Debug, Deserialize)]
struct ItemDraft {
    #[serde(default)]
    item_type: ItemType,
    title: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    notes: String,
    category: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    expires_at: String,
    #[serde(default)]
    custom_fields: Vec<CustomField>,
    #[serde(default)]
    attachments: Vec<Attachment>,
}

const DEFAULT_CATEGORY: &str = "Général";
/// Taille max d'une pièce jointe (en octets de données décodées) : reste
/// "léger" comme demandé, le vault entier reste un unique blob en mémoire/disque.
const MAX_ATTACHMENT_BYTES: usize = 3 * 1024 * 1024; // 3 Mo
/// Nombre maximum d'anciennes valeurs conservées dans `password_history`
/// par entrée ; au-delà, la plus ancienne est évincée. Évite une croissance
/// non bornée du vault pour une entrée dont le mot de passe change souvent.
const MAX_PASSWORD_HISTORY: usize = 20;

/// Nettoie une liste de tags saisie par l'utilisateur : trim, retire les
/// entrées vides, déduplique en conservant l'ordre.
fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    tags.into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .filter(|t| seen.insert(t.clone()))
        .collect()
}

fn persist(session: &Session) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&session.file).map_err(|e| e.to_string())?;
    std::fs::write(&session.path, json).map_err(|e| format!("Impossible d'écrire le fichier .vault: {e}"))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// S'assure que `name` existe dans la liste des albums (le crée sinon).
fn ensure_category(vault: &mut Vault, name: &str) {
    let name = name.trim();
    if name.is_empty() {
        return;
    }
    if !vault.categories.iter().any(|c| c == name) {
        vault.categories.push(name.to_string());
    }
}

fn check_attachment_sizes(attachments: &[Attachment]) -> Result<(), String> {
    for a in attachments {
        // Une estimation base64 -> octets (approximative mais suffisante pour la limite)
        let approx_bytes = a.data_base64.len() / 4 * 3;
        if approx_bytes > MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "La pièce jointe « {} » dépasse la limite de {} Mo.",
                a.filename,
                MAX_ATTACHMENT_BYTES / (1024 * 1024)
            ));
        }
    }
    Ok(())
}

// ---------- Rate limiting sur le déverrouillage local ----------
//
// Le vault local n'a pas de "compte" pour porter une protection type
// Firebase Auth : cette protection doit donc exister côté application.
// Le compteur d'échecs est stocké dans un petit fichier sidecar en clair
// (`<chemin du .vault>.attempts`), à côté du fichier `.vault` lui-même.
// Ce n'est PAS un secret (aucune donnée du vault n'y transite, juste un
// compteur et une date de fin de blocage) : le protéger davantage
// n'apporterait rien puisqu'un attaquant qui a accès au disque pourrait de
// toute façon simplement supprimer ce fichier pour réinitialiser le
// compteur. L'objectif ici n'est pas de résister à un attaquant qui
// contrôle déjà la machine, mais de ralentir des tentatives automatisées
// répétées depuis l'interface de l'application elle-même.

#[derive(Serialize, Deserialize, Default)]
struct AttemptState {
    failed_count: u32,
    /// RFC3339 ; présent seulement pendant une période de blocage.
    locked_until: Option<String>,
}

fn attempts_sidecar_path(vault_path: &str) -> String {
    format!("{vault_path}.attempts")
}

fn load_attempt_state(vault_path: &str) -> AttemptState {
    std::fs::read_to_string(attempts_sidecar_path(vault_path))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_attempt_state(vault_path: &str, state: &AttemptState) {
    // Best-effort : si l'écriture échoue, on préfère laisser l'utilisateur
    // retenter le déverrouillage plutôt que de bloquer l'application sur
    // un souci de permissions disque annexe.
    if let Ok(json) = serde_json::to_string(state) {
        let _ = std::fs::write(attempts_sidecar_path(vault_path), json);
    }
}

fn clear_attempt_state(vault_path: &str) {
    let _ = std::fs::remove_file(attempts_sidecar_path(vault_path));
}

/// Palier de délai (en secondes) appliqué une fois `failed_count` atteint.
/// Volontairement croissant plutôt que fixe : quelques fautes de frappe
/// restent indolores, mais une tentative automatisée devient rapidement
/// très coûteuse en temps.
fn lockout_seconds_for(failed_count: u32) -> i64 {
    match failed_count {
        0..=2 => 0,
        3..=4 => 5,
        5..=6 => 30,
        7..=9 => 120,   // 2 min
        10..=14 => 600, // 10 min
        _ => 1800,      // 30 min, plafond
    }
}

/// À appeler AVANT toute tentative de déverrouillage (donc avant même de
/// lire le fichier .vault) : si une période de blocage est en cours,
/// refuse immédiatement sans relancer l'Argon2id.
fn check_not_locked_out(vault_path: &str) -> Result<(), String> {
    let state = load_attempt_state(vault_path);
    if let Some(locked_until) = &state.locked_until {
        if let Ok(until) = DateTime::parse_from_rfc3339(locked_until) {
            let remaining = until.with_timezone(&Utc) - Utc::now();
            if remaining > Duration::zero() {
                let secs = remaining.num_seconds().max(1);
                return Err(if secs >= 60 {
                    format!(
                        "Trop de tentatives échouées. Réessayez dans environ {} minute(s).",
                        (secs + 59) / 60
                    )
                } else {
                    format!("Trop de tentatives échouées. Réessayez dans {secs} seconde(s).")
                });
            }
        }
    }
    Ok(())
}

/// À appeler après un échec de déverrouillage qui correspond réellement à
/// un secret incorrect (pas à un fichier corrompu, voir
/// `describe_unlock_error`). Incrémente le compteur et, si un palier est
/// franchi, pose une nouvelle fenêtre de blocage.
fn register_failed_attempt(vault_path: &str) -> Result<(), String> {
    let mut state = load_attempt_state(vault_path);
    state.failed_count += 1;
    let lockout = lockout_seconds_for(state.failed_count);
    if lockout > 0 {
        state.locked_until = Some((Utc::now() + Duration::seconds(lockout)).to_rfc3339());
    }
    save_attempt_state(vault_path, &state);
    Ok(())
}

// ---------- Cycle de vie du vault ----------
// (La sélection du fichier .vault se fait côté frontend via le plugin JS
// @tauri-apps/plugin-dialog — voir src/lib/tauri.ts pour le pourquoi.)

#[tauri::command]
fn create_local_vault(
    path: String,
    master_password: String,
    state: State<AppState>,
) -> Result<CreateVaultResponse, String> {
    if master_password.len() < 10 {
        return Err("Le master password doit contenir au moins 10 caractères.".into());
    }

    let new_vault = vault_core::create_vault(&master_password).map_err(|e| e.to_string())?;

    let (vault, dek) = vault_core::unlock_with_master_password(&new_vault.file, &master_password)
        .map_err(|e| e.to_string())?;

    // Un nouveau vault part avec un compteur d'échecs propre, au cas où un
    // fichier .attempts orphelin existerait déjà à cet emplacement.
    clear_attempt_state(&path);

    let session = Session { path: path.clone(), file: new_vault.file, dek, vault };
    let snapshot = snapshot_of(&session);
    persist(&session)?;
    *state.0.lock().unwrap() = Some(session);

    Ok(CreateVaultResponse { snapshot, recovery_code: new_vault.recovery_code })
}

/// Message d'erreur uniforme utilisé par `unlock_local_vault` et
/// `unlock_local_vault_with_recovery` pour transformer une erreur de
/// `vault-core` en message frontend, en distinguant explicitement le cas
/// "fichier corrompu" (qui n'est pas une tentative de devinette et ne doit
/// donc pas alimenter le compteur de brute-force) du reste.
fn describe_unlock_error(err: vault_core::VaultError, wrong_secret_message: &str) -> (String, bool) {
    match err {
        VaultError::CorruptedFile => (
            "Ce fichier .vault semble corrompu ou a été modifié (checksum invalide). \
             Restaurez-le depuis une sauvegarde si vous en avez une."
                .to_string(),
            false, // ne compte pas comme un échec de devinette
        ),
        _ => (wrong_secret_message.to_string(), true),
    }
}

#[tauri::command]
fn unlock_local_vault(
    path: String,
    master_password: String,
    state: State<AppState>,
) -> Result<VaultSnapshot, String> {
    check_not_locked_out(&path)?;

    let content = std::fs::read_to_string(&path).map_err(|_| "Impossible de lire ce fichier.".to_string())?;
    let file: VaultFile = serde_json::from_str(&content).map_err(|_| "Fichier .vault invalide.".to_string())?;

    match vault_core::unlock_with_master_password(&file, &master_password) {
        Ok((vault, dek)) => {
            clear_attempt_state(&path);
            let session = Session { path, file, dek, vault };
            let snapshot = snapshot_of(&session);
            *state.0.lock().unwrap() = Some(session);
            Ok(snapshot)
        }
        Err(e) => {
            let (message, counts_as_guess) = describe_unlock_error(e, "Master password incorrect.");
            if counts_as_guess {
                register_failed_attempt(&path)?;
            }
            Err(message)
        }
    }
}

#[tauri::command]
fn unlock_local_vault_with_recovery(
    path: String,
    recovery_code: String,
    state: State<AppState>,
) -> Result<VaultSnapshot, String> {
    check_not_locked_out(&path)?;

    let content = std::fs::read_to_string(&path).map_err(|_| "Impossible de lire ce fichier.".to_string())?;
    let file: VaultFile = serde_json::from_str(&content).map_err(|_| "Fichier .vault invalide.".to_string())?;

    match vault_core::unlock_with_recovery_code(&file, &recovery_code) {
        Ok((vault, dek)) => {
            clear_attempt_state(&path);
            let session = Session { path, file, dek, vault };
            let snapshot = snapshot_of(&session);
            *state.0.lock().unwrap() = Some(session);
            Ok(snapshot)
        }
        Err(e) => {
            let (message, counts_as_guess) = describe_unlock_error(e, "Kit de récupération invalide.");
            if counts_as_guess {
                register_failed_attempt(&path)?;
            }
            Err(message)
        }
    }
}

#[tauri::command]
fn lock_vault(state: State<AppState>) {
    *state.0.lock().unwrap() = None;
}

fn with_session<T>(
    state: &State<AppState>,
    f: impl FnOnce(&mut Session) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.0.lock().unwrap();
    let session = guard.as_mut().ok_or("Le coffre n'est pas déverrouillé.")?;
    f(session)
}

fn save_and_snapshot(session: &mut Session) -> Result<VaultSnapshot, String> {
    vault_core::save_vault(&mut session.file, &session.vault, &session.dek).map_err(|e| e.to_string())?;
    persist(session)?;
    Ok(snapshot_of(session))
}

fn draft_into_item(item: ItemDraft, id: String, created_at: String, updated_at: String) -> VaultItem {
    VaultItem {
        id,
        item_type: item.item_type,
        title: item.title,
        username: item.username,
        password: item.password,
        url: item.url,
        notes: item.notes,
        category: item.category,
        tags: normalize_tags(item.tags),
        favorite: item.favorite,
        expires_at: item.expires_at,
        custom_fields: item.custom_fields,
        attachments: item.attachments,
        password_history: Vec::new(),
        last_used_at: None,
        created_at,
        updated_at,
    }
}

// ---------- CRUD des entrées (mots de passe ET notes sécurisées) ----------

#[tauri::command]
fn add_item(item: ItemDraft, state: State<AppState>) -> Result<VaultSnapshot, String> {
    check_attachment_sizes(&item.attachments)?;
    with_session(&state, |session| {
        ensure_category(&mut session.vault, &item.category);
        let now = now_iso();
        session
            .vault
            .items
            .push(draft_into_item(item, uuid::Uuid::new_v4().to_string(), now.clone(), now));
        save_and_snapshot(session)
    })
}

/// Importe plusieurs entrées en une seule écriture disque (utilisé par
/// l'import CSV, pour éviter N écritures successives).
#[tauri::command]
fn import_items(items: Vec<ItemDraft>, state: State<AppState>) -> Result<VaultSnapshot, String> {
    for item in &items {
        check_attachment_sizes(&item.attachments)?;
    }
    with_session(&state, |session| {
        let now = now_iso();
        for item in items {
            ensure_category(&mut session.vault, &item.category);
            session
                .vault
                .items
                .push(draft_into_item(item, uuid::Uuid::new_v4().to_string(), now.clone(), now.clone()));
        }
        save_and_snapshot(session)
    })
}

#[tauri::command]
fn update_item(item: VaultItem, state: State<AppState>) -> Result<VaultSnapshot, String> {
    check_attachment_sizes(&item.attachments)?;
    with_session(&state, |session| {
        ensure_category(&mut session.vault, &item.category);
        let existing = session
            .vault
            .items
            .iter_mut()
            .find(|i| i.id == item.id)
            .ok_or("Entrée introuvable.")?;
        // Le mot de passe précédent part dans l'historique UNIQUEMENT s'il
        // change réellement et qu'il n'était pas déjà vide (première
        // saisie / note sécurisée sans mot de passe) — pas à chaque
        // modification d'un autre champ. `password_history` n'est jamais
        // pris depuis `item` : c'est le serveur, pas le frontend, qui en
        // reste responsable.
        if existing.item_type == ItemType::Password
            && !existing.password.is_empty()
            && existing.password != item.password
        {
            existing.password_history.push(PasswordHistoryEntry {
                password: existing.password.clone(),
                changed_at: now_iso(),
            });
            if existing.password_history.len() > MAX_PASSWORD_HISTORY {
                existing.password_history.remove(0);
            }
        }

        existing.title = item.title;
        existing.username = item.username;
        existing.password = item.password;
        existing.url = item.url;
        existing.notes = item.notes;
        existing.category = item.category;
        existing.tags = normalize_tags(item.tags);
        existing.favorite = item.favorite;
        existing.expires_at = item.expires_at;
        existing.custom_fields = item.custom_fields;
        existing.attachments = item.attachments;
        existing.updated_at = now_iso();

        save_and_snapshot(session)
    })
}

/// Bascule rapide du statut favori, sans passer par le formulaire complet.
#[tauri::command]
fn toggle_favorite(id: String, state: State<AppState>) -> Result<VaultSnapshot, String> {
    with_session(&state, |session| {
        let existing = session
            .vault
            .items
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or("Entrée introuvable.")?;
        existing.favorite = !existing.favorite;
        save_and_snapshot(session)
    })
}

/// Date la dernière utilisation réelle d'une entrée (copie du mot de passe
/// ou du contenu d'une note dans le presse-papiers — voir `copySecret` côté
/// frontend). Sert de signal pour repérer les comptes oubliés dans l'audit
/// de sécurité. Pas de confirmation utilisateur nécessaire : cette
/// métadonnée est visible et expliquée dans l'app, pas un tracking caché.
#[tauri::command]
fn mark_item_used(id: String, state: State<AppState>) -> Result<VaultSnapshot, String> {
    with_session(&state, |session| {
        let existing = session
            .vault
            .items
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or("Entrée introuvable.")?;
        existing.last_used_at = Some(now_iso());
        save_and_snapshot(session)
    })
}

#[tauri::command]
fn delete_item(id: String, state: State<AppState>) -> Result<VaultSnapshot, String> {
    with_session(&state, |session| {
        session.vault.items.retain(|i| i.id != id);
        save_and_snapshot(session)
    })
}

/// Supprime plusieurs entrées en une seule écriture disque (sélection multiple).
#[tauri::command]
fn bulk_delete_items(ids: Vec<String>, state: State<AppState>) -> Result<VaultSnapshot, String> {
    with_session(&state, |session| {
        session.vault.items.retain(|i| !ids.contains(&i.id));
        save_and_snapshot(session)
    })
}

/// Déplace plusieurs entrées vers un même album (sélection multiple).
/// Crée l'album cible s'il n'existe pas encore, comme `add_item`/`update_item`.
#[tauri::command]
fn bulk_set_category(ids: Vec<String>, category: String, state: State<AppState>) -> Result<VaultSnapshot, String> {
    with_session(&state, |session| {
        let trimmed = category.trim();
        if trimmed.is_empty() {
            return Err("Le nom de l'album ne peut pas être vide.".into());
        }
        ensure_category(&mut session.vault, trimmed);
        let now = now_iso();
        for item in session.vault.items.iter_mut() {
            if ids.contains(&item.id) {
                item.category = trimmed.to_string();
                item.updated_at = now.clone();
            }
        }
        save_and_snapshot(session)
    })
}

/// Ajoute un même tag à plusieurs entrées (sélection multiple). Réutilise
/// `normalize_tags` pour rester cohérent avec l'ajout de tag unitaire —
/// pas de doublon si l'entrée avait déjà ce tag.
#[tauri::command]
fn bulk_add_tag(ids: Vec<String>, tag: String, state: State<AppState>) -> Result<VaultSnapshot, String> {
    with_session(&state, |session| {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            return Err("Le tag ne peut pas être vide.".into());
        }
        let now = now_iso();
        for item in session.vault.items.iter_mut() {
            if ids.contains(&item.id) {
                let mut tags = item.tags.clone();
                tags.push(trimmed.to_string());
                item.tags = normalize_tags(tags);
                item.updated_at = now.clone();
            }
        }
        save_and_snapshot(session)
    })
}

// ---------- Gestion des albums ----------

#[tauri::command]
fn create_album(name: String, state: State<AppState>) -> Result<VaultSnapshot, String> {
    with_session(&state, |session| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Le nom de l'album ne peut pas être vide.".into());
        }
        if session.vault.categories.iter().any(|c| c == trimmed) {
            return Err("Un album porte déjà ce nom.".into());
        }
        session.vault.categories.push(trimmed.to_string());
        save_and_snapshot(session)
    })
}

#[tauri::command]
fn rename_album(old_name: String, new_name: String, state: State<AppState>) -> Result<VaultSnapshot, String> {
    with_session(&state, |session| {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err("Le nom de l'album ne peut pas être vide.".into());
        }
        if new_name != old_name && session.vault.categories.iter().any(|c| c == new_name) {
            return Err("Un album porte déjà ce nom.".into());
        }
        let slot = session
            .vault
            .categories
            .iter_mut()
            .find(|c| **c == old_name)
            .ok_or("Album introuvable.")?;
        *slot = new_name.to_string();
        for item in session.vault.items.iter_mut() {
            if item.category == old_name {
                item.category = new_name.to_string();
            }
        }
        save_and_snapshot(session)
    })
}

#[tauri::command]
fn delete_album(name: String, state: State<AppState>) -> Result<VaultSnapshot, String> {
    with_session(&state, |session| {
        if name == DEFAULT_CATEGORY {
            return Err("L'album « Général » ne peut pas être supprimé.".into());
        }
        session.vault.categories.retain(|c| c != &name);
        ensure_category(&mut session.vault, DEFAULT_CATEGORY);
        for item in session.vault.items.iter_mut() {
            if item.category == name {
                item.category = DEFAULT_CATEGORY.to_string();
            }
        }
        save_and_snapshot(session)
    })
}

// ---------- Master password ----------

#[tauri::command]
fn verify_master_password_cmd(candidate: String, state: State<AppState>) -> Result<bool, String> {
    with_session(&state, |session| Ok(vault_core::verify_master_password(&session.file, &candidate)))
}

#[tauri::command]
fn change_master_password_cmd(new_password: String, state: State<AppState>) -> Result<(), String> {
    if new_password.len() < 10 {
        return Err("Le nouveau master password doit contenir au moins 10 caractères.".into());
    }
    with_session(&state, |session| {
        vault_core::change_master_password(&mut session.file, &session.dek, &new_password)
            .map_err(|e| e.to_string())?;
        persist(session)
    })
}

#[tauri::command]
fn generate_password_cmd(options: GeneratorOptions) -> String {
    vault_core::generate_password(&options)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Impossible de lire ce fichier: {e}"))
}

/// Écrit des données binaires (encodées en base64 côté frontend) sur disque.
/// Utilisé pour l'export du kit de récupération en image : plus fiable que
/// le mécanisme `<a download>` du navigateur, qui ne fonctionne pas de façon
/// cohérente dans la webview Tauri (surtout WebKitGTK sur Linux).
#[tauri::command]
fn write_binary_file(path: String, base64_data: String) -> Result<(), String> {
    let bytes = B64
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("Données invalides: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Impossible d'écrire le fichier: {e}"))
}

// ---------- Sauvegarde ----------

/// Copie le fichier .vault courant (déjà entièrement chiffré) vers un autre
/// emplacement choisi par l'utilisateur — une sauvegarde manuelle simple.
#[tauri::command]
fn export_backup(destination: String, state: State<AppState>) -> Result<(), String> {
    with_session(&state, |session| {
        std::fs::copy(&session.path, &destination)
            .map(|_| ())
            .map_err(|e| format!("Impossible de créer la sauvegarde: {e}"))
    })
}

/// Préfixe utilisé pour reconnaître les fichiers créés par `auto_backup`,
/// afin de savoir lesquels nettoyer (voir `keep`) sans toucher à d'autres
/// fichiers que l'utilisateur aurait dans le même dossier.
const AUTO_BACKUP_PREFIX: &str = "coffre-backup-";

/// Copie le `.vault` actuellement ouvert vers `folder`, horodatée, puis
/// supprime les sauvegardes automatiques les plus anciennes dans ce même
/// dossier au-delà de `keep` exemplaires (rotation, pour ne pas accumuler
/// indéfiniment des copies sur le disque de l'utilisateur). Appelée
/// périodiquement par le frontend (voir `src/lib/autoBackup.ts`) tant que
/// le coffre reste déverrouillé — jamais en tâche de fond après
/// verrouillage/fermeture, ce n'est pas un daemon.
#[tauri::command]
fn auto_backup(folder: String, keep: u32, state: State<AppState>) -> Result<String, String> {
    with_session(&state, |session| {
        let timestamp = now_iso().replace(':', "-").replace('.', "-");
        let filename = format!("{AUTO_BACKUP_PREFIX}{timestamp}.vault");
        let dest_path = std::path::Path::new(&folder).join(&filename);

        std::fs::copy(&session.path, &dest_path)
            .map_err(|e| format!("Impossible de créer la sauvegarde automatique: {e}"))?;

        // Rotation : ne garder que les `keep` sauvegardes automatiques les
        // plus récentes dans ce dossier (tri par nom de fichier, qui
        // encode l'horodatage donc trie déjà chronologiquement).
        if let Ok(entries) = std::fs::read_dir(&folder) {
            let mut backups: Vec<_> = entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name()
                        .to_str()
                        .map(|n| n.starts_with(AUTO_BACKUP_PREFIX) && n.ends_with(".vault"))
                        .unwrap_or(false)
                })
                .collect();
            backups.sort_by_key(|e| e.file_name());
            if backups.len() > keep as usize {
                for old in &backups[..backups.len() - keep as usize] {
                    let _ = std::fs::remove_file(old.path());
                }
            }
        }

        Ok(filename)
    })
}

// ---------- Kit de récupération ----------

/// Marque le kit de récupération comme sauvegardé/imprimé à l'instant
/// présent. Appelée une première fois automatiquement à la création du
/// vault (voir `RecoveryKitModal`), et à nouveau chaque fois que
/// l'utilisateur répond "oui" au rappel périodique affiché par le
/// frontend quand `recoveryKitConfirmedAt` date de plus de 90 jours.
#[tauri::command]
fn confirm_recovery_kit_saved(state: State<AppState>) -> Result<VaultSnapshot, String> {
    with_session(&state, |session| {
        vault_core::mark_recovery_kit_confirmed(&mut session.file, now_iso());
        persist(session)?;
        Ok(snapshot_of(session))
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Suit le pattern officiel du plugin updater (v2.tauri.app/plugin/updater) :
            // enregistré dans .setup() plutôt qu'en .plugin() direct comme les
            // autres, pour pouvoir le limiter à `#[cfg(desktop)]` — ce projet ne
            // cible pas mobile aujourd'hui, mais ça évite un piège si ça change
            // un jour (le plugin updater n'a pas de sens sur mobile, où les mises
            // à jour passent par le store de l'OS).
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            create_local_vault,
            unlock_local_vault,
            unlock_local_vault_with_recovery,
            lock_vault,
            add_item,
            import_items,
            update_item,
            toggle_favorite,
            mark_item_used,
            delete_item,
            bulk_delete_items,
            bulk_set_category,
            bulk_add_tag,
            create_album,
            rename_album,
            delete_album,
            verify_master_password_cmd,
            change_master_password_cmd,
            generate_password_cmd,
            read_text_file,
            write_binary_file,
            export_backup,
            auto_backup,
            confirm_recovery_kit_saved,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}
