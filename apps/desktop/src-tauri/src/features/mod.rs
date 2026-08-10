pub mod security;
pub mod sharing;
pub mod auto_type;
pub mod steganography;
pub mod journal;
pub mod native_messaging;
// p2p désactivé pour l'instant (spec #6/#7, hors du lot de fonctionnalités traité ici)
// pub mod p2p;

use tauri::Manager;

pub fn init_advanced_features(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Display Shield (uniquement sur les plateformes supportées)
    if let Some(window) = app.get_webview_window("main") {
        security::apply_display_shield(&window);
    }

    // Journal et Native Messaging : fonctionnalités desktop uniquement.
    // Sur Android, l'écriture dans config_dir() et l'ouverture d'un socket
    // TCP au démarrage échouent → crash SIGABRT. On les désactive sur mobile.
    #[cfg(not(target_os = "android"))]
    {
        journal::init_journal()?;

        // Native Messaging : relais TCP local vers le processus `--native-host`
        // (voir main.rs) que Chrome/Firefox lance pour parler à l'extension.
        let handle = app.handle().clone();
        native_messaging::start_native_relay(handle)?;
    }

    // Auto-type : raccourci global Ctrl+Alt+A (Cmd+Option+A sur macOS, géré
    // automatiquement par le parsing de "CmdOrCtrl+Alt+A"). Le raccourci
    // émet un évènement "auto-type-trigger" que le frontend écoute pour
    // afficher le Quick Launcher et proposer une entrée à taper.
    #[cfg(desktop)]
    {
        use tauri::Emitter;
        use tauri_plugin_global_shortcut::ShortcutState;

        let shortcut: tauri_plugin_global_shortcut::Shortcut = "CmdOrCtrl+Alt+A"
            .parse()
            .map_err(|e| format!("Raccourci auto-type invalide: {e:?}"))?;

        app.handle().plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app_handle, triggered, event| {
                    if *triggered == shortcut && event.state == ShortcutState::Pressed {
                        let _ = app_handle.emit("auto-type-trigger", ());
                    }
                })
                .build(),
        )?;

        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        if let Err(e) = app.global_shortcut().register(shortcut) {
            // Non fatal : un autre logiciel a peut-être déjà pris ce raccourci.
            eprintln!("Impossible d'enregistrer le raccourci auto-type Ctrl+Alt+A: {e}");
        }
    }

    Ok(())
}
