// Preload script for Dashboard window
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("velara", {
  // Window controls
  closeDashboard:    () => ipcRenderer.send("close-dashboard"),
  minimizeDashboard: () => ipcRenderer.send("minimize-dashboard"),

  // Settings
  getSettings:       () => ipcRenderer.invoke("get-settings"),
  saveSettings:      (s) => ipcRenderer.invoke("save-settings", s),
  detectWowPath:     () => ipcRenderer.invoke("detect-wow-path"),
  browseWowPath:     () => ipcRenderer.invoke("browse-wow-path"),
  browseCombatLog:   () => ipcRenderer.invoke("browse-combat-log"),
  getBuildInfo:      () => ipcRenderer.invoke("get-build-info"),

  // Upload (GO button)
  uploadRun:         (data) => ipcRenderer.invoke("upload-run", data),

  // Parse combat log file (Upload tab)
  parseCombatLogFile: (filePath) => ipcRenderer.invoke("parse-combat-log-file", filePath),

  // Ingest JSON (manual paste upload)
  ingestJSON:        (json) => ipcRenderer.invoke("upload-run", json),

  // Status events
  onStatusLog:       (cb) => ipcRenderer.on("status-log", (_, data) => cb(data.msg, data.level)),
  onRunCompleted:    (cb) => ipcRenderer.on("run-completed", (_, data) => cb(data)),
  onUploadResult:    (cb) => ipcRenderer.on("upload-result", (_, data) => cb(data)),
  onKeyEndDetected:  (cb) => ipcRenderer.on("key-end-detected", (_, data) => cb(data)),
});
