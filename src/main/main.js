// VelaraIntel Companion — Electron Main Process v0.4.3
// Added mapId > 0 guard — silently skips stale runs with mapId 0.

const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, dialog, nativeImage,
} = require("electron");
const path = require("path");
const Store = require("electron-store");

const { FileWatcher }      = require("../services/fileWatcher");
const { LuaParser }        = require("../services/luaParser");
const { ApiUploader }      = require("../services/apiUploader");
const { CombatLogWatcher } = require("../services/combatLogWatcher");
const { CombatLogParser }  = require("../services/combatLogParser");
const { RunAssembler }     = require("../services/runAssembler");

const store = new Store({
  defaults: {
    wowPath      : "",
    accountName  : "",
    apiKey       : "",
    hotkey       : "CommandOrControl+Shift+V",
    autoUpload   : true,
    startMinimized: false,
    overlayBounds: { x: 100, y: 100, width: 320, height: 220 },
  },
});

let dashboardWindow  = null;
let overlayWindow    = null;
let tray             = null;
let svWatcher        = null;
let combatLogWatcher = null;
let combatLogParser  = null;
let runAssembler     = null;
let apiUploader      = null;
let lastKnownRunId   = null;
let lastActiveRunId  = null;

const WOW_SEARCH_PATHS = [
  "C:\\Program Files (x86)\\World of Warcraft\\_retail_",
  "C:\\Program Files\\World of Warcraft\\_retail_",
  "D:\\World of Warcraft\\_retail_",
  "D:\\Games\\World of Warcraft\\_retail_",
  "E:\\World of Warcraft\\_retail_",
];

function detectWowPath() {
  const fs = require("fs");
  for (const p of WOW_SEARCH_PATHS) {
    try { if (fs.existsSync(path.join(p, "WTF"))) return p; } catch { /* skip */ }
  }
  return "";
}

function getAccountNames(wowPath) {
  const fs = require("fs");
  const accountDir = path.join(wowPath, "WTF", "Account");
  try {
    return fs.readdirSync(accountDir).filter((name) => {
      try {
        return fs.statSync(path.join(accountDir, name)).isDirectory() && name !== "SavedVariables";
      } catch { return false; }
    });
  } catch { return []; }
}

function getSavedVarsPath() {
  const wowPath = store.get("wowPath");
  const account = store.get("accountName");
  if (!wowPath || !account) return null;
  return path.join(wowPath, "WTF", "Account", account, "SavedVariables", "VelaraIntel.lua");
}

function getCombatLogPath() {
  const wowPath = store.get("wowPath");
  if (!wowPath) return null;
  return path.join(wowPath, "Logs", "WoWCombatLog.txt");
}

// ── V1.2 payload builder ──────────────────────────────────────────────────────
function buildV12Payload(latest) {
  const startTs       = (latest.startSec  || 0) * 1000;
  const finishTs      = (latest.finishSec || 0) * 1000;
  const affixes       = Array.isArray(latest.affixes)       ? latest.affixes       : [];
  const enemyRegistry = Array.isArray(latest.enemyRegistry) ? latest.enemyRegistry : [];

  return {
    addon    : "VelaraIntel",
    v        : latest.addonVersion || "0.5.3",
    uploadTs : Date.now(),
    clockOffsetMs       : null,
    clockSyncConfidence : "unknown",
    run: {
      runId         : latest.runId,
      mapId         : latest.mapId       || 0,
      dungeonName   : latest.dungeonName || "Unknown",
      keyLevel      : latest.keyLevel    || 0,
      affixes       : affixes,
      startTs       : startTs,
      finishTs      : finishTs,
      durationMs    : finishTs > startTs ? finishTs - startTs : null,
      runType       : latest.runType      || "private",
      addonVersion  : latest.addonVersion || "0.5.3",
      exportVersion : latest.exportVersion || "1.0.0",
      telemetryCapabilities: latest.telemetryCapabilities || {
        hasCombatSegments      : false,
        hasEnemyRegistry       : false,
        hasPartySnapshot       : false,
        hasDeathContext        : false,
        hasDamageBuckets       : false,
        hasEnemyCasts          : false,
        hasInterrupts          : false,
        hasEnemyHealthSnapshots: false,
        hasEnemyPositions      : false,
      },
      player        : latest.player || { class: "UNKNOWN", role: "dps" },
      partyMembers  : Array.isArray(latest.partyMembers)   ? latest.partyMembers   : [],
      pulls         : [],
      wipes         : [],
      damageBuckets : [],
      enemyRegistry : enemyRegistry,
      combatSegments: Array.isArray(latest.combatSegments) ? latest.combatSegments : [],
    },
  };
}

function createDashboard() {
  if (dashboardWindow) { dashboardWindow.show(); dashboardWindow.focus(); return; }
  dashboardWindow = new BrowserWindow({
    width: 480, height: 600, frame: false, resizable: false,
    backgroundColor: "#080A0C", show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-dashboard.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, "..", "renderer", "dashboard.html"));
  dashboardWindow.once("ready-to-show", () => { if (!store.get("startMinimized")) dashboardWindow.show(); });
  dashboardWindow.on("close",  (e) => { e.preventDefault(); dashboardWindow.hide(); });
  dashboardWindow.on("closed", ()  => { dashboardWindow = null; });
}

function createOverlay() {
  if (overlayWindow) return;
  const bounds = store.get("overlayBounds");
  overlayWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: true, hasShadow: false, focusable: false, backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload-overlay.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  overlayWindow.loadFile(path.join(__dirname, "..", "renderer", "overlay.html"));
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.on("moved",   () => store.set("overlayBounds", overlayWindow.getBounds()));
  overlayWindow.on("resized", () => store.set("overlayBounds", overlayWindow.getBounds()));
  overlayWindow.on("closed",  () => { overlayWindow = null; });
}

function toggleOverlay() {
  if (!overlayWindow) { createOverlay(); return; }
  overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
}

function createTray() {
  const iconPath = path.join(__dirname, "..", "..", "assets", "icon.png");
  const fs = require("fs");
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Velara Intelligence Companion");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Dashboard", click: () => createDashboard() },
    { label: "Toggle Overlay", click: () => toggleOverlay()   },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => createDashboard());
}

function broadcast(channel, data) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send(channel, data);
  if (overlayWindow   && !overlayWindow.isDestroyed())   overlayWindow.webContents.send(channel, data);
}

// ── Pipeline: SavedVariables watcher ─────────────────────────────────────────
function startSVWatcher() {
  if (svWatcher) svWatcher.stop();
  const svPath = getSavedVarsPath();
  if (!svPath) { console.warn("[SV] No SavedVariables path configured — skipping"); return; }

  const parser = new LuaParser();
  svWatcher    = new FileWatcher(svPath, 3000);

  svWatcher.on("change", (content) => {
    try {
      const parsed = parser.parse(content);
      if (!parsed || !parsed.VelaraIntelDB) return;
      const db = parsed.VelaraIntelDB;

      // ── Detect run open ───────────────────────────────────────────────────
      if (db._activeRun && db._activeRun.runId) {
        const ar = db._activeRun;
        if (ar.runId !== lastActiveRunId) {
          lastActiveRunId = ar.runId;
          console.log(`[SV] Run opened: ${ar.dungeonName} +${ar.keyLevel} (${ar.runId})`);
          if (combatLogParser && ar.player && ar.player.name) combatLogParser.setPlayerName(ar.player.name);
          if (combatLogWatcher) combatLogWatcher.resetToEnd();
          runAssembler.openRun(ar);
          broadcast("run-opened", ar);
        }
      }

      // ── Detect run close ──────────────────────────────────────────────────
      const runs = db.runs || [];
      if (runs.length > 0) {
        const latest = runs[0];

        if (
          latest.runId &&
          latest.finishSec > 0 &&
          latest.runId !== lastKnownRunId
        ) {
          lastKnownRunId  = latest.runId;
          lastActiveRunId = null;

          console.log(`[SV] Run detected: ${latest.dungeonName} +${latest.keyLevel} (${latest.runId})`);

          // Guard: skip stale runs with mapId 0 (pre-fix data)
          if (!latest.mapId || latest.mapId === 0) {
            console.log(`[SV] Skipping run ${latest.runId} — mapId is 0 (stale data)`);
            return;
          }

          const payload = buildV12Payload(latest);
          broadcast("run-update", latest);

          if (store.get("autoUpload") && store.get("apiKey")) {
            apiUploader.upload(payload).then((result) => {
              console.log("[Uploader] Result:", JSON.stringify(result));
              broadcast("upload-result", result);
            });
          } else {
            console.log("[SV] Auto-upload disabled or no API key — skipping");
          }
        }
      }
    } catch (err) {
      console.error("[SV] Parse error:", err.message);
    }
  });

  svWatcher.on("error", (err) => console.error("[SV] Error:", err.message));
  svWatcher.start();
}

// ── Pipeline: Combat log watcher ──────────────────────────────────────────────
function startCombatLogWatcher() {
  if (combatLogWatcher) combatLogWatcher.stop();
  const wowPath = store.get("wowPath");
  if (!wowPath) { console.warn("[CombatLog] No WoW path configured — skipping"); return; }

  combatLogWatcher = new CombatLogWatcher(wowPath, 2000);
  combatLogParser  = new CombatLogParser();

  combatLogParser.on("pullEnd", (pull) => {
    if (runAssembler.isOpen) {
      runAssembler.addPull(pull);
      broadcast("pull-update", { runId: runAssembler.currentRunID, pull });
    }
  });

  combatLogWatcher.on("line", (line) => {
    try { combatLogParser.parseLine(line); }
    catch (err) { console.error("[CombatLog] Parse error:", err.message); }
  });

  combatLogWatcher.on("error", (err) => console.error("[CombatLog] Error:", err.message));
  combatLogWatcher.start();
}

function setupUploader() {
  const apiKey = store.get("apiKey");
  apiUploader  = new ApiUploader(apiKey || "");
  runAssembler = new RunAssembler({
    onReady: async (payload) => {
      broadcast("run-assembled", payload.run);
      if (!store.get("autoUpload") || !store.get("apiKey")) {
        console.log("[Uploader] Auto-upload disabled or no API key — skipping"); return;
      }
      const result = await apiUploader.upload(payload);
      console.log("[Uploader] Result:", JSON.stringify(result));
      broadcast("upload-result", result);
    },
  });
}

function setupIPC() {
  ipcMain.handle("get-settings", () => ({
    wowPath      : store.get("wowPath"),
    accountName  : store.get("accountName"),
    apiKey       : store.get("apiKey"),
    hotkey       : store.get("hotkey"),
    autoUpload   : store.get("autoUpload"),
    startMinimized: store.get("startMinimized"),
  }));

  ipcMain.handle("save-settings", (_, settings) => {
    const needsRestart = settings.wowPath !== store.get("wowPath") || settings.accountName !== store.get("accountName");
    Object.entries(settings).forEach(([k, v]) => store.set(k, v));
    if (settings.apiKey && apiUploader) apiUploader.setApiKey(settings.apiKey);
    if (settings.hotkey) { globalShortcut.unregisterAll(); globalShortcut.register(settings.hotkey, toggleOverlay); }
    if (needsRestart) { startSVWatcher(); startCombatLogWatcher(); }
    return { ok: true };
  });

  ipcMain.handle("detect-wow-path", () => ({ path: detectWowPath() }));
  ipcMain.handle("get-accounts",    (_, wowPath) => ({ accounts: getAccountNames(wowPath || store.get("wowPath")) }));

  ipcMain.handle("browse-wow-path", async () => {
    const result = await dialog.showOpenDialog(dashboardWindow, {
      properties: ["openDirectory"], title: "Select your World of Warcraft _retail_ folder",
    });
    if (result.canceled || !result.filePaths.length) return { path: "" };
    return { path: result.filePaths[0] };
  });

  ipcMain.handle("manual-upload", async (_, runData) => {
    if (!store.get("apiKey")) return { ok: false, error: "No API key set" };
    return new ApiUploader(store.get("apiKey")).upload(runData);
  });

  ipcMain.handle("get-status", () => ({
    svWatcherActive       : !!svWatcher,
    combatLogWatcherActive: !!combatLogWatcher,
    combatLogPath         : getCombatLogPath(),
    runOpen               : runAssembler ? runAssembler.isOpen : false,
    currentRunId          : runAssembler ? runAssembler.currentRunID : null,
    lastKnownRunId,
  }));

  ipcMain.on("close-dashboard",    () => { if (dashboardWindow) dashboardWindow.hide(); });
  ipcMain.on("minimize-dashboard", () => { if (dashboardWindow) dashboardWindow.minimize(); });
}

app.whenReady().then(() => {
  if (!store.get("wowPath")) {
    const detected = detectWowPath();
    if (detected) {
      store.set("wowPath", detected);
      const accounts = getAccountNames(detected);
      if (accounts.length === 1) store.set("accountName", accounts[0]);
    }
  }
  setupIPC();
  setupUploader();
  createTray();
  createDashboard();
  createOverlay();
  const hotkey = store.get("hotkey");
  if (hotkey) globalShortcut.register(hotkey, toggleOverlay);
  startSVWatcher();
  startCombatLogWatcher();
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => {
  app.isQuitting = true;
  if (svWatcher)        svWatcher.stop();
  if (combatLogWatcher) combatLogWatcher.stop();
  globalShortcut.unregisterAll();
});
app.on("activate", () => createDashboard());
