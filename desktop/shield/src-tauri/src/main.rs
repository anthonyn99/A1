// Prevents a console window appearing alongside the app on Windows in release.
// The agent lives in the tray; a stray black console would be the most obvious
// thing on screen at the exact moment the user wants nothing to be obvious.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    shield_agent_lib::run()
}
