//! vault-core
//!
//! Coeur cryptographique "zero-knowledge" du gestionnaire de mots de passe.
//! Ce crate ne dépend d'aucune librairie GUI/Tauri : il est testable seul
//! avec `cargo test`, ce qui permet de vérifier la logique de sécurité
//! indépendamment de l'application desktop.
//!
//! ## Principe (voir README.md du projet)
//!
//! - Le master password de l'utilisateur ne quitte JAMAIS cette librairie
//!   sous sa forme brute au-delà de la dérivation de clé.
//! - On ne chiffre pas directement les données avec une clé dérivée du
//!   master password. À la place :
//!     1. On génère une clé de données aléatoire (DEK - Data Encryption Key)
//!     2. Le VAULT est chiffré avec cette DEK (AES-256-GCM)
//!     3. La DEK elle-même est chiffrée ("wrappée") avec DEUX clés
//!        différentes, dérivées via Argon2id :
//!          - une dérivée du master password
//!          - une dérivée du kit de récupération (recovery code)
//!   Cela permet de déverrouiller le vault avec l'un OU l'autre secret,
//!   et de changer le master password plus tard sans re-chiffrer toutes
//!   les données (roadmap V2).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Argon2, Params, Version, Algorithm};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::Zeroize;

pub const DEK_LEN: usize = 32; // AES-256
const NONCE_LEN: usize = 12; // AES-GCM standard
const SALT_LEN: usize = 16;

/// Version courante du format `.vault` produite par `create_vault`. Les
/// fichiers plus anciens (`version: 1`, sans `checksum_sha256` ni
/// `recovery_kit_confirmed_at`) restent lisibles grâce aux valeurs par
/// défaut de `serde` sur ces champs — aucune migration bloquante n'est
/// nécessaire, seule la vérification de checksum est simplement ignorée
/// pour eux (voir `verify_checksum`).
pub const CURRENT_VAULT_VERSION: u32 = 2;

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("mot de passe incorrect ou données corrompues")]
    DecryptionFailed,
    #[error("erreur de dérivation de clé: {0}")]
    Kdf(String),
    #[error("erreur de sérialisation: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("format de kit de récupération invalide")]
    InvalidRecoveryFormat,
    #[error("fichier .vault corrompu ou modifié (checksum invalide)")]
    CorruptedFile,
}

type Result<T> = std::result::Result<T, VaultError>;

/// Paramètres Argon2id utilisés. Volontairement coûteux (mémoire + temps)
/// car exécutés uniquement au déverrouillage, côté client.
fn argon2_params() -> Params {
    // m_cost en KiB, t_cost = itérations, p_cost = parallélisme
    Params::new(19 * 1024, 2, 1, Some(DEK_LEN)).expect("paramètres Argon2id valides")
}

fn derive_key(secret: &[u8], salt: &[u8; SALT_LEN]) -> Result<[u8; DEK_LEN]> {
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon2_params());
    let mut out = [0u8; DEK_LEN];
    argon2
        .hash_password_into(secret, salt, &mut out)
        .map_err(|e| VaultError::Kdf(e.to_string()))?;
    Ok(out)
}

fn random_salt() -> [u8; SALT_LEN] {
    let mut s = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut s);
    s
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

/// Chiffre `plaintext` avec la clé donnée (AES-256-GCM). Retourne
/// nonce || ciphertext, encodé en base64, prêt à stocker/transmettre.
fn aes_encrypt(key: &[u8; DEK_LEN], plaintext: &[u8]) -> String {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .expect("le chiffrement AES-GCM ne devrait pas échouer");
    let mut combined = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);
    B64.encode(combined)
}

fn aes_decrypt(key: &[u8; DEK_LEN], blob_b64: &str) -> Result<Vec<u8>> {
    let combined = B64
        .decode(blob_b64)
        .map_err(|_| VaultError::DecryptionFailed)?;
    if combined.len() < NONCE_LEN {
        return Err(VaultError::DecryptionFailed);
    }
    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| VaultError::DecryptionFailed)
}

/// Type d'un champ personnalisé (à la Bitwarden : texte libre, secret masqué,
/// email/URL pour la sémantique, ou code TOTP calculé côté frontend).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomFieldType {
    Text,
    Password,
    Email,
    Url,
    Totp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomField {
    pub id: String,
    pub label: String,
    pub value: String,
    pub field_type: CustomFieldType,
}

/// Pièce jointe chiffrée (embarquée dans le vault, donc protégée par le même
/// AES-256-GCM que le reste). Volontairement limité à de petits fichiers —
/// la limite de taille est appliquée côté frontend avant l'ajout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub data_base64: String,
}

/// Type d'une entrée : mot de passe classique, note sécurisée (texte libre),
/// ou passkey (identifiant FIDO2/WebAuthn). Pour une passkey, `username`
/// porte le compte associé (facultatif) et `passkey` porte les métadonnées
/// de l'identifiant ; il n'y a pas de "mot de passe" au sens classique.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    Password,
    Note,
    Passkey,
}

impl Default for ItemType {
    fn default() -> Self {
        ItemType::Password
    }
}

/// Une ancienne valeur de `password`, conservée quand le mot de passe d'une
/// entrée change (voir `push_password_history` côté `src-tauri`, qui compare
/// l'ancienne et la nouvelle valeur avant d'écraser). Chiffrée comme le reste
/// du vault : `password_history` fait partie de `VaultItem`, donc du même
/// blob AES-256-GCM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordHistoryEntry {
    pub password: String,
    /// Date ISO à laquelle CE mot de passe a cessé d'être le mot de passe actif.
    pub changed_at: String,
}

/// Métadonnées d'une passkey (FIDO2/WebAuthn) stockées dans une entrée de
/// type `Passkey`. **Important : cette app ne réalise aucune cérémonie
/// WebAuthn (création/assertion) ni intégration d'autofill natif — c'est
/// hors périmètre ici, prévu côté extension navigateur séparée.** Ce struct
/// ne fait que stocker, chiffré comme le reste du vault, les métadonnées
/// publiques d'une passkey déjà créée ailleurs (ou saisies manuellement),
/// pour inventaire/consultation/synchronisation future.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasskeyData {
    /// Identifiant de l'identifiant (`credential.id`), tel qu'exposé par
    /// l'authentificateur — pas une donnée secrète en soi, mais utile pour
    /// retrouver la bonne passkey côté relying party.
    #[serde(default)]
    pub credential_id: String,
    /// Domaine du relying party (ex: "example.com").
    #[serde(default)]
    pub rp_id: String,
    /// Nom affiché du relying party (ex: "Example Inc.").
    #[serde(default)]
    pub rp_name: String,
    /// Identifiant utilisateur côté relying party (`user.id`/`user.handle`).
    #[serde(default)]
    pub user_handle: String,
    /// Clé publique associée (format dépend de l'algorithme), stockée pour
    /// référence/export — jamais de clé privée : une vraie clé privée FIDO2
    /// ne doit exister que dans l'authentificateur (TPM, clé matérielle,
    /// trousseau OS), pas dans un fichier `.vault` portable.
    #[serde(default)]
    pub public_key: String,
    /// Algorithme COSE utilisé (ex: "ES256", "RS256").
    #[serde(default)]
    pub algorithm: String,
}

/// Règle de génération de mot de passe mémorisée pour une entrée (ex: un
/// site bancaire qui interdit les symboles). Appliquée par défaut la
/// prochaine fois que l'utilisateur régénère un mot de passe pour cette
/// entrée, sans avoir à re-configurer le générateur à chaque fois.
///
/// Couvre l'intégralité de `GeneratorOptions`, pas seulement
/// `alphanumeric_only`/`exclude_chars` : un retour utilisateur a montré que
/// décocher "Majuscules"/"Minuscules"/"Chiffres"/"Symboles" puis mémoriser
/// la règle ne les restaurait pas à la réouverture, faute d'être stockés ici.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationRule {
    #[serde(default)]
    pub length: usize,
    #[serde(default = "default_true")]
    pub uppercase: bool,
    #[serde(default = "default_true")]
    pub lowercase: bool,
    #[serde(default = "default_true")]
    pub numbers: bool,
    #[serde(default = "default_true")]
    pub symbols: bool,
    /// Restreint le pool aux lettres/chiffres (pas de symboles), utile pour
    /// des formulaires qui rejettent la ponctuation (ex: sites bancaires).
    #[serde(default)]
    pub alphanumeric_only: bool,
    /// Caractères explicitement exclus du pool de génération (ex: caractères
    /// ambigus `l1IO0`, ou des symboles refusés par un site en particulier).
    #[serde(default)]
    pub exclude_chars: String,
}

fn default_true() -> bool {
    true
}

/// Un item du coffre-fort (correspond à VaultItem dans le README).
/// Pour une note sécurisée, `username`/`password`/`url` restent vides et
/// `notes` porte le contenu de la note.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultItem {
    pub id: String,
    #[serde(default, rename = "item_type")]
    pub item_type: ItemType,
    pub title: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub notes: String,
    pub category: String,
    /// Tags libres, multiples, indépendants de `category` (qui reste un
    /// classement exclusif "un album par entrée"). Un item peut n'avoir
    /// aucun tag.
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    /// Date ISO de rotation prévue du mot de passe ; chaîne vide = pas d'échéance.
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub custom_fields: Vec<CustomField>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    /// Anciennes valeurs de `password`, la plus récente en dernier. Alimenté
    /// par `src-tauri::update_item` quand le mot de passe change réellement
    /// (pas à chaque modification d'un autre champ).
    #[serde(default)]
    pub password_history: Vec<PasswordHistoryEntry>,
    /// Date ISO de la dernière fois que le mot de passe/contenu de cette
    /// entrée a été copié dans le presse-papiers — pas juste "ouverte pour
    /// consulter/modifier", un vrai signal d'usage réel. `None` tant que
    /// l'entrée n'a jamais été copiée depuis sa création. Sert à repérer
    /// les comptes oubliés dans l'audit de sécurité (voir
    /// `runLocalAudit`/`mark_item_used`), pas une donnée de suivi caché :
    /// visible et expliquée dans l'app.
    #[serde(default)]
    pub last_used_at: Option<String>,
    /// Présent uniquement pour `item_type: Passkey`. Voir `PasskeyData` :
    /// métadonnées publiques seulement, jamais de clé privée FIDO2.
    #[serde(default)]
    pub passkey: Option<PasskeyData>,
    /// Règle de génération mémorisée pour cette entrée (facultative). Voir
    /// `GenerationRule`.
    #[serde(default)]
    pub generation_rule: Option<GenerationRule>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_categories() -> Vec<String> {
    vec!["Général".to_string()]
}

/// Contenu en clair du vault (n'existe jamais sur disque tel quel).
/// `categories` est la liste des "albums" créés par l'utilisateur — il n'y a
/// plus de liste figée côté code, "Général" est juste la valeur de départ.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vault {
    #[serde(default)]
    pub items: Vec<VaultItem>,
    #[serde(default = "default_categories")]
    pub categories: Vec<String>,
}

impl Default for Vault {
    fn default() -> Self {
        Vault { items: Vec::new(), categories: default_categories() }
    }
}

/// Représentation du fichier `.vault` sur disque (ou du document Firestore
/// en mode Cloud). Tout ce qui est `String` ici est soit du base64 chiffré,
/// soit un sel/paramètre public — jamais de secret en clair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultFile {
    pub version: u32,
    /// Sel Argon2id pour dériver la clé à partir du master password
    pub master_salt: String,
    /// Sel Argon2id pour dériver la clé à partir du kit de récupération
    pub recovery_salt: String,
    /// DEK chiffrée avec la clé dérivée du master password
    pub wrapped_dek_master: String,
    /// DEK chiffrée avec la clé dérivée du kit de récupération
    pub wrapped_dek_recovery: String,
    /// Vault (liste des entrées) chiffré avec la DEK
    pub encrypted_vault: String,
    /// SHA-256 hexadécimal de `encrypted_vault`, recalculé à chaque
    /// `save_vault`. Ce n'est PAS un HMAC (aucune clé secrète n'est
    /// disponible avant le déchiffrement) : il ne protège pas contre une
    /// falsification par un attaquant qui peut aussi recalculer ce
    /// checksum, mais il détecte une corruption/troncature accidentelle du
    /// fichier *avant* de lancer l'Argon2id (coûteux), avec un message
    /// d'erreur clair plutôt qu'un échec de déchiffrement générique.
    /// Chaîne vide = fichier `version: 1` antérieur à ce contrôle, ignoré.
    #[serde(default)]
    pub checksum_sha256: String,
    /// Date ISO de la dernière confirmation explicite par l'utilisateur
    /// qu'il a bien sauvegardé/imprimé son kit de récupération. `None` tant
    /// qu'aucune confirmation n'a eu lieu. Donnée non sensible (ne révèle
    /// rien sur le contenu du vault), stockée en clair à dessein pour
    /// pouvoir déclencher un rappel périodique côté frontend sans
    /// déverrouiller le vault.
    #[serde(default)]
    pub recovery_kit_confirmed_at: Option<String>,
}

/// Calcule le checksum SHA-256 (hex) de `encrypted_vault`.
fn compute_checksum(encrypted_vault: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(encrypted_vault.as_bytes());
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Vérifie l'intégrité structurelle du fichier avant toute tentative de
/// déchiffrement. Renvoie `true` si le checksum correspond, ou si le
/// fichier est antérieur à ce contrôle (`checksum_sha256` vide).
fn verify_checksum(file: &VaultFile) -> bool {
    if file.checksum_sha256.is_empty() {
        return true; // fichier version 1, pas de checksum à vérifier
    }
    file.checksum_sha256 == compute_checksum(&file.encrypted_vault)
}

/// Résultat de la création d'un nouveau vault : le fichier à persister,
/// et le kit de récupération en clair à montrer UNE SEULE FOIS à l'utilisateur.
pub struct NewVault {
    pub file: VaultFile,
    pub recovery_code: String,
}

/// Formate 24 octets aléatoires en code lisible: 6 groupes de 4 caractères
/// base32-like (chiffres+lettres majuscules, sans caractères ambigus).
fn format_recovery_code(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans O/0/I/1
    let mut out = String::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut chars = Vec::new();
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = (acc >> bits) & 0x1F;
            chars.push(ALPHABET[idx as usize] as char);
        }
    }
    for (i, c) in chars.iter().enumerate() {
        if i > 0 && i % 4 == 0 {
            out.push('-');
        }
        out.push(*c);
    }
    out
}

fn parse_recovery_code(code: &str) -> Vec<u8> {
    code.chars().filter(|c| *c != '-').collect::<String>().into_bytes()
}

/// Crée un nouveau vault vide, protégé par `master_password`, avec un
/// kit de récupération généré aléatoirement.
pub fn create_vault(master_password: &str) -> Result<NewVault> {
    let dek = random_bytes::<DEK_LEN>();

    let master_salt = random_salt();
    let master_key = derive_key(master_password.as_bytes(), &master_salt)?;
    let wrapped_dek_master = aes_encrypt(&master_key, &dek);

    let recovery_raw = random_bytes::<18>(); // 18 octets -> code lisible
    let recovery_code = format_recovery_code(&recovery_raw);
    let recovery_salt = random_salt();
    let recovery_key = derive_key(&parse_recovery_code(&recovery_code), &recovery_salt)?;
    let wrapped_dek_recovery = aes_encrypt(&recovery_key, &dek);

    let empty_vault = Vault::default();
    let vault_json = serde_json::to_vec(&empty_vault)?;
    let encrypted_vault = aes_encrypt(&dek, &vault_json);

    let mut dek_mut = dek;
    let checksum_sha256 = compute_checksum(&encrypted_vault);
    let file = VaultFile {
        version: CURRENT_VAULT_VERSION,
        master_salt: B64.encode(master_salt),
        recovery_salt: B64.encode(recovery_salt),
        wrapped_dek_master,
        wrapped_dek_recovery,
        encrypted_vault,
        checksum_sha256,
        recovery_kit_confirmed_at: None,
    };
    dek_mut.zeroize();

    Ok(NewVault { file, recovery_code })
}

fn decode_salt(s: &str) -> Result<[u8; SALT_LEN]> {
    let raw = B64.decode(s).map_err(|_| VaultError::DecryptionFailed)?;
    raw.try_into().map_err(|_| VaultError::DecryptionFailed)
}

/// Déverrouille un vault avec le master password. Retourne le Vault en
/// clair (à garder uniquement en mémoire côté frontend) ainsi que la DEK,
/// nécessaire pour ré-enregistrer des modifications sans redemander le
/// master password à chaque sauvegarde pendant la session.
pub fn unlock_with_master_password(file: &VaultFile, master_password: &str) -> Result<(Vault, [u8; DEK_LEN])> {
    if !verify_checksum(file) {
        return Err(VaultError::CorruptedFile);
    }
    let salt = decode_salt(&file.master_salt)?;
    let key = derive_key(master_password.as_bytes(), &salt)?;
    let dek_bytes = aes_decrypt(&key, &file.wrapped_dek_master)?;
    let dek: [u8; DEK_LEN] = dek_bytes.try_into().map_err(|_| VaultError::DecryptionFailed)?;
    let vault_json = aes_decrypt(&dek, &file.encrypted_vault)?;
    let vault: Vault = serde_json::from_slice(&vault_json)?;
    Ok((vault, dek))
}

/// Déverrouille un vault avec le kit de récupération (cas "mot de passe oublié").
pub fn unlock_with_recovery_code(file: &VaultFile, recovery_code: &str) -> Result<(Vault, [u8; DEK_LEN])> {
    if !verify_checksum(file) {
        return Err(VaultError::CorruptedFile);
    }
    let salt = decode_salt(&file.recovery_salt)?;
    let key = derive_key(&parse_recovery_code(recovery_code), &salt)?;
    let dek_bytes = aes_decrypt(&key, &file.wrapped_dek_recovery)?;
    let dek: [u8; DEK_LEN] = dek_bytes.try_into().map_err(|_| VaultError::DecryptionFailed)?;
    let vault_json = aes_decrypt(&dek, &file.encrypted_vault)?;
    let vault: Vault = serde_json::from_slice(&vault_json)?;
    Ok((vault, dek))
}

/// Ré-encode et met à jour `file.encrypted_vault` après modification des items.
/// Ne touche pas au wrapping de la DEK (donc ni au master password ni au
/// kit de récupération) : une simple sauvegarde ne les redemande pas.
pub fn save_vault(file: &mut VaultFile, vault: &Vault, dek: &[u8; DEK_LEN]) -> Result<()> {
    let vault_json = serde_json::to_vec(vault)?;
    file.encrypted_vault = aes_encrypt(dek, &vault_json);
    file.checksum_sha256 = compute_checksum(&file.encrypted_vault);
    Ok(())
}

/// Marque le kit de récupération comme confirmé (sauvegardé/imprimé) par
/// l'utilisateur à l'instant `at` (chaîne ISO fournie par l'appelant, qui
/// gère déjà l'horodatage ailleurs — voir `now_iso()` côté `src-tauri`).
/// Ne touche à rien d'autre : peut être appelé sans déverrouiller le vault.
pub fn mark_recovery_kit_confirmed(file: &mut VaultFile, at: String) {
    file.recovery_kit_confirmed_at = Some(at);
}

/// Vérifie qu'un mot de passe correspond bien au master password actuel,
/// sans avoir besoin de redéchiffrer tout le vault. Utilisé pour re-confirmer
/// l'identité avant un changement de master password (l'utilisateur pourrait
/// avoir laissé le coffre déverrouillé sans surveillance).
pub fn verify_master_password(file: &VaultFile, candidate: &str) -> bool {
    unlock_with_master_password(file, candidate).is_ok()
}

/// Permet de changer le master password : re-dérive et re-wrap la DEK
/// sans jamais toucher aux données chiffrées elles-mêmes.
pub fn change_master_password(file: &mut VaultFile, dek: &[u8; DEK_LEN], new_master_password: &str) -> Result<()> {
    let new_salt = random_salt();
    let new_key = derive_key(new_master_password.as_bytes(), &new_salt)?;
    file.master_salt = B64.encode(new_salt);
    file.wrapped_dek_master = aes_encrypt(&new_key, dek);
    Ok(())
}

/// Génère un mot de passe aléatoire selon les critères demandés.
#[derive(Debug, Deserialize)]
pub struct GeneratorOptions {
    pub length: usize,
    pub uppercase: bool,
    pub lowercase: bool,
    pub numbers: bool,
    pub symbols: bool,
    /// Si vrai, force un pool alphanumérique (ignore `symbols`) — utile pour
    /// les sites (ex: bancaires) qui rejettent la ponctuation. Correspond à
    /// `GenerationRule.alphanumeric_only` côté `VaultItem`.
    #[serde(default)]
    pub alphanumeric_only: bool,
    /// Caractères explicitement retirés du pool final, quelle que soit leur
    /// catégorie (ex: "l1IO0" pour éviter les caractères ambigus, ou des
    /// symboles refusés par un formulaire précis).
    #[serde(default)]
    pub exclude_chars: String,
}

impl Default for GeneratorOptions {
    fn default() -> Self {
        Self {
            length: 20,
            uppercase: true,
            lowercase: true,
            numbers: true,
            symbols: true,
            alphanumeric_only: false,
            exclude_chars: String::new(),
        }
    }
}

pub fn generate_password(opts: &GeneratorOptions) -> String {
    const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const NUMS: &[u8] = b"0123456789";
    const SYMS: &[u8] = b"!@#$%^&*()-_=+[]{}?";

    let mut pool: Vec<u8> = Vec::new();
    if opts.lowercase { pool.extend_from_slice(LOWER); }
    if opts.uppercase { pool.extend_from_slice(UPPER); }
    if opts.numbers { pool.extend_from_slice(NUMS); }
    if opts.symbols && !opts.alphanumeric_only { pool.extend_from_slice(SYMS); }
    if pool.is_empty() { pool.extend_from_slice(LOWER); }

    let excluded: std::collections::HashSet<u8> = opts.exclude_chars.bytes().collect();
    let mut pool: Vec<u8> = pool.into_iter().filter(|b| !excluded.contains(b)).collect();
    if pool.is_empty() {
        // Toutes les exclusions ont vidé le pool : on retombe sur les
        // minuscules non exclues pour ne jamais planter, plutôt que de
        // renvoyer une chaîne vide silencieusement fausse.
        pool = LOWER.iter().copied().filter(|b| !excluded.contains(b)).collect();
        if pool.is_empty() { pool = LOWER.to_vec(); }
    }

    let mut rng = OsRng;
    let len = opts.length.max(4);
    (0..len)
        .map(|_| pool[(rng.next_u32() as usize) % pool.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_unlock_roundtrip_with_master_password() {
        let NewVault { mut file, recovery_code: _ } = create_vault("correct horse battery staple").unwrap();
        let (vault, dek) = unlock_with_master_password(&file, "correct horse battery staple").unwrap();
        assert!(vault.items.is_empty());

        let mut vault = vault;
        vault.items.push(VaultItem {
            id: "1".into(),
            item_type: ItemType::Password,
            title: "Gmail".into(),
            username: "moi@gmail.com".into(),
            password: "hunter2".into(),
            url: "https://gmail.com".into(),
            notes: "".into(),
            category: "Email".into(),
            tags: vec!["important".into()],
            favorite: false,
            expires_at: "".into(),
            custom_fields: Vec::new(),
            attachments: Vec::new(),
            password_history: Vec::new(),
            last_used_at: None,
            passkey: None,
            generation_rule: None,
            created_at: "2026-01-01".into(),
            updated_at: "2026-01-01".into(),
        });
        save_vault(&mut file, &vault, &dek).unwrap();

        let (vault2, _dek2) = unlock_with_master_password(&file, "correct horse battery staple").unwrap();
        assert_eq!(vault2.items.len(), 1);
        assert_eq!(vault2.items[0].title, "Gmail");
    }

    #[test]
    fn wrong_master_password_fails() {
        let NewVault { file, .. } = create_vault("le bon mot de passe").unwrap();
        let result = unlock_with_master_password(&file, "un mauvais mot de passe");
        assert!(result.is_err());
    }

    #[test]
    fn recovery_code_unlocks_vault() {
        let NewVault { file, recovery_code } = create_vault("master password oublié plus tard").unwrap();
        let (vault, _dek) = unlock_with_recovery_code(&file, &recovery_code).unwrap();
        assert!(vault.items.is_empty());
    }

    #[test]
    fn wrong_recovery_code_fails() {
        let NewVault { file, .. } = create_vault("un master password").unwrap();
        let fake_code = "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF";
        assert!(unlock_with_recovery_code(&file, fake_code).is_err());
    }

    #[test]
    fn change_master_password_then_unlock_with_new_one() {
        let NewVault { mut file, .. } = create_vault("ancien mdp").unwrap();
        let (vault, dek) = unlock_with_master_password(&file, "ancien mdp").unwrap();
        change_master_password(&mut file, &dek, "nouveau mdp").unwrap();

        assert!(unlock_with_master_password(&file, "ancien mdp").is_err());
        let (vault2, _) = unlock_with_master_password(&file, "nouveau mdp").unwrap();
        assert_eq!(vault2.items.len(), vault.items.len());
    }

    #[test]
    fn tampered_encrypted_vault_is_detected_before_kdf() {
        let NewVault { mut file, .. } = create_vault("un master password solide").unwrap();
        // On corrompt le blob chiffré sans toucher au reste du fichier.
        file.encrypted_vault = format!("{}AAAA", file.encrypted_vault);
        let result = unlock_with_master_password(&file, "un master password solide");
        assert!(matches!(result, Err(VaultError::CorruptedFile)));
    }

    #[test]
    fn legacy_vault_without_checksum_still_unlocks() {
        let NewVault { mut file, .. } = create_vault("mdp pour vieux format").unwrap();
        // Simule un fichier version 1 créé avant l'introduction du checksum.
        file.checksum_sha256 = String::new();
        file.version = 1;
        let result = unlock_with_master_password(&file, "mdp pour vieux format");
        assert!(result.is_ok());
    }

    #[test]
    fn save_vault_refreshes_checksum() {
        let NewVault { mut file, .. } = create_vault("mdp de test checksum").unwrap();
        let (mut vault, dek) = unlock_with_master_password(&file, "mdp de test checksum").unwrap();
        let checksum_before = file.checksum_sha256.clone();
        vault.items.push(VaultItem {
            id: "1".into(),
            item_type: ItemType::Note,
            title: "Note".into(),
            username: "".into(),
            password: "".into(),
            url: "".into(),
            notes: "secret".into(),
            category: "Général".into(),
            tags: Vec::new(),
            favorite: false,
            expires_at: "".into(),
            custom_fields: Vec::new(),
            attachments: Vec::new(),
            password_history: Vec::new(),
            last_used_at: None,
            passkey: None,
            generation_rule: None,
            created_at: "2026-01-01".into(),
            updated_at: "2026-01-01".into(),
        });
        save_vault(&mut file, &vault, &dek).unwrap();
        assert_ne!(checksum_before, file.checksum_sha256);
        assert!(verify_checksum(&file));
    }

    #[test]
    fn recovery_kit_confirmation_is_tracked() {
        let NewVault { mut file, .. } = create_vault("mdp kit recup").unwrap();
        assert!(file.recovery_kit_confirmed_at.is_none());
        mark_recovery_kit_confirmed(&mut file, "2026-08-01T00:00:00Z".into());
        assert_eq!(file.recovery_kit_confirmed_at.as_deref(), Some("2026-08-01T00:00:00Z"));
    }

    #[test]
    fn generator_respects_length_and_charset() {
        let opts = GeneratorOptions { length: 32, uppercase: false, lowercase: true, numbers: false, symbols: false, alphanumeric_only: false, exclude_chars: String::new() };
        let pwd = generate_password(&opts);
        assert_eq!(pwd.len(), 32);
        assert!(pwd.chars().all(|c| c.is_ascii_lowercase()));
    }

    #[test]
    fn generator_respects_exclude_chars_and_alphanumeric_only() {
        let opts = GeneratorOptions {
            length: 64,
            uppercase: true,
            lowercase: true,
            numbers: true,
            symbols: true,
            alphanumeric_only: true,
            exclude_chars: "lI1O0".to_string(),
        };
        let pwd = generate_password(&opts);
        assert_eq!(pwd.len(), 64);
        assert!(pwd.chars().all(|c| c.is_ascii_alphanumeric()));
        assert!(!pwd.chars().any(|c| "lI1O0".contains(c)));
    }

    #[test]
    fn passkey_item_round_trips_through_save_and_unlock() {
        let NewVault { mut file, .. } = create_vault("mdp passkeys").unwrap();
        let (mut vault, dek) = unlock_with_master_password(&file, "mdp passkeys").unwrap();
        vault.items.push(VaultItem {
            id: "pk1".into(),
            item_type: ItemType::Passkey,
            title: "GitHub".into(),
            username: "moi@example.com".into(),
            password: "".into(),
            url: "https://github.com".into(),
            notes: "".into(),
            category: "Général".into(),
            tags: Vec::new(),
            favorite: false,
            expires_at: "".into(),
            custom_fields: Vec::new(),
            attachments: Vec::new(),
            password_history: Vec::new(),
            last_used_at: None,
            passkey: Some(PasskeyData {
                credential_id: "cred-abc".into(),
                rp_id: "github.com".into(),
                rp_name: "GitHub".into(),
                user_handle: "user-123".into(),
                public_key: "base64-pubkey".into(),
                algorithm: "ES256".into(),
            }),
            generation_rule: None,
            created_at: "2026-01-01".into(),
            updated_at: "2026-01-01".into(),
        });
        save_vault(&mut file, &vault, &dek).unwrap();

        let (vault2, _) = unlock_with_master_password(&file, "mdp passkeys").unwrap();
        assert_eq!(vault2.items.len(), 1);
        assert_eq!(vault2.items[0].item_type, ItemType::Passkey);
        assert_eq!(vault2.items[0].passkey.as_ref().unwrap().rp_id, "github.com");
    }

    #[test]
    fn generation_rule_round_trips_all_fields() {
        let NewVault { mut file, .. } = create_vault("mdp regles").unwrap();
        let (mut vault, dek) = unlock_with_master_password(&file, "mdp regles").unwrap();
        vault.items.push(VaultItem {
            id: "gr1".into(),
            item_type: ItemType::Password,
            title: "Banque".into(),
            username: "moi".into(),
            password: "abc123".into(),
            url: "".into(),
            notes: "".into(),
            category: "Général".into(),
            tags: Vec::new(),
            favorite: false,
            expires_at: "".into(),
            custom_fields: Vec::new(),
            attachments: Vec::new(),
            password_history: Vec::new(),
            last_used_at: None,
            passkey: None,
            generation_rule: Some(GenerationRule {
                length: 24,
                uppercase: true,
                lowercase: true,
                numbers: true,
                symbols: false,
                alphanumeric_only: true,
                exclude_chars: "l1IO0".into(),
            }),
            created_at: "2026-01-01".into(),
            updated_at: "2026-01-01".into(),
        });
        save_vault(&mut file, &vault, &dek).unwrap();

        let (vault2, _) = unlock_with_master_password(&file, "mdp regles").unwrap();
        let rule = vault2.items[0].generation_rule.as_ref().unwrap();
        assert_eq!(rule.length, 24);
        assert!(!rule.symbols);
        assert!(rule.alphanumeric_only);
        assert_eq!(rule.exclude_chars, "l1IO0");
    }
}
