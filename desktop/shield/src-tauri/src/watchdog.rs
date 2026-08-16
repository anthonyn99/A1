//! Keeps emergency targets closed.
//!
//! Windows 11 Home has no AppLocker and no Software Restriction Policies, so
//! there is no supported way to stop an executable from starting. What is left
//! is to close it again the moment it appears. That is a real difference and
//! the UI says so: a target will visibly flash on screen before it dies.
//!
//! Rejected alternatives, for the record:
//!   · Image File Execution Options "Debugger" hijacking — needs admin, is a
//!     well-known malware technique, and gets flagged by Defender/ASR.
//!   · HKCU DisallowRun — only Explorer honours it, so it stops a double-click
//!     but not a script, a launcher or an app's own updater. Available as an
//!     opt-in extra later, never as the thing Shield relies on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::proc::{self, Target};

const TICK_MS: u64 = 750;

pub struct Watchdog {
    running: Arc<AtomicBool>,
    targets: Arc<Mutex<Vec<Target>>>,
}

/// Watches for "trigger" applications and runs the Program Closer when one
/// appears.
///
/// The point is that starting a game should tidy everything else away without
/// anyone reaching for a button. Two rules make it behave rather than thrash:
///
///   · EDGE-triggered. It fires on the transition from not-running to running,
///     not while the app is up. Otherwise launching League would re-close the
///     same set every second for the whole session.
///   · The trigger itself is never a casualty. The thing you just opened is
///     excluded from the kill, even if it also appears in the closer list —
///     "open League, close everything" must not mean "open League, close
///     League".
pub struct Triggers {
    running: Arc<AtomicBool>,
    list: Arc<Mutex<Vec<Target>>>,
    /// Ids seen running on the previous tick, for the edge comparison.
    seen: Arc<Mutex<Vec<String>>>,
}

impl Default for Triggers {
    fn default() -> Self {
        Self::new()
    }
}

impl Triggers {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            list: Arc::new(Mutex::new(Vec::new())),
            seen: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Replace the trigger list. Starts or stops the thread to match.
    pub fn set(&self, targets: Vec<Target>, on_fire: impl Fn(Vec<Target>) + Send + 'static) {
        let empty = targets.is_empty();
        *self.list.lock().unwrap_or_else(|e| e.into_inner()) = targets;
        if empty {
            self.running.store(false, Ordering::SeqCst);
            self.seen.lock().unwrap_or_else(|e| e.into_inner()).clear();
            return;
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return; // thread already up; it will pick up the new list
        }

        let running = self.running.clone();
        let list = self.list.clone();
        let seen = self.seen.clone();
        thread::spawn(move || {
            // Seed from the CURRENT state so a trigger that is already up when
            // Shield starts does not fire the instant the agent launches.
            {
                let l = list.lock().unwrap_or_else(|e| e.into_inner()).clone();
                *seen.lock().unwrap_or_else(|e| e.into_inner()) = proc::running_ids(&l);
            }
            let mut last_fg: Option<String> = None;
            let mut cooled: Vec<(String, Instant)> = Vec::new();

            while running.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(TRIGGER_TICK_MS));
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                let l = list.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if l.is_empty() {
                    last_fg = None;
                    continue;
                }

                let now = proc::running_ids(&l);
                let mut guard = seen.lock().unwrap_or_else(|e| e.into_inner());

                // Signal 1 — the process just appeared. Catches apps that start
                // in the background or without stealing focus.
                let mut fired: Vec<Target> =
                    l.iter().filter(|t| now.contains(&t.id) && !guard.contains(&t.id)).cloned().collect();
                *guard = now;
                drop(guard);

                // Signal 2 — the app came to the front. This is what "I opened
                // Brave" actually means: the browser was already running, and
                // opening it raised an existing window. Without this the
                // trigger appears simply not to work.
                let fg = proc::foreground_target_id(&l);
                if fg != last_fg {
                    if let Some(id) = &fg {
                        if !fired.iter().any(|t| &t.id == id) {
                            if let Some(t) = l.iter().find(|t| &t.id == id) {
                                fired.push(t.clone());
                            }
                        }
                    }
                    last_fg = fg;
                }

                // Alt-tabbing back and forth must not re-close everything each
                // time, so each target can only fire once per cooldown.
                let now_i = Instant::now();
                cooled.retain(|(_, at)| now_i.duration_since(*at) < COOLDOWN);
                fired.retain(|t| !cooled.iter().any(|(id, _)| id == &t.id));
                for t in &fired {
                    cooled.push((t.id.clone(), now_i));
                }

                if !fired.is_empty() {
                    on_fire(fired);
                }
            }
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.seen.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

/// Slower than the watchdog: this is "did something just start", not "kill it
/// before it draws". A second of latency is imperceptible and costs far less.
const TRIGGER_TICK_MS: u64 = 1000;

/// How long a target waits before it can fire again.
///
/// Without this, alt-tabbing between a trigger and something else would re-run
/// the closer every second. Long enough to be sane, short enough that genuinely
/// reopening an app later still works.
const COOLDOWN: Duration = Duration::from_secs(45);

impl Default for Watchdog {
    fn default() -> Self {
        Self::new()
    }
}

impl Watchdog {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            targets: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn start(&self, targets: Vec<Target>) {
        *self.targets.lock().unwrap_or_else(|e| e.into_inner()) = targets;
        // Already running: swapping the target list above is enough, and
        // starting a second thread would double the kill rate for no gain.
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let running = self.running.clone();
        let list = self.targets.clone();
        thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                let snapshot = list.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if !snapshot.is_empty() {
                    proc::kill_on_sight(&snapshot);
                }
                thread::sleep(Duration::from_millis(TICK_MS));
            }
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.targets.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}
