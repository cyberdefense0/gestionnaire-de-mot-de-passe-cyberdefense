use tauri::Manager;
use tokio::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize)]
pub struct ExtensionRequest {
    pub action: String,
    pub url: String,
    pub tab_id: Option<u32>,
}

#[derive(Serialize)]
pub struct ExtensionResponse {
    pub action: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub error: Option<String>,
}

// Lance le serveur HTTP sur le port 4321
pub async fn start_local_server(app_handle: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:4321").await?;
    println!("🌐 Serveur local pour extension démarré sur http://127.0.0.1:4321");

    while let Ok((mut stream, _)) = listener.accept().await {
        let app_handle_clone = app_handle.clone();
        tokio::spawn(async move {
            let mut buffer = [0u8; 4096];
            if let Ok(n) = stream.read(&mut buffer).await {
                let request_str = String::from_utf8_lossy(&buffer[..n]);
                // Parser simple : on cherche le JSON dans la requête
                if let Some(json_start) = request_str.find('{') {
                    if let Some(json_end) = request_str.rfind('}') {
                        let json_part = &request_str[json_start..=json_end];
                        if let Ok(req) = serde_json::from_str::<ExtensionRequest>(json_part) {
                            let response = handle_request(req, &app_handle_clone).await;
                            let resp_json = serde_json::to_string(&response).unwrap();
                            let _ = stream.write_all(resp_json.as_bytes()).await;
                        }
                    }
                }
            }
        });
    }
    Ok(())
}

async fn handle_request(req: ExtensionRequest, app_handle: &tauri::AppHandle) -> ExtensionResponse {
    if req.action == "get" {
        // Appeler le vault-core pour récupérer les identifiants du domaine
        // Ici on simule, mais vous utilisez votre state existant
        let vault_state = app_handle.state::<crate::VaultState>(); // Vous devez avoir un state global
        // let entry = vault_state.find_by_url(&req.url).await;
        
        // Simulation :
        ExtensionResponse {
            action: "fill".to_string(),
            username: Some("mon_utilisateur".to_string()),
            password: Some("mon_mot_de_passe".to_string()),
            error: None,
        }
    } else {
        ExtensionResponse {
            action: "error".to_string(),
            username: None,
            password: None,
            error: Some("Action inconnue".to_string()),
        }
    }
}
