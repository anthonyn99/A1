//! Schedule-evaluation tests: the cases spec §4 calls out explicitly —
//! midnight-crossing windows, DST transitions, duplicate/overlapping rules, and
//! disabling a single rule.

use chrono::{DateTime, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use tradeboard_core::model::{ItemType, LaunchItem, ScheduleRule, Target};
use tradeboard_core::schedule::*;

fn rule(days: &[u32], start: &str, end: Option<&str>, tz: &str) -> ScheduleRule {
    ScheduleRule {
        id: "r1".into(),
        enabled: true,
        days_of_week: Some(days.to_vec()),
        date: None,
        start_time: start.into(),
        end_time: end.map(|s| s.to_string()),
        timezone: Some(tz.into()),
    }
}

fn item_with(schedules: Vec<ScheduleRule>) -> LaunchItem {
    LaunchItem {
        id: "i1".into(),
        name: "test".into(),
        item_type: ItemType::DesktopApp,
        enabled: true,
        target: Target::default(),
        schedules,
    }
}

/// Build a UTC instant from a wall-clock time in the given zone.
fn at(tz: &str, s: &str) -> DateTime<Utc> {
    let tz: Tz = tz.parse().unwrap();
    let naive = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap();
    tz.from_local_datetime(&naive).unwrap().with_timezone(&Utc)
}

const NY: &str = "America/New_York";

#[test]
fn same_day_window_boundaries_are_start_inclusive_end_exclusive() {
    // Wednesday 2026-07-29, 09:00-17:00.
    let r = rule(&[3], "09:00", Some("17:00"), NY);
    assert!(!is_active_at(&r, at(NY, "2026-07-29 08:59")));
    assert!(is_active_at(&r, at(NY, "2026-07-29 09:00")));
    assert!(is_active_at(&r, at(NY, "2026-07-29 16:59")));
    assert!(!is_active_at(&r, at(NY, "2026-07-29 17:00")));
}

#[test]
fn wrong_day_is_never_active() {
    let r = rule(&[3], "09:00", Some("17:00"), NY);
    // Thursday.
    assert!(!is_active_at(&r, at(NY, "2026-07-30 12:00")));
}

#[test]
fn window_crossing_midnight_extends_into_the_next_day() {
    // Monday 22:00 -> 02:00 Tuesday.
    let r = rule(&[1], "22:00", Some("02:00"), NY);
    assert!(!is_active_at(&r, at(NY, "2026-07-27 21:59")));
    assert!(is_active_at(&r, at(NY, "2026-07-27 22:30")));
    // Tuesday's small hours still belong to Monday's window.
    assert!(is_active_at(&r, at(NY, "2026-07-28 01:59")));
    assert!(!is_active_at(&r, at(NY, "2026-07-28 02:00")));
    // Tuesday evening must NOT be active — only Monday is scheduled.
    assert!(!is_active_at(&r, at(NY, "2026-07-28 22:30")));
}

#[test]
fn open_only_rule_has_no_sustained_state_but_its_edge_fires() {
    let r = rule(&[3], "09:00", None, NY);
    assert!(!is_active_at(&r, at(NY, "2026-07-29 10:00")));
    assert!(just_started(
        &r,
        at(NY, "2026-07-29 08:59"),
        at(NY, "2026-07-29 09:01")
    ));
}

#[test]
fn start_edge_fires_exactly_once() {
    let r = rule(&[3], "09:00", None, NY);
    let a = at(NY, "2026-07-29 08:59");
    let b = at(NY, "2026-07-29 09:01");
    let c = at(NY, "2026-07-29 09:03");
    assert!(just_started(&r, a, b));
    // The following tick's window no longer contains the edge.
    assert!(!just_started(&r, b, c));
}

#[test]
fn disabling_one_rule_stops_only_that_rule() {
    // Two rules on the same item: 09:00-12:00 (disabled) and 14:00-16:00 (on).
    let mut off = rule(&[3], "09:00", Some("12:00"), NY);
    off.enabled = false;
    let on = rule(&[3], "14:00", Some("16:00"), NY);
    let item = item_with(vec![off, on]);

    // The disabled rule's window must not be enforced...
    assert!(!item_should_be_open(&item, at(NY, "2026-07-29 10:00")));
    // ...while the enabled one still is.
    assert!(item_should_be_open(&item, at(NY, "2026-07-29 15:00")));
}

#[test]
fn disabling_the_item_stops_every_rule() {
    let mut item = item_with(vec![rule(&[3], "09:00", Some("17:00"), NY)]);
    item.enabled = false;
    assert!(!item_should_be_open(&item, at(NY, "2026-07-29 10:00")));
}

#[test]
fn duplicate_and_overlapping_rules_cannot_double_launch() {
    // "Should be open" is a single boolean OR, so N identical rules == 1.
    let item = item_with(vec![
        rule(&[3], "09:00", Some("17:00"), NY),
        rule(&[3], "09:00", Some("17:00"), NY),
        rule(&[3], "10:00", Some("12:00"), NY), // overlapping, not identical
    ]);
    assert!(item_should_be_open(&item, at(NY, "2026-07-29 11:00")));
    assert!(item_should_be_open(&item, at(NY, "2026-07-29 16:00")));
    assert!(!item_should_be_open(&item, at(NY, "2026-07-29 18:00")));
}

#[test]
fn dst_spring_forward_skips_a_nonexistent_time() {
    // 2026-03-08 02:30 America/New_York never happens (clocks jump 02:00->03:00).
    // A rule at 02:30 that day must not fire at some arbitrary substitute moment.
    let r = rule(&[0], "02:30", None, NY); // 2026-03-08 is a Sunday
    let prev = at(NY, "2026-03-08 01:00");
    let now = at(NY, "2026-03-08 04:00");
    assert!(
        !just_started(&r, prev, now),
        "a wall-clock time inside the DST gap must not fire"
    );
}

#[test]
fn dst_fall_back_uses_the_first_occurrence() {
    // 2026-11-01 01:30 happens twice in New York. The window should open at the
    // EARLIER instant (EDT, UTC-4 => 05:30 UTC), not the later EST one.
    let r = rule(&[0], "01:30", None, NY); // 2026-11-01 is a Sunday
    let prev = at(NY, "2026-11-01 00:00");
    // 05:45 UTC is after the first 01:30 but before the second.
    let now = Utc.with_ymd_and_hms(2026, 11, 1, 5, 45, 0).unwrap();
    assert!(just_started(&r, prev, now));
}

#[test]
fn dst_window_still_closes_correctly_across_the_transition() {
    // A 23:00 -> 03:00 window over the spring-forward night: the local hour
    // 02:00-03:00 does not exist, so the window is one hour shorter in real time
    // but must still be active before it and closed after.
    let r = rule(&[6], "23:00", Some("03:00"), NY); // Saturday 2026-03-07
    assert!(is_active_at(&r, at(NY, "2026-03-07 23:30")));
    assert!(is_active_at(&r, at(NY, "2026-03-08 01:30")));
    // 03:00 local on the 8th is the end — exclusive.
    assert!(!is_active_at(&r, at(NY, "2026-03-08 03:00")));
}

#[test]
fn rule_timezone_wins_over_machine_timezone() {
    // 09:00-17:00 Tokyo is evaluated in Tokyo terms wherever the test runs.
    let r = rule(&[3], "09:00", Some("17:00"), "Asia/Tokyo");
    assert!(is_active_at(&r, at("Asia/Tokyo", "2026-07-29 09:30")));
    assert!(!is_active_at(&r, at("Asia/Tokyo", "2026-07-29 18:00")));
}

#[test]
fn specific_date_rule_fires_only_on_that_date() {
    let mut r = rule(&[], "09:00", Some("17:00"), NY);
    r.date = Some("2026-07-29".into());
    assert!(is_active_at(&r, at(NY, "2026-07-29 10:00")));
    assert!(!is_active_at(&r, at(NY, "2026-07-30 10:00")));
}

#[test]
fn last_start_edge_identifies_the_current_window() {
    // This is what the suppression flag is keyed on: it clears when the edge
    // changes, i.e. at the next scheduled start.
    let item = item_with(vec![rule(&[3], "09:00", Some("17:00"), NY)]);
    let edge = last_start_edge(&item, at(NY, "2026-07-29 10:00")).unwrap();
    assert_eq!(edge, at(NY, "2026-07-29 09:00"));

    // Still the same edge later in the same window...
    let same = last_start_edge(&item, at(NY, "2026-07-29 16:00")).unwrap();
    assert_eq!(same, edge);
}

#[test]
fn suppression_edge_changes_at_the_next_scheduled_start() {
    // Two consecutive scheduled days produce different edges, which is exactly
    // what clears a "manually closed" suppression.
    let item = item_with(vec![rule(&[3, 4], "09:00", Some("17:00"), NY)]);
    let wed = last_start_edge(&item, at(NY, "2026-07-29 10:00")).unwrap();
    let thu = last_start_edge(&item, at(NY, "2026-07-30 10:00")).unwrap();
    assert_ne!(wed, thu);
}

#[test]
fn malformed_times_are_rejected_rather_than_guessed() {
    assert_eq!(hhmm_to_min("09:00"), Some(540));
    assert_eq!(hhmm_to_min("00:00"), Some(0));
    assert_eq!(hhmm_to_min("23:59"), Some(1439));
    assert_eq!(hhmm_to_min("24:00"), None);
    assert_eq!(hhmm_to_min("9"), None);
    assert_eq!(hhmm_to_min(""), None);
    assert_eq!(hhmm_to_min("aa:bb"), None);
}

#[test]
fn missed_trigger_is_caught_up_after_a_long_gap() {
    // The PC slept through 09:00; the next tick spans the edge and must fire.
    let r = rule(&[3], "09:00", None, NY);
    let before = at(NY, "2026-07-29 07:00");
    let after = at(NY, "2026-07-29 11:00");
    assert!(just_started(&r, before, after));
}

#[test]
fn ambiguous_local_time_resolves_to_the_earlier_utc_instant() {
    // Direct check of the fall-back rule: 01:30 on 2026-11-01 in NY -> 05:30 UTC.
    let tz: Tz = NY.parse().unwrap();
    let d = NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();
    let naive = d.and_hms_opt(1, 30, 0).unwrap();
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Ambiguous(a, b) => {
            assert_eq!(a.with_timezone(&Utc).hour(), 5);
            assert_eq!(b.with_timezone(&Utc).hour(), 6);
        }
        other => panic!("expected an ambiguous local time, got {other:?}"),
    }
}
