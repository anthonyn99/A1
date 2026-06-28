// ──────────────────────────────────────────────────────────────────────────
// TaskHub / StudyOS desktop shell
//
// Loads the live web app (https://anthonyn99.github.io/A1/) inside an Electron
// window so we can do something a sandboxed web page CAN'T: a real OS file
// drag-out. The renderer asks us to stage a temp file, then on dragstart we
// call webContents.startDrag() — which hands the OS a genuine file path that
// EVERY app accepts (Claude desktop, claude.ai, Explorer, Slack, Word, …).
//
// IndexedDB is scoped to the origin, so loading the same github.io URL means
// all of your already-uploaded StudyOS files are right there — nothing to migrate.
// ──────────────────────────────────────────────────────────────────────────
const { app, BrowserWindow, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// The deployed app. Override with STUDY_URL env var if the URL ever changes.
const APP_URL = process.env.STUDY_URL || 'https://anthonyn99.github.io/A1/';

// Temp files we stage for drag-out; cleaned up on quit.
const STAGE_DIR = path.join(os.tmpdir(), 'studyos-drag');
const stagedFiles = new Set();

let dragIcon = null;
function getDragIcon() {
  if (dragIcon && !dragIcon.isEmpty()) return dragIcon;
  dragIcon = nativeImage.createFromPath(path.join(__dirname, 'drag-icon.png'));
  // startDrag() throws on an empty icon — fall back to a 1x1 if the file is missing.
  if (dragIcon.isEmpty()) {
    dragIcon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    );
  }
  return dragIcon;
}

function sanitize(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 180) || 'file';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'TaskHub',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload needs fs/ipc; content stays isolated via contextBridge
    }
  });

  win.loadURL(APP_URL);

  // Open target=_blank / window.open (e.g. "open file in new tab") in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^blob:|^data:/.test(url)) { shell.openExternal(url); }
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', cleanup);

// ── IPC: stage a file on disk so it can be dragged out ──
// data arrives as a Uint8Array (structured-cloned across the bridge).
ipcMain.handle('study:stage-file', async (_e, name, data) => {
  try {
    await fs.promises.mkdir(STAGE_DIR, { recursive: true });
    const file = path.join(STAGE_DIR, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + sanitize(name));
    await fs.promises.writeFile(file, Buffer.from(data));
    stagedFiles.add(file);
    return file;
  } catch (err) {
    console.error('stage-file failed:', err);
    return null;
  }
});

// ── IPC: perform the native drag using the staged file ──
ipcMain.on('study:start-drag', (e, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    e.sender.startDrag({ file: filePath, icon: getDragIcon() });
  } catch (err) {
    console.error('startDrag failed:', err);
  }
});

function cleanup() {
  for (const f of stagedFiles) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  stagedFiles.clear();
}
