//! Module de sécurité : Display Shield, Memory Locking, Anti-keylogger.
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Clone, Serialize, Deserialize)]
pub struct SecurityAlert {
    pub hook_detected: bool,
    pub message: String,
    /// Noms de processus suspects trouvés (vide si `hook_detected` est faux).
    pub suspicious_processes: Vec<String>,
}

// ========== DISPLAY SHIELD ==========
// ⚠️ Non compilable/testable dans cet environnement (pas de Windows/macOS
// disponibles ici) : à vérifier avec `cargo build` sur la plateforme cible.
#[cfg(target_os = "windows")]
pub fn apply_display_shield(window: &WebviewWindow) {
    use winapi::shared::windef::HWND;
    use winapi::um::winuser::SetWindowDisplayAffinity;
    // WDA_EXCLUDEFROMCAPTURE absent de winapi 0.3.x — valeur définie manuellement
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x00000011;

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            SetWindowDisplayAffinity(hwnd.0 as HWND, WDA_EXCLUDEFROMCAPTURE);
        }
        println!("Display Shield activé (Windows)");
    } else {
        eprintln!("Display Shield: impossible de récupérer le HWND de la fenêtre");
    }
}

#[cfg(target_os = "macos")]
pub fn apply_display_shield(window: &WebviewWindow) {
    // NSWindowSharingType.none = 0 (exclut la fenêtre des captures d'écran système).
    use objc::{msg_send, sel, sel_impl};
    if let Ok(ns_window) = window.ns_window() {
        unsafe {
            let _: () = msg_send![ns_window as *mut objc::runtime::Object, setSharingType: 0isize];
        }
        println!("Display Shield activé (macOS)");
    } else {
        eprintln!("Display Shield: impossible de récupérer le NSWindow");
    }
}

#[cfg(target_os = "linux")]
pub fn apply_display_shield(_window: &WebviewWindow) {
    // X11/Wayland n'exposent pas d'équivalent standard à WDA_EXCLUDEFROMCAPTURE ;
    // un compositeur Wayland pourrait honorer un hint spécifique, mais rien de
    // portable n'existe aujourd'hui. Fonctionnalité indisponible sur Linux.
    println!("Display Shield non supporté sur Linux (limitation du protocole d'affichage)");
}

// ========== MEMORY LOCKING ==========
// Empêche l'OS de swapper sur disque les pages mémoire contenant des secrets
// (clé de déchiffrement du coffre). Best-effort : l'échec n'est pas fatal,
// juste journalisé, car mlock peut échouer si RLIMIT_MEMLOCK est trop bas.

#[cfg(unix)]
pub fn lock_memory(ptr: *const u8, len: usize) {
    use nix::sys::mman::mlock;
    if len == 0 {
        return;
    }
    unsafe {
        if mlock(std::ptr::NonNull::new(ptr as *mut core::ffi::c_void).unwrap(), len).is_err() {
            eprintln!(
                "Memory locking: mlock a échoué (RLIMIT_MEMLOCK probablement trop bas) — \
                 les secrets peuvent être swappés sur disque."
            );
        }
    }
}

#[cfg(unix)]
pub fn unlock_memory(ptr: *const u8, len: usize) {
    use nix::sys::mman::munlock;
    if len == 0 {
        return;
    }
    unsafe {
        let _ = munlock(std::ptr::NonNull::new(ptr as *mut core::ffi::c_void).unwrap(), len);
    }
}

#[cfg(windows)]
pub fn lock_memory(ptr: *const u8, len: usize) {
    use winapi::ctypes::c_void;
    use winapi::um::memoryapi::VirtualLock;
    if len == 0 {
        return;
    }
    unsafe {
        if VirtualLock(ptr as *mut c_void, len) == 0 {
            eprintln!("Memory locking: VirtualLock a échoué — les secrets peuvent être swappés sur disque.");
        }
    }
}

#[cfg(windows)]
pub fn unlock_memory(ptr: *const u8, len: usize) {
    use winapi::ctypes::c_void;
    use winapi::um::memoryapi::VirtualUnlock;
    if len == 0 {
        return;
    }
    unsafe {
        let _ = VirtualUnlock(ptr as *mut c_void, len);
    }
}

#[cfg(not(any(unix, windows)))]
pub fn lock_memory(_ptr: *const u8, _len: usize) {}
#[cfg(not(any(unix, windows)))]
pub fn unlock_memory(_ptr: *const u8, _len: usize) {}

// ========== ANTI-KEYLOGGER (heuristique best-effort) ==========
//
// ⚠️ Limitation honnête : il n'existe pas d'API publique fiable pour
// énumérer les hooks clavier globaux (`WH_KEYBOARD_LL` sous Windows) déjà
// posés par un autre processus — c'est un choix délibéré de conception des
// OS modernes. Ce qu'on peut faire raisonnablement en best-effort : scanner
// les processus en cours à la recherche de noms connus de keyloggers/RAT.
// Cela ne détecte ni les hooks personnalisés ni les keyloggers matériels ;
// c'est une alerte indicative, pas une garantie de sécurité — le message
// renvoyé au frontend le précise explicitement.
const SUSPICIOUS_PROCESS_PATTERNS: &[&str] = &[
    "keylogger",
    "klogger",
    "spyrix",
    "revealer",
    "refog",
    "actualkeylogger",
    "ardamax",
    "hawkeye",
    "snakekeylogger",
    "agenttesla",
    "logixoft",
];

pub fn detect_global_keyboard_hooks() -> SecurityAlert {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut matches = Vec::new();
    for process in sys.processes().values() {
        let name = process.name().to_string_lossy().to_lowercase();
        if SUSPICIOUS_PROCESS_PATTERNS.iter().any(|p| name.contains(p)) {
            matches.push(process.name().to_string_lossy().to_string());
        }
    }
    matches.sort();
    matches.dedup();

    if matches.is_empty() {
        SecurityAlert {
            hook_detected: false,
            message: "Aucun processus suspect connu détecté (vérification heuristique — ne garantit pas \
                      l'absence de keylogger, notamment matériel ou inconnu de cette liste)."
                .to_string(),
            suspicious_processes: Vec::new(),
        }
    } else {
        SecurityAlert {
            hook_detected: true,
            message: format!(
                "Processus potentiellement suspect(s) détecté(s) : {}. Vérifiez-les avant de saisir votre \
                 master password.",
                matches.join(", ")
            ),
            suspicious_processes: matches,
        }
    }
}

#[tauri::command]
pub fn check_keyboard_security() -> SecurityAlert {
    detect_global_keyboard_hooks()
}
