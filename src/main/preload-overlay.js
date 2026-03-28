// Preload script for Overlay window
const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");

contextBridge.exposeInMainWorld("velara", {
  // Run data events
  onRunUpdate:         (cb) => ipcRenderer.on("run-update",          (_, data) => cb(data)),
  onRunOpened:         (cb) => ipcRenderer.on("run-opened",          (_, data) => cb(data)),

  // Upload events
  onUploadResult:      (cb) => ipcRenderer.on("upload-result",       (_, data) => cb(data)),

  // Combat log events
  onCombatLogStatus:   (cb) => ipcRenderer.on("combat-log-status",   (_, data) => cb(data)),
  onCombatLogMissing:  (cb) => ipcRenderer.on("combat-log-missing",  (_, data) => cb(data)),

  // Key lifecycle
  onKeyEndDetected:    (cb) => ipcRenderer.on("key-end-detected",    (_, data) => cb(data)),

  // Enrichment
  onEnrichmentFailed:  (cb) => ipcRenderer.on("enrichment-failed",   (_, data) => cb(data)),
  onEnrichmentComplete:(cb) => ipcRenderer.on("enrichment-complete", (_, data) => cb(data)),

  // Asset path
  logoPath: "file://" + path.join(__dirname, "..", "..", "assets", "icon.png").replace(/\\/g, "/"),
});
