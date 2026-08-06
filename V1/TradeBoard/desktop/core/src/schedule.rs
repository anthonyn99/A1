//! Schedule evaluation: "should this item be open right now?"
//!
//! All reasoning happens in each rule's own IANA timezone via chrono-tz, so DST
//! is handled by the tz database rather than by offset arithmetic (spec §4).
//! This module is pure — no process or state access — which is what makes the
//! midnight-crossing and DST cases testable (see ../tests/schedule_tests.rs).

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

use crate::model::{LaunchItem, ScheduleRule};

/// Parse "HH:mm" into minutes since local midnight.
pub fn hhmm_to_min(s: &str) -> Option<u32> {
    let s = s.trim();
    let (h, m) = s.split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

pub fn tz_of(rule: &ScheduleRule) -> Tz {
    rule.timezone
        .as_deref()
        .and_then(|s| s.parse::<Tz>().ok())
        .unwrap_or_else(system_tz)
}

/// The machine's IANA zone, falling back to UTC if it can't be determined.
pub fn system_tz() -> Tz {
    iana_time_zone::get_timezone()
        .ok()
        .and_then(|s| s.parse::<Tz>().ok())
        .unwrap_or(chrono_tz::UTC)
}

fn day_matches(rule: &ScheduleRule, local_date: NaiveDate, weekday0: u32) -> bool {
    if let Some(d) = rule.date.as_deref() {
        return NaiveDate::parse_from_str(d, "%Y-%m-%d")
            .map(|rd| rd == local_date)
            .unwrap_or(false);
    }
    rule.days_of_week
        .as_ref()
        .map(|v| v.contains(&weekday0))
        .unwrap_or(false)
}

/// chrono's weekday numbering is Mon=0; the data model (and JS `getDay()`) use
/// Sun=0, so convert rather than storing two conventions.
fn weekday0(dt: &DateTime<Tz>) -> u32 {
    dt.weekday().num_days_from_sunday()
}

/// Does this rule say the item should be OPEN at `now`?
///
/// A rule with no end time is "open-only": it has no sustained open state, so it
/// returns false here and is fired by `just_started` instead.
pub fn is_active_at(rule: &ScheduleRule, now: DateTime<Utc>) -> bool {
    if !rule.enabled {
        return false;
    }
    let (Some(start), Some(end_s)) = (hhmm_to_min(&rule.start_time), rule.end_time.as_deref())
    else {
        return false;
    };
    let Some(end) = hhmm_to_min(end_s) else {
        return false;
    };

    let tz = tz_of(rule);
    let local = now.with_timezone(&tz);
    let mins = local.hour() * 60 + local.minute();
    let today = local.date_naive();

    if end > start {
        // Ordinary same-day window.
        day_matches(rule, today, weekday0(&local)) && mins >= start && mins < end
    } else {
        // Crosses midnight: [start,24:00) counts against today, [00:00,end)
        // against YESTERDAY's start day.
        if mins >= start && day_matches(rule, today, weekday0(&local)) {
            return true;
        }
        if mins < end {
            let y = local - Duration::days(1);
            return day_matches(rule, y.date_naive(), weekday0(&y));
        }
        false
    }
}

/// Did this rule's start edge fall inside (prev, now]? This is what fires
/// open-only rules exactly once, and it's edge-triggered so a duplicate rule
/// with the same start cannot double-launch (the caller ORs across rules).
pub fn just_started(rule: &ScheduleRule, prev: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    if !rule.enabled || prev >= now {
        return false;
    }
    let Some(start) = hhmm_to_min(&rule.start_time) else {
        return false;
    };
    let tz = tz_of(rule);

    // Walk each local date the (prev, now] span could touch — at most a couple
    // even for a long sleep-resume gap, and this correctly ignores a start time
    // that DST skipped over entirely.
    let mut d = prev.with_timezone(&tz).date_naive() - Duration::days(1);
    let last = now.with_timezone(&tz).date_naive() + Duration::days(1);
    while d <= last {
        if let Some(instant) = local_at(tz, d, start) {
            if instant > prev && instant <= now {
                let l = instant.with_timezone(&tz);
                if day_matches(rule, l.date_naive(), weekday0(&l)) {
                    return true;
                }
            }
        }
        d += Duration::days(1);
    }
    false
}

/// Resolve a local wall-clock time on a local date to a real instant.
///
/// DST corner cases, both handled by chrono-tz rather than by us:
///   • Spring-forward gap (that wall time never happens): `None`, so the trigger
///     is skipped rather than firing at a wrong moment.
///   • Fall-back ambiguity (it happens twice): the EARLIER instant, so a window
///     opens at the first occurrence.
fn local_at(tz: Tz, date: NaiveDate, minutes: u32) -> Option<DateTime<Utc>> {
    let t = NaiveTime::from_hms_opt(minutes / 60, minutes % 60, 0)?;
    let naive = date.and_time(t);
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.with_timezone(&Utc)),
        chrono::LocalResult::Ambiguous(a, _b) => Some(a.with_timezone(&Utc)),
        chrono::LocalResult::None => None,
    }
}

/// Should the item be open at `now`, per ANY of its enabled rules?
/// Overlapping/duplicate rules collapse to one boolean here, which is what makes
/// double-launching structurally impossible (spec §4).
pub fn item_should_be_open(item: &LaunchItem, now: DateTime<Utc>) -> bool {
    item.enabled && item.schedules.iter().any(|r| is_active_at(r, now))
}

/// Did any enabled rule's start edge fall in (prev, now]?
pub fn item_just_triggered(item: &LaunchItem, prev: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    item.enabled
        && item
            .schedules
            .iter()
            .any(|r| just_started(r, prev, now))
}

/// The most recent start edge at or before `now`, across enabled rules.
/// The suppression flag is cleared when this value changes — i.e. at the next
/// scheduled start, per spec §4.
pub fn last_start_edge(item: &LaunchItem, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let mut best: Option<DateTime<Utc>> = None;
    for rule in item.schedules.iter().filter(|r| r.enabled) {
        let Some(start) = hhmm_to_min(&rule.start_time) else {
            continue;
        };
        let tz = tz_of(rule);
        let today = now.with_timezone(&tz).date_naive();
        // 8 days back covers weekly recurrence.
        for back in 0..=8 {
            let d = today - Duration::days(back);
            if let Some(instant) = local_at(tz, d, start) {
                if instant <= now {
                    let l = instant.with_timezone(&tz);
                    if day_matches(rule, l.date_naive(), weekday0(&l))
                        && best.map(|b| instant > b).unwrap_or(true)
                    {
                        best = Some(instant);
                    }
                    break;
                }
            }
        }
    }
    best
}
