//! The literal Step 6 acceptance test: notepad.exe, scheduled to start about a
//! minute from now and end about two minutes after that, driven by a real
//! 5-second tick loop against real `Utc::now()` — no simulated clock.
//!
//! Ignored by default because it takes ~3.5 minutes of wall time and opens a
//! visible Notepad window. Run it explicitly:
//!
//!   cargo test -p tradeboard-core --test wallclock_notepad_test -- --ignored --nocapture

use std::process::Command;
use std::time::{Duration, Instant, SystemTime};

use chrono::{Datelike, Timelike, Utc};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tradeboard_core::model::{ItemType, LaunchItem, ScheduleRule, Target};
use tradeboard_core::schedule::*;

const NOTEPAD: &str = r"C:\Windows\System32\notepad.exe";

fn file_name_of(p: &str) -> String {
    std::path::Path::new(&p.replace('/', "\\"))
        .file_name()
        .map(|f| f.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Mirrors the production liveness check, including adoption of a re-parented
/// process. Notepad is store-packaged: the pid we spawn dies at once and the
/// real app runs from `...\WindowsApps\...\Notepad.exe` under a new pid.
fn running_pid(sys: &mut System, since: SystemTime) -> Option<u32> {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    let floor = since
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs().saturating_sub(2))
        .unwrap_or(0);
    sys.processes()
        .values()
        .filter(|p| {
            p.exe()
                .map(|e| file_name_of(&e.to_string_lossy()) == "notepad.exe")
                .unwrap_or(false)
        })
        .filter(|p| p.start_time() >= floor)
        .min_by_key(|p| p.start_time())
        .map(|p| p.pid().as_u32())
}

fn kill_pid(sys: &mut System, pid: u32) {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::nothing(),
    );
    if let Some(p) = sys.process(sysinfo::Pid::from_u32(pid)) {
        p.kill();
    }
}

#[test]
#[ignore = "takes ~3.5 minutes of real time and opens a Notepad window"]
fn notepad_auto_launches_and_auto_closes_on_a_real_schedule() {
    let now = Utc::now();
    let start = now + chrono::Duration::seconds(60);
    let end = start + chrono::Duration::seconds(120);

    let rule = ScheduleRule {
        id: "wall".into(),
        enabled: true,
        days_of_week: Some(vec![start.weekday().num_days_from_sunday()]),
        date: None,
        start_time: format!("{:02}:{:02}", start.hour(), start.minute()),
        end_time: Some(format!("{:02}:{:02}", end.hour(), end.minute())),
        timezone: Some("UTC".into()),
    };

    let item = LaunchItem {
        id: "notepad-wall".into(),
        name: "Notepad".into(),
        item_type: ItemType::DesktopApp,
        enabled: true,
        target: Target {
            path: Some(NOTEPAD.into()),
            args: Some(vec![]),
            url: None,
            open_in: None,
        },
        schedules: vec![rule],
    };

    println!(
        "scheduled window (UTC): {} -> {}",
        item.schedules[0].start_time,
        item.schedules[0].end_time.as_deref().unwrap()
    );

    // Start clean so a stray Notepad can't confuse the count.
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "notepad.exe"])
        .output();
    std::thread::sleep(Duration::from_millis(600));

    let mut sys = System::new();
    let mut spawned_at: Option<SystemTime> = None;
    let mut launched_at = None;
    let mut closed_at = None;
    let mut launch_count = 0;

    // Run until a little past the end edge.
    let deadline = Instant::now() + Duration::from_secs(60 + 120 + 45);
    while Instant::now() < deadline {
        let t = Utc::now();
        let should = item_should_be_open(&item, t);
        let live = spawned_at.and_then(|s| running_pid(&mut sys, s));

        if should && live.is_none() {
            let now_sys = SystemTime::now();
            let c = Command::new(NOTEPAD).spawn().expect("notepad should spawn");
            launch_count += 1;
            println!(
                "[{}] launched notepad (spawn pid={}) — launch #{launch_count}",
                t.format("%H:%M:%S"),
                c.id()
            );
            spawned_at = Some(now_sys);
            if launched_at.is_none() {
                launched_at = Some(t);
            }
        } else if !should && live.is_some() {
            kill_pid(&mut sys, live.unwrap());
            println!("[{}] closed notepad", t.format("%H:%M:%S"));
            closed_at = Some(t);
            break;
        }
        std::thread::sleep(Duration::from_secs(5));
    }

    // Clean up whatever is left.
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "notepad.exe"])
        .output();

    let launched_at = launched_at.expect("notepad should have auto-launched");
    let closed_at = closed_at.expect("notepad should have auto-closed");

    // The tick interval is 5s, so allow that much slack on each edge.
    let launch_skew = (launched_at - start).num_seconds().abs();
    let close_skew = (closed_at - end).num_seconds().abs();
    println!("launch skew {launch_skew}s, close skew {close_skew}s, launches {launch_count}");
    assert!(
        launch_skew <= 65,
        "launched {launch_skew}s from the scheduled start"
    );
    assert!(
        close_skew <= 65,
        "closed {close_skew}s from the scheduled end"
    );
    // The regression that started all this: Notepad re-parents, so a naive
    // liveness check relaunched it on every tick.
    assert_eq!(
        launch_count, 1,
        "the item must be launched exactly once per window"
    );
}
