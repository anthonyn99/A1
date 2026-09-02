// Thin wrapper: all logic lives in the library crate so it stays testable.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    studyos_desktop_lib::run()
}
