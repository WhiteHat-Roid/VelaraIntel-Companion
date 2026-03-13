// Preload script for Dashboard window
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("velara", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  detectWowPath: () => ipcRenderer.invoke("detect-wow-path"),
  getAccounts: (wowPath) => ipcRenderer.invoke("get-accounts", wowPath),
  browseWowPath: () => ipcRenderer.invoke("browse-wow-path"),
  manualUpload: (runData) => ipcRenderer.invoke("manual-upload", runData),
  closeDashboard: () => ipcRenderer.send("close-dashboard"),
  minimizeDashboard: () => ipcRenderer.send("minimize-dashboard"),
  onRunUpdate: (callback) => ipcRenderer.on("run-update", (_, data) => callback(data)),
  onUploadResult: (callback) => ipcRenderer.on("upload-result", (_, data) => callback(data)),
});
