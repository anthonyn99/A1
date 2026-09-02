// Staging area for native file drags.
//
// WHY A CACHE IS NEEDED AT ALL
// A native drag must name a path that already exists the instant the drag
// begins — the OS reads the file, we cannot stream it. StudyOS resources live
// in IndexedDB (and Firebase), never on disk, so the webview hands us the
// bytes and we write them out first. Staging happens on hover/mousedown, so by
// the time the pointer moves the file is already there.
//
// Everything here is written to a per-user temp directory that only this app
// manages, and every path is rebuilt from a sanitised file name — the webview
// never gets to choose where a byte lands.
use std::fs;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;

/// Root of the staging area: %LOCALAPPDATA%\StudyOS\dragcache (or the platform
/// temp dir if the data dir is unavailable). Kept out of Documents/Downloads on
/// purpose — these are throwaway copies, not files the user asked to keep.
fn cache_root() -> PathBuf {
    let base = dirs_local_data().unwrap_or_else(std::env::temp_dir);
    base.join("StudyOS").join("dragcache")
}

/// %LOCALAPPDATA% on Windows; XDG_DATA_HOME/HOME elsewhere. Avoids pulling in
/// the `dirs` crate for one lookup.
fn dirs_local_data() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    }
}

/// Reduce an arbitrary, webview-supplied string to a single safe file name.
///
/// This is the security boundary of this module. The name reaches us from a
/// file record that ultimately came from a cloud document, so it must be
/// treated as hostile: `..\..\Startup\evil.exe` has to become a plain name in
/// our own directory, never an escape from it. We therefore keep only the
/// final component and allow only a conservative character set.
fn sanitize_name(raw: &str) -> String {
    // Take the last path component under BOTH separators. Windows treats
    // '/' and '\' alike, so splitting on only one leaves the other usable.
    let last = raw
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(raw)
        .trim();

    let cleaned: String = last
        .chars()
        .map(|c| {
            // Reserved on Windows, plus control characters.
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();

    // A name of only dots ("." / "..") would still address a directory.
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    // Windows also forbids these device names regardless of extension.
    let stem_upper = cleaned
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    const DEVICES: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if cleaned.is_empty() || DEVICES.contains(&stem_upper.as_str()) {
        return "file".to_string();
    }

    // Keep well under MAX_PATH once the cache root and id folder are prepended.
    if cleaned.chars().count() > 120 {
        let tail: String = cleaned.chars().skip(cleaned.chars().count() - 120).collect();
        return tail;
    }
    cleaned.to_string()
}

/// Same treatment for the id that becomes a directory name. Ids are generated
/// by StudyOS, but they are persisted and synced, so they get validated too.
fn sanitize_id(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        .take(80)
        .collect();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

#[derive(Serialize)]
pub struct StagedFile {
    pub path: String,
}

/// Write one file into the staging area and return its absolute path.
///
/// `bytes_b64` is the file content, base64-encoded — the webview bridge is
/// JSON, so raw bytes cannot cross it directly.
///
/// Re-staging the same id+name with identical content is a no-op, so hovering
/// a row repeatedly does not rewrite the file on every pass.
#[tauri::command]
pub fn stage_drag_file(id: String, name: String, bytes_b64: String) -> Result<StagedFile, String> {
    let bytes = B64
        .decode(bytes_b64.as_bytes())
        .map_err(|e| format!("bad payload: {e}"))?;

    let dir = cache_root().join(sanitize_id(&id));
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create cache dir: {e}"))?;

    let path = dir.join(sanitize_name(&name));

    // Defence in depth: even after sanitising, refuse anything that did not
    // land directly inside the directory we just created.
    if path.parent() != Some(dir.as_path()) {
        return Err("refusing to write outside the drag cache".into());
    }

    // Skip the write when the staged copy is already byte-identical.
    let already = fs::metadata(&path)
        .ok()
        .map(|m| m.len() == bytes.len() as u64)
        .unwrap_or(false)
        && fs::read(&path).map(|b| b == bytes).unwrap_or(false);

    if !already {
        fs::write(&path, &bytes).map_err(|e| format!("cannot stage file: {e}"))?;
    }

    Ok(StagedFile {
        path: path.to_string_lossy().to_string(),
    })
}

/// Exposed so the UI can offer "open the folder" if a drag still misbehaves.
#[tauri::command]
pub fn drag_cache_dir() -> String {
    cache_root().to_string_lossy().to_string()
}

/// Delete everything staged by previous runs. Called once at startup: a file
/// from an earlier session can have no live drag holding it.
pub fn purge_on_launch() {
    let root = cache_root();
    if root.exists() {
        let _ = fs::remove_dir_all(&root);
    }
    let _ = fs::create_dir_all(&root);
}

/* ── Path-safety tests ────────────────────────────────────────────────────
   stage_drag_file writes a caller-supplied name to disk, and that name rides
   along with a file record that syncs from the cloud — so it is hostile input.
   Without sanitising, a name like `..\..\Startup\evil.exe` would let a synced
   document choose where bytes land. These pin that boundary.
   They live INSIDE the crate rather than in tests/: an integration binary
   links the whole WebView2 stack and cannot start under the test harness. */
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_traversal_to_a_bare_name() {
        for raw in [
            r"..\..\Startup\evil.exe",
            "../../etc/passwd",
            r"C:\Windows\System32\calc.exe",
            "subdir/inner/notes.pdf",
        ] {
            let out = sanitize_name(raw);
            assert!(!out.contains('/'), "{raw} -> {out} kept a forward slash");
            assert!(!out.contains('\\'), "{raw} -> {out} kept a backslash");
            assert!(!out.contains(".."), "{raw} -> {out} kept a parent ref");
        }
    }

    #[test]
    fn a_sanitised_name_always_stays_in_its_directory() {
        let root = std::path::Path::new("C:").join("cache").join("id");
        for raw in [
            r"..\..\evil.exe",
            "../../../../../../tmp/x",
            "....//....//x",
            "",
            "...",
        ] {
            let joined = root.join(sanitize_name(raw));
            assert_eq!(
                joined.parent(),
                Some(root.as_path()),
                "{raw} escaped its directory as {joined:?}"
            );
        }
    }

    #[test]
    fn empty_and_dot_only_names_get_a_fallback() {
        for raw in ["", "   ", ".", "..", "....", "///"] {
            let out = sanitize_name(raw);
            assert!(!out.is_empty(), "{raw:?} produced an empty file name");
            assert_ne!(out, ".");
            assert_ne!(out, "..");
        }
    }

    #[test]
    fn windows_device_names_are_not_used_verbatim() {
        // Writing to CON/NUL/COM1 addresses a device, not a file.
        for raw in ["CON", "nul.txt", "COM1", "LPT9.pdf", "aux"] {
            let out = sanitize_name(raw);
            let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
            assert!(
                !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    && !stem.starts_with("COM")
                    && !stem.starts_with("LPT"),
                "{raw} -> {out} is still a device name"
            );
        }
    }

    #[test]
    fn ordinary_names_survive_intact() {
        // The sanitiser must not mangle the normal case, or every dragged file
        // arrives with a corrupted name and the wrong extension.
        for raw in [
            "Lecture 3 - Kinetics.pdf",
            "syllabus_v2.docx",
            "notes (final).pptx",
            "CHEM101.summary.2026.md",
        ] {
            assert_eq!(sanitize_name(raw), raw);
        }
    }

    #[test]
    fn control_characters_are_replaced() {
        let out = sanitize_name("bad\r\nname.pdf");
        assert!(!out.chars().any(|c| c.is_control()), "kept a control char: {out:?}");
    }

    #[test]
    fn very_long_names_are_bounded() {
        let long = "a".repeat(5000) + ".pdf";
        let out = sanitize_name(&long);
        assert!(out.chars().count() <= 120, "name not bounded: {}", out.chars().count());
    }

    #[test]
    fn ids_cannot_become_paths() {
        for raw in [r"..\..\windows", "../../etc", "a/b", "id with spaces", ""] {
            let out = sanitize_id(raw);
            assert!(!out.contains('/') && !out.contains('\\') && !out.contains(".."),
                "{raw} -> {out} is still path-shaped");
            assert!(!out.is_empty());
        }
    }

    #[test]
    fn staged_paths_live_under_the_cache_root() {
        let root = cache_root();
        let p = root
            .join(sanitize_id("file_123"))
            .join(sanitize_name(r"..\..\evil.exe"));
        assert!(p.starts_with(&root), "{p:?} is outside {root:?}");
    }
}
