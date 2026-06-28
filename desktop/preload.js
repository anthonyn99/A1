// Bridges the sandboxed web app to the native drag capability.
// Exposed as window.studyDesktop — the web app feature-detects this and, when
// present, uses real OS drag-out instead of the web DownloadURL fallback.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studyDesktop', {
  isDesktop: true,
  // Stage bytes to a temp file; resolves to the on-disk path (or null on failure).
  stageFile: (name, data) => ipcRenderer.invoke('study:stage-file', name, data),
  // Kick off the native OS drag for a previously staged file path.
  startDrag: (filePath) => ipcRenderer.send('study:start-drag', filePath)
});
