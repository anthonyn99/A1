//! Shield desktop agent — the part of Shield that can actually close things.
//!
//! `shield.html` is loaded from https://anthonyn99.github.io/A1/shield.html, not
//! bundled. That is deliberate and load-bearing:
//!   · the auth Worker pins CORS to that exact origin (workers/taskhub-reminders/worker.js:23),
//!   · Firebase App Check's reCAPTCHA site key is registered for it and is SHARED
//!     by every A1 app — re-registering it breaks the whole suite an hour later,
//!   · Firestore rejects a `file://` / `tauri://` origin outright.
//! Loading the live page sidesteps all three and leaves exactly one copy of the
//! UI to maintain.
//!
//! The consequence is that the window needs the network. The tray menu and the
//! global hotkeys deliberately do NOT: they read the last configuration the page
//! pushed into %APPDATA%\Shield\state.json and run entirely in Rust. Closing
//! apps must work when the internet is down, when the page has never been
//! opened on this boot, and when there is no window at all.

mod history;
mod proc;
mod shortcuts;
mod state;
mod watchdog;

use serde::Deserialize;
use serde_json::json;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};

use proc::{LaunchItem, Target};
use state::EmergencyCfg;
use watchdog::Watchdog;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const GRACEFUL_MS: u64 = 1500;
/// Kept in step with tauri.conf.json's window url and the capability's
/// remote.urls. tests/agent-contract.test.js checks all three agree.
const PAGE_URL: &str = "https://anthonyn99.github.io/A1/shield.html";

pub struct Ctx {
    pub wd: Watchdog,
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn lock_workstation() {
    unsafe {
        let _ = windows::Win32::System::Shutdown::LockWorkStation();
    }
}

fn tray_icon_bytes(alert: bool) -> &'static [u8] {
    if alert {
        include_bytes!("../icons/icon-alert.ico")
    } else {
        include_bytes!("../icons/icon.ico")
    }
}

/// Repaint the tray and tell any open window what just happened.
///
/// The tray icon turning red is the only feedback there is when Emergency Mode
/// was triggered by a hotkey with no window open, so it is not decoration.
fn publish(app: &AppHandle, active: bool) {
    if let Some(tray) = app.tray_by_id("shield") {
        if let Ok(img) = tauri::image::Image::from_bytes(tray_icon_bytes(active)) {
            let _ = tray.set_icon(Some(img));
        }
        let _ = tray.set_tooltip(Some(if active { "Shield — LOCKED" } else { "Shield" }));
    }
    let s = state::get();
    let _ = app.emit(
        "shield://state",
        json!({
            "emergency": { "active": s.emergency_active, "at": s.emergency_at,
                           "source": s.emergency_source, "entryId": s.entry_id },
            "watchdog": active,
        }),
    );
}

/// The whole of Emergency Mode, in the order that matters.
///
/// Capture and close first, bookkeeping after. Everything before the return is
/// synchronous local work: no network call sits between pressing the button and
/// the applications going away.
fn engage_emergency(app: &AppHandle, ctx: &Ctx, source: &str) -> serde_json::Value {
    let s = state::get();
    let cfg = s.emergency.clone();
    let entry_id = history::new_id();

    let results = proc::capture_and_kill(&cfg.targets, GRACEFUL_MS);
    let hidden = shortcuts::hide(&entry_id, &cfg.targets);

    if cfg.watchdog {
        ctx.wd.start(cfg.targets.clone());
    }

    let entry = history::record(
        &entry_id,
        "emergency",
        if source == "remote" { "global" } else { "local" },
        source,
        &results,
        &hidden,
    );

    state::update(|st| {
        st.emergency_active = true;
        st.emergency_at = entry.at;
        st.emergency_source = source.to_string();
        st.entry_id = entry_id.clone();
    });

    // Last, because it takes the screen away from the user and everything above
    // must already have happened by then.
    if cfg.lock_workstation {
        lock_workstation();
    }

    publish(app, true);
    json!({ "entryId": entry_id, "at": entry.at, "results": results, "hidden": hidden })
}

fn disengage_emergency(app: &AppHandle, ctx: &Ctx) -> serde_json::Value {
    ctx.wd.stop();
    let s = state::get();
    let restored = if s.entry_id.is_empty() {
        shortcuts::restore_all()
    } else {
        shortcuts::restore(&s.entry_id)
    };
    state::update(|st| {
        st.emergency_active = false;
        st.emergency_source = String::new();
        st.entry_id = String::new();
    });
    publish(app, false);
    json!({ "restored": restored })
}

fn run_closer(app: &AppHandle) -> serde_json::Value {
    let s = state::get();
    let entry_id = history::new_id();
    let results = proc::capture_and_kill(&s.closer, GRACEFUL_MS);
    let entry = history::record(&entry_id, "closer", "local", "local", &results, &[]);
    let _ = app.emit("shield://closed", json!({ "entryId": entry_id }));
    json!({ "entryId": entry_id, "at": entry.at, "results": results })
}

// ── commands ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SetConfig {
    #[serde(default)]
    profile: String,
    #[serde(default)]
    closer: Vec<Target>,
    #[serde(default)]
    emergency: EmergencyCfg,
}

/// The page pushes its device configuration down on every change.
///
/// Without this the tray and the hotkeys would have nothing to act on, which
/// would make the agent useless in exactly the situation it exists for.
#[tauri::command]
fn sh_set_config(cfg: SetConfig) -> serde_json::Value {
    // Filter protected processes here as well as in the kill path. Config
    // arrives from Firestore and may have been written by an older build or a
    // different device, so input validation cannot live only at the UI.
    let clean = |v: Vec<Target>| -> Vec<Target> {
        v.into_iter().filter(|t| !proc::is_denied(&t.r#match.value)).collect()
    };
    state::update(|st| {
        if !cfg.profile.is_empty() {
            st.profile = cfg.profile.clone();
        }
        st.closer = clean(cfg.closer.clone());
        st.emergency = EmergencyCfg {
            targets: clean(cfg.emergency.targets.clone()),
            lock_workstation: cfg.emergency.lock_workstation,
            watchdog: cfg.emergency.watchdog,
        };
    });
    json!({ "ok": true })
}

#[tauri::command]
fn sh_status(ctx: State<'_, Ctx>) -> serde_json::Value {
    let s = state::get();
    json!({
        "version": VERSION,
        "platform": "windows",
        "deviceId": state::device_id(),
        "emergency": { "active": s.emergency_active, "at": s.emergency_at,
                       "source": s.emergency_source, "entryId": s.entry_id },
        "watchdog": ctx.wd.is_running(),
        "targets": { "closer": s.closer.len(), "emergency": s.emergency.targets.len() },
        "caps": {
            "kill": true, "watchdog": true, "hideIcons": true,
            "lockWorkstation": true, "tray": true, "launch": true
        }
    })
}

#[tauri::command]
fn sh_enumerate() -> serde_json::Value {
    let (running, shortcuts) = proc::enumerate();
    json!({ "running": running, "shortcuts": shortcuts })
}

#[derive(Deserialize)]
pub struct KillArgs {
    #[serde(default)]
    targets: Vec<Target>,
    /// Report what would be closed without closing it. Nothing is recorded in
    /// history either — a preview is not an action.
    #[serde(default, rename = "dryRun")]
    dry_run: bool,
}

/// Close the Program Closer targets.
///
/// `targets` may be supplied by the caller; when it is empty the stored config
/// is used, which is what the tray path relies on.
#[tauri::command]
fn sh_kill(app: AppHandle, args: KillArgs) -> serde_json::Value {
    if args.dry_run {
        let list = if args.targets.is_empty() { state::get().closer } else { args.targets };
        return json!({ "dryRun": true, "results": proc::capture_and_kill_opt(&list, 0, true) });
    }
    if !args.targets.is_empty() {
        state::update(|st| {
            st.closer = args.targets.iter().filter(|t| !proc::is_denied(&t.r#match.value)).cloned().collect();
        });
    }
    run_closer(&app)
}

#[derive(Deserialize)]
pub struct EmergencyArgs {
    #[serde(default)]
    targets: Vec<Target>,
    #[serde(default)]
    watchdog: Option<bool>,
    #[serde(default, rename = "lockWorkstation")]
    lock_workstation: Option<bool>,
    #[serde(default)]
    source: Option<String>,
}

#[tauri::command]
fn sh_emergency_on(app: AppHandle, ctx: State<'_, Ctx>, args: EmergencyArgs) -> serde_json::Value {
    if !args.targets.is_empty() || args.watchdog.is_some() || args.lock_workstation.is_some() {
        state::update(|st| {
            if !args.targets.is_empty() {
                st.emergency.targets =
                    args.targets.iter().filter(|t| !proc::is_denied(&t.r#match.value)).cloned().collect();
            }
            if let Some(w) = args.watchdog {
                st.emergency.watchdog = w;
            }
            if let Some(l) = args.lock_workstation {
                st.emergency.lock_workstation = l;
            }
        });
    }
    engage_emergency(&app, &ctx, args.source.as_deref().unwrap_or("local"))
}

#[tauri::command]
fn sh_emergency_off(app: AppHandle, ctx: State<'_, Ctx>) -> serde_json::Value {
    disengage_emergency(&app, &ctx)
}

#[derive(Deserialize)]
pub struct LaunchArgs {
    #[serde(default, rename = "entryId")]
    entry_id: String,
    #[serde(default)]
    items: Vec<LaunchGroup>,
}
#[derive(Deserialize)]
pub struct LaunchGroup {
    #[serde(default)]
    label: String,
    #[serde(default)]
    launch: Vec<LaunchItem>,
}

/// Reopen what was closed.
///
/// The page normally passes the manifest it holds; when it passes only an
/// `entryId`, the agent's own copy is used — which is how a tray-initiated
/// close is reverted after the page is opened later.
#[tauri::command]
fn sh_launch(args: LaunchArgs) -> serde_json::Value {
    let groups: Vec<(String, Vec<LaunchItem>)> = if !args.items.is_empty() {
        args.items.into_iter().map(|g| (g.label, g.launch)).collect()
    } else if let Some(e) = history::get(&args.entry_id) {
        e.items.into_iter().map(|i| (i.label, i.launch)).collect()
    } else {
        vec![]
    };
    let results = proc::launch(&groups);
    if !args.entry_id.is_empty() {
        history::mark_reverted(&args.entry_id);
    }
    json!({ "results": results })
}

#[tauri::command]
fn sh_restore_icons(args: serde_json::Value) -> serde_json::Value {
    let id = args.get("entryId").and_then(|v| v.as_str()).unwrap_or("");
    let n = if id.is_empty() { shortcuts::restore_all() } else { shortcuts::restore(id) };
    json!({ "restored": n })
}

#[tauri::command]
fn sh_pull_history(args: serde_json::Value) -> serde_json::Value {
    let since = args.get("since").and_then(|v| v.as_u64()).unwrap_or(0);
    json!({ "entries": history::since(since) })
}

#[tauri::command]
fn sh_lock_workstation() -> serde_json::Value {
    lock_workstation();
    json!({ "ok": true })
}

// ── tray + hotkeys ──────────────────────────────────────────────────────────

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let close = MenuItem::with_id(app, "close", "Close Apps", true, None::<&str>)?;
    let emg = MenuItem::with_id(app, "emergency", "EMERGENCY", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Shield", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Shield", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&close, &emg, &sep, &open, &quit])?;

    TrayIconBuilder::with_id("shield")
        .icon(tauri::image::Image::from_bytes(tray_icon_bytes(false))?)
        .tooltip("Shield")
        .menu(&menu)
        // The menu must NOT open on a plain left click: left-click opens the
        // window, right-click gets the emergency menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| {
            let ctx = app.state::<Ctx>();
            match ev.id().as_ref() {
                "close" => {
                    run_closer(app);
                }
                "emergency" => {
                    // From the tray this is a single click by design. The whole
                    // point is speed; the passcode guards getting OUT, not in.
                    engage_emergency(app, &ctx, "local");
                }
                "open" => show_window(app),
                "quit" => {
                    // Leaving the desktop permanently missing its icons would be
                    // a far worse bug than an emergency ending early, so put the
                    // shortcuts back on the way out.
                    ctx.wd.stop();
                    shortcuts::restore_all();
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    // Ctrl+Shift+X → close apps, Ctrl+Shift+L → emergency.
    // Two copies of each: the handler closure takes ownership of one pair, and
    // setup() still needs the other pair to register them.
    let hk_close = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyX);
    let hk_emg = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyL);
    let (hk_close_h, hk_emg_h) = (hk_close.clone(), hk_emg.clone());

    tauri::Builder::default()
        // MUST be registered first. Shield starts at logon and can also be
        // launched by hand, and two agents is not a cosmetic problem: two tray
        // icons, a failed hotkey registration for whichever loses the race, and
        // two watchdogs fighting over the same process list. The second
        // instance now just surfaces the first one's window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let ctx = app.state::<Ctx>();
                    if shortcut == &hk_close_h {
                        run_closer(app);
                    } else if shortcut == &hk_emg_h {
                        engage_emergency(app, &ctx, "local");
                    }
                })
                .build(),
        )
        .manage(Ctx { wd: Watchdog::new() })
        .invoke_handler(tauri::generate_handler![
            sh_status, sh_set_config, sh_enumerate, sh_kill,
            sh_emergency_on, sh_emergency_off, sh_launch,
            sh_restore_icons, sh_pull_history, sh_lock_workstation
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let s = state::load();
            build_tray(&handle)?;

            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                // A hotkey another app already owns is a warning, not a reason to
                // refuse to start — the tray still works.
                if let Err(e) = handle.global_shortcut().register(hk_close) {
                    eprintln!("[shield] Ctrl+Shift+X unavailable: {e}");
                }
                if let Err(e) = handle.global_shortcut().register(hk_emg) {
                    eprintln!("[shield] Ctrl+Shift+L unavailable: {e}");
                }
            }

            // Boot re-arm. Emergency Mode survives a restart by design, so this
            // runs BEFORE anything touches the network: re-close the targets and
            // restart the watchdog straight from state.json.
            if s.emergency_active {
                let ctx = handle.state::<Ctx>();
                proc::capture_and_kill(&s.emergency.targets, GRACEFUL_MS);
                if s.emergency.watchdog {
                    ctx.wd.start(s.emergency.targets.clone());
                }
                publish(&handle, true);
            } else {
                // Not in an emergency, but a crash mid-lockdown could have left
                // shortcuts in the stash. Put anything stranded back.
                shortcuts::restore_all();
                publish(&handle, false);
            }

            // Force a fresh copy of the UI on every launch.
            //
            // GitHub Pages serves the page with a cache lifetime, and WebView2
            // honours it — so after an update the agent kept showing the old
            // build, including bugs that were already fixed. The page's own
            // no-cache <meta> tags do not help: those are advisory and are
            // ignored for the document itself. A per-launch query string is the
            // only reliable way to guarantee the window is running the code
            // that is actually deployed. Same origin, so localStorage, the
            // capability match and App Check are all unaffected.
            if let Some(w) = handle.get_webview_window("main") {
                let url = format!("{}?v={}-{}", PAGE_URL, VERSION, state::now_ms());
                if let Ok(parsed) = url.parse() {
                    let _ = w.navigate(parsed);
                }
            }

            // Closing the window hides it; the agent lives in the tray. Quitting
            // is an explicit choice from the menu, so that closing the window
            // cannot silently end an active lockdown.
            if let Some(w) = app.get_webview_window("main") {
                let h = handle.clone();
                w.on_window_event(move |ev| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        api.prevent_close();
                        if let Some(w) = h.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Shield");
}
