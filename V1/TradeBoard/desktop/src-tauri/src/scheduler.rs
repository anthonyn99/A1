//! The background scheduler.
//!
//! A tokio task ticks every 20s, computes what SHOULD be true, compares it with
//! what IS true, and corrects the difference. Because it reconciles state rather
//! than firing timers, three awkward cases fall out for free:
//!
//!   • Missed triggers (PC asleep, shell not running) self-correct on the next
//!     tick — including the very first tick at startup, which is the "catch-up"
//!     behaviour in spec §4.
//!   • Duplicate/overlapping rules cannot double-launch: "should be open" is a
//!     single boolean OR across rules, and we only act when it disagrees with
//!     reality.
//!   • Disabling an item or one rule is honoured on the next tick, because the
//!     item list is re-read from shared state every time.

use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Manager};

use crate::model::{ItemType, LaunchItem, OpenIn};
use crate::schedule;
use crate::state::{close_item_inner, emit_action, open_item_inner, AppState};

const TICK: Duration = Duration::from_secs(20);

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Reconcile immediately on startup (catch-up), then on every tick.
        loop {
            if let Err(e) = tick(&app).await {
                eprintln!("scheduler tick failed: {e}");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

async fn tick(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let now = Utc::now();
    let prev = *state.last_tick.lock().unwrap();
    *state.last_tick.lock().unwrap() = Some(now);

    let items: Vec<LaunchItem> = state.items.lock().unwrap().clone();

    for item in items {
        if !item.enabled {
            continue;
        }

        // ── clear a stale suppression ───────────────────────────────────────
        // Suppression lasts only until the NEXT scheduled start, so compare the
        // edge we suppressed against the edge that is current now.
        let current_edge = schedule::last_start_edge(&item, now);
        {
            let mut rt = state.runtime.lock().unwrap();
            if let Some(e) = rt.get_mut(&item.id) {
                if e.suppressed_until_next_start && e.suppressed_for_edge != current_edge {
                    e.suppressed_until_next_start = false;
                    e.suppressed_for_edge = None;
                }
            }
        }

        let should_open = schedule::item_should_be_open(&item, now);
        // Open-only rules (no end time) have no sustained state; they fire on
        // their start edge instead. On the first tick after startup `prev` is
        // None, so we don't retro-fire every open-only rule in history.
        let edge_fired = match prev {
            Some(p) => schedule::item_just_triggered(&item, p, now),
            None => false,
        };

        let suppressed = state
            .runtime
            .lock()
            .unwrap()
            .get(&item.id)
            .map(|r| r.suppressed_until_next_start)
            .unwrap_or(false);

        let is_open = is_currently_open(app, &state, &item);

        // ── should be open but isn't → launch ───────────────────────────────
        if (should_open || edge_fired) && !is_open {
            if suppressed {
                continue; // user closed it by hand; wait for the next window
            }
            match open_item_inner(&item, app, &state) {
                Ok(()) => emit_action(
                    app,
                    format!("Opened \"{}\" on schedule.", item.name),
                    "ok",
                ),
                Err(e) => emit_action(
                    app,
                    format!("Failed to open \"{}\" on schedule — {e}", item.name),
                    "err",
                ),
            }
            continue;
        }

        // ── should be closed but isn't → close ──────────────────────────────
        // Only for items with at least one enabled rule that has an end time;
        // an item whose rules are all open-only is never auto-closed.
        if !should_open && is_open && has_closing_rule(&item) && was_opened_by_us(&state, app, &item)
        {
            match close_item_inner(Some(&item), &item.id, app, &state) {
                Ok(o) if !o.noop => emit_action(
                    app,
                    format!("Closed \"{}\" on schedule.", item.name),
                    "ok",
                ),
                Ok(_) => {}
                Err(e) => emit_action(
                    app,
                    format!("Failed to close \"{}\" on schedule — {e}", item.name),
                    "err",
                ),
            }
        }
    }
    Ok(())
}

fn has_closing_rule(item: &LaunchItem) -> bool {
    item.schedules
        .iter()
        .any(|r| r.enabled && r.end_time.is_some())
}

fn is_currently_open(app: &AppHandle, state: &AppState, item: &LaunchItem) -> bool {
    match item.item_type {
        ItemType::Website => match item.open_in() {
            OpenIn::ChildWindow => app
                .get_webview_window(&format!(
                    "site_{}",
                    item.id
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                        .collect::<String>()
                ))
                .is_some(),
            // Handed to the browser — we cannot observe it, so treat as "not
            // open" and let the start edge do the (idempotent enough) work.
            OpenIn::DefaultBrowser => false,
        },
        ItemType::DesktopApp => match state.procs.get(&item.id) {
            Some(t) => {
                let mut sys = state.sys.lock().unwrap();
                // Tolerant of re-parenting, or a program like Notepad that hands
                // off to a new pid would be relaunched on every tick.
                crate::state::is_alive_or_reparented(&mut sys, &state.procs, &item.id, &t)
            }
            None => item
                .target
                .path
                .as_deref()
                .map(|p| {
                    let mut sys = state.sys.lock().unwrap();
                    crate::process::any_running_by_path(&mut sys, p)
                })
                .unwrap_or(false),
        },
    }
}

/// May the scheduler close this? Only if we can positively identify the thing as
/// ours (spec §5): a tracked PID, or a child window we created. A process that
/// merely matches by path — e.g. an editor the user opened themselves — is left
/// strictly alone.
fn was_opened_by_us(state: &AppState, app: &AppHandle, item: &LaunchItem) -> bool {
    match item.item_type {
        ItemType::Website => match item.open_in() {
            OpenIn::ChildWindow => app
                .get_webview_window(&format!(
                    "site_{}",
                    item.id
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                        .collect::<String>()
                ))
                .is_some(),
            OpenIn::DefaultBrowser => false,
        },
        ItemType::DesktopApp => state.procs.get(&item.id).is_some(),
    }
}
