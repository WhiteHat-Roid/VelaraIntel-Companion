// VelaraIntel Companion — Electron Main Process v0.5.1
// V0.5.1: Auto-start with Windows wired to startMinimized toggle in settings.
//         Turning on "Start minimized to tray" also registers Windows startup entry.
//         Turning it off removes it. Player controls it — no forced behavior.
// V0.5.0: Removed API key requirement. Added clientId UUID for rate tracking.

const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, dialog, nativeImage, shell,
} = require("electron");
const path   = require("path");
const crypto = require("crypto");
const Store  = require("electron-store");

const { FileWatcher }      = require("../services/fileWatcher");
const { LuaParser }        = require("../services/luaParser");
const { ApiUploader }      = require("../services/apiUploader");
const { CombatLogWatcher } = require("../services/combatLogWatcher");
const { CombatLogParser }  = require("../services/combatLogParser");
const { RunAssembler }     = require("../services/runAssembler");

const store = new Store({
  defaults: {
    wowPath        : "",
    accountName    : "",
    clientId       : "",
    hotkey         : "CommandOrControl+Shift+V",
    autoUpload     : true,
    startMinimized : false,
    overlayBounds  : { x: 100, y: 100, width: 100, height: 100 },
  },
});

// ── clientId — generate once on first launch ──────────────────────────────────
function ensureClientId() {
  let id = store.get("clientId");
  if (!id || typeof id !== "string" || id.length < 8) {
    id = crypto.randomUUID();
    store.set("clientId", id);
  }
  return id;
}

// ── Auto-start with Windows ───────────────────────────────────────────────────
// Uses Electron's built-in login item API — no external packages needed.
// openAsHidden = true means it starts in tray without showing the window.
function setAutoStart(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin : enabled,
      openAsHidden: true,
      name        : "Velara Intelligence Companion",
    });
  } catch (err) {
    console.warn("[AutoStart] setLoginItemSettings failed:", err.message);
  }
}

function getAutoStart() {
  try {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  } catch {
    return false;
  }
}

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

// ── Privacy — strip forbidden fields before upload ────────────────────────────
const FORBIDDEN_FIELDS = new Set(["guid", "playerName", "characterName", "realmName", "battleTag"]);
function stripPrivacy(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!FORBIDDEN_FIELDS.has(k)) clean[k] = v;
  }
  return clean;
}

// ── V1.2 payload builder ──────────────────────────────────────────────────────
function buildV12Payload(latest) {
  const startTs       = (latest.startSec  || 0) * 1000;
  const finishTs      = (latest.finishSec || 0) * 1000;
  const affixes       = Array.isArray(latest.affixes)       ? latest.affixes       : [];
  const enemyRegistry = Array.isArray(latest.enemyRegistry) ? latest.enemyRegistry : [];

  return {
    addon    : "VelaraIntel",
    v        : latest.addonVersion || "0.7.3",
    uploadTs : Date.now(),
    clockOffsetMs       : null,
    clockSyncConfidence : "unknown",
    run: {
      runId         : latest.runId,
      mapId         : latest.mapId        || 0,
      dungeonName   : latest.dungeonName  || "Unknown",
      keyLevel      : latest.keyLevel     || 0,
      affixes,
      startTs,
      finishTs,
      durationMs    : finishTs > startTs ? finishTs - startTs : null,
      runType       : latest.runType      || "private",
      runMode       : latest.runMode      || "standard",
      addonVersion  : latest.addonVersion || "0.7.3",
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
      player       : stripPrivacy(latest.player || { class: "UNKNOWN", role: "dps" }),
      partyMembers : (Array.isArray(latest.partyMembers) ? latest.partyMembers : []).map(stripPrivacy),
      pulls         : [],
      wipes         : [],
      damageBuckets : [],
      enemyRegistry,
      combatSegments: Array.isArray(latest.combatSegments) ? latest.combatSegments : [],
    },
  };
}

function createDashboard() {
  if (dashboardWindow) { dashboardWindow.show(); dashboardWindow.focus(); return; }
  dashboardWindow = new BrowserWindow({
    width: 480, height: 560, frame: false, resizable: false,
    backgroundColor: "#080A0C", show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-dashboard.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, "..", "renderer", "dashboard.html"));
  dashboardWindow.once("ready-to-show", () => {
    if (!store.get("startMinimized")) dashboardWindow.show();
  });
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
  overlayWindow.loadFile(path.join(__dirname, "..", "renderer", "overlay_v2.html"));
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
  // Use .ico on Windows for proper multi-size tray icon rendering
  const fs = require("fs");
  const icoPath = path.join(__dirname, "..", "..", "assets", "icon.ico");
  const pngPath = path.join(__dirname, "..", "..", "assets", "icon.png");
  const iconPath = (process.platform === "win32" && fs.existsSync(icoPath)) ? icoPath : pngPath;
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Velara Intelligence Companion");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Dashboard", click: () => createDashboard()  },
    { label: "Toggle Overlay", click: () => toggleOverlay()    },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => createDashboard());
}

function broadcast(channel, data) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send(channel, data);
  if (overlayWindow   && !overlayWindow.isDestroyed())   overlayWindow.webContents.send(channel, data);
}

// ── Open run in browser via public token ──────────────────────────────────────
function openRunInBrowser(uploadResult) {
  if (!uploadResult || !uploadResult.ok) return;
  const body = uploadResult.body;
  if (!body) return;
  const token = body.runToken;
  if (token && typeof token === "string" && token.startsWith("vr_")) {
    shell.openExternal(`https://velaraintel.com/run/${token}`);
  } else {
    console.warn("[Uploader] Ingest succeeded but runToken missing or malformed:", token);
  }
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

      const runs = db.runs || [];
      if (runs.length > 0) {
        const latest = runs[0];
        if (latest.runId && latest.finishSec > 0 && latest.runId !== lastKnownRunId) {
          lastKnownRunId  = latest.runId;
          lastActiveRunId = null;

          console.log(`[SV] Run detected: ${latest.dungeonName} +${latest.keyLevel} (${latest.runId})`);

          if (!latest.mapId || latest.mapId === 0) {
            console.log(`[SV] Skipping run ${latest.runId} — mapId is 0`);
            return;
          }

          const payload = buildV12Payload(latest);
          broadcast("run-update", latest);

          if (store.get("autoUpload")) {
            apiUploader.upload(payload).then((result) => {
              console.log("[Uploader] Result:", JSON.stringify(result));
              broadcast("upload-result", result);
              openRunInBrowser(result);
            });
          } else {
            console.log("[SV] Auto-upload disabled — skipping");
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
  if (!wowPath) { console.warn("[CombatLog] No WoW path — skipping"); return; }

  combatLogWatcher = new CombatLogWatcher(wowPath, 2000);
  combatLogParser  = new CombatLogParser();

  combatLogParser.on("pullEnd", (pull) => {
    if (runAssembler.isOpen) {
      runAssembler.addPull(pull);
      broadcast("pull-update", { runId: runAssembler.currentRunID, pull });
    }
  });

  combatLogWatcher.on("line",  (line) => {
    try { combatLogParser.parseLine(line); }
    catch (err) { console.error("[CombatLog] Parse error:", err.message); }
  });

  combatLogWatcher.on("error", (err) => console.error("[CombatLog] Error:", err.message));
  combatLogWatcher.start();
}

function setupUploader() {
  const clientId = ensureClientId();
  apiUploader    = new ApiUploader(clientId);
  runAssembler   = new RunAssembler({
    onReady: async (payload) => {
      broadcast("run-assembled", payload.run);
      if (!store.get("autoUpload")) {
        console.log("[Uploader] Auto-upload disabled — skipping"); return;
      }
      const result = await apiUploader.upload(payload);
      console.log("[Uploader] Result:", JSON.stringify(result));
      broadcast("upload-result", result);
      openRunInBrowser(result);
    },
  });
}

function setupIPC() {
  ipcMain.handle("get-settings", () => ({
    wowPath        : store.get("wowPath"),
    accountName    : store.get("accountName"),
    hotkey         : store.get("hotkey"),
    autoUpload     : store.get("autoUpload"),
    startMinimized : store.get("startMinimized"),
    autoStartOnBoot: getAutoStart(),
  }));

  ipcMain.handle("save-settings", (_, settings) => {
    const needsRestart =
      settings.wowPath !== store.get("wowPath") ||
      settings.accountName !== store.get("accountName");

    // Only persist known safe settings — never accept apiKey from renderer
    const safe = {
      wowPath       : settings.wowPath,
      accountName   : settings.accountName,
      hotkey        : settings.hotkey,
      autoUpload    : settings.autoUpload,
      startMinimized: settings.startMinimized,
    };
    Object.entries(safe).forEach(([k, v]) => store.set(k, v));

    // Wire startMinimized toggle to Windows auto-start
    if (typeof settings.startMinimized === "boolean") {
      setAutoStart(settings.startMinimized);
    }

    if (settings.hotkey) {
      globalShortcut.unregisterAll();
      globalShortcut.register(settings.hotkey, toggleOverlay);
    }
    if (needsRestart) { startSVWatcher(); startCombatLogWatcher(); }
    return { ok: true };
  });

  ipcMain.handle("detect-wow-path", () => ({ path: detectWowPath() }));
  ipcMain.handle("get-accounts",    (_, wowPath) => ({ accounts: getAccountNames(wowPath || store.get("wowPath")) }));

  ipcMain.handle("browse-wow-path", async () => {
    const result = await dialog.showOpenDialog(dashboardWindow, {
      properties: ["openDirectory"],
      title: "Select your World of Warcraft _retail_ folder",
    });
    if (result.canceled || !result.filePaths.length) return { path: "" };
    return { path: result.filePaths[0] };
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
  ensureClientId();
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
