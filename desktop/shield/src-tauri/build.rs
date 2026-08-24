//! Declares Shield's own commands to the Tauri ACL.
//!
//! Tauri v2 used to let custom (non-plugin) commands bypass the ACL entirely
//! when an app had no manifest. That was fixed as a security issue
//! (GHSA-7gmj-67g7-phm9): remote origins are now always subject to ACL
//! resolution. Since Shield deliberately loads its UI from
//! https://anthonyn99.github.io, every one of its commands is a remote call and
//! every one is refused — "Command sh_kill not allowed by ACL" — unless it is
//! declared here and then granted in capabilities/default.json.
//!
//! Each name below becomes a permission `allow-<name-in-kebab-case>`, e.g.
//! `sh_emergency_on` → `allow-sh-emergency-on`. The capability lists them.
//!
//! Keep this list, `generate_handler![]` in lib.rs, and the capability's
//! permissions in step. `tests/agent-contract.test.js` fails the build if they
//! drift apart, because the symptom otherwise is a button that silently does
//! nothing.

const COMMANDS: &[&str] = &[
    "sh_status",
    "sh_set_config",
    "sh_enumerate",
    "sh_apps",
    "sh_kill",
    "sh_emergency_on",
    "sh_emergency_off",
    "sh_launch",
    "sh_set_links",
    "sh_restore_icons",
    "sh_pull_history",
    "sh_lock_workstation",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
