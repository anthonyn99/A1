//! Shared types. These mirror the LaunchItem shape that `TB.apps` in
//! tradeboard.html persists to Firestore, so the JSON crosses the bridge with
//! no translation layer.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    DesktopApp,
    Website,
}

/// Where a website should be opened. Only `ChildWindow` can be closed reliably.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OpenIn {
    #[default]
    ChildWindow,
    DefaultBrowser,
}

/// The target is a tagged union on the JS side; here both variants' fields are
/// optional on one struct so a malformed/partial item deserializes instead of
/// failing the whole list.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Target {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub open_in: Option<OpenIn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleRule {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 0 = Sunday .. 6 = Saturday. Ignored when `date` is set.
    #[serde(rename = "daysOfWeek", default)]
    pub days_of_week: Option<Vec<u32>>,
    /// "YYYY-MM-DD" for a one-off rule; takes precedence over `days_of_week`.
    #[serde(default)]
    pub date: Option<String>,
    #[serde(rename = "startTime")]
    pub start_time: String,
    /// `None` = open-only: fire at start, never auto-close.
    #[serde(rename = "endTime", default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchItem {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub target: Target,
    #[serde(default)]
    pub schedules: Vec<ScheduleRule>,
}

impl LaunchItem {
    pub fn open_in(&self) -> OpenIn {
        self.target.open_in.unwrap_or_default()
    }
}

fn default_true() -> bool {
    true
}

/// One row of `list_running()`.
#[derive(Debug, Clone, Serialize)]
pub struct RunningStatus {
    pub id: String,
    pub running: bool,
    /// True while a manual close suppresses re-launching inside the current
    /// scheduled window (see scheduler.rs).
    pub suppressed: bool,
}

/// `close_item` reports whether there was anything to close, so the UI can say
/// "wasn't running" rather than claiming a close that never happened.
#[derive(Debug, Clone, Serialize)]
pub struct CloseOutcome {
    pub noop: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidateOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What the scheduler emits to the frontend so the history log records
/// background activity too.
#[derive(Debug, Clone, Serialize)]
pub struct ActionEvent {
    pub message: String,
    /// "ok" | "err" | "" — matches the toast/log vocabulary in the web app.
    pub kind: String,
}
