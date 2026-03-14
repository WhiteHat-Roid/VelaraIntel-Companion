// Preload script for Overlay window
const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");

contextBridge.exposeInMainWorld("velara", {
  onRunUpdate: (callback) => ipcRenderer.on("run-update", (_, data) => callback(data)),
  logoPath: "file://" + path.join(__dirname, "..", "..", "assets", "icon.png").replace(/\\/g, "/"),
});
