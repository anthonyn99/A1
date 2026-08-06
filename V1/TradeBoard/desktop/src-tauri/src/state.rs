//! Shared runtime state and the Tauri commands the frontend invokes.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::model::*;
use crate::process::{self, ProcRegistry};
use crate::schedule;

/// How long a program gets to exit politely before it is force-killed.
const GRACE: Duration = Duration::from_millis(2500);

/// Per-item scheduler bookkeeping that must survive between ticks.
#[derive(Debug, Default, Clone)]
pub struct ItemRuntime {
    /// Set when the user closes an item by hand during a window in which the
    /// schedule says it should be open. While set, the scheduler will not
    /// relaunch it. Cleared when the window's start edge changes (§4).
    pub suppressed_until_next_start: bool,
    /// The start edge that was current when suppression was recorded.
    pub suppressed_for_edge: Option<DateTime<Utc>>,
}

pub struct AppState {
    pub items: Mutex<Vec<LaunchItem>>,
    pub procs: ProcRegistry,
    pub runtime: Mutex<HashMap<String, ItemRuntime>>,
    pub sys: Mutex<System>,
    /// Timestamp of the previous scheduler tick, for edge detection.
    pub last_tick: Mutex<Option<DateTime<Utc>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            items: Mutex::new(Vec::new()),
            procs: ProcRegistry::new(),
            runtime: Mutex::new(HashMap::new()),
            sys: Mutex::new(System::new()),
            last_tick: Mutex::new(None),
        }
    }

    pub fn item(&self, id: &str) -> Option<LaunchItem> {
        self.items
            .lock()
            .unwrap()
            .iter()
            .find(|i| i.id == id)
            .cloned()
    }
}

/// Label for the child window that hosts a website item.
fn web_window_label(item_id: &str) -> String {
    // Tauri window labels allow only alphanumerics, `-`, `/`, `:`, `_`.
    let safe: String = item_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("site_{safe}")
}

/// "Is this item's process still up?", tolerant of re-parenting.
///
/// Several Windows programs exit the pid we spawned and continue under a new
/// one (modern Notepad, MSIX-packaged apps, launcher stubs). When that happens
/// we adopt the replacement pid so the item doesn't look closed — otherwise the
/// scheduler relaunches it on every single tick.
pub fn is_alive_or_reparented(
    sys: &mut System,
    procs: &ProcRegistry,
    item_id: &str,
    t: &process::Tracked,
) -> bool {
    if process::is_alive(sys, t) {
        return true;
    }
    match process::find_reparented(sys, t) {
        Some(pid) => {
            procs.repoint(item_id, pid);
            true
        }
        None => false,
    }
}

/// Emit an action to the frontend so it lands in the history log.
pub fn emit_action(app: &AppHandle, message: impl Into<String>, kind: &str) {
    let ev = ActionEvent {
        message: message.into(),
        kind: kind.to_string(),
    };
    let _ = app.emit("apps://action", ev);
}

// ── commands ────────────────────────────────────────────────────────────────

/// Replace the scheduler's view of the item list. Called on every save and on
/// every inbound cloud sync, so a disable takes effect without a restart (§4).
#[tauri::command]
pub fn set_items(items: Vec<LaunchItem>, state: State<'_, AppState>) -> Result<(), String> {
    *state.items.lock().unwrap() = items;
    Ok(())
}

/// Native "Browse…" file picker.
///
/// This is a Rust command rather than a direct call to the dialog plugin's JS
/// API, because tradeboard.html has no bundler: it can only reach Tauri through
/// the `window.__TAURI__` global, and that global carries `core` + `event` only.
/// Plugin front-ends ship as separate npm packages, so `window.__TAURI__.dialog`
/// is always undefined here. Routing the picker through `invoke` keeps the whole
/// bridge on one mechanism that actually exists.
///
/// Returns the chosen path, or `None` if the user cancelled.
#[tauri::command]
pub async fn pick_executable(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Programs", &["exe", "com", "bat", "cmd"])
        .set_title("Choose a program")
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });

    // pick_file is callback-based; block the async task on the reply so the
    // frontend just gets a promise that resolves with the path.
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|e| format!("file picker failed: {e}"))?;

    Ok(picked.map(|p| p.to_string()))
}

#[tauri::command]
pub fn validate_path(path: String) -> ValidateOutcome {
    match process::validate_exe(&path) {
        Ok(()) => ValidateOutcome {
            ok: true,
            error: None,
        },
        Err(e) => ValidateOutcome {
            ok: false,
            error: Some(e),
        },
    }
}

/// Launch a desktop app by explicit path + argument array. Exposed as its own
/// command (spec §3) as well as being used by `open_item`.
#[tauri::command]
pub fn launch_app(path: String, args: Vec<String>) -> Result<u32, String> {
    process::spawn(&path, &args)
}

/// Open an item: spawn a process, or open a website per its `openIn` mode.
#[tauri::command]
pub async fn open_item(
    item_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let item = state
        .item(&item_id)
        .ok_or_else(|| format!("No item with id {item_id}"))?;
    open_item_inner(&item, &app, &state)
}

pub fn open_item_inner(
    item: &LaunchItem,
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    match item.item_type {
        ItemType::DesktopApp => {
            let path = item
                .target
                .path
                .as_deref()
                .ok_or("This item has no executable path.")?;
            let args = item.target.args.clone().unwrap_or_default();

            // Already running (and still ours)? Do nothing rather than spawn a
            // second copy.
            if let Some(t) = state.procs.get(&item.id) {
                let mut sys = state.sys.lock().unwrap();
                if is_alive_or_reparented(&mut sys, &state.procs, &item.id, &t) {
                    return Ok(());
                }
            }
            let pid = process::spawn(path, &args)?;
            state.procs.insert(&item.id, pid, path);
            Ok(())
        }
        ItemType::Website => {
            let url = item
                .target
                .url
                .as_deref()
                .ok_or("This item has no URL.")?;
            match item.open_in() {
                OpenIn::DefaultBrowser => {
                    // Best-effort, open-only: we hand the URL to the OS and lose
                    // all control over it (see README "website close").
                    open_in_default_browser(url)
                }
                OpenIn::ChildWindow => {
                    let label = web_window_label(&item.id);
                    if app.get_webview_window(&label).is_some() {
                        return Ok(()); // already open
                    }
                    let parsed: tauri::Url = url
                        .parse()
                        .map_err(|_| format!("{url} is not a valid URL."))?;
                    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
                        .title(&item.name)
                        .inner_size(1100.0, 800.0)
                        .resizable(true)
                        .build()
                        .map_err(|e| format!("Could not open a window for {url}: {e}"))?;
                    Ok(())
                }
            }
        }
    }
}

/// Open a URL in the user's default browser without a shell string.
fn open_in_default_browser(url: &str) -> Result<(), String> {
    // Validate before handing anything to the OS.
    let parsed: tauri::Url = url
        .parse()
        .map_err(|_| format!("{url} is not a valid URL."))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http:// and https:// URLs can be opened.".into());
    }
    // `cmd /C start "" <url>` is the usual trick but involves the interpreter;
    // rundll32's URL handler takes the URL as a single argv entry instead.
    std::process::Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(parsed.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open {url}: {e}"))
}

/// Close an item.
///
/// `manual` distinguishes a user pressing "Close now" (which arms suppression so
/// the scheduler doesn't immediately reopen it) from an automatic/rule-driven
/// close.
#[tauri::command]
pub async fn close_item(
    item_id: String,
    manual: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CloseOutcome, String> {
    let item = state.item(&item_id);
    let outcome = close_item_inner(item.as_ref(), &item_id, &app, &state)?;

    if manual {
        if let Some(item) = item.as_ref() {
            let now = Utc::now();
            // Only suppress if we're inside a window that WOULD reopen it.
            if schedule::item_should_be_open(item, now) {
                let edge = schedule::last_start_edge(item, now);
                let mut rt = state.runtime.lock().unwrap();
                let e = rt.entry(item_id.clone()).or_default();
                e.suppressed_until_next_start = true;
                e.suppressed_for_edge = edge;
            }
        }
    }
    Ok(outcome)
}

pub fn close_item_inner(
    item: Option<&LaunchItem>,
    item_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<CloseOutcome, String> {
    // A website in a child window: closing the window is the close.
    if let Some(it) = item {
        if it.item_type == ItemType::Website {
            return match it.open_in() {
                OpenIn::ChildWindow => {
                    let label = web_window_label(item_id);
                    match app.get_webview_window(&label) {
                        Some(w) => {
                            w.close().map_err(|e| format!("Could not close window: {e}"))?;
                            Ok(CloseOutcome { noop: false })
                        }
                        None => Ok(CloseOutcome { noop: true }),
                    }
                }
                // We never opened a controllable surface, so there is nothing we
                // may close. Reported as a no-op, not an error (§3).
                OpenIn::DefaultBrowser => Ok(CloseOutcome { noop: true }),
            };
        }
    }

    // Desktop app: only ever terminate a PID we ourselves recorded (§5).
    let Some(tracked) = state.procs.get(item_id) else {
        // No tracked PID. We may still ANSWER whether something matching is
        // running, but we must not kill it — the user may have started it.
        return Ok(CloseOutcome { noop: true });
    };

    let mut sys = state.sys.lock().unwrap();
    let killed = process::terminate(&mut sys, &tracked, GRACE)?;
    drop(sys);
    state.procs.remove(item_id);
    Ok(CloseOutcome { noop: !killed })
}

/// Current status for every item, reconciled against real OS state on every
/// call rather than trusting the in-memory map (§3).
#[tauri::command]
pub fn list_running(app: AppHandle, state: State<'_, AppState>) -> Vec<RunningStatus> {
    let items = state.items.lock().unwrap().clone();
    let mut out = Vec::with_capacity(items.len());
    let mut stale: Vec<String> = Vec::new();

    {
        let mut sys = state.sys.lock().unwrap();
        for item in &items {
            let running = match item.item_type {
                ItemType::Website => match item.open_in() {
                    OpenIn::ChildWindow => {
                        app.get_webview_window(&web_window_label(&item.id)).is_some()
                    }
                    // A browser tab we handed off is genuinely unknowable.
                    OpenIn::DefaultBrowser => false,
                },
                ItemType::DesktopApp => match state.procs.get(&item.id) {
                    Some(t) => {
                        let alive =
                            is_alive_or_reparented(&mut sys, &state.procs, &item.id, &t);
                        if !alive {
                            stale.push(item.id.clone());
                        }
                        alive
                    }
                    None => item
                        .target
                        .path
                        .as_deref()
                        .map(|p| process::any_running_by_path(&mut sys, p))
                        .unwrap_or(false),
                },
            };
            let suppressed = state
                .runtime
                .lock()
                .unwrap()
                .get(&item.id)
                .map(|r| r.suppressed_until_next_start)
                .unwrap_or(false);
            out.push(RunningStatus {
                id: item.id.clone(),
                running,
                suppressed,
            });
        }
    }

    // Drop PIDs that have exited so the map doesn't grow stale entries.
    for id in stale {
        state.procs.remove(&id);
    }
    out
}
