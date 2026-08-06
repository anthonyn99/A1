//! Regression tests for the re-parenting double-launch bug.
//!
//! Found by the wall-clock acceptance test: modern Notepad exits the process we
//! spawn within ~a second and continues under a pid we never saw. A liveness
//! check that only looks at the spawned pid therefore reports "not running", and
//! the scheduler relaunches on every tick — five Notepads in a two-minute window.
//!
//! These tests mirror `process::find_reparented` from src-tauri and pin down both
//! halves of the contract:
//!   • a re-parented process IS adopted, so the item stops looking closed,
//!   • a matching process that was already running BEFORE we launched anything
//!     is NOT adopted, so we never take ownership of the user's own work.

use std::process::Command;
use std::time::{Duration, Instant, SystemTime};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

fn norm(p: &str) -> String {
    p.replace('/', "\\").to_ascii_lowercase()
}

#[derive(Clone)]
struct Tracked {
    pid: u32,
    exe: String,
    started: SystemTime,
}

/// Mirror of process::is_alive.
fn is_alive(sys: &mut System, t: &Tracked) -> bool {
    let pid = sysinfo::Pid::from_u32(t.pid);
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    match sys.process(pid) {
        None => false,
        Some(p) => match p.exe() {
            None => true,
            Some(exe) => norm(&exe.to_string_lossy()) == norm(&t.exe),
        },
    }
}

fn file_name_of(p: &str) -> String {
    std::path::Path::new(&p.replace('/', "\\"))
        .file_name()
        .map(|f| f.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Mirror of process::find_reparented.
fn find_reparented(sys: &mut System, t: &Tracked) -> Option<u32> {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    let want_path = norm(&t.exe);
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
            if p.start_time() < floor {
                return None;
            }
            Some((p.start_time(), p.pid().as_u32(), exact))
        })
        .collect();
    candidates.sort_by_key(|(start, _pid, exact)| (!*exact, *start));
    candidates.first().map(|(_, pid, _)| *pid)
}

fn alive_or_reparented(sys: &mut System, t: &mut Tracked) -> bool {
    if is_alive(sys, t) {
        return true;
    }
    match find_reparented(sys, t) {
        Some(pid) => {
            t.pid = pid;
            true
        }
        None => false,
    }
}

const NOTEPAD: &str = r"C:\Windows\System32\notepad.exe";

fn kill_all_notepad() {
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "notepad.exe"])
        .output();
    std::thread::sleep(Duration::from_millis(600));
}

/// Count by FILE NAME, not full path: the real Notepad runs out of
/// `...\WindowsApps\Microsoft.WindowsNotepad_...\Notepad\Notepad.exe`, not the
/// System32 stub we launch.
fn notepad_count(sys: &mut System) -> usize {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    sys.processes()
        .values()
        .filter(|p| {
            p.exe()
                .map(|e| file_name_of(&e.to_string_lossy()) == "notepad.exe")
                .unwrap_or(false)
        })
        .count()
}

#[test]
#[ignore = "opens real Notepad windows"]
fn reparented_notepad_is_adopted_instead_of_being_relaunched() {
    kill_all_notepad();
    let mut sys = System::new();

    let child = Command::new(NOTEPAD).spawn().expect("spawn notepad");
    let mut tracked = Tracked {
        pid: child.id(),
        exe: NOTEPAD.into(),
        started: SystemTime::now(),
    };

    // Give Notepad time to hand off to its real process.
    std::thread::sleep(Duration::from_secs(3));

    // The naive check is exactly what caused the bug.
    let naive = is_alive(&mut sys, &tracked);
    // The tolerant check must report it as running.
    let tolerant = alive_or_reparented(&mut sys, &mut tracked);

    println!("naive is_alive = {naive}, tolerant = {tolerant}, pid now {}", tracked.pid);
    assert!(
        tolerant,
        "a re-parented Notepad must be recognised as still running"
    );

    // Simulate 5 scheduler ticks inside the window: with the tolerant check,
    // none of them should decide a relaunch is needed.
    let before = notepad_count(&mut sys);
    for _ in 0..5 {
        if !alive_or_reparented(&mut sys, &mut tracked) {
            let c = Command::new(NOTEPAD).spawn().expect("relaunch");
            tracked = Tracked {
                pid: c.id(),
                exe: NOTEPAD.into(),
                started: SystemTime::now(),
            };
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    let after = notepad_count(&mut sys);
    println!("notepad instances before={before} after={after}");
    assert_eq!(
        before, after,
        "the scheduler must not spawn extra Notepad instances while one is running"
    );

    kill_all_notepad();
}

#[test]
#[ignore = "opens real Notepad windows"]
fn a_preexisting_process_is_never_adopted() {
    // The safety half: something the USER already had open must not be adopted
    // (and therefore must never be killed by a later scheduled close).
    kill_all_notepad();
    let mut sys = System::new();

    // The user's own Notepad, started BEFORE we launch anything.
    let _users = Command::new(NOTEPAD).spawn().expect("spawn user's notepad");
    std::thread::sleep(Duration::from_secs(3));

    // Now we "launch" an item, but pretend the spawn failed to survive: we hold
    // a tracked entry whose start time is NOW, after the user's process began.
    let tracked = Tracked {
        pid: 999_999, // a pid that does not exist
        exe: NOTEPAD.into(),
        started: SystemTime::now(),
    };

    let adopted = find_reparented(&mut sys, &tracked);
    println!("adopted = {adopted:?}");
    assert!(
        adopted.is_none(),
        "a process that predates our launch must never be adopted"
    );

    kill_all_notepad();
}

#[test]
fn adoption_requires_a_matching_executable() {
    // A different exe is never adopted even if it started after us.
    let mut sys = System::new();
    let mut child = Command::new("cmd.exe")
        .args(["/C", "timeout", "/T", "10", "/NOBREAK"])
        .spawn()
        .expect("spawn");
    std::thread::sleep(Duration::from_millis(400));

    let tracked = Tracked {
        pid: 999_999,
        exe: NOTEPAD.into(), // we claim to have launched Notepad
        started: SystemTime::now() - Duration::from_secs(5),
    };
    // The running process is cmd.exe, so nothing should match.
    let got = find_reparented(&mut sys, &tracked);
    let _ = child.kill();
    assert!(
        got.is_none() || got != Some(child.id()),
        "must not adopt a process with a different executable"
    );
}

#[test]
fn adoption_is_time_bounded() {
    // Verify the floor arithmetic: a start time far in the future means nothing
    // currently running can qualify.
    let mut sys = System::new();
    let tracked = Tracked {
        pid: 999_999,
        exe: r"C:\Windows\System32\cmd.exe".into(),
        started: SystemTime::now() + Duration::from_secs(3600),
    };
    assert!(
        find_reparented(&mut sys, &tracked).is_none(),
        "nothing should qualify when the launch floor is in the future"
    );
}

#[test]
fn timing_helper_survives_clock_edge_cases() {
    let t = Tracked {
        pid: 1,
        exe: "x".into(),
        started: SystemTime::UNIX_EPOCH,
    };
    // saturating_sub must not underflow at the epoch.
    let floor = t
        .started
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs().saturating_sub(2))
        .unwrap_or(0);
    assert_eq!(floor, 0);
}

#[test]
#[ignore = "opens a real Notepad window"]
fn adopted_process_can_still_be_terminated() {
    // Adoption is only useful if the pid we adopt is one we can actually close.
    kill_all_notepad();
    let mut sys = System::new();

    let child = Command::new(NOTEPAD).spawn().expect("spawn notepad");
    let mut tracked = Tracked {
        pid: child.id(),
        exe: NOTEPAD.into(),
        started: SystemTime::now(),
    };
    std::thread::sleep(Duration::from_secs(3));
    assert!(alive_or_reparented(&mut sys, &mut tracked));

    // Terminate the adopted pid.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(tracked.pid)]),
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    if let Some(p) = sys.process(sysinfo::Pid::from_u32(tracked.pid)) {
        p.kill();
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut gone = false;
    while Instant::now() < deadline {
        if notepad_count(&mut sys) == 0 {
            gone = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    assert!(gone, "the adopted process should be closable");
    kill_all_notepad();
}
