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
        *self.targets.lock().unwrap() = targets;
        // Already running: swapping the target list above is enough, and
        // starting a second thread would double the kill rate for no gain.
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let running = self.running.clone();
        let list = self.targets.clone();
        thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                let snapshot = list.lock().unwrap().clone();
                if !snapshot.is_empty() {
                    proc::kill_on_sight(&snapshot);
                }
                thread::sleep(Duration::from_millis(TICK_MS));
            }
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.targets.lock().unwrap().clear();
    }
}
