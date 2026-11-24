mod audio;
mod commands;
mod compute;
mod diarize;
mod engine;
mod models;
mod runtime;
mod sessions;
mod settings;
mod state;
mod stt;
mod translate;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

use crate::state::AppState;

/// Tells the interface which shortcut or menu item fired.
fn send_shortcut(app: &tauri::AppHandle, name: &str) {
    let _ = app.emit("shortcut", name);
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }

                    let primary = Modifiers::SUPER | Modifiers::SHIFT;
                    let other   = Modifiers::CONTROL | Modifiers::SHIFT;

                    for (code, name) in [(Code::Space, "toggle"), (Code::KeyS, "subtitles"), (Code::KeyL, "lock")] {
                        if shortcut == &Shortcut::new(Some(primary), code) || shortcut == &Shortcut::new(Some(other), code) {
                            send_shortcut(app, name);
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let data_dir   = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;

            // Clean up anything an interrupted session left behind.
            models::sweep_incomplete(&data_dir.join("models"));
            runtime::sweep(&data_dir);
            sessions::sweep(&data_dir);

            app.manage(AppState::new(data_dir, config_dir));

            // Global shortcuts: Cmd+Shift on macOS, Ctrl+Shift elsewhere.
            #[cfg(target_os = "macos")]
            let modifiers = Modifiers::SUPER | Modifiers::SHIFT;
            #[cfg(not(target_os = "macos"))]
            let modifiers = Modifiers::CONTROL | Modifiers::SHIFT;

            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;

                for code in [Code::Space, Code::KeyS, Code::KeyL] {
                    if let Err(err) = app.global_shortcut().register(Shortcut::new(Some(modifiers), code)) {
                        log::warn!("could not register a global shortcut: {err}");
                    }
                }
            }

            // Menu-bar / tray icon.
            let toggle    = MenuItem::with_id(app, "toggle", "Start or stop translating", true, None::<&str>)?;
            let subtitles = MenuItem::with_id(app, "subtitles", "Show or hide subtitles", true, None::<&str>)?;
            let lock      = MenuItem::with_id(app, "lock", "Lock or unlock subtitles", true, None::<&str>)?;
            let open      = MenuItem::with_id(app, "open", "Open Pheasa", true, None::<&str>)?;
            let quit      = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu      = Menu::with_items(app, &[&toggle, &subtitles, &lock, &open, &quit])?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("Pheasa")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    name   => send_shortcut(app, name),
                });

            // macOS wants a single-colour "template" image in the menu bar, which it
            // tints for light, dark and highlighted states. Other systems get the app icon.
            #[cfg(target_os = "macos")]
            {
                let template = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
                tray = tray.icon(template).icon_as_template(true);
            }

            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            tray.build(app)?;

            // Native sidebar material behind the translucent sidebar.
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                use tauri::window::{Effect, EffectState, EffectsBuilder};

                let _ = window.set_effects(
                    EffectsBuilder::new()
                        .effect(Effect::Sidebar)
                        .state(EffectState::Active)
                        .build(),
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::list_compute_devices,
            commands::list_audio_devices,
            commands::start_engine,
            commands::stop_engine,
            commands::engine_running,
            commands::start_monitor,
            commands::stop_monitor,
            commands::list_voices,
            commands::delete_voice,
            commands::rename_voice,
            commands::enroll_voice,
            commands::remember_voice,
            commands::search_models,
            commands::recommended_models,
            commands::download_model,
            commands::cancel_download,
            commands::list_installed,
            commands::delete_model,
            commands::runtime_status,
            commands::setup_runtime,
            commands::add_mlx_runtime,
            commands::remove_runtime,
            commands::storage_report,
            commands::reveal_data_dir,
            commands::save_session,
            commands::list_sessions,
            commands::load_session,
            commands::delete_session,
            commands::clear_sessions,
            commands::set_overlay,
            commands::save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Pheasa");
}
