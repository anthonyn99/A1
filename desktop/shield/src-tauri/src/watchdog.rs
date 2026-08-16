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
use std::time::Duration;

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
            // Seed from the CURRENT state so a trigger already running when
            // Shield starts does not immediately fire. Only a fresh launch
            // should count.
            {
                let l = list.lock().unwrap_or_else(|e| e.into_inner()).clone();
                *seen.lock().unwrap_or_else(|e| e.into_inner()) = proc::running_ids(&l);
            }
            while running.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(TRIGGER_TICK_MS));
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                let l = list.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if l.is_empty() {
                    continue;
                }
                let now = proc::running_ids(&l);
                let mut guard = seen.lock().unwrap_or_else(|e| e.into_inner());
                let fired: Vec<Target> = l
                    .iter()
                    .filter(|t| now.contains(&t.id) && !guard.contains(&t.id))
                    .cloned()
                    .collect();
                *guard = now;
                drop(guard);
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
