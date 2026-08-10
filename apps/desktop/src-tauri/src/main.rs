//! Point d'entrée principal de l'application.
//! Détecte s'il est lancé en mode "native-host" (pour l'extension navigateur)
//! ou en mode normal (interface graphique).

use std::io::{Read, Write};
use std::net::TcpStream;
use serde_json::{json, Value};

fn main() {
    // Détection du mode native-host : uniquement via l'argument explicite.
    // On ne se fie PAS à isatty(stdin) car tauri dev (et certains launchers)
    // pipent stdin même pour une session GUI normale, ce qui causait une
    // détection faussement positive et un crash immédiat sans fenêtre.
    let is_native_host = std::env::args().any(|arg| arg == "--native-host");

    if is_native_host {
        run_native_host();
    } else {
        // Le crate est nommé `password_manager_lib` dans Cargo.toml (`[lib] name`),
        // pas `coffre_lib` (qui n'existe pas et empêchait toute compilation).
        password_manager_lib::run();
    }
}

/// Mode Native Messaging : relie stdin/stdout (protocole standard attendu
/// par Chrome/Firefox) au relais TCP local exposé par l'appli GUI déjà
/// lancée (voir `features::native_messaging::start_native_relay`). Les deux
/// bouts utilisent EXACTEMENT le même format de frame (4 octets LE + JSON),
/// donc ce process se contente de faire suivre les octets, en y ajoutant le
/// jeton d'authentification local avant transmission.
fn run_native_host() {
    let mut stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    loop {
        let mut len_bytes = [0u8; 4];
        if stdin.read_exact(&mut len_bytes).is_err() {
            break; // L'extension a fermé la connexion
        }
        let len = u32::from_le_bytes(len_bytes) as usize;

        let mut buffer = vec![0u8; len];
        if stdin.read_exact(&mut buffer).is_err() {
            break;
        }

        let mut msg: Value = match serde_json::from_slice(&buffer) {
            Ok(m) => m,
            Err(e) => {
                write_response(&mut stdout, &json!({ "status": "error", "error": format!("JSON invalide : {}", e) }));
                continue;
            }
        };

        let response = match msg.get("action").and_then(|a| a.as_str()) {
            Some("get") | Some("get_password") | Some("ping") => {
                match password_manager_lib::features::native_messaging::read_token() {
                    Ok(token) => {
                        if let Value::Object(ref mut map) = msg {
                            map.insert("token".to_string(), Value::String(token));
                        }
                        forward_to_relay(&msg)
                    }
                    Err(_) => json!({
                        "status": "error",
                        "error": "L'application Coffre ne semble pas lancée (jeton introuvable)."
                    }),
                }
            }
            _ => json!({ "status": "error", "error": "Action inconnue" }),
        };

        write_response(&mut stdout, &response);
    }
}

/// Relaie la requête vers l'appli GUI via TCP local (frame 4 octets LE + JSON,
/// symétrique de `features::native_messaging::read_frame`/`write_frame`).
fn forward_to_relay(msg: &Value) -> Value {
    let mut stream = match TcpStream::connect(("127.0.0.1", 4321)) {
        Ok(s) => s,
        Err(_) => {
            return json!({ "status": "error", "error": "Impossible de joindre l'application Coffre. Est-elle lancée ?" })
        }
    };

    let payload = match serde_json::to_vec(msg) {
        Ok(p) => p,
        Err(e) => return json!({ "status": "error", "error": format!("Échec d'encodage: {e}") }),
    };

    if stream.write_all(&(payload.len() as u32).to_le_bytes()).is_err()
        || stream.write_all(&payload).is_err()
        || stream.flush().is_err()
    {
        return json!({ "status": "error", "error": "Échec d'écriture vers l'application Coffre." });
    }

    let mut len_buf = [0u8; 4];
    if stream.read_exact(&mut len_buf).is_err() {
        return json!({ "status": "error", "error": "Réponse absente de l'application Coffre." });
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > 10 * 1024 * 1024 {
        return json!({ "status": "error", "error": "Réponse invalide." });
    }
    let mut buf = vec![0u8; len];
    if stream.read_exact(&mut buf).is_err() {
        return json!({ "status": "error", "error": "Réponse tronquée." });
    }

    serde_json::from_slice(&buf).unwrap_or(json!({ "status": "error", "error": "Réponse illisible." }))
}

/// Écrit une réponse JSON dans stdout (préfixée par sa longueur), sans jamais
/// paniquer même en cas d'échec d'écriture (le process ne doit pas crasher
/// juste parce que Chrome a déjà fermé le pipe côté extension).
fn write_response(stdout: &mut std::io::Stdout, response: &Value) {
    let resp_bytes = match serde_json::to_vec(response) {
        Ok(b) => b,
        Err(_) => return,
    };
    let len = resp_bytes.len() as u32;
    let _ = stdout.write_all(&len.to_le_bytes());
    let _ = stdout.write_all(&resp_bytes);
    let _ = stdout.flush();
}
