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
/// How often the agent asks the Worker about a profile-wide emergency.
///
/// Every poll is a KV read, around the clock, on every machine with an agent —
/// so this number is a standing bill, not a one-off. At 20s two agents spent
/// 17,000 KV reads a day between them, 17% of the whole account's daily free
/// tier, purely to discover that nothing had changed. 45s costs a third of that
/// and moves the worst case from 20 seconds to 45.
///
/// That is the right trade because this path only covers the narrow case where
/// Shield's window is CLOSED on the target machine. With the page open its
/// Firestore listener already delivers in under a second, and a lockdown raised
/// from a phone is not a race won or lost in twenty-five seconds.
const POLL_SECS: u64 = 45;
/// Back off after repeated failures so an outage does not mean a request every
/// twenty seconds forever.
const MAX_BACKOFF_SECS: u64 = 300;
/// Granularity of the wait between polls.
///
/// Small enough that a resume is noticed promptly, large enough that the thread
/// is doing nothing measurable in between. This costs no extra requests — only
/// the sleep is divided, not the polling.
const SLICE_SECS: u64 = 5;
/// How far the wall clock may move during one slice before it is read as a
/// suspend rather than ordinary scheduling jitter.
const RESUME_SKEW_SECS: u64 = 10;

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
            // Ask IMMEDIATELY, before the first sleep.
            //
            // This is the whole of "an emergency raised while this laptop was
            // off must land the moment it comes back". The agent starts with
            // Windows, so boot and resume-from-hibernate both arrive here; if
            // the loop slept first, a machine that had been off for a day would
            // still sit unlocked for the poll interval after the user opened
            // the lid — exactly the window the feature exists to close.
            let mut due_now = true;
            while running.load(Ordering::SeqCst) {
                if !due_now {
                    // Sleep in short slices rather than one long block. A thread
                    // parked in a 45-second sleep across a suspend does not
                    // resume promptly on wake — the remainder of the sleep is
                    // served on the far side of it, so the first poll after
                    // waking could be a full interval late on top of however
                    // long the machine was out. Slicing also lets a wall-clock
                    // jump be noticed, which is what actually identifies a
                    // resume.
                    let mut slept = 0u64;
                    let mut last = std::time::SystemTime::now();
                    while slept < backoff && running.load(Ordering::SeqCst) {
                        thread::sleep(Duration::from_secs(SLICE_SECS));
                        slept += SLICE_SECS;
                        // A jump far larger than the slice means the machine was
                        // suspended. Stop waiting and go ask straight away.
                        let now = std::time::SystemTime::now();
                        let jumped = now
                            .duration_since(last)
                            .map(|d| d.as_secs() > SLICE_SECS + RESUME_SKEW_SECS)
                            .unwrap_or(true);
                        last = now;
                        if jumped {
                            // Also drop any backoff: whatever network failure
                            // caused it happened before a suspend, and the link
                            // on the other side is a fresh one.
                            backoff = POLL_SECS;
                            break;
                        }
                    }
                }
                due_now = false;
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
