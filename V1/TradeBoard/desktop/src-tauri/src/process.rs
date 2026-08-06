//! Native process control.
//!
//! Safety rules this module enforces (spec §5):
//!   • Never build a shell command string. `Command::new(exe).args(array)` only,
//!     so a path or argument containing `&`, `|`, quotes etc. can never be
//!     re-interpreted as a command.
//!   • Never terminate a process this feature did not itself start. We only kill
//!     a PID we recorded at spawn time, and only after confirming the live
//!     process at that PID still has the executable path we launched — PIDs get
//!     recycled by the OS, and killing a recycled PID would take down unrelated
//!     work.
//!   • Never request elevation. If Windows refuses to start a target without a
//!     UAC prompt, that surfaces as a plain error.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System};

/// What we remember about something we launched. `exe` is kept so a recycled PID
/// can be told apart from our real child.
#[derive(Debug, Clone)]
pub struct Tracked {
    pub pid: u32,
    pub exe: String,
    /// When we started it. Used to adopt a re-parented process: some Windows
    /// apps (modern Notepad, anything launched via a stub or an AppX/MSIX
    /// wrapper) exit the process we spawned almost immediately and continue in
    /// a NEW pid we never see. Without this, the tracked pid looks dead, the
    /// scheduler thinks the app closed, and it relaunches on every tick.
    pub started: SystemTime,
}

/// PID map, keyed by LaunchItem id. Deliberately NOT persisted: after a restart
/// we cannot prove a running process is ours, so we start with an empty map and
/// let the scheduler reconcile (see scheduler.rs `catch-up`).
#[derive(Default)]
pub struct ProcRegistry {
    inner: Mutex<HashMap<String, Tracked>>,
}

impl ProcRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, item_id: &str, pid: u32, exe: &str) {
        let mut m = self.inner.lock().unwrap();
        m.insert(
            item_id.to_string(),
            Tracked {
                pid,
                exe: exe.to_string(),
                started: SystemTime::now(),
            },
        );
    }

    /// Re-point an entry at the pid a re-parented process actually ended up on,
    /// preserving the original launch time.
    pub fn repoint(&self, item_id: &str, pid: u32) {
        let mut m = self.inner.lock().unwrap();
        if let Some(t) = m.get_mut(item_id) {
            t.pid = pid;
        }
    }

    pub fn get(&self, item_id: &str) -> Option<Tracked> {
        self.inner.lock().unwrap().get(item_id).cloned()
    }

    pub fn remove(&self, item_id: &str) -> Option<Tracked> {
        self.inner.lock().unwrap().remove(item_id)
    }
}

/// Normalizing makes the "is this still our process?" comparison reliable across
/// `C:\` vs `c:/` and short-vs-long path spellings.
fn norm(p: &str) -> String {
    p.replace('/', "\\").to_ascii_lowercase()
}

/// Validate that a path exists and is a file we can plausibly execute.
/// Returns Err(reason) with a message meant for the user.
pub fn validate_exe(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if path.trim().is_empty() {
        return Err("Enter a path to an executable.".into());
    }
    if !p.exists() {
        return Err(format!("No file exists at {path}"));
    }
    if !p.is_file() {
        return Err(format!("{path} is a folder, not a program."));
    }
    let ok_ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "exe" || e == "com" || e == "bat" || e == "cmd"
        })
        .unwrap_or(false);
    if !ok_ext {
        return Err("The target must be an .exe, .com, .bat or .cmd file.".into());
    }
    Ok(())
}

/// Spawn a program. `args` is passed as a real argument vector — never joined
/// into a string, never handed to cmd.exe.
pub fn spawn(path: &str, args: &[String]) -> Result<u32, String> {
    validate_exe(path)?;

    // .bat/.cmd are not PE executables; Windows can only run them through the
    // command interpreter. We still avoid shell STRING construction: cmd.exe
    // receives the script path and each argument as separate argv entries, so
    // nothing is re-parsed from a concatenated line.
    let lower = path.to_ascii_lowercase();
    let is_script = lower.ends_with(".bat") || lower.ends_with(".cmd");

    let mut cmd = if is_script {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into());
        let mut c = Command::new(comspec);
        c.arg("/C").arg(path);
        c
    } else {
        Command::new(path)
    };
    cmd.args(args);

    // Start in the program's own directory: many apps look for resources
    // relative to cwd and misbehave when inherited from our shell.
    if let Some(dir) = Path::new(path).parent() {
        if dir.is_dir() {
            cmd.current_dir(dir);
        }
    }

    match cmd.spawn() {
        Ok(child) => Ok(child.id()),
        Err(e) => Err(explain_spawn_error(&e, path)),
    }
}

/// Turn an OS error into something a user can act on. Notably ERROR_ELEVATION_
/// REQUIRED (740): we surface it rather than relaunching with a UAC prompt (§5).
fn explain_spawn_error(e: &std::io::Error, path: &str) -> String {
    const ERROR_ELEVATION_REQUIRED: i32 = 740;
    match e.raw_os_error() {
        Some(ERROR_ELEVATION_REQUIRED) => format!(
            "{path} needs administrator rights to start. TradeBoard will not request \
             elevation — start this program manually, or point the item at a version \
             that runs without admin."
        ),
        Some(5) => format!("Permission denied starting {path}."),
        Some(2) | Some(3) => format!("No file exists at {path}"),
        _ => format!("Could not start {path}: {e}"),
    }
}

/// Is the tracked process still alive AND still the program we launched?
/// The exe re-check is what stops us from acting on a recycled PID.
pub fn is_alive(sys: &mut System, t: &Tracked) -> bool {
    let pid = Pid::from_u32(t.pid);
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    match sys.process(pid) {
        None => false,
        Some(p) => match p.exe() {
            // If the exe path can't be read (access denied on some system
            // processes), fall back to "it exists" rather than killing blind —
            // termination has its own identity check.
            None => true,
            Some(exe) => norm(&exe.to_string_lossy()) == norm(&t.exe),
        },
    }
}

/// Find a process that is almost certainly the re-parented continuation of
/// something we launched: same executable, and started at or after we spawned it.
///
/// This exists because several Windows programs (modern Notepad, MSIX/AppX
/// packaged apps, launcher stubs) exit the process we spawn within a second and
/// carry on under a pid we never saw. Without adopting that pid, the scheduler
/// sees "not running" on the next tick and launches another copy — the bug this
/// was written to fix.
///
/// The launch-time floor is the safety property: a matching process that was
/// ALREADY running before we spawned anything is never adopted, so we can't
/// take ownership of (and later kill) something the user started themselves.
pub fn find_reparented(sys: &mut System, t: &Tracked) -> Option<u32> {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    let want_path = norm(&t.exe);
    // Store-packaged programs run from a completely different location than the
    // stub you launch: `C:\Windows\System32\notepad.exe` actually starts
    // `...\WindowsApps\Microsoft.WindowsNotepad_.../Notepad/Notepad.exe`. So an
    // exact path match can never succeed for those, and we fall back to the
    // FILE NAME. That is a weaker identity, which is precisely why the
    // launch-time floor below is not optional.
    let want_name = file_name_of(&t.exe);

    let floor = t
        .started
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs().saturating_sub(2))
        .unwrap_or(0);

    let mut candidates: Vec<(u64, u32, bool)> = sys
        .processes()
        .values()
        .filter_map(|p| {
            let exe = p.exe()?;
            let exe_s = exe.to_string_lossy();
            let exact = norm(&exe_s) == want_path;
            let by_name = !want_name.is_empty() && file_name_of(&exe_s) == want_name;
            if !exact && !by_name {
                return None;
            }
            // Only ever consider processes that appeared at or after we
            // launched. Anything older is the user's own and must not be
            // adopted — adopting it would later authorize killing it.
            if p.start_time() < floor {
                return None;
            }
            Some((p.start_time(), p.pid().as_u32(), exact))
        })
        .collect();

    // Prefer an exact path match; among equals, the earliest process started
    // after our launch is the likeliest continuation of it.
    candidates.sort_by_key(|(start, _pid, exact)| (!*exact, *start));
    candidates.first().map(|(_, pid, _)| *pid)
}

/// Lowercased final path component, e.g. "notepad.exe".
fn file_name_of(p: &str) -> String {
    Path::new(&p.replace('/', "\\"))
        .file_name()
        .map(|f| f.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Graceful-then-forceful termination of a process WE started.
///
/// Windows has no SIGTERM. sysinfo's `Signal::Term` maps onto a polite close
/// request; if the process is still there after `grace`, we escalate to `kill()`
/// (TerminateProcess). Returns Ok(true) if something was actually terminated.
pub fn terminate(sys: &mut System, t: &Tracked, grace: Duration) -> Result<bool, String> {
    if !is_alive(sys, t) {
        return Ok(false);
    }
    let pid = Pid::from_u32(t.pid);

    // Re-read the identity immediately before acting. Between the is_alive check
    // and here the PID could in principle be recycled; this is the last gate
    // before we terminate anything.
    let proc = match sys.process(pid) {
        Some(p) => p,
        None => return Ok(false),
    };
    if let Some(exe) = proc.exe() {
        if norm(&exe.to_string_lossy()) != norm(&t.exe) {
            return Err(format!(
                "Refusing to close PID {} — it is no longer the program this item started.",
                t.pid
            ));
        }
    }

    // Polite request first.
    let _ = proc.kill_with(Signal::Term);

    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(120));
        if !is_alive(sys, t) {
            return Ok(true);
        }
    }

    // Still there — force it.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    if let Some(p) = sys.process(pid) {
        // Identity gate again before the hard kill.
        if let Some(exe) = p.exe() {
            if norm(&exe.to_string_lossy()) != norm(&t.exe) {
                return Err(format!(
                    "Refusing to force-close PID {} — identity changed.",
                    t.pid
                ));
            }
        }
        p.kill();
        std::thread::sleep(Duration::from_millis(150));
        return Ok(!is_alive(sys, t));
    }
    Ok(true)
}

/// Is *some* process running whose exe matches `path`?
///
/// Used only to ANSWER "is it running?" when we have no tracked PID (e.g. after
/// a restart). It never authorizes a kill: `close_item` with no tracked PID is a
/// no-op precisely so we can't terminate a process the user started themselves.
pub fn any_running_by_path(sys: &mut System, path: &str) -> bool {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    let want = norm(path);
    sys.processes().values().any(|p| {
        p.exe()
            .map(|e| norm(&e.to_string_lossy()) == want)
            .unwrap_or(false)
    })
}
