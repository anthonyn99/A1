//! Agent state that has to survive a reboot.
//!
//! Emergency Mode persists across a restart (a deliberate product decision —
//! otherwise rebooting is a trivial bypass), and the agent starts before any
//! network is available. So everything needed to re-arm lives on disk, in
//! %APPDATA%\Shield\state.json, and is read before Firestore is even contacted.
//!
//! This file also carries the last configuration the page pushed down, which is
//! what makes the tray menu and the global hotkeys work with no window open and
//! no internet — the case Shield actually exists for.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::proc::Target;
use crate::shortcuts::shield_dir;

fn state_path() -> PathBuf {
    shield_dir().join("state.json")
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EmergencyCfg {
    #[serde(default)]
    pub targets: Vec<Target>,
    #[serde(default, rename = "lockWorkstation")]
    pub lock_workstation: bool,
    #[serde(default = "yes")]
    pub watchdog: bool,
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentState {
    /// This machine's Shield device id.
    ///
    /// The agent owns it rather than the page, because the Tauri WebView has
    /// its own localStorage partition — separate from Edge or Chrome on the
    /// same PC, even though the origin is identical. Left to the page, opening
    /// Shield in the agent and opening it in a browser registered the same
    /// machine twice. Now the agent hands its id down and both agree.
    #[serde(default)]
    pub device_id: String,
    /// Which profile last used this device — only ever "tony" or "veda".
    #[serde(default)]
    pub profile: String,
    #[serde(default)]
    pub closer: Vec<Target>,
    /// Applications whose launch automatically runs the Program Closer.
    ///
    /// Open a game, everything else tidies itself away. Stored with the rest of
    /// the config so it survives a restart and works with no window open.
    #[serde(default)]
    pub triggers: Vec<Target>,
    #[serde(default)]
    pub emergency: EmergencyCfg,

    #[serde(default)]
    pub emergency_active: bool,
    #[serde(default)]
    pub emergency_at: u64,
    /// "local" | "remote" — which one is shown on the takeover screen.
    #[serde(default)]
    pub emergency_source: String,
    /// History entry this lockdown belongs to, so its stash can be restored.
    #[serde(default)]
    pub entry_id: String,
    /// Highest profile-wide emergency version this device has already applied.
    ///
    /// Persisted so a restart neither re-fires a lockdown that was already
    /// handled nor re-lifts one that is still meant to be raised.
    #[serde(default)]
    pub remote_v: u64,

    /// Custom External Link button id → local file path, mirrored down from
    /// TaskHub's `dashboards/navorder` by shield.html (see its navorder
    /// listener). TaskHub runs in a plain browser tab with no way to launch a
    /// program on this PC itself, so a button whose "url" is actually a local
    /// path hands off to this agent via the `shieldopen:<id>` protocol instead
    /// of opening a tab — see `main::open_from_link`. The id is opaque on
    /// purpose: the real path never travels in the link, so a page that merely
    /// knows the scheme name cannot make Shield launch an arbitrary path, only
    /// one the user already put in their own Settings.
    #[serde(default)]
    pub local_links: HashMap<String, String>,
}

pub static STATE: Mutex<Option<AgentState>> = Mutex::new(None);

/// Lock the state, tolerating poisoning.
///
/// A poisoned mutex only means some other thread panicked while holding it —
/// the data behind it is still structurally valid. `.unwrap()` would turn one
/// transient panic into an agent that panics on every subsequent access, which
/// is how a single fault becomes "Shield keeps closing".
fn lock() -> std::sync::MutexGuard<'static, Option<AgentState>> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn load() -> AgentState {
    let s = fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<AgentState>(&raw).ok())
        // A corrupt or half-written state file must not stop the agent from
        // starting. Defaults mean "no emergency, no targets", which is safe in
        // the sense that matters: it never kills something the user did not ask
        // for. The cost is that a lockdown could be forgotten across a crash,
        // and that is the right way round for this trade.
        .unwrap_or_default();
    *lock() = Some(s.clone());
    s
}

pub fn get() -> AgentState {
    lock().clone().unwrap_or_default()
}

pub fn update<F: FnOnce(&mut AgentState)>(f: F) -> AgentState {
    let mut guard = lock();
    let mut s = guard.clone().unwrap_or_default();
    f(&mut s);
    *guard = Some(s.clone());
    drop(guard);
    save(&s);
    s
}

fn save(s: &AgentState) {
    let dir = shield_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    // Write-then-rename, so a power cut during the write cannot leave a
    // truncated state.json that reads as "no emergency".
    let tmp = dir.join("state.json.tmp");
    if let Ok(json) = serde_json::to_string_pretty(s) {
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, state_path());
        }
    }
}

/// This machine's device id, minted once and then stable forever.
///
/// Same `dev_<rand36><time36>` shape the page uses, so the two are
/// indistinguishable downstream.
pub fn device_id() -> String {
    let existing = get().device_id;
    if !existing.is_empty() {
        return existing;
    }
    let t = now_ms();
    let seed = std::process::id() as u64 ^ t.rotate_left(17);
    let id = format!("dev_{:x}{:x}", seed & 0xffff_ffff, t & 0xffff_ffff);
    update(|st| st.device_id = id.clone());
    id
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
