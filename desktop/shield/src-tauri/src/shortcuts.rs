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
    /// Where it was moved to. Empty when the shortcut never moved.
    #[serde(default)]
    pub to: String,
    /// "attr" — hidden in place by file attribute, position preserved.
    /// "move" — relocated to the stash.
    /// Absent in manifests written before this existed; those were all moves.
    #[serde(default = "default_method")]
    pub method: String,
}
fn default_method() -> String {
    "move".into()
}

/// Would hiding a file by attribute actually hide it from this user?
///
/// Only if Explorer is not set to show hidden files. Shield sets Hidden AND
/// System, so it takes BOTH "Show hidden files" and "Hide protected operating
/// system files" being switched off to see through it — but if someone has done
/// exactly that, the attribute is decoration and Shield must move the file
/// instead. Guessing wrong here means an icon that visibly stays put during an
/// emergency.
fn attribute_hiding_works() -> bool {
    const ADV: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
    let shows_hidden = reg_dword(ADV, "Hidden") == Some(1);
    let shows_system = reg_dword(ADV, "ShowSuperHidden") == Some(1);
    !(shows_hidden && shows_system)
}

fn reg_dword(subkey: &str, name: &str) -> Option<u32> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let sub: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let nam: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut data: u32 = 0;
    let mut size: u32 = 4;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(sub.as_ptr()),
            PCWSTR(nam.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        )
        .is_ok()
        .then_some(data)
    }
}

fn set_hidden(path: &Path, hidden: bool) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM,
        FILE_FLAGS_AND_ATTRIBUTES, INVALID_FILE_ATTRIBUTES,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let cur = GetFileAttributesW(PCWSTR(wide.as_ptr()));
        if cur == INVALID_FILE_ATTRIBUTES {
            return false;
        }
        let mask = FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0;
        let next = if hidden { cur | mask } else { cur & !mask };
        SetFileAttributesW(PCWSTR(wide.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(next)).is_ok()
    }
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

/// What a .lnk actually points at.
///
/// Name matching alone was not good enough, and the failure was silent: a
/// folder target of `C:\Riot Games` produces the keys "riot" and "riotgames",
/// while the shortcut on the desktop is `Riot Client.lnk` → "riotclient".
/// Nothing matched, so the icon simply stayed there with no explanation.
///
/// Reading the link's real target removes the guessing entirely: a shortcut is
/// hidden when the thing it launches would itself be matched by the very same
/// rule that selects processes. A folder target therefore covers every shortcut
/// pointing anywhere inside it, however the shortcut happens to be named.
fn resolve_lnk(path: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe {
        // Already-initialised returns S_FALSE / RPC_E_CHANGED_MODE; both are
        // fine, so the result is deliberately ignored rather than treated as
        // fatal — this runs on whichever thread the emergency happens to be on.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = windows::core::Interface::cast(&link).ok()?;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        file.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;

        let mut buf = [0u16; 1024];
        let mut fd = WIN32_FIND_DATAW::default();
        link.GetPath(&mut buf, &mut fd, 0).ok()?;
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        if end == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

/// Tell Explorer the desktop changed.
///
/// Moving a .lnk out of the Desktop folder does not repaint the desktop —
/// Explorer keeps showing the icon until something else makes it refresh. That
/// is why hiding "took a few clicks": the file was gone immediately, the icon
/// was not. On an emergency tool a delay between pressing the button and the
/// screen being safe is the whole failure.
fn refresh_shell(dirs: &[PathBuf]) {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_UPDATEDIR, SHCNF_FLUSH, SHCNF_PATHW};
    for d in dirs {
        let wide: Vec<u16> = d.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            SHChangeNotify(
                SHCNE_UPDATEDIR,
                SHCNF_PATHW | SHCNF_FLUSH,
                Some(wide.as_ptr() as *const _),
                None,
            );
        }
    }
}

/// Fallback name comparison, used only when a .lnk cannot be resolved.
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
    let wanted: Vec<&Target> = targets.iter().filter(|t| t.hide_icons).collect();
    if wanted.is_empty() {
        return vec![];
    }

    let dir = stash_dir(entry_id);
    if fs::create_dir_all(&dir).is_err() {
        return vec![];
    }

    let mut hidden: Vec<HiddenItem> = Vec::new();
    let mut touched: Vec<PathBuf> = Vec::new();
    let use_attr = attribute_hiding_works();

    for lnk in all_shortcuts() {
        let stem = lnk.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        // What does this shortcut actually launch?
        let dest_path = resolve_lnk(&lnk);

        let matched = wanted.iter().find(|t| {
            if let Some(p) = &dest_path {
                // The real test: would the SAME rule that picks processes pick
                // this shortcut's target? A folder target then covers every
                // shortcut pointing inside it, whatever it is called.
                let file = Path::new(p)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_default();
                if t.matches(&file, p) {
                    return true;
                }
            }
            // Unresolvable .lnk (a Store app, a URL shortcut, a broken link):
            // fall back to the old name comparison rather than give up.
            let keys = target_keys(t);
            let ls = loose(&stem);
            keys.iter().any(|k| *k == ls)
        });

        let Some(t) = matched else { continue };
        let note_dir = |touched: &mut Vec<PathBuf>| {
            if let Some(parent) = lnk.parent() {
                if !touched.iter().any(|p| p == parent) {
                    touched.push(parent.to_path_buf());
                }
            }
        };

        // Hide IN PLACE where possible.
        //
        // Moving the file away and back loses the icon's position: Explorer
        // stores desktop layout per file, and a file that disappears and
        // returns is laid out again in the first free slot. Setting the hidden
        // attribute leaves the file exactly where it is, so the icon returns to
        // the same square it left. It is also atomic, which removes the risk of
        // a crash mid-move stranding a shortcut in the stash.
        if use_attr && set_hidden(&lnk, true) {
            note_dir(&mut touched);
            hidden.push(HiddenItem {
                label: t.display(),
                from: lnk.to_string_lossy().to_string(),
                to: String::new(),
                method: "attr".into(),
            });
            continue;
        }

        // Fallback: this user has Explorer showing hidden AND system files, so
        // the attribute would hide nothing. Move it instead and accept that the
        // icon comes back in a different spot — visible-but-tidy is not what
        // Emergency Mode is for.
        let name = lnk.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let dst = unique_dest(&dir, &name);
        if fs::rename(&lnk, &dst).is_ok() {
            note_dir(&mut touched);
            hidden.push(HiddenItem {
                label: t.display(),
                from: lnk.to_string_lossy().to_string(),
                to: dst.to_string_lossy().to_string(),
                method: "move".into(),
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
    // Repaint now, not whenever Explorer happens to notice.
    refresh_shell(&touched);
    hidden
}

/// Put one entry's shortcuts back where they came from.
pub fn restore(entry_id: &str) -> usize {
    let dir = stash_dir(entry_id);
    let Ok(raw) = fs::read_to_string(dir.join("manifest.json")) else { return 0 };
    let items: Vec<HiddenItem> = serde_json::from_str(&raw).unwrap_or_default();
    let mut n = 0;
    let mut touched: Vec<PathBuf> = Vec::new();
    for it in &items {
        let orig = Path::new(&it.from);
        if let Some(parent) = orig.parent() {
            if !touched.iter().any(|p| p == parent) {
                touched.push(parent.to_path_buf());
            }
        }

        // Hidden in place: just clear the attribute. The file never moved, so
        // the icon reappears in exactly the square it occupied.
        if it.method == "attr" {
            if orig.exists() && set_hidden(orig, false) {
                n += 1;
            }
            continue;
        }

        let from = Path::new(&it.to);
        let to = orig;
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
    // Same reason as hiding: the icon must come back immediately, not when
    // Explorer next feels like refreshing.
    refresh_shell(&touched);
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

    /// The exact failure the user hit: a folder target whose desktop shortcut
    /// is named nothing like it.
    ///
    /// `C:\Riot Games` yields the name keys "riot" and "riotgames", but the
    /// shortcut is `Riot Client.lnk` → "riotclient". Name matching cannot see
    /// it. Matching on what the shortcut POINTS AT does, because the resolved
    /// path lives inside the folder.
    #[test]
    fn a_folder_target_matches_a_shortcut_by_where_it_points_not_its_name() {
        let t = Target {
            id: "x".into(),
            label: "Riot".into(),
            r#match: Match { kind: "folder".into(), value: r"C:\Riot Games".into() },
            hide_icons: true,
        };
        let resolved = r"C:\Riot Games\Riot Client\RiotClientServices.exe";

        // Name matching alone: misses it. This is the bug.
        assert!(!target_keys(&t).iter().any(|k| *k == loose("Riot Client")));

        // Matching on the resolved target: finds it.
        assert!(t.matches("RiotClientServices.exe", resolved));
    }

    #[test]
    fn an_exe_target_matches_a_shortcut_pointing_at_that_exe() {
        let t = Target {
            id: "x".into(),
            label: "CapCut".into(),
            r#match: Match { kind: "exe".into(), value: "capcut.exe".into() },
            hide_icons: true,
        };
        assert!(t.matches("CapCut.exe", r"C:\Users\a\AppData\Local\CapCut\CapCut.exe"));
        // A shortcut to something else in the same folder is left alone.
        assert!(!t.matches("CapCutUpdater.exe", r"C:\Users\a\AppData\Local\CapCut\CapCutUpdater.exe"));
    }

    /// Hiding must not move the file.
    ///
    /// This is the whole reason for the attribute approach: Explorer lays out
    /// the desktop per file, so a shortcut that disappears and comes back is
    /// placed in the first free slot rather than its own. A file that never
    /// moves keeps its square. The test asserts the file is still at its
    /// original path while hidden, and that the attributes round-trip.
    #[test]
    fn hiding_in_place_never_moves_the_file() {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            GetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, INVALID_FILE_ATTRIBUTES,
        };

        let p = std::env::temp_dir().join(format!("shield_attr_{}.lnk", std::process::id()));
        if std::fs::write(&p, b"x").is_err() {
            return;
        }
        let attrs = |path: &Path| -> u32 {
            let w: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
            unsafe { GetFileAttributesW(PCWSTR(w.as_ptr())) }
        };

        assert_ne!(attrs(&p), INVALID_FILE_ATTRIBUTES, "test file missing");
        assert_eq!(attrs(&p) & FILE_ATTRIBUTE_HIDDEN.0, 0, "should start visible");

        assert!(set_hidden(&p, true), "could not set attributes");
        assert!(p.exists(), "the file MOVED - position would be lost");
        assert_ne!(attrs(&p) & FILE_ATTRIBUTE_HIDDEN.0, 0, "not actually hidden");

        assert!(set_hidden(&p, false), "could not clear attributes");
        assert!(p.exists());
        assert_eq!(attrs(&p) & FILE_ATTRIBUTE_HIDDEN.0, 0, "still hidden after restore");

        let _ = std::fs::remove_file(&p);
    }

    /// Manifests written before in-place hiding existed have no `method`, and
    /// every one of them was a move. Defaulting wrong would strand shortcuts in
    /// the stash forever.
    #[test]
    fn an_old_manifest_without_a_method_is_treated_as_a_move() {
        let json = r#"[{"label":"A","from":"C:\\Desktop\\A.lnk","to":"C:\\stash\\A.lnk"}]"#;
        let items: Vec<HiddenItem> = serde_json::from_str(json).expect("parse");
        assert_eq!(items[0].method, "move");
        assert_eq!(items[0].to, r"C:\stash\A.lnk");
    }

    #[test]
    fn a_new_manifest_round_trips_the_method() {
        let items = vec![HiddenItem {
            label: "A".into(),
            from: r"C:\Desktop\A.lnk".into(),
            to: String::new(),
            method: "attr".into(),
        }];
        let s = serde_json::to_string(&items).unwrap();
        let back: Vec<HiddenItem> = serde_json::from_str(&s).unwrap();
        assert_eq!(back[0].method, "attr");
        assert!(back[0].to.is_empty(), "an in-place hide has nowhere it moved to");
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
