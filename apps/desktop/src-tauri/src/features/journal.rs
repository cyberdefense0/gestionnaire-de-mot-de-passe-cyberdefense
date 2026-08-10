//! Module de journal append-only (chaîne de hash façon Merkle).
//!
//! Chaque commit contient le hash du commit précédent : toute altération ou
//! suppression d'un commit passé casse la chaîne à partir de ce point, ce que
//! `verify_chain()` détecte. Auto-pruning paramétrable (nombre de commits /
//! ancienneté max) pour éviter que le fichier ne grossisse indéfiniment.

use serde::{Deserialize, Serialize};
use chrono::Utc;
use std::collections::VecDeque;
use std::sync::Mutex;
use sha2::{Sha256, Digest};

const MAX_COMMITS: usize = 500;
const MAX_DAYS: i64 = 30;

#[derive(Serialize, Deserialize, Clone)]
pub struct Commit {
    /// Hash du commit précédent (ou [0;32] pour le tout premier commit).
    pub previous_hash: [u8; 32],
    pub timestamp: i64,
    pub operation: String,
    pub entry_id: String,
    pub data_hash: [u8; 32],
}

impl Commit {
    /// Hash de CE commit (utilisé comme `previous_hash` du commit suivant).
    /// Inclut tous les champs pour que la moindre altération (y compris de
    /// `previous_hash` lui-même) casse la chaîne — pas seulement `data_hash`.
    fn own_hash(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(self.previous_hash);
        hasher.update(self.timestamp.to_le_bytes());
        hasher.update(self.operation.as_bytes());
        hasher.update(self.entry_id.as_bytes());
        hasher.update(self.data_hash);
        hasher.finalize().into()
    }
}

pub struct Journal {
    path: std::path::PathBuf,
    commits: VecDeque<Commit>,
}

impl Journal {
    pub fn new(base_path: &std::path::Path) -> Self {
        let path = base_path.join("vault.journal");
        let mut journal = Journal { path, commits: VecDeque::new() };
        let _ = journal.load();
        journal
    }

    /// Ajoute un commit chaîné au précédent, applique l'auto-pruning, puis persiste.
    pub fn append(&mut self, op: String, entry_id: String, data: &[u8]) -> Result<(), String> {
        // Chaîne au hash du DERNIER COMMIT LUI-MÊME (pas à son propre previous_hash,
        // sinon la chaîne ne relie jamais réellement les commits entre eux).
        let previous_hash = self
            .commits
            .back()
            .map(|c| c.own_hash())
            .unwrap_or([0u8; 32]);

        let mut hasher = Sha256::new();
        hasher.update(data);
        let data_hash = hasher.finalize().into();

        let commit = Commit {
            previous_hash,
            timestamp: Utc::now().timestamp(),
            operation: op,
            entry_id,
            data_hash,
        };
        self.commits.push_back(commit);

        // Auto-pruning : garde au plus MAX_COMMITS commits, purge ceux de plus de MAX_DAYS.
        while self.commits.len() > MAX_COMMITS {
            self.commits.pop_front();
        }
        let cutoff = (Utc::now() - chrono::Duration::days(MAX_DAYS)).timestamp();
        self.commits.retain(|c| c.timestamp >= cutoff);

        self.save()
    }

    /// Vérifie l'intégrité de toute la chaîne conservée localement.
    /// Ne prouve pas l'absence de purge (l'auto-pruning retire volontairement
    /// les anciens commits), seulement l'absence d'altération de ce qui reste.
    pub fn verify(&self) -> bool {
        let mut expected_previous = self.commits.front().map(|c| c.previous_hash).unwrap_or([0u8; 32]);
        for commit in &self.commits {
            if commit.previous_hash != expected_previous {
                return false;
            }
            expected_previous = commit.own_hash();
        }
        true
    }

    pub fn entries(&self) -> Vec<Commit> {
        self.commits.iter().cloned().collect()
    }

    fn save(&self) -> Result<(), String> {
        let bytes = bincode::serialize(&self.commits).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, &bytes).map_err(|e| e.to_string())
    }

    fn load(&mut self) -> Result<(), String> {
        if let Ok(bytes) = std::fs::read(&self.path) {
            let commits: VecDeque<Commit> = bincode::deserialize(&bytes).map_err(|e| e.to_string())?;
            self.commits = commits;
        }
        Ok(())
    }
}

lazy_static::lazy_static! {
    static ref JOURNAL_INSTANCE: Mutex<Option<Journal>> = Mutex::new(None);
}

pub fn init_journal() -> Result<(), String> {
    let dir = dirs::config_dir()
        .unwrap_or(std::path::PathBuf::from("./"))
        .join("coffre");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Impossible de créer {}: {e}", dir.display()))?;
    let j = Journal::new(&dir);
    let mut instance = JOURNAL_INSTANCE
        .lock()
        .map_err(|_| "Verrou du journal empoisonné".to_string())?;
    *instance = Some(j);
    Ok(())
}

/// Enregistre un événement dans le journal. `data` sert uniquement à calculer
/// une empreinte (aucune donnée en clair n'est stockée dans le journal
/// lui-même) : passez par ex. le JSON de l'entrée concernée.
pub fn record(operation: &str, entry_id: &str, data: &[u8]) {
    if let Ok(mut guard) = JOURNAL_INSTANCE.lock() {
        if let Some(journal) = guard.as_mut() {
            let _ = journal.append(operation.to_string(), entry_id.to_string(), data);
        }
    }
}

#[derive(Serialize)]
pub struct JournalEntryDto {
    pub timestamp: i64,
    pub operation: String,
    pub entry_id: String,
    pub data_hash_hex: String,
}

#[tauri::command]
pub fn get_journal_entries() -> Vec<JournalEntryDto> {
    JOURNAL_INSTANCE
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|j| j.entries()))
        .unwrap_or_default()
        .into_iter()
        .map(|c| JournalEntryDto {
            timestamp: c.timestamp,
            operation: c.operation,
            entry_id: c.entry_id,
            data_hash_hex: hex_encode(&c.data_hash),
        })
        .collect()
}

#[tauri::command]
pub fn verify_journal_integrity() -> bool {
    JOURNAL_INSTANCE
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|j| j.verify()))
        .unwrap_or(true)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
