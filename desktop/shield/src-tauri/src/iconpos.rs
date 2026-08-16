//! Saving and restoring desktop icon positions.
//!
//! Keeping the file in place is not enough. Explorer's desktop layout is a
//! table of filename → grid position, and an item it cannot see is dropped from
//! that table — so hiding a shortcut by attribute still loses its square, and
//! it reappears wherever the first free slot happens to be. Moving the file has
//! the same effect for the same reason.
//!
//! The only reliable fix is to ask Explorer where the icon is before hiding it,
//! and to put it back afterwards, through the same interface Explorer uses
//! itself: `IFolderView` on the live desktop view. That works without
//! restarting Explorer and without touching the undocumented `ItemPos` registry
//! blob, which Explorer caches in memory and would overwrite anyway.
//!
//! Every function here degrades to a no-op rather than failing: a lost position
//! is a cosmetic annoyance, and it must never stop an emergency from running.

use std::path::Path;

use windows::core::{Interface, PCWSTR, VARIANT};
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{CoCreateInstance, IServiceProvider, CLSCTX_ALL};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    IFolderView, IShellBrowser, IShellWindows, ILCreateFromPathW, ILFindLastID, ILFree,
    ShellWindows, SID_STopLevelBrowser, SVSI_POSITIONITEM, SWC_DESKTOP, SWFO_NEEDDISPATCH,
};

/// The live desktop view, if there is one.
///
/// Walks Explorer's own object model: the shell-windows collection → the
/// desktop window → its top-level browser → the active view.
fn desktop_view() -> Option<IFolderView> {
    unsafe {
        let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).ok()?;
        // Empty locations plus SWC_DESKTOP is the documented way to ask for the
        // desktop specifically, and avoids constructing a CSIDL VARIANT.
        let loc = VARIANT::default();
        let root = VARIANT::default();
        let mut hwnd: i32 = 0;
        let disp = windows
            .FindWindowSW(&loc, &root, SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)
            .ok()?;
        let provider: IServiceProvider = disp.cast().ok()?;
        let browser: IShellBrowser = provider.QueryService(&SID_STopLevelBrowser).ok()?;
        let view = browser.QueryActiveShellView().ok()?;
        view.cast::<IFolderView>().ok()
    }
}

/// RAII wrapper so a PIDL is always freed, including on the error paths.
struct Pidl(*mut ITEMIDLIST);
impl Drop for Pidl {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { ILFree(Some(self.0)) };
        }
    }
}
fn pidl_for(path: &Path) -> Option<Pidl> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let p = unsafe { ILCreateFromPathW(PCWSTR(wide.as_ptr())) };
    if p.is_null() {
        None
    } else {
        Some(Pidl(p))
    }
}

/// Where this desktop item currently sits, in view coordinates.
pub fn get(path: &Path) -> Option<(i32, i32)> {
    let view = desktop_view()?;
    let pidl = pidl_for(path)?;
    unsafe {
        // IFolderView wants the CHILD id (the last component), not the full path.
        let child = ILFindLastID(pidl.0);
        let pt: POINT = view.GetItemPosition(child).ok()?;
        Some((pt.x, pt.y))
    }
}

/// Put an item back at a remembered position.
pub fn set(path: &Path, pos: (i32, i32)) -> bool {
    let Some(view) = desktop_view() else { return false };
    let Some(pidl) = pidl_for(path) else { return false };
    unsafe {
        let child = ILFindLastID(pidl.0) as *const ITEMIDLIST;
        let pt = POINT { x: pos.0, y: pos.1 };
        view.SelectAndPositionItems(1, &child, Some(&pt), SVSI_POSITIONITEM.0 as u32).is_ok()
    }
}

/// Is this path on a desktop? Only those have positions worth restoring —
/// Start-menu entries are laid out alphabetically and have none.
pub fn is_desktop_item(path: &Path) -> bool {
    let Some(parent) = path.parent() else { return false };
    let p = parent.to_string_lossy().to_ascii_lowercase();
    p.ends_with("\\desktop")
}
