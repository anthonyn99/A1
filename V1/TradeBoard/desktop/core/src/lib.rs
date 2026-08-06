//! Pure, GUI-free half of the TradeBoard desktop shell: the LaunchItem data
//! model and all schedule evaluation. The Tauri crate in ../src-tauri depends on
//! this and adds the OS-facing parts (process spawning, tray, commands).

pub mod model;
pub mod schedule;
