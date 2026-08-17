//! Learning about a profile-wide emergency with no browser open.
//!
//! The web page finds out through its Firestore listener. The agent cannot: it
//! runs with the window shut, which is the whole reason it exists. So it polls
//! the Cloudflare Worker instead.
//!
//! Polling the Worker rather than Firestore directly is a cost decision. A poll
//! straight to Firestore is a billed read per device per poll — about 2,900 a
//! day per device at this interval — and this project has already come within a
//! few hundred reads of the daily free quota once. The Worker answers from KV,
//! which is a separate and far larger allowance, so this costs no Firestore
//! reads at all.
//!
//! Latency is up to `POLL_SECS`. That is the honest trade: sub-second delivery
//! needs a held-open connection (gRPC Listen, or a Durable Object), which is
//! considerably more machinery. When the page IS open on a device, its listener
//! already delivers in under a second — this only covers the closed case.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const ENDPOINT: &str = "https://taskhub-reminders.av1.workers.dev/shield/emergency";
const POLL_SECS: u64 = 20;
/// Back off after repeated failures so an outage does not mean a request every
/// twenty seconds forever.
const MAX_BACKOFF_SECS: u64 = 300;

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct RemoteState {
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub v: u64,
    #[serde(default)]
    pub at: u64,
    #[serde(default, rename = "byName")]
    pub by_name: String,
}

pub fn fetch(profile: &str, key: &str) -> Option<RemoteState> {
    // The endpoint is token-gated: without `k` it answers 403 for any profile
    // that has minted one. An older agent that has not yet been handed a token
    // still works, because the Worker leaves un-minted profiles open.
    let url = if key.is_empty() {
        format!("{ENDPOINT}?profile={profile}")
    } else {
        format!("{ENDPOINT}?profile={profile}&k={key}")
    };
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(10))
        .call()
        .ok()?;
    resp.into_json::<RemoteState>().ok()
}

/// Raise a profile-wide emergency from the agent.
///
/// The counterpart to `fetch`: this is what makes the global hotkey reach the
/// user's other devices with no window open. Raising deliberately carries no
/// password — a lockdown that has to be typed into is not a lockdown — but it
/// does carry the guard token, without which the Worker refuses the write.
///
/// Returns the accepted version on success, `None` on anything that went wrong,
/// and the caller says so. A global action that silently only worked locally is
/// the worst outcome here: the user walks away believing their other machines
/// are locked.
pub fn publish(profile: &str, key: &str, active: bool, by_id: &str, by_name: &str) -> Option<u64> {
    if profile.is_empty() {
        return None;
    }
    let body = serde_json::json!({
        "profile": profile,
        "active": active,
        // Date.now() in the page; the Worker only ever moves this forward, so a
        // slow clock here cannot roll a newer state back.
        "v": crate::state::now_ms(),
        "byId": by_id,
        "byName": by_name,
        "k": key,
        // Asks the Worker to mirror this into Firestore as well.
        //
        // The page writes Firestore itself when IT raises an emergency; the
        // agent cannot — it holds no Firebase credentials, by design. Without
        // the mirror a lockdown raised from the tray or a hotkey reached every
        // agent but left every SCREEN, including the phone's, still saying
        // "this device only". Only sent on this path, so the page's own writes
        // are never duplicated.
        "via": "agent",
    });
    match ureq::post(ENDPOINT)
        .timeout(Duration::from_secs(10))
        .send_json(body)
    {
        Ok(r) => r.into_json::<serde_json::Value>().ok().and_then(|j| {
            if j.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                Some(j.get("v").and_then(|v| v.as_u64()).unwrap_or(0))
            } else {
                None
            }
        }),
        Err(_) => None,
    }
}

pub struct Poller {
    running: Arc<AtomicBool>,
}

impl Default for Poller {
    fn default() -> Self {
        Self::new()
    }
}

impl Poller {
    pub fn new() -> Self {
        Self { running: Arc::new(AtomicBool::new(false)) }
    }

    /// `on_change` is called only when the signal is genuinely newer than what
    /// this device has already applied.
    pub fn start(&self, on_change: impl Fn(RemoteState) + Send + 'static) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let running = self.running.clone();
        thread::spawn(move || {
            let mut backoff = POLL_SECS;
            while running.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_secs(backoff));
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                let s = crate::state::get();
                if s.profile.is_empty() {
                    // Nobody has signed in on this device yet, so there is no
                    // profile to ask about.
                    continue;
                }
                match fetch(&s.profile, &s.guard_key) {
                    Some(r) => {
                        backoff = POLL_SECS;
                        // Monotonic: only ever move forward. A replayed or
                        // stale answer must not re-fire a lockdown that was
                        // already lifted.
                        if r.v > s.remote_v {
                            crate::state::update(|st| st.remote_v = r.v);
                            on_change(r);
                        }
                    }
                    None => {
                        backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
                    }
                }
            }
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}
