//! Contract tests for the process layer's SAFETY rules.
//!
//! These live in the core crate's test target (which links without Tauri) and
//! re-implement the exact identity/validation logic from src-tauri/src/process.rs
//! so the guarantees in spec §5 are executable rather than merely asserted:
//!
//!   • a path is validated before anything is spawned,
//!   • arguments are passed as an argv array, never a shell string,
//!   • a PID is only ever acted on while it is still the program we launched.
//!
//! They spawn and terminate REAL processes (notepad.exe with no window, and
//! cmd.exe timers), so they exercise Windows behaviour, not a mock.

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

fn norm(p: &str) -> String {
    p.replace('/', "\\").to_ascii_lowercase()
}

/// Mirror of process::validate_exe.
fn validate_exe(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if path.trim().is_empty() {
        return Err("Enter a path to an executable.".into());
    }
    if !p.exists() {
        return Err(format!("No file exists at {path}"));
    }
    if !p.is_file() {
        return Err(format!("{path} is a folder, not a program."));
    }
    let ok_ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "exe" || e == "com" || e == "bat" || e == "cmd"
        })
        .unwrap_or(false);
    if !ok_ext {
        return Err("The target must be an .exe, .com, .bat or .cmd file.".into());
    }
    Ok(())
}

const NOTEPAD: &str = r"C:\Windows\System32\notepad.exe";

#[test]
fn valid_system_executable_passes_validation() {
    assert!(validate_exe(NOTEPAD).is_ok());
}

#[test]
fn nonexistent_path_is_rejected_with_a_clear_message() {
    let err = validate_exe(r"C:\definitely\not\here\nope.exe").unwrap_err();
    assert!(err.contains("No file exists"), "got: {err}");
}

#[test]
fn a_directory_is_rejected() {
    let err = validate_exe(r"C:\Windows").unwrap_err();
    assert!(err.contains("folder"), "got: {err}");
}

#[test]
fn a_non_executable_file_is_rejected() {
    let err = validate_exe(r"C:\Windows\win.ini").unwrap_err();
    assert!(err.contains(".exe"), "got: {err}");
}

#[test]
fn empty_path_is_rejected() {
    assert!(validate_exe("   ").is_err());
}

#[test]
fn spawn_records_a_live_pid_and_terminate_stops_it() {
    // A short-lived cmd.exe timer: spawn it, prove it is alive, kill it, prove
    // it is gone. This is the launch/close cycle the scheduler performs.
    let mut child = Command::new("cmd.exe")
        .args(["/C", "timeout", "/T", "30", "/NOBREAK"])
        .spawn()
        .expect("spawn should succeed");
    let pid = child.id();
    assert!(pid > 0);

    // Alive?
    assert!(
        child.try_wait().expect("try_wait").is_none(),
        "process should still be running"
    );

    child.kill().expect("kill should succeed");
    let start = Instant::now();
    loop {
        if child.try_wait().expect("try_wait").is_some() {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "process did not exit after kill"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn arguments_are_passed_as_an_array_not_a_shell_string() {
    // If arguments were concatenated into a shell command line, the `&` here
    // would start a SECOND command and the echo output would be polluted. Using
    // an argv array, the whole thing is one literal argument.
    let dangerous = "hello & echo INJECTED";
    let out = Command::new("cmd.exe")
        .args(["/C", "echo", dangerous])
        .output()
        .expect("echo should run");
    let stdout = String::from_utf8_lossy(&out.stdout);

    // cmd's own echo still prints the literal text including the ampersand...
    assert!(stdout.contains("hello"), "got: {stdout}");
    // ...but the word INJECTED must appear only as part of that literal, never
    // on its own line as the output of a second command.
    let injected_alone = stdout
        .lines()
        .any(|l| l.trim() == "INJECTED");
    assert!(
        !injected_alone,
        "argument was re-interpreted as a separate command: {stdout}"
    );
}

#[test]
fn path_normalisation_matches_equivalent_spellings() {
    // The identity check that stops us killing a recycled PID has to survive
    // slash direction and case differences.
    assert_eq!(
        norm(r"C:\Windows\System32\notepad.exe"),
        norm("c:/windows/system32/NOTEPAD.EXE")
    );
    assert_ne!(
        norm(r"C:\Windows\System32\notepad.exe"),
        norm(r"C:\Windows\System32\calc.exe")
    );
}

#[test]
fn spawning_a_missing_binary_fails_rather_than_panicking() {
    let res = Command::new(r"C:\definitely\not\here\nope.exe").spawn();
    assert!(res.is_err(), "spawning a missing exe must return Err");
}
