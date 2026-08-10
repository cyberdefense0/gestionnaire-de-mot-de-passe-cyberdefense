//! Module de partage : Shamir Secret Sharing (kit de récupération), partage
//! web temporaire zero-knowledge (AES-256-GCM, TTL, lien avec clé en fragment `#`).
use shamir::SecretData;
use chrono::{Utc, Duration};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;
use rand::RngCore;
use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::{Aead, KeyInit};

/// (ciphertext, nonce, expiration). Le nonce doit être stocké : il est généré
/// aléatoirement à chaque partage (jamais réutilisé, contrairement à la
/// version précédente qui utilisait un nonce fixe à zéro).
#[derive(Default)]
pub struct TempStore(Mutex<HashMap<String, (Vec<u8>, [u8; 12], chrono::DateTime<Utc>)>>);

fn sweep_expired(store: &mut HashMap<String, (Vec<u8>, [u8; 12], chrono::DateTime<Utc>)>) {
    let now = Utc::now();
    store.retain(|_, (_, _, expires)| *expires > now);
}

/// Fragmente le kit de récupération (chaîne lisible retournée par
/// `create_vault`, ex. `"AB3F-9KLM-..."`) en `n` fragments Shamir, dont `k`
/// suffisent à le reconstituer. `k` et `n` sont bornés pour rester dans un
/// usage raisonnable (le crate `shamir` travaille sur GF(2^8), n ≤ 255).
#[tauri::command]
pub fn generate_shamir_shares(recovery_code: String, n: u8, k: u8) -> Result<Vec<Vec<u8>>, String> {
    if recovery_code.trim().is_empty() {
        return Err("Le kit de récupération ne peut pas être vide.".to_string());
    }
    if k < 2 || k > n {
        return Err("Le seuil (k) doit être compris entre 2 et n.".to_string());
    }
    if n < 2 || n > 255 {
        return Err("Le nombre de fragments (n) doit être compris entre 2 et 255.".to_string());
    }

    // Le kit de récupération est déjà une chaîne lisible (base32-like + tirets),
    // donc toujours UTF-8 valide — pas besoin de reconvertir depuis des octets bruts.
    let secret_data = SecretData::with_secret(&recovery_code, k);

    let mut shares = Vec::with_capacity(n as usize);
    for i in 1..=n {
        let share = secret_data
            .get_share(i)
            .map_err(|e| format!("Impossible de générer le fragment {}: {:?}", i, e))?;
        shares.push(share);
    }

    Ok(shares)
}

/// Reconstitue le kit de récupération à partir d'au moins `threshold` fragments.
/// `threshold` DOIT être le `k` utilisé lors de la génération (`generate_shamir_shares`) :
/// le déduire du nombre de fragments fournis est incorrect si l'utilisateur
/// en fournit plus que le seuil requis (ex. les 3 fragments d'un schéma k=2/n=3).
#[tauri::command]
pub fn reconstruct_shamir_secret(shares: Vec<Vec<u8>>, threshold: u8) -> Result<String, String> {
    if threshold < 2 {
        return Err("Le seuil doit être d'au moins 2.".to_string());
    }
    if (shares.len() as u8) < threshold {
        return Err(format!(
            "Il faut au moins {} fragment(s) pour reconstruire ce secret (reçu : {}).",
            threshold,
            shares.len()
        ));
    }

    // On ne prend que les `threshold` premiers fragments : le crate `shamir`
    // attend exactement le nombre de parts correspondant au seuil.
    let selected: Vec<Vec<u8>> = shares.into_iter().take(threshold as usize).collect();

    // `recover_secret` du crate `shamir` renvoie directement `Option<String>`
    // (pas `Option<Vec<u8>>` malgré ce que laissait penser un ancien commentaire).
    SecretData::recover_secret(threshold, selected)
        .ok_or_else(|| "Échec de la reconstruction : fragments invalides ou seuil incorrect.".to_string())
}

#[tauri::command]
pub async fn create_temp_share(
    state: State<'_, TempStore>,
    plaintext: Vec<u8>,
    ttl_seconds: u64,
) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;

    const MIN_TTL: u64 = 15 * 60; // 15 minutes
    const MAX_TTL: u64 = 14 * 24 * 60 * 60; // 14 jours (voir spec #4)
    if !(MIN_TTL..=MAX_TTL).contains(&ttl_seconds) {
        return Err("Le TTL doit être compris entre 15 minutes et 14 jours.".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let expires = Utc::now() + Duration::seconds(ttl_seconds as i64);

    let mut key_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key_bytes);
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher = Aes256Gcm::new(key);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| e.to_string())?;

    {
        let mut store = state.0.lock().unwrap();
        sweep_expired(&mut store); // purge opportuniste des partages expirés non consultés
        store.insert(id.clone(), (ciphertext, nonce_bytes, expires));
    }

    let key_b64 = B64.encode(key_bytes);
    // Le fragment après `#` n'est jamais envoyé au serveur qui héberge la page.
    Ok(format!("https://votre-domaine.com/#/send/{}/{}", id, key_b64))
}

#[tauri::command]
pub async fn fetch_temp_share(
    state: State<'_, TempStore>,
    id: String,
    key_b64: String,
) -> Result<Vec<u8>, String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;

    let key_bytes = B64.decode(&key_b64).map_err(|e| e.to_string())?;
    if key_bytes.len() != 32 {
        return Err("Clé de déchiffrement invalide.".to_string());
    }
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);

    let (ciphertext, nonce_bytes, expires) = {
        let mut store = state.0.lock().unwrap();
        store.remove(&id).ok_or("Secret introuvable ou déjà consulté.")?
    };
    if Utc::now() > expires {
        return Err("Ce lien a expiré.".to_string());
    }

    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher = Aes256Gcm::new(key);
    cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Déchiffrement impossible (clé incorrecte ou donnée corrompue).".to_string())
}

// Routage Tor/proxy anonyme (spec #5) — délibérément NON implémenté pour
// l'instant (nécessiterait d'intégrer un client Tor embarqué comme `arti`,
// non vérifiable dans cet environnement). Cette commande n'est PAS
// enregistrée dans `invoke_handler!` pour éviter que le frontend ne puisse
// l'appeler et obtenir une fausse impression de protection.
#[allow(dead_code)]
pub async fn upload_via_tor(_secret: Vec<u8>, _proxy_addr: Option<String>) -> Result<String, String> {
    Err("Le routage Tor n'est pas encore implémenté.".to_string())
}
