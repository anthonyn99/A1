//! Process enumeration, capture, termination and relaunch.
//!
//! The single most important rule in this file: **capture before you kill.**
//! `Win32_Process.CommandLine` and the full image path are only readable while
//! the process is alive. Shield's whole Reopen feature depends on reading them
//! first, so `capture_and_kill` always builds the manifest before it sends a
//! single close message. Getting that order wrong does not fail loudly — it
//! just silently produces history entries that can never be reverted.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};

use windows::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, TerminateProcess, PROCESS_TERMINATE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
};

/// Processes Shield refuses to touch under any configuration.
///
/// A name-matched kill loop that catches `explorer.exe` does not read as a bug
/// to the person using it — it reads as the machine breaking. This list is
/// checked on every path (configure, close, watchdog), not just at input time,
/// because configuration syncs in from other devices and from older versions.
const DENY: &[&str] = &[
    "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
    "services.exe", "lsass.exe", "lsaiso.exe", "svchost.exe", "explorer.exe",
    "dwm.exe", "fontdrvhost.exe", "sihost.exe", "ctfmon.exe", "taskhostw.exe",
    "runtimebroker.exe", "searchhost.exe", "startmenuexperiencehost.exe",
    "shellexperiencehost.exe", "textinputhost.exe", "audiodg.exe",
    "wudfhost.exe", "conhost.exe", "shield.exe", "shield-agent.exe",
];

pub fn is_denied(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    DENY.iter().any(|d| *d == n)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Match {
    #[serde(rename = "type", default = "default_match_type")]
    pub kind: String, // "exe" | "path"
    #[serde(default)]
    pub value: String,
}
fn default_match_type() -> String {
    "exe".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_match")]
    pub r#match: Match,
    #[serde(default, rename = "hideIcons")]
    pub hide_icons: bool,
}
fn default_match() -> Match {
    Match { kind: "exe".into(), value: String::new() }
}

impl Target {
    pub fn display(&self) -> String {
        if !self.label.is_empty() { self.label.clone() } else { self.r#match.value.clone() }
    }
    /// Exact stem/name matching, never substring.
    ///
    /// Substring matching looks helpful right up until "code" also matches
    /// `codecs.exe` and Shield kills something the user never named. An exact
    /// match is predictable, and the picker in the UI offers real running names
    /// so there is nothing to guess at.
    fn matches(&self, name: &str, exe_path: &str) -> bool {
        let v = self.r#match.value.trim();
        if v.is_empty() {
            return false;
        }
        if self.r#match.kind == "path" {
            return exe_path.eq_ignore_ascii_case(v);
        }
        name.eq_ignore_ascii_case(v)
            || std::path::Path::new(v)
                .file_name()
                .map(|f| name.eq_ignore_ascii_case(&f.to_string_lossy()))
                .unwrap_or(false)
    }
}

/// How to start one process again. Captured while it is still alive.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LaunchItem {
    pub path: String,
    #[serde(default)]
    pub cmd: String,
    #[serde(default)]
    pub dir: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TargetResult {
    pub label: String,
    pub r#match: String,
    /// closed | notrunning | notfound | denied | failed
    pub status: String,
    pub count: u32,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
    pub launch: Vec<LaunchItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LaunchResult {
    pub label: String,
    /// launched | notfound | denied | failed
    pub status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
}

/// A fresh process snapshot.
///
/// `new_all()` rather than a narrowed `RefreshKind`: the specifics builder has
/// been renamed twice across recent sysinfo releases, and this is called a few
/// times per action, not in a hot loop. Correct and version-stable beats
/// marginally cheaper here.
fn sys() -> System {
    System::new_all()
}

/// Running executables and installed shortcut names, for the "add target" picker.
pub fn enumerate() -> (Vec<String>, Vec<String>) {
    let s = sys();
    let mut names: Vec<String> = s
        .processes()
        .values()
        .filter_map(|p| {
            let n = p.name().to_string_lossy().to_string();
            if n.is_empty() || is_denied(&n) { None } else { Some(n) }
        })
        .collect();
    names.sort_by_key(|n| n.to_ascii_lowercase());
    names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));

    let mut shortcuts = crate::shortcuts::list_shortcut_names();
    shortcuts.sort_by_key(|n| n.to_ascii_lowercase());
    shortcuts.dedup_by(|a, b| a.eq_ignore_ascii_case(b));

    (names, shortcuts)
}

struct Found {
    pid: Pid,
    launch: LaunchItem,
}

fn find(target: &Target, s: &System) -> Vec<Found> {
    let mut out = Vec::new();
    for (pid, p) in s.processes() {
        let name = p.name().to_string_lossy().to_string();
        if name.is_empty() || is_denied(&name) {
            continue;
        }
        let exe = p.exe().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        if !target.matches(&name, &exe) {
            continue;
        }
        // The manifest is built HERE, while the process is alive. After
        // termination none of this is readable.
        let cmd_parts: Vec<String> =
            p.cmd().iter().map(|c| c.to_string_lossy().to_string()).collect();
        out.push(Found {
            pid: *pid,
            launch: LaunchItem {
                path: exe,
                cmd: cmd_parts.join(" "),
                dir: p.cwd().map(|c| c.to_string_lossy().to_string()).unwrap_or_default(),
                name,
            },
        });
    }
    out
}

// ── Graceful close ──────────────────────────────────────────────────────────
// WM_CLOSE first so an editor gets to prompt about unsaved work; TerminateProcess
// only for what is still standing afterwards. Force-killing a browser outright
// loses every open tab, which is a real cost to pay for a fraction of a second.

struct EnumCtx {
    want: u32,
    hwnds: Vec<HWND>,
}

unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumCtx);
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == ctx.want && IsWindowVisible(hwnd).as_bool() {
        ctx.hwnds.push(hwnd);
    }
    BOOL(1)
}

fn top_level_windows(pid: u32) -> Vec<HWND> {
    let mut ctx = EnumCtx { want: pid, hwnds: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut ctx as *mut _ as isize));
    }
    ctx.hwnds
}

fn request_close(pid: u32) -> bool {
    let hwnds = top_level_windows(pid);
    let mut sent = false;
    for h in hwnds {
        unsafe {
            // windows 0.58 takes a bare HWND here; it became Option<HWND> in a
            // later release. If this stops compiling after a crate bump, that
            // is the change.
            if PostMessageW(h, WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok() {
                sent = true;
            }
        }
    }
    sent
}

fn force_kill(pid: u32) -> Result<(), String> {
    unsafe {
        let handle: HANDLE =
            OpenProcess(PROCESS_TERMINATE, false, pid).map_err(|e| classify(&e.to_string()))?;
        let r = TerminateProcess(handle, 1);
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        r.map_err(|e| classify(&e.to_string()))
    }
}

/// Turn a Win32 error into something the UI can say out loud. "Access denied"
/// on a process almost always means it is elevated and Shield is not.
fn classify(msg: &str) -> String {
    let m = msg.to_ascii_lowercase();
    if m.contains("access is denied") || m.contains("0x80070005") {
        "denied".into()
    } else {
        msg.to_string()
    }
}

fn still_alive(pids: &[u32]) -> Vec<u32> {
    let s = sys();
    pids.iter()
        .copied()
        .filter(|p| s.process(Pid::from_u32(*p)).is_some())
        .collect()
}

/// The main path: capture the manifest, ask nicely, then force what is left.
pub fn capture_and_kill(targets: &[Target], graceful_ms: u64) -> Vec<TargetResult> {
    let s = sys();
    let mut results = Vec::new();
    let mut pending: HashMap<usize, Vec<u32>> = HashMap::new();

    for (i, t) in targets.iter().enumerate() {
        let label = t.display();
        if t.r#match.value.trim().is_empty() {
            results.push(TargetResult {
                label, r#match: t.r#match.value.clone(), status: "notfound".into(),
                count: 0, error: String::new(), launch: vec![],
            });
            continue;
        }
        if is_denied(&t.r#match.value) {
            results.push(TargetResult {
                label, r#match: t.r#match.value.clone(), status: "denied".into(), count: 0,
                error: "protected system process — Shield will not target this".into(),
                launch: vec![],
            });
            continue;
        }
        let found = find(t, &s);
        if found.is_empty() {
            results.push(TargetResult {
                label, r#match: t.r#match.value.clone(), status: "notrunning".into(),
                count: 0, error: String::new(), launch: vec![],
            });
            continue;
        }
        let launch: Vec<LaunchItem> =
            found.iter().filter(|f| !f.launch.path.is_empty()).map(|f| f.launch.clone()).collect();
        let pids: Vec<u32> = found.iter().map(|f| f.pid.as_u32()).collect();
        for pid in &pids {
            request_close(*pid);
        }
        pending.insert(i, pids.clone());
        results.push(TargetResult {
            label, r#match: t.r#match.value.clone(), status: "closed".into(),
            count: pids.len() as u32, error: String::new(), launch,
        });
    }

    if pending.is_empty() {
        return results;
    }

    // Give the polite route a moment, polling rather than sleeping the whole
    // budget — most apps are gone in well under 200ms.
    let deadline = Instant::now() + Duration::from_millis(graceful_ms);
    let mut alive: Vec<u32> = pending.values().flatten().copied().collect();
    while Instant::now() < deadline && !alive.is_empty() {
        std::thread::sleep(Duration::from_millis(80));
        alive = still_alive(&alive);
    }

    for (i, pids) in pending {
        let mut denied = 0;
        let mut failed: Option<String> = None;
        for pid in pids.iter() {
            if !alive.contains(pid) {
                continue;
            }
            match force_kill(*pid) {
                Ok(()) => {}
                Err(e) if e == "denied" => denied += 1,
                Err(e) => failed = Some(e),
            }
        }
        let leftover = still_alive(&pids);
        if !leftover.is_empty() {
            let r = &mut results[i];
            if denied > 0 {
                r.status = "denied".into();
                r.error = "needs admin".into();
            } else {
                r.status = "failed".into();
                r.error = failed.unwrap_or_else(|| "process would not close".into());
            }
            r.count = (pids.len() - leftover.len()) as u32;
        }
    }
    results
}

/// Watchdog path: no manifest, no grace period, no reporting. Kill on sight.
///
/// Deliberately does NOT capture launch data — the entry that opened the
/// emergency already recorded how to start these again, and re-capturing on
/// every 750ms tick would both cost real work and overwrite that record with
/// whatever a half-started relaunch happened to look like.
pub fn kill_on_sight(targets: &[Target]) -> u32 {
    let s = sys();
    let mut n = 0;
    for t in targets {
        if t.r#match.value.trim().is_empty() || is_denied(&t.r#match.value) {
            continue;
        }
        for f in find(t, &s) {
            if force_kill(f.pid.as_u32()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(kind: &str, value: &str) -> Target {
        Target {
            id: "x".into(),
            label: "X".into(),
            r#match: Match { kind: kind.into(), value: value.into() },
            hide_icons: false,
        }
    }

    #[test]
    fn deny_list_is_case_insensitive() {
        assert!(is_denied("explorer.exe"));
        assert!(is_denied("Explorer.EXE"));
        assert!(is_denied("  CSRSS.exe  "));
        assert!(!is_denied("discord.exe"));
    }

    #[test]
    fn matching_is_exact_never_substring() {
        // The whole reason for exact matching: "code" must not take out
        // codecs.exe, and "steam" must not take out steamwebhelper.exe.
        let code = t("exe", "code.exe");
        assert!(code.matches("code.exe", r"C:\VS Code\code.exe"));
        assert!(!code.matches("codecs.exe", r"C:\x\codecs.exe"));
        assert!(!code.matches("qcode.exe", r"C:\x\qcode.exe"));

        let steam = t("exe", "steam.exe");
        assert!(!steam.matches("steamwebhelper.exe", r"C:\Steam\steamwebhelper.exe"));
    }

    #[test]
    fn exe_matching_ignores_case_and_accepts_a_full_path_as_the_value() {
        let d = t("exe", "Discord.exe");
        assert!(d.matches("discord.exe", r"C:\a\discord.exe"));
        // Someone pastes a full path but leaves the type as exe — match on the
        // file name rather than silently never firing.
        let p = t("exe", r"C:\Users\a\AppData\Discord.exe");
        assert!(p.matches("discord.exe", r"D:\somewhere\else\discord.exe"));
    }

    #[test]
    fn path_matching_compares_the_whole_path() {
        let p = t("path", r"C:\Games\steam.exe");
        assert!(p.matches("steam.exe", r"c:\games\steam.exe"));
        assert!(!p.matches("steam.exe", r"D:\Games\steam.exe"));
    }

    #[test]
    fn an_empty_target_matches_nothing() {
        let e = t("exe", "");
        assert!(!e.matches("discord.exe", r"C:\a\discord.exe"));
        assert!(!e.matches("", ""));
    }

    /// End-to-end against a REAL process: capture its manifest, kill it, then
    /// start it again from what was captured.
    ///
    /// This is the test that actually proves Reopen works. It copies a stock
    /// system binary to a uniquely-named file first, so the exact-name match can
    /// never collide with anything else running on the machine — matching on
    /// `ping.exe` directly would risk killing something the user started.
    #[test]
    fn captures_kills_and_reopens_a_real_process() {
        use std::process::Command;

        let uniq = format!("shield_selftest_{}_{}.exe", std::process::id(), now_ish());
        let dir = std::env::temp_dir();
        let exe = dir.join(&uniq);
        if std::fs::copy(r"C:\Windows\System32\PING.EXE", &exe).is_err() {
            eprintln!("skipping: could not stage a test binary");
            return;
        }

        let spawn = || {
            Command::new(&exe).args(["-n", "600", "127.0.0.1"]).spawn().expect("spawn test process")
        };
        let mut child = spawn();
        std::thread::sleep(Duration::from_millis(600)); // let it show up in the process table

        let target = t("exe", &uniq);

        // 1. capture + kill. No window, so WM_CLOSE cannot land and this
        //    exercises the force path after the grace period.
        let r = capture_and_kill(&[target.clone()], 300);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].status, "closed", "error was {:?}", r[0].error);
        assert_eq!(r[0].count, 1);

        // 2. the manifest has to carry a usable path, or Reopen is dead
        assert_eq!(r[0].launch.len(), 1);
        let captured = &r[0].launch[0];
        assert!(
            captured.path.eq_ignore_ascii_case(&exe.to_string_lossy()),
            "captured {:?}, expected {:?}",
            captured.path,
            exe
        );
        assert!(captured.cmd.contains("127.0.0.1"), "command line not captured: {:?}", captured.cmd);

        // 3. it is really gone
        std::thread::sleep(Duration::from_millis(400));
        assert!(find(&target, &sys()).is_empty(), "process survived the kill");
        let _ = child.wait();

        // 4. reopen from the captured manifest.
        //
        //    Only the SPAWN is asserted, not that the process is still alive a
        //    moment later — Shield starts the bare image and does not replay the
        //    captured command line, so a target that needs arguments (this stand-in
        //    is a copy of ping.exe, which prints usage and exits without them)
        //    legitimately goes away again. That is the documented behaviour and
        //    it is right for the real targets: for a multi-process app like a
        //    browser, the manifest holds the main process AND its renderers, all
        //    sharing one image path, and replaying a renderer's command line
        //    would start something nonsensical.
        let lr = launch(&[("selftest".into(), r[0].launch.clone())]);
        assert_eq!(lr[0].status, "launched", "error was {:?}", lr[0].error);

        // 5. and it is genuinely the CAPTURED path being started, not the name
        //    or a guess: the same manifest with a path that does not exist has
        //    to come back notfound.
        //
        //    Deleting the staged file to prove this does not work — Windows
        //    keeps the image locked for a moment after step 4 spawned it, so the
        //    removal quietly fails and the assertion passes for the wrong
        //    reason. A synthetic path is deterministic.
        let mut bogus = r[0].launch[0].clone();
        bogus.path = dir.join("shield_selftest_does_not_exist.exe").to_string_lossy().into();
        let gone = launch(&[("selftest".into(), vec![bogus])]);
        assert_eq!(gone[0].status, "notfound", "error was {:?}", gone[0].error);

        // clean up anything the reopen in step 4 may have left behind
        capture_and_kill(&[target], 200);
        std::thread::sleep(Duration::from_millis(300));
        // Best effort: the image can stay locked briefly after the last exit.
        for _ in 0..10 {
            if std::fs::remove_file(&exe).is_ok() || !exe.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    /// A target whose processes were all unreadable leaves an empty manifest,
    /// and Reopen has to say so rather than claim success on nothing.
    #[test]
    fn reopening_an_empty_manifest_is_reported_as_notfound() {
        let r = launch(&[("Nothing".into(), vec![])]);
        assert_eq!(r[0].status, "notfound");
        assert!(r[0].error.contains("nothing was captured"));
    }

    fn now_ish() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    #[test]
    fn a_denied_target_is_reported_not_silently_skipped() {
        // "notrunning" would read as "there was nothing to do". Refusing to
        // touch a system process is a different fact and has to say so.
        let r = capture_and_kill(&[t("exe", "explorer.exe")], 0);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].status, "denied");
        assert!(r[0].error.contains("protected"));
    }
}

/// Reopen from a captured manifest.
pub fn launch(items: &[(String, Vec<LaunchItem>)]) -> Vec<LaunchResult> {
    use std::process::Command;
    let mut out = Vec::new();
    for (label, launches) in items {
        if launches.is_empty() {
            out.push(LaunchResult {
                label: label.clone(), status: "notfound".into(),
                error: "nothing was captured for this target".into(),
            });
            continue;
        }
        let mut ok = 0;
        let mut last_err = String::new();
        // One process per distinct image path. A multi-process app (a browser,
        // Discord) forks its own helpers on startup, so replaying every captured
        // PID would open the app several times over.
        let mut seen: Vec<String> = Vec::new();
        for l in launches {
            if l.path.is_empty() || seen.iter().any(|s| s.eq_ignore_ascii_case(&l.path)) {
                continue;
            }
            seen.push(l.path.clone());
            if !std::path::Path::new(&l.path).exists() {
                last_err = "executable no longer exists".into();
                continue;
            }
            // The captured command line is NOT replayed. It routinely contains
            // one-shot arguments (a crash-handler pipe, a parent PID, an update
            // token) that are meaningless or actively harmful the second time.
            // Starting the image from its own directory is the predictable
            // behaviour, and it is what "reopen the app" actually means.
            let mut c = Command::new(&l.path);
            if !l.dir.is_empty() && std::path::Path::new(&l.dir).is_dir() {
                c.current_dir(&l.dir);
            } else if let Some(p) = std::path::Path::new(&l.path).parent() {
                c.current_dir(p);
            }
            match c.spawn() {
                Ok(_) => ok += 1,
                Err(e) => last_err = classify(&e.to_string()),
            }
        }
        out.push(if ok > 0 {
            LaunchResult { label: label.clone(), status: "launched".into(), error: String::new() }
        } else if last_err == "denied" {
            LaunchResult { label: label.clone(), status: "denied".into(), error: "needs admin".into() }
        } else {
            LaunchResult {
                label: label.clone(),
                status: if last_err.contains("no longer exists") { "notfound".into() } else { "failed".into() },
                error: last_err,
            }
        });
    }
    out
}
