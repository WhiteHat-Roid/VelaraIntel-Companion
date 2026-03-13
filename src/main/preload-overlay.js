// Preload script for Overlay window
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("velara", {
  onRunUpdate: (callback) => ipcRenderer.on("run-update", (_, data) => callback(data)),
});
