//! TradeBoard desktop shell.
//!
//! Wraps the existing TradeBoard web app in a native window so the "Apps" tab
//! can actually launch and close programs. The web app itself is unchanged and
//! still deploys to Cloudflare Pages exactly as before; this shell loads a LOCAL
//! copy (desktop/dist/index.html, produced by `npm run build:desktop`) rather
//! than the remote URL, so it works offline and isn't affected by a bad deploy.

mod process;
mod scheduler;
mod state;

// The data model and schedule maths live in the GUI-free `tradeboard-core`
// crate (so they can be tested without linking Tauri). Re-export them under the
// paths the rest of this crate uses.
pub use tradeboard_core::model;
pub use tradeboard_core::schedule;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

use state::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            state::set_items,
            state::pick_executable,
            state::validate_path,
            state::launch_app,
            state::open_item,
            state::close_item,
            state::list_running,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // ── system tray ────────────────────────────────────────────────
            // Closing the main window hides it instead of quitting, so the
            // scheduler keeps running in the background (spec §4).
            let show = MenuItem::with_id(app, "show", "Open TradeBoard", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("tradeboard-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("TradeBoard — schedules are running")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click the tray icon to bring the window back.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ── background scheduler ───────────────────────────────────────
            scheduler::spawn(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Only the MAIN window hides-instead-of-closes. A site child
                // window must really close — that's the whole point of it.
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
