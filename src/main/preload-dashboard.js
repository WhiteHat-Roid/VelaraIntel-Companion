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
  // Directive 10: the get-accounts handler existed in main since long before, but was
  // never bridged — the renderer had no way to call it, which is why there was no
  // Account picker to fix a blank accountName with. get-sv-status backs the dashboard
  // warning.
  getAccounts:       (wowPath) => ipcRenderer.invoke("get-accounts", wowPath),
  getSvStatus:       () => ipcRenderer.invoke("get-sv-status"),
  browseWowPath:     () => ipcRenderer.invoke("browse-wow-path"),
  browseCombatLog:   () => ipcRenderer.invoke("browse-combat-log"),
  getBuildInfo:      () => ipcRenderer.invoke("get-build-info"),

  // Upload (GO button)
  uploadRun:         (data) => ipcRenderer.invoke("upload-run", data),

  // Parse combat log file (Upload tab)
  parseCombatLogFile: (filePath) => ipcRenderer.invoke("parse-combat-log-file", filePath),

  // Ingest JSON (manual paste upload)
  ingestJSON:        (json) => ipcRenderer.invoke("upload-run", json),

  // Live Log toggle
  setLiveLog:        (enabled) => ipcRenderer.send("set-live-log", enabled),
  getLiveLog:        () => ipcRenderer.invoke("get-live-log"),

  // Privacy mode persistence (for auto-upload)
  setPrivacyMode:    (mode) => ipcRenderer.send("set-privacy-mode", mode),
  getPrivacyMode:    () => ipcRenderer.invoke("get-privacy-mode"),

  // Account link (velaraAuth)
  getAuthStatus:     () => ipcRenderer.invoke("get-auth-status"),
  linkCompanion:     (code) => ipcRenderer.invoke("link-companion", code),
  unlinkCompanion:   () => ipcRenderer.invoke("unlink-companion"),

  // Batch scan WoW Logs directory for missed M+ runs
  scanMissedRuns:    () => ipcRenderer.invoke("scan-missed-runs"),
  scanAllHistory:    () => ipcRenderer.invoke("scan-all-history"),
  onScanProgress:    (cb) => ipcRenderer.on("scan-progress", (_, data) => cb(data)),
  onScanComplete:    (cb) => ipcRenderer.on("scan-complete", (_, data) => cb(data)),

  // Status events
  onStatusLog:       (cb) => ipcRenderer.on("status-log", (_, data) => cb(data.msg, data.level)),
  onRunCompleted:    (cb) => ipcRenderer.on("run-completed", (_, data) => cb(data)),
  onUploadResult:    (cb) => ipcRenderer.on("upload-result", (_, data) => cb(data)),
  onKeyEndDetected:  (cb) => ipcRenderer.on("key-end-detected", (_, data) => cb(data)),
  onAutoUploadSuccess: (cb) => ipcRenderer.on("auto-upload-success", (_, data) => cb(data)),
  onAutoUploadFailed:  (cb) => ipcRenderer.on("auto-upload-failed", (_, data) => cb(data)),
});
