//! End-to-end scheduler tests against REAL Windows processes.
//!
//! These drive the same decision logic the Tauri scheduler runs (`schedule::*`
//! from the core crate) and pair it with real spawning/termination, so the
//! Step 6 checklist items are executed rather than asserted on paper:
//!
//!   • an item scheduled ~1 minute out auto-launches, then auto-closes at its
//!     end time (compressed here into seconds so the suite stays fast),
//!   • removing an item mid-window closes it and stops future triggers,
//!   • a restart mid-window reconciles (catch-up) instead of going stale,
//!   • a manual close suppresses relaunch until the next scheduled start,
//!   • nothing the harness did not spawn is ever terminated.
//!
//! The scheduler in src-tauri/src/scheduler.rs is a thin loop over exactly these
//! primitives: compare `item_should_be_open` with observed process state and
//! correct the difference. `Harness` below reproduces that loop faithfully.

use std::collections::HashMap;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use chrono::{DateTime, Duration as ChDuration, Timelike, Utc};
use tradeboard_core::model::{ItemType, LaunchItem, ScheduleRule, Target};
use tradeboard_core::schedule::*;

/// A stand-in for the shell's PID registry + runtime flags.
struct Harness {
    items: Vec<LaunchItem>,
    procs: HashMap<String, Child>,
    suppressed: HashMap<String, Option<DateTime<Utc>>>,
    last_tick: Option<DateTime<Utc>>,
    pub log: Vec<String>,
}

impl Harness {
    fn new(items: Vec<LaunchItem>) -> Self {
        Self {
            items,
            procs: HashMap::new(),
            suppressed: HashMap::new(),
            last_tick: None,
            log: Vec::new(),
        }
    }

    fn is_running(&mut self, id: &str) -> bool {
        match self.procs.get_mut(id) {
            Some(child) => child.try_wait().ok().flatten().is_none(),
            None => false,
        }
    }

    /// Mirrors scheduler::tick().
    fn tick_at(&mut self, now: DateTime<Utc>) {
        let prev = self.last_tick;
        self.last_tick = Some(now);
        let items = self.items.clone();

        for item in items {
            if !item.enabled {
                continue;
            }

            // Clear a suppression whose window has passed.
            let current_edge = last_start_edge(&item, now);
            if let Some(sup_edge) = self.suppressed.get(&item.id).cloned() {
                if sup_edge != current_edge {
                    self.suppressed.remove(&item.id);
                }
            }

            let should_open = item_should_be_open(&item, now);
            let edge_fired = match prev {
                Some(p) => item_just_triggered(&item, p, now),
                None => false,
            };
            let suppressed = self.suppressed.contains_key(&item.id);
            let is_open = self.is_running(&item.id);

            if (should_open || edge_fired) && !is_open {
                if suppressed {
                    continue;
                }
                let path = item.target.path.clone().unwrap_or_default();
                let args = item.target.args.clone().unwrap_or_default();
                match Command::new(&path).args(&args).spawn() {
                    Ok(c) => {
                        self.log.push(format!("opened {}", item.name));
                        self.procs.insert(item.id.clone(), c);
                    }
                    Err(e) => self.log.push(format!("failed to open {}: {e}", item.name)),
                }
                continue;
            }

            let has_close_rule = item.schedules.iter().any(|r| r.enabled && r.end_time.is_some());
            // Only ever close something WE started (spec §5).
            let ours = self.procs.contains_key(&item.id);
            if !should_open && is_open && has_close_rule && ours {
                self.kill(&item.id);
                self.log.push(format!("closed {}", item.name));
            }
        }
    }

    fn kill(&mut self, id: &str) {
        if let Some(mut c) = self.procs.remove(id) {
            let _ = c.kill();
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if c.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        }
    }

    /// The user pressing "Close now" during a scheduled window.
    fn manual_close(&mut self, id: &str, now: DateTime<Utc>) {
        self.kill(id);
        if let Some(item) = self.items.iter().find(|i| i.id == id) {
            if item_should_be_open(item, now) {
                self.suppressed
                    .insert(id.to_string(), last_start_edge(item, now));
            }
        }
    }

    fn remove(&mut self, id: &str) {
        self.kill(id);
        self.items.retain(|i| i.id != id);
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let ids: Vec<String> = self.procs.keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }
}

/// A harmless long-running process to stand in for "the app".
fn sleeper_item(id: &str, schedules: Vec<ScheduleRule>) -> LaunchItem {
    LaunchItem {
        id: id.into(),
        name: format!("sleeper-{id}"),
        item_type: ItemType::DesktopApp,
        enabled: true,
        target: Target {
            path: Some(r"C:\Windows\System32\cmd.exe".into()),
            args: Some(vec![
                "/C".into(),
                "timeout".into(),
                "/T".into(),
                "300".into(),
                "/NOBREAK".into(),
            ]),
            url: None,
            open_in: None,
        },
        schedules,
    }
}

/// Build a rule active on the weekday of `anchor`, spanning [start, end) minutes
/// of that local day, in UTC so the test is machine-independent.
fn rule_around(anchor: DateTime<Utc>, start_off_min: i64, end_off_min: Option<i64>) -> ScheduleRule {
    let start = anchor + ChDuration::minutes(start_off_min);
    let dow = chrono::Datelike::weekday(&start).num_days_from_sunday();
    ScheduleRule {
        id: "r".into(),
        enabled: true,
        days_of_week: Some(vec![dow]),
        date: None,
        start_time: format!("{:02}:{:02}", start.hour(), start.minute()),
        end_time: end_off_min.map(|e| {
            let t = anchor + ChDuration::minutes(e);
            format!("{:02}:{:02}", t.hour(), t.minute())
        }),
        timezone: Some("UTC".into()),
    }
}

/// A fixed anchor well away from midnight so ±minutes stays on one day.
fn anchor() -> DateTime<Utc> {
    Utc::now()
        .with_hour(12)
        .unwrap()
        .with_minute(0)
        .unwrap()
        .with_second(0)
        .unwrap()
        .with_nanosecond(0)
        .unwrap()
}

#[test]
fn item_auto_launches_at_start_and_auto_closes_at_end() {
    let a = anchor();
    // Window: 12:01 -> 12:03. We drive virtual time across both edges.
    let item = sleeper_item("auto1", vec![rule_around(a, 1, Some(3))]);
    let mut h = Harness::new(vec![item]);

    // 12:00 — before the window: nothing should start.
    h.tick_at(a);
    assert!(!h.is_running("auto1"), "must not start before the window");

    // 12:02 — inside the window: it launches.
    h.tick_at(a + ChDuration::minutes(2));
    assert!(h.is_running("auto1"), "should have auto-launched");

    // 12:04 — past the end: it closes.
    h.tick_at(a + ChDuration::minutes(4));
    assert!(!h.is_running("auto1"), "should have auto-closed");

    assert!(h.log.iter().any(|l| l.starts_with("opened")));
    assert!(h.log.iter().any(|l| l.starts_with("closed")));
}

#[test]
fn repeated_ticks_inside_a_window_do_not_launch_twice() {
    let a = anchor();
    let item = sleeper_item("once1", vec![rule_around(a, 1, Some(9))]);
    let mut h = Harness::new(vec![item]);

    h.tick_at(a + ChDuration::minutes(2));
    assert!(h.is_running("once1"));
    let opens = h.log.iter().filter(|l| l.starts_with("opened")).count();

    // Several more ticks inside the same window.
    h.tick_at(a + ChDuration::minutes(3));
    h.tick_at(a + ChDuration::minutes(4));
    h.tick_at(a + ChDuration::minutes(5));

    let opens_after = h.log.iter().filter(|l| l.starts_with("opened")).count();
    assert_eq!(opens, opens_after, "must not relaunch while already running");
}

#[test]
fn duplicate_rules_launch_only_one_process() {
    let a = anchor();
    // Two identical rules on one item.
    let mut item = sleeper_item("dup1", vec![rule_around(a, 1, Some(9))]);
    let mut second = rule_around(a, 1, Some(9));
    second.id = "r2".into();
    item.schedules.push(second);

    let mut h = Harness::new(vec![item]);
    h.tick_at(a + ChDuration::minutes(2));
    let opens = h.log.iter().filter(|l| l.starts_with("opened")).count();
    assert_eq!(opens, 1, "duplicate rules must not double-launch");
}

#[test]
fn removing_an_item_mid_window_closes_it_and_stops_future_triggers() {
    let a = anchor();
    let item = sleeper_item("rm1", vec![rule_around(a, 1, Some(20))]);
    let mut h = Harness::new(vec![item]);

    h.tick_at(a + ChDuration::minutes(2));
    assert!(h.is_running("rm1"), "should be running inside its window");

    h.remove("rm1");
    assert!(!h.is_running("rm1"), "removal must close a running item");

    // Still inside the original window — but the item is gone, so no relaunch.
    h.tick_at(a + ChDuration::minutes(5));
    assert!(!h.is_running("rm1"), "a removed item must never relaunch");
}

#[test]
fn manual_close_suppresses_relaunch_for_the_rest_of_the_window() {
    let a = anchor();
    let item = sleeper_item("sup1", vec![rule_around(a, 1, Some(30))]);
    let mut h = Harness::new(vec![item]);

    h.tick_at(a + ChDuration::minutes(2));
    assert!(h.is_running("sup1"));

    // User closes it by hand at 12:05, still inside the window.
    h.manual_close("sup1", a + ChDuration::minutes(5));
    assert!(!h.is_running("sup1"));

    // Subsequent ticks inside the SAME window must not reopen it.
    h.tick_at(a + ChDuration::minutes(6));
    h.tick_at(a + ChDuration::minutes(10));
    assert!(
        !h.is_running("sup1"),
        "must not fight the user during the window they closed it in"
    );
}

#[test]
fn suppression_lifts_at_the_next_scheduled_start() {
    let a = anchor();
    // Two windows the same day: 12:01-12:10 and 12:20-12:40.
    let mut r1 = rule_around(a, 1, Some(10));
    r1.id = "w1".into();
    let mut r2 = rule_around(a, 20, Some(40));
    r2.id = "w2".into();
    let item = sleeper_item("sup2", vec![r1, r2]);
    let mut h = Harness::new(vec![item]);

    h.tick_at(a + ChDuration::minutes(2));
    assert!(h.is_running("sup2"));

    // Manually closed during the FIRST window.
    h.manual_close("sup2", a + ChDuration::minutes(5));
    h.tick_at(a + ChDuration::minutes(7));
    assert!(!h.is_running("sup2"), "suppressed inside the first window");

    // The second window has its own start edge, so suppression must lift.
    h.tick_at(a + ChDuration::minutes(22));
    assert!(
        h.is_running("sup2"),
        "a new scheduled start must clear the suppression"
    );
}

#[test]
fn restart_mid_window_catches_up_instead_of_going_stale() {
    let a = anchor();
    let item = sleeper_item("catch1", vec![rule_around(a, 1, Some(30))]);

    // First "run" of the shell: launches normally, then the process is dropped
    // (simulating the shell exiting — PIDs are not persisted).
    {
        let mut h = Harness::new(vec![item.clone()]);
        h.tick_at(a + ChDuration::minutes(2));
        assert!(h.is_running("catch1"));
        // Drop kills the child, i.e. the app is no longer running after restart.
    }

    // Second "run": a brand-new harness with an EMPTY pid map, first tick lands
    // in the middle of the window. It must launch rather than do nothing.
    let mut h2 = Harness::new(vec![item]);
    h2.tick_at(a + ChDuration::minutes(10));
    assert!(
        h2.is_running("catch1"),
        "a restart inside the window must catch up and launch"
    );
}

#[test]
fn missed_start_while_shell_was_down_is_caught_up() {
    let a = anchor();
    // Window 12:01-12:30; the shell only starts at 12:15 and never saw 12:01.
    let item = sleeper_item("miss1", vec![rule_around(a, 1, Some(30))]);
    let mut h = Harness::new(vec![item]);

    h.tick_at(a + ChDuration::minutes(15));
    assert!(
        h.is_running("miss1"),
        "a missed trigger must self-correct on the first tick"
    );
}

#[test]
fn disabled_item_is_never_launched() {
    let a = anchor();
    let mut item = sleeper_item("off1", vec![rule_around(a, 1, Some(30))]);
    item.enabled = false;
    let mut h = Harness::new(vec![item]);

    h.tick_at(a + ChDuration::minutes(5));
    assert!(!h.is_running("off1"), "a disabled item must never launch");
}

#[test]
fn disabling_one_rule_leaves_the_other_working() {
    let a = anchor();
    let mut off = rule_around(a, 1, Some(10));
    off.id = "off".into();
    off.enabled = false;
    let mut on = rule_around(a, 20, Some(40));
    on.id = "on".into();
    let item = sleeper_item("mix1", vec![off, on]);
    let mut h = Harness::new(vec![item]);

    // Inside the DISABLED rule's window — nothing happens.
    h.tick_at(a + ChDuration::minutes(5));
    assert!(!h.is_running("mix1"), "a disabled rule must not fire");

    // Inside the ENABLED rule's window — it launches.
    h.tick_at(a + ChDuration::minutes(25));
    assert!(h.is_running("mix1"), "the enabled rule must still fire");
}

#[test]
fn an_untracked_process_is_never_closed_by_the_scheduler() {
    let a = anchor();
    // The user starts this themselves; the scheduler has no PID for it.
    let mut foreign = Command::new("cmd.exe")
        .args(["/C", "timeout", "/T", "60", "/NOBREAK"])
        .spawn()
        .expect("spawn");

    let item = sleeper_item("untracked1", vec![rule_around(a, 1, Some(3))]);
    let mut h = Harness::new(vec![item]);

    // Tick well past the window's end. The scheduler has nothing tracked, so it
    // must not go hunting for a matching process to kill.
    h.tick_at(a + ChDuration::minutes(10));

    let still_alive = foreign.try_wait().expect("try_wait").is_none();
    assert!(
        still_alive,
        "the scheduler must never terminate a process it did not start"
    );
    let _ = foreign.kill();
}

#[test]
fn open_only_rule_launches_but_is_never_auto_closed() {
    let a = anchor();
    // No end time.
    let item = sleeper_item("openonly1", vec![rule_around(a, 1, None)]);
    let mut h = Harness::new(vec![item]);

    // Prime `prev` so the edge can be detected on the following tick.
    h.tick_at(a);
    h.tick_at(a + ChDuration::minutes(2));
    assert!(h.is_running("openonly1"), "the start edge should launch it");

    // Much later — it must still be running; nothing closes an open-only item.
    h.tick_at(a + ChDuration::minutes(60));
    assert!(
        h.is_running("openonly1"),
        "an open-only item must never be auto-closed"
    );
}
