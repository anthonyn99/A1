//! Saving and restoring desktop icon positions.
//!
//! Keeping a shortcut's file in place is not enough. Explorer's desktop layout
//! is a table of item → grid position, and an item it cannot see is dropped
//! from that table — so hiding one by attribute still loses its square, and it
//! reappears wherever the first free slot happens to be.
//!
//! So the position is read before hiding and written back afterwards, through
//! the interface Explorer uses itself: `IFolderView` on the live desktop. That
//! needs no Explorer restart and avoids the undocumented `ItemPos` registry
//! blob, which Explorer caches in memory and would overwrite anyway.
//!
//! ## Why items are looked up by asking the view
//!
//! The visible desktop is a VIRTUAL folder that merges at least three sources:
//! the user's own Desktop, the all-users Public Desktop, and namespace items
//! like the Recycle Bin. An item id built from a file path only lines up with
//! what the view enumerates for the user's own folder — for a Public Desktop
//! shortcut the view holds a different id, `GetItemPosition` does not recognise
//! it, and the position is silently lost.
//!
//! That is not hypothetical: `CapCut.lnk` and `League of Legends.lnk` live in
//! the user's Desktop and restored correctly, while `Riot Client.lnk` lives in
//! `C:\Users\Public\Desktop` and did not. So nothing here derives an id from a
//! path. The view is enumerated and each item matched on its parsing name (its
//! full path), which works identically for every source.
//!
//! Every function degrades to a no-op rather than failing: a lost position is a
//! cosmetic annoyance and must never stop an emergency from running.

use std::path::Path;

use windows::core::{Interface, PWSTR, VARIANT};
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, IServiceProvider, CLSCTX_ALL};
use windows::Win32::UI::Shell::Common::{ITEMIDLIST, STRRET};
use windows::Win32::UI::Shell::{
    IFolderView, IShellBrowser, IShellFolder, IShellWindows, ShellWindows, StrRetToStrW,
    SHGDN_FORPARSING, SID_STopLevelBrowser, SVGIO_ALLVIEW, SVSI_POSITIONITEM, SWC_DESKTOP,
    SWFO_NEEDDISPATCH,
};

/// The live desktop view, if there is one.
fn desktop_view() -> Option<IFolderView> {
    unsafe {
        let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).ok()?;
        // Empty locations plus SWC_DESKTOP is the documented way to ask for the
        // desktop specifically, without constructing a CSIDL VARIANT.
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

/// A child id owned by the view. Freed on drop.
struct ViewItem(*mut ITEMIDLIST);
impl Drop for ViewItem {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CoTaskMemFree(Some(self.0 as *const _)) };
        }
    }
}

/// The full path an item represents, as the shell parses it.
fn parsing_name(folder: &IShellFolder, pidl: *mut ITEMIDLIST) -> Option<String> {
    unsafe {
        let mut ret = STRRET::default();
        folder.GetDisplayNameOf(pidl, SHGDN_FORPARSING, &mut ret).ok()?;
        let mut s = PWSTR::null();
        StrRetToStrW(&mut ret, Some(pidl), &mut s).ok()?;
        if s.is_null() {
            return None;
        }
        let out = s.to_string().ok();
        CoTaskMemFree(Some(s.0 as *const _));
        out
    }
}

/// Find the view's own id for a path, by enumerating what the view holds.
fn find_in_view(view: &IFolderView, path: &Path) -> Option<ViewItem> {
    let want = path.to_string_lossy().to_ascii_lowercase();
    unsafe {
        let folder: IShellFolder = view.GetFolder().ok()?;
        let count = view.ItemCount(SVGIO_ALLVIEW).ok()?;
        for i in 0..count {
            let Ok(raw) = view.Item(i) else { continue };
            if raw.is_null() {
                continue;
            }
            let item = ViewItem(raw);
            if let Some(name) = parsing_name(&folder, item.0) {
                if name.to_ascii_lowercase() == want {
                    return Some(item);
                }
            }
        }
        None
    }
}

/// Where this desktop item currently sits, in view coordinates.
pub fn get(path: &Path) -> Option<(i32, i32)> {
    let view = desktop_view()?;
    let item = find_in_view(&view, path)?;
    unsafe {
        let pt: POINT = view.GetItemPosition(item.0).ok()?;
        Some((pt.x, pt.y))
    }
}

/// Put an item back at a remembered position.
pub fn set(path: &Path, pos: (i32, i32)) -> bool {
    let Some(view) = desktop_view() else { return false };
    let Some(item) = find_in_view(&view, path) else { return false };
    unsafe {
        let child = item.0 as *const ITEMIDLIST;
        let pt = POINT { x: pos.0, y: pos.1 };
        if view.SelectAndPositionItems(1, &child, Some(&pt), SVSI_POSITIONITEM.0 as u32).is_err() {
            return false;
        }
        // Confirm it took. SelectAndPositionItems can report success while the
        // view is still rebuilding, and a silent no-op here is exactly the bug
        // this module exists to prevent.
        match view.GetItemPosition(item.0) {
            Ok(now) => (now.x - pos.0).abs() <= 2 && (now.y - pos.1).abs() <= 2,
            Err(_) => false,
        }
    }
}

/// Is this path shown on the desktop?
///
/// Covers the user's own Desktop, a OneDrive-redirected Desktop, and the
/// all-users Public Desktop — all three appear in the same view, and the last
/// one is where this originally went wrong.
pub fn is_desktop_item(path: &Path) -> bool {
    let Some(parent) = path.parent() else { return false };
    parent.to_string_lossy().to_ascii_lowercase().ends_with("\\desktop")
}
