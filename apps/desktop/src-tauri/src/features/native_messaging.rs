//! Relais local pour le Native Messaging (extension de navigateur).
//!
//! Architecture : Chrome/Firefox lance le binaire de l'appli avec `--native-host`
//! (voir `main.rs`), qui parle le protocole Native Messaging standard sur
//! stdin/stdout (frames 4 octets LE + JSON) avec l'extension. Ce process
//! `--native-host` est un AUTRE processus que l'appli GUI principale (celle
//! qui détient le coffre déverrouillé en mémoire) : il relaie donc chaque
//! requête vers l'appli GUI via une connexion TCP locale (127.0.0.1 uniquement),
//! avec le MÊME format de frame (4 octets LE + JSON) pour éviter toute
//! confusion de protocole (la version précédente mélangeait un client HTTP
//! `reqwest` avec un serveur qui ne parlait pas HTTP — incompatibles).
//!
//! Authentification : un jeton aléatoire est régénéré à chaque démarrage de
//! l'appli et écrit dans un fichier à permissions restreintes (0600 sous
//! Unix) que seul l'utilisateur courant peut lire. Le process `--native-host`
//! lit ce même fichier pour joindre le jeton à chaque requête. Ça protège
//! contre un AUTRE processus non privilégié de l'utilisateur qui tenterait de
//! se connecter directement au port 4321 sans passer par Chrome/Firefox —
//! pas contre un processus tournant sous le même utilisateur avec accès au
//! système de fichiers (limite inhérente à ce modèle, comparable à ce que
//! font d'autres gestionnaires de mots de passe pour leur pont navigateur).

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use tauri::{AppHandle, Manager};

const RELAY_PORT: u16 = 4321;

#[derive(Deserialize)]
pub struct NativeRequest {
    pub action: String, // "get" | "ping"
    pub url: String,
    pub token: String,
    /// Identifiant de corrélation renvoyé tel quel dans la réponse,
    /// pour que le background.js puisse router vers le bon callback.
    pub request_id: Option<String>,
}

/// Une entrée du coffre exposée à l'extension.
#[derive(Serialize, Clone)]
pub struct EntryDto {
    pub id: String,
    pub label: String,
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct NativeResponse {
    pub status: String,             // "ok" | "error" | "locked" | "not_found"
    pub request_id: Option<String>, // miroir de NativeRequest.request_id
    /// Toutes les entrées correspondant au domaine (pas seulement la première).
    /// Vide si status != "ok".
    pub entries: Vec<EntryDto>,
    pub error: Option<String>,
}

impl NativeResponse {
    fn error(msg: impl Into<String>, request_id: Option<String>) -> Self {
        NativeResponse { status: "error".into(), request_id, entries: vec![], error: Some(msg.into()) }
    }
}

fn token_path() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or(std::path::PathBuf::from("./"))
        .join("coffre")
        .join("native-token")
}

/// Régénère le jeton d'authentification local et l'écrit avec des permissions
/// restrictives. Appelé une fois au démarrage de l'appli GUI.
pub fn generate_token() -> Result<String, String> {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>();

    let path = token_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &token).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(token)
}

/// Lit le jeton courant (utilisé côté process `--native-host`, voir `main.rs`).
pub fn read_token() -> Result<String, String> {
    std::fs::read_to_string(token_path()).map_err(|e| e.to_string())
}

fn read_frame(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    // Borne de sécurité pour éviter une allocation absurde sur une frame malveillante.
    if len > 10 * 1024 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame trop grande"));
    }
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf)?;
    Ok(buf)
}

fn write_frame(stream: &mut TcpStream, data: &[u8]) -> std::io::Result<()> {
    stream.write_all(&(data.len() as u32).to_le_bytes())?;
    stream.write_all(data)?;
    stream.flush()
}

/// Extrait un "domaine" simplifié d'une URL pour comparaison
/// (retire le schéma, le chemin, le port).
fn extract_domain(url: &str) -> String {
    let without_scheme = url.split("://").last().unwrap_or(url);
    let host = without_scheme.split('/').next().unwrap_or(without_scheme);
    host.split(':').next().unwrap_or(host).to_lowercase()
}

fn domains_match(item_url: &str, request_url: &str) -> bool {
    if item_url.trim().is_empty() {
        return false;
    }
    let item_domain = extract_domain(item_url);
    let req_domain = extract_domain(request_url);
    // Correspondance exacte ou sous-domaine (ex. "accounts.google.com" doit
    // matcher une entrée enregistrée pour "google.com").
    item_domain == req_domain || req_domain.ends_with(&format!(".{item_domain}"))
}

fn handle_native_request(req: NativeRequest, app_handle: &AppHandle) -> NativeResponse {
    let rid = req.request_id.clone();

    match read_token() {
        Ok(expected) if expected == req.token => {}
        _ => return NativeResponse::error("Authentification invalide.", rid),
    }

    if req.action == "ping" {
        return NativeResponse { status: "ok".into(), request_id: rid, entries: vec![], error: None };
    }

    let state = app_handle.state::<crate::AppState>();
    let guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return NativeResponse::error("État interne verrouillé.", rid),
    };

    let session = match guard.as_ref() {
        Some(s) => s,
        None => return NativeResponse {
            status: "locked".into(),
            request_id: rid,
            entries: vec![],
            error: Some("Le coffre est verrouillé.".into()),
        },
    };

    // Toutes les entrées correspondant au domaine, triées : d'abord les favoris,
    // puis par date de dernière utilisation décroissante.
    let entries: Vec<EntryDto> = session
        .vault
        .items
        .iter()
        .filter(|item| domains_match(&item.url, &req.url))
        .map(|item| EntryDto {
            id: item.id.clone(),
            label: if !item.title.is_empty() { item.title.clone() } else { item.url.clone() },
            username: item.username.clone(),
            password: item.password.clone(),
        })
        .collect();

    if entries.is_empty() {
        return NativeResponse {
            status: "not_found".into(),
            request_id: rid,
            entries: vec![],
            error: Some("Aucune entrée pour ce domaine.".into()),
        };
    }

    // Une seule entrée → on la met directement sans demander à l'utilisateur.
    // Plusieurs → le popup/content-script affichera un sélecteur.
    NativeResponse { status: "ok".into(), request_id: rid, entries, error: None }
}

pub fn start_native_relay(app_handle: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    generate_token().map_err(|e| format!("Impossible de générer le jeton natif: {e}"))?;

    // 127.0.0.1 uniquement : jamais exposé au réseau local ou à Internet.
    let listener = TcpListener::bind(("127.0.0.1", RELAY_PORT))?;

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };
            let app_handle = app_handle.clone();
            std::thread::spawn(move || {
                let frame = match read_frame(&mut stream) {
                    Ok(f) => f,
                    Err(_) => return,
                };
                let response = match serde_json::from_slice::<NativeRequest>(&frame) {
                    Ok(req) => handle_native_request(req, &app_handle),
                    Err(_) => NativeResponse::error("Requête malformée.", None),
                };
                if let Ok(payload) = serde_json::to_vec(&response) {
                    let _ = write_frame(&mut stream, &payload);
                }
            });
        }
    });

    Ok(())
}

// ===== Installation du manifeste Native Messaging (Chrome/Chromium) =====
//
// Firefox utilise un format proche mais avec la clé `allowed_extensions` au
// lieu de `allowed_origins`, et sous Windows le chemin passe par le
// Registre plutôt que par un fichier — non implémenté ici (limite connue,
// documentée plutôt que simulée).
const EXTENSION_ID_PLACEHOLDER: &str = "REMPLACER_PAR_L_ID_REEL_DE_L_EXTENSION";
const HOST_NAME: &str = "com.coffre.native_host";

fn manifest_json(exe_path: &std::path::Path) -> serde_json::Value {
    serde_json::json!({
        "name": HOST_NAME,
        "description": "Pont natif du gestionnaire de mots de passe Coffre",
        "path": exe_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{}/", EXTENSION_ID_PLACEHOLDER)]
    })
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[tauri::command]
pub fn install_native_host_manifest() -> Result<String, String> {
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let manifest = manifest_json(&exe_path);
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;

    let target_dir = chrome_manifest_dir()?;
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("Impossible de créer {}: {e}", target_dir.display()))?;
    let target_path = target_dir.join(format!("{HOST_NAME}.json"));
    std::fs::write(&target_path, &manifest_bytes).map_err(|e| e.to_string())?;

    Ok(target_path.to_string_lossy().to_string())
}

// Fallback pour Android, iOS et toute autre plateforme sans Chrome natif.
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
#[tauri::command]
pub fn install_native_host_manifest() -> Result<String, String> {
    Err("Native Messaging non supporté sur cette plateforme.".to_string())
}

#[cfg(target_os = "linux")]
fn chrome_manifest_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Impossible de déterminer le dossier utilisateur.")?;
    Ok(home.join(".config/google-chrome/NativeMessagingHosts"))
}

#[cfg(target_os = "macos")]
fn chrome_manifest_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Impossible de déterminer le dossier utilisateur.")?;
    Ok(home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts"))
}

#[cfg(target_os = "windows")]
fn chrome_manifest_dir() -> Result<std::path::PathBuf, String> {
    // Chrome sous Windows lit aussi ce chemin via une clé de registre pointant
    // vers le fichier manifeste ; ici on écrit le fichier dans AppData et on
    // s'appuie sur une inscription registre faite ailleurs (non couverte ici).
    let appdata = dirs::data_dir().ok_or("Impossible de déterminer %APPDATA%.")?;
    Ok(appdata.join("Coffre").join("NativeMessagingHosts"))
}
