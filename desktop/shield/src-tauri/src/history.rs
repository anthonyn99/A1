//! The agent's own close history.
//!
//! Why the agent owns this rather than the page: the tray menu and the global
//! hotkeys are the PRIMARY way Shield gets used — that is the whole reason a
//! desktop agent exists — and both of them fire with no window open. If history
//! only existed in the page's localStorage, the most common path would close
//! applications and record nothing, leaving Reopen permanently empty for
//! exactly the actions people actually take.
//!
//! So the agent writes the entry, returns its id, and the page mirrors it. When
//! the page opens later it calls `sh_pull_history` and merges anything it
//! missed. One id, one entry, whoever started it.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::proc::{LaunchItem, TargetResult};
use crate::shortcuts::{shield_dir, HiddenItem};
use crate::state::now_ms;

const MAX: usize = 50;

fn path() -> PathBuf {
    shield_dir().join("history.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistItem {
    pub label: String,
    #[serde(default)]
    pub r#match: String,
    pub status: String,
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub launch: Vec<LaunchItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistEntry {
    pub id: String,
    /// "closer" | "emergency"
    pub kind: String,
    pub at: u64,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub items: Vec<HistItem>,
    #[serde(default)]
    pub hidden: Vec<HiddenItem>,
    #[serde(default)]
    pub reverted: bool,
    #[serde(default, rename = "revertedAt")]
    pub reverted_at: u64,
}

static LOCK: Mutex<()> = Mutex::new(());

pub fn all() -> Vec<HistEntry> {
    fs::read_to_string(path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<HistEntry>>(&raw).ok())
        .unwrap_or_default()
}

fn write_all(list: &[HistEntry]) {
    let dir = shield_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let tmp = dir.join("history.json.tmp");
    if let Ok(json) = serde_json::to_string_pretty(&list[..list.len().min(MAX)]) {
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, path());
        }
    }
}

/// A short, collision-free-enough id. Matches the page's `h_` prefix so the two
/// sides can be merged without caring which produced an entry.
pub fn new_id() -> String {
    let t = now_ms();
    let r: u32 = std::process::id() ^ (t as u32).rotate_left(7);
    format!("h_a{:x}{:x}", t & 0xffff_ffff, r & 0xffff)
}

pub fn record(
    id: &str,
    kind: &str,
    scope: &str,
    source: &str,
    results: &[TargetResult],
    hidden: &[HiddenItem],
) -> HistEntry {
    let _g = LOCK.lock().unwrap();
    let e = HistEntry {
        id: id.to_string(),
        kind: kind.to_string(),
        at: now_ms(),
        scope: scope.to_string(),
        source: source.to_string(),
        items: results
            .iter()
            .map(|r| HistItem {
                label: r.label.clone(),
                r#match: r.r#match.clone(),
                status: r.status.clone(),
                count: r.count,
                error: r.error.clone(),
                launch: r.launch.clone(),
            })
            .collect(),
        hidden: hidden.to_vec(),
        reverted: false,
        reverted_at: 0,
    };
    let mut list = all();
    list.insert(0, e.clone());
    list.truncate(MAX);
    write_all(&list);
    e
}

pub fn mark_reverted(id: &str) {
    let _g = LOCK.lock().unwrap();
    let mut list = all();
    for e in list.iter_mut() {
        if e.id == id {
            e.reverted = true;
            e.reverted_at = now_ms();
        }
    }
    write_all(&list);
}

pub fn since(ts: u64) -> Vec<HistEntry> {
    all().into_iter().filter(|e| e.at > ts).collect()
}

pub fn get(id: &str) -> Option<HistEntry> {
    all().into_iter().find(|e| e.id == id)
}
