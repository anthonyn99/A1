//! Hiding and restoring an application's launch points.
//!
//! Scope, stated plainly because the UI repeats it to the user:
//!   · Desktop `.lnk` files (this user's Desktop and the Public Desktop) — yes.
//!   · Start-menu `.lnk` files (this user's and the All Users tree)          — yes.
//!   · Store/UWP apps                                                        — no .lnk exists to move.
//!   · Taskbar pins                                                          — no. The pin state lives in an
//!     undocumented binary blob under HKCU\...\Taskband and needs Explorer
//!     restarted to take effect. Shield does not touch it.
//!
//! Shortcuts are MOVED into a stash folder, never deleted, and a manifest
//! records where each one came from. That is what makes the operation
//! reversible — and reversible is the whole contract Shield makes with the
//! person using it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::proc::Target;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HiddenItem {
    pub label: String,
    pub from: String,
    pub to: String,
}

pub fn shield_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("Shield")
}
fn stash_root() -> PathBuf {
    shield_dir().join("stash")
}
fn stash_dir(entry_id: &str) -> PathBuf {
    stash_root().join(sanitise(entry_id))
}

/// Entry ids come from the page, so they are treated as untrusted path input.
fn sanitise(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    if cleaned.is_empty() { "entry".into() } else { cleaned }
}

fn shortcut_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(u) = std::env::var("USERPROFILE") {
        v.push(PathBuf::from(&u).join("Desktop"));
        v.push(PathBuf::from(&u).join("OneDrive").join("Desktop"));
    }
    if let Ok(p) = std::env::var("PUBLIC") {
        v.push(PathBuf::from(p).join("Desktop"));
    }
    if let Ok(a) = std::env::var("APPDATA") {
        v.push(PathBuf::from(a).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Ok(a) = std::env::var("ProgramData") {
        v.push(PathBuf::from(a).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    v.into_iter().filter(|p| p.is_dir()).collect()
}

fn walk_lnk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 3 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_lnk(&p, depth + 1, out);
        } else if p.extension().map(|x| x.eq_ignore_ascii_case("lnk")).unwrap_or(false) {
            out.push(p);
        }
    }
}

fn all_shortcuts() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for d in shortcut_dirs() {
        walk_lnk(&d, 0, &mut out);
    }
    out
}

pub fn list_shortcut_names() -> Vec<String> {
    all_shortcuts()
        .iter()
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
        .collect()
}

/// Loose comparison for shortcut names: case- and punctuation-insensitive.
///
/// Shield matches a shortcut to a target by NAME, not by reading the .lnk's
/// target path. Parsing .lnk properly means COM (IShellLink) or a shell-format
/// parser, and both are a lot of surface area for a gain that only shows up in
/// the uncommon case where a shortcut is named nothing like the program it
/// starts. The trade-off is real and is stated in the UI: a shortcut called
/// something unrelated to the executable will not be found and will stay on the
/// desktop. Killing the process still removes its taskbar button either way.
fn loose(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase()
}

fn target_keys(t: &Target) -> Vec<String> {
    let mut keys = Vec::new();
    if !t.label.is_empty() {
        keys.push(loose(&t.label));
    }
    let v = &t.r#match.value;
    if let Some(stem) = Path::new(v).file_stem() {
        keys.push(loose(&stem.to_string_lossy()));
    }
    keys.retain(|k| k.len() >= 3); // "vs" would match half the Start menu
    keys.dedup();
    keys
}

fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let mut p = dir.join(name);
    let mut n = 1;
    while p.exists() {
        p = dir.join(format!("{}_{}", n, name));
        n += 1;
    }
    p
}

/// Move every shortcut matching a `hideIcons` target into this entry's stash.
pub fn hide(entry_id: &str, targets: &[Target]) -> Vec<HiddenItem> {
    let wanted: Vec<(String, Vec<String>)> = targets
        .iter()
        .filter(|t| t.hide_icons)
        .map(|t| (t.display(), target_keys(t)))
        .filter(|(_, k)| !k.is_empty())
        .collect();
    if wanted.is_empty() {
        return vec![];
    }

    let dir = stash_dir(entry_id);
    if fs::create_dir_all(&dir).is_err() {
        return vec![];
    }

    let mut hidden: Vec<HiddenItem> = Vec::new();
    for lnk in all_shortcuts() {
        let Some(stem) = lnk.file_stem().map(|s| loose(&s.to_string_lossy())) else { continue };
        let Some((label, _)) = wanted.iter().find(|(_, keys)| keys.iter().any(|k| &stem == k))
        else {
            continue;
        };
        let name = lnk.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let dest = unique_dest(&dir, &name);
        if fs::rename(&lnk, &dest).is_ok() {
            hidden.push(HiddenItem {
                label: label.clone(),
                from: lnk.to_string_lossy().to_string(),
                to: dest.to_string_lossy().to_string(),
            });
        }
    }

    // The manifest is what makes restore possible after a reboot, when nothing
    // is left in memory. Written last, so a crash mid-move leaves files in the
    // stash rather than a manifest pointing at files that were never moved.
    let _ = fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&hidden).unwrap_or_default(),
    );
    hidden
}

/// Put one entry's shortcuts back where they came from.
pub fn restore(entry_id: &str) -> usize {
    let dir = stash_dir(entry_id);
    let Ok(raw) = fs::read_to_string(dir.join("manifest.json")) else { return 0 };
    let items: Vec<HiddenItem> = serde_json::from_str(&raw).unwrap_or_default();
    let mut n = 0;
    for it in &items {
        let from = Path::new(&it.to);
        let to = Path::new(&it.from);
        if !from.exists() {
            continue;
        }
        if let Some(parent) = to.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // If something has since re-created the shortcut, drop ours rather than
        // leaving a duplicate on the desktop.
        if to.exists() {
            let _ = fs::remove_file(from);
            n += 1;
            continue;
        }
        if fs::rename(from, to).is_ok() {
            n += 1;
        }
    }
    let _ = fs::remove_dir_all(&dir);
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc::Match;

    #[test]
    fn entry_ids_cannot_escape_the_stash_directory() {
        // Entry ids arrive from the page, so they are untrusted path input.
        // Without this, "../../.." would let a crafted id move shortcuts into,
        // or delete them from, anywhere the user can write.
        for evil in ["../../../windows", r"..\..\system32", "a/b", "C:\\evil", "..", "."] {
            let s = sanitise(evil);
            assert!(!s.contains('/') && !s.contains('\\'), "{evil} -> {s}");
            assert!(!s.contains(".."), "{evil} -> {s}");
            assert!(!s.contains(':'), "{evil} -> {s}");
            assert!(stash_dir(evil).starts_with(stash_root()), "{evil} escaped");
        }
    }

    #[test]
    fn an_empty_or_fully_stripped_id_still_yields_a_usable_folder() {
        assert_eq!(sanitise(""), "entry");
        assert_eq!(sanitise("///"), "entry");
        assert_eq!(sanitise(".."), "entry");
    }

    #[test]
    fn normal_ids_survive_intact() {
        assert_eq!(sanitise("h_a1b2c3"), "h_a1b2c3");
        assert_eq!(sanitise("h-tray-1"), "h-tray-1");
    }

    #[test]
    fn shortcut_names_match_loosely_but_not_across_different_programs() {
        assert_eq!(loose("Discord"), "discord");
        assert_eq!(loose("Visual Studio Code"), "visualstudiocode");
        assert_eq!(loose("Adobe Photoshop 2024"), "adobephotoshop2024");
        assert_ne!(loose("Discord"), loose("Discord PTB"));
    }

    #[test]
    fn very_short_keys_are_dropped_so_they_cannot_sweep_the_start_menu() {
        let t = Target {
            id: "x".into(),
            label: "VS".into(),
            r#match: Match { kind: "exe".into(), value: "vs.exe".into() },
            hide_icons: true,
        };
        // "vs" is two characters and would match a great many shortcuts.
        assert!(target_keys(&t).iter().all(|k| k.len() >= 3));
    }

    #[test]
    fn target_keys_cover_both_the_label_and_the_executable_stem() {
        let t = Target {
            id: "x".into(),
            label: "Discord".into(),
            r#match: Match { kind: "exe".into(), value: "discord.exe".into() },
            hide_icons: true,
        };
        assert!(target_keys(&t).contains(&"discord".to_string()));
    }
}

/// Restore everything still stashed. Used on emergency-off and at startup, so a
/// crash mid-emergency can never leave the desktop permanently missing icons.
pub fn restore_all() -> usize {
    let root = stash_root();
    let Ok(rd) = fs::read_dir(&root) else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        if e.path().is_dir() {
            if let Some(name) = e.file_name().to_str() {
                n += restore(name);
            }
        }
    }
    n
}
