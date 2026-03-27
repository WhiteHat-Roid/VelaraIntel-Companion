// VelaraIntel Companion — Electron Main Process v0.5.3
// V0.5.3: Auto-upload on key end (combat log detection), fix dedup cache,
//         real error logging on 422, retry on failure.
// V0.5.2: Fixed "Start with Windows" — uses Windows Registry instead of
//         Electron's broken setLoginItemSettings (fails with NSIS installers).
// V0.5.1: Auto-start with Windows wired to startMinimized toggle in settings.
// V0.5.0: Removed API key requirement. Added clientId UUID for rate tracking.

const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, dialog, nativeImage, shell,
} = require("electron");
const path   = require("path");
const crypto = require("crypto");
const Store  = require("electron-store");
const { execSync } = require("child_process");

const { FileWatcher }      = require("../services/fileWatcher");
const { LuaParser }        = require("../services/luaParser");
const { ApiUploader }      = require("../services/apiUploader");
const { CombatLogWatcher } = require("../services/combatLogWatcher");
const { CombatLogParser, parseCombatLog } = require("../services/combatLogParser");
const { RunAssembler }     = require("../services/runAssembler");
const fs = require("fs");

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

// ── Auto-start with Windows (Registry approach) ──────────────────────────────
// Electron's app.setLoginItemSettings() is broken with NSIS installers on Windows.
// Instead, we directly write/remove a registry key in HKCU\...\Run.
// This is the same mechanism Windows itself uses for startup programs.

const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REG_NAME = "VelaraIntelCompanion";

function setAutoStart(enabled) {
  try {
    if (enabled) {
      // Get the path to the installed .exe
      const exePath = app.getPath("exe");
      // Add registry entry — runs minimized to tray on login
      execSync(`reg add "${REG_KEY}" /v "${REG_NAME}" /t REG_SZ /d "\\"${exePath}\\"" /f`, { windowsHide: true });
      console.log("[AutoStart] Registry entry added:", exePath);
    } else {
      // Remove registry entry
      execSync(`reg delete "${REG_KEY}" /v "${REG_NAME}" /f`, { windowsHide: true });
      console.log("[AutoStart] Registry entry removed");
    }
  } catch (err) {
    // reg delete throws if the key doesn't exist — that's fine
    if (enabled) {
      console.warn("[AutoStart] Failed to set registry entry:", err.message);
    } else {
      console.log("[AutoStart] Registry entry already absent");
    }
  }
}

function getAutoStart() {
  try {
    const output = execSync(`reg query "${REG_KEY}" /v "${REG_NAME}"`, { windowsHide: true, encoding: "utf-8" });
    return output.includes(REG_NAME);
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
      privacyMode  : latest.privacyMode  || "shareable",
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
      bossEncounters: Array.isArray(latest.bossEncounters) ? latest.bossEncounters.map(b => ({
        encounterID:   b.encounterID   || 0,
        encounterName: b.encounterName || "Unknown",
        startTs:       (b.startSec || 0) * 1000,
        endTs:         (b.endSec   || 0) * 1000,
        success:       b.success ?? 0,
        difficultyID:  b.difficultyID || 0,
        groupSize:     b.groupSize    || 5,
        segmentId:     b.segmentId    || null,
        pullIndex:     b.pullIndex    || null,
      })) : [],
    },
  };
}

// ── Combat log enrichment — parse WoWCombatLog.txt and attach evidence ───────
function enrichPayloadWithCombatLog(payload, latest) {
  const logPath = getCombatLogPath();
  if (!logPath) {
    console.log("[Enrich] No combat log path configured — uploading thin data");
    return payload;
  }

  if (!fs.existsSync(logPath)) {
    console.log("[Enrich] WoWCombatLog.txt not found — uploading thin data");
    broadcast("combat-log-missing", { message: "Enable Advanced Combat Logging in WoW for rich telemetry" });
    return payload;
  }

  try {
    console.log(`[Enrich] Reading combat log: ${logPath}`);
    const logContent = fs.readFileSync(logPath, "utf8");
    const combatLogLines = logContent.split("\n").filter(l => l.trim().length > 0);
    console.log(`[Enrich] Combat log: ${combatLogLines.length} lines`);

    // Build a run object with ms timestamps for the parser
    const run = {
      runId: latest.runId,
      startTs: (latest.startSec || 0) * 1000,
      finishTs: (latest.finishSec || 0) * 1000,
      mapId: latest.mapId,
      keyLevel: latest.keyLevel,
      player: latest.player,
      partyMembers: latest.partyMembers,
      combatSegments: (latest.combatSegments || []).map(seg => ({
        segmentId: seg.segmentId,
        startTs: (seg.startSec || 0) * 1000,
        finishTs: (seg.finishSec || 0) * 1000,
        rawOutcome: seg.rawOutcome,
      })),
    };

    // Filter log lines to the run's time window (rough filter before full parse)
    // The parser does its own clock sync, but we can pre-filter by keeping only
    // lines from a few minutes before run start to a few minutes after run end
    const result = parseCombatLog({ run, combatLogLines });

    console.log(`[Enrich] Parse complete: ${result.enrichedSegments.length} segments enriched`);
    console.log(`[Enrich] Clock sync: ${result.clockSyncConfidence}, offset: ${result.clockOffsetMs}ms`);
    console.log(`[Enrich] Data quality: ${JSON.stringify(result.dataQuality)}`);
    console.log(`[Enrich] Capabilities: ${JSON.stringify(result.capabilityFlags)}`);

    // Attach enriched data to each combatSegment in the payload
    const evidenceMap = new Map();
    for (const eseg of result.enrichedSegments) {
      evidenceMap.set(eseg.segmentId, eseg);
    }

    const runObj = payload.run;
    for (const seg of (runObj.combatSegments || [])) {
      const evidence = evidenceMap.get(seg.segmentId);
      if (evidence) {
        // Attach evidence arrays to the segment
        seg.damageBuckets = evidence.damageBuckets || [];
        seg.interrupts = evidence.interrupts || [];
        seg.defensives = evidence.cooldownEvents || [];
        seg.enemyCasts = evidence.enemyCasts || [];
        seg.spikes = evidence.spikes || [];
        seg.healthMinBuckets = (evidence.damageBuckets || []).map(b => {
          // Derive a rough health pressure metric from damage vs healing
          const netDamage = (b.partyDamageTaken || 0) - (b.partyHealingReceived || 0);
          return Math.max(0, Math.min(100, Math.round(100 - (netDamage / 10000))));
        });
        // Enrich deaths with pre-death evidence
        if (evidence.deaths && evidence.deaths.length > 0) {
          seg.deathsEvidence = evidence.deaths;
        }
      }
    }

    // Update capability flags on the payload
    const caps = runObj.telemetryCapabilities;
    if (result.capabilityFlags.hasDamageBuckets) caps.hasDamageBuckets = true;
    if (result.capabilityFlags.hasInterrupts)    caps.hasInterrupts = true;
    if (result.capabilityFlags.hasEnemyCasts)    caps.hasEnemyCasts = true;
    if (result.capabilityFlags.hasDeathContext)   caps.hasDeathContext = true;
    caps.hasDefensives = result.enrichedSegments.some(s => s.cooldownEvents && s.cooldownEvents.length > 0);
    caps.hasEnemyHealthSnapshots = false; // Not derived from combat log yet

    // Attach parse metadata
    payload.clockOffsetMs = result.clockOffsetMs;
    payload.clockSyncConfidence = result.clockSyncConfidence;

    const totalInterrupts = result.enrichedSegments.reduce((s, seg) => s + (seg.interrupts?.length || 0), 0);
    const totalDefensives = result.enrichedSegments.reduce((s, seg) => s + (seg.cooldownEvents?.length || 0), 0);
    const totalEnemyCasts = result.enrichedSegments.reduce((s, seg) => s + (seg.enemyCasts?.length || 0), 0);
    const totalDeaths = result.enrichedSegments.reduce((s, seg) => s + (seg.deaths?.length || 0), 0);
    const totalBuckets = result.enrichedSegments.reduce((s, seg) => s + (seg.damageBuckets?.length || 0), 0);

    console.log(`[Enrich] Totals: interrupts=${totalInterrupts} defensives=${totalDefensives} enemyCasts=${totalEnemyCasts} deaths=${totalDeaths} damageBuckets=${totalBuckets}`);
    broadcast("enrichment-complete", {
      interrupts: totalInterrupts,
      defensives: totalDefensives,
      enemyCasts: totalEnemyCasts,
      deaths: totalDeaths,
      damageBuckets: totalBuckets,
      clockSync: result.clockSyncConfidence,
    });

    return payload;
  } catch (err) {
    console.error("[Enrich] Combat log parsing failed:", err.message);
    console.error("[Enrich] Stack:", err.stack);
    broadcast("enrichment-failed", { error: err.message });
    return payload; // Upload thin data as fallback
  }
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

          let payload = buildV12Payload(latest);
          payload = enrichPayloadWithCombatLog(payload, latest);
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

// ── Key-end detection via combat log → trigger SV re-read ────────────────────
// WoW writes CHALLENGE_MODE_COMPLETED to the combat log in real time.
// When we see it, we wait for SV to flush, then re-read and upload.

let keyEndPollTimer = null;

function onKeyEndDetected() {
  console.log("[KeyEnd] CHALLENGE_MODE_COMPLETED detected in combat log — waiting for SV flush...");
  broadcast("key-end-detected", { message: "Key completed — uploading..." });

  // Wait 5 seconds for WoW to flush SavedVariables, then poll
  if (keyEndPollTimer) clearInterval(keyEndPollTimer);
  let attempts = 0;
  const maxAttempts = 10; // 10 attempts × 3s = 30 seconds total

  setTimeout(() => {
    keyEndPollTimer = setInterval(() => {
      attempts++;
      console.log(`[KeyEnd] SV poll attempt ${attempts}/${maxAttempts}`);

      const svPath = getSavedVarsPath();
      if (!svPath) { clearInterval(keyEndPollTimer); return; }

      try {
        const fs = require("fs");
        const content = fs.readFileSync(svPath, "utf8");
        const parser = new LuaParser();
        const parsed = parser.parse(content);
        if (!parsed || !parsed.VelaraIntelDB) return;

        const db = parsed.VelaraIntelDB;
        const runs = db.runs || [];
        if (runs.length > 0) {
          const latest = runs[0];
          if (latest.runId && latest.finishSec > 0 && latest.runId !== lastKnownRunId) {
            lastKnownRunId = latest.runId;
            lastActiveRunId = null;
            clearInterval(keyEndPollTimer);

            console.log(`[KeyEnd] New run found: ${latest.dungeonName} +${latest.keyLevel} (${latest.runId})`);

            if (!latest.mapId || latest.mapId === 0) {
              console.log(`[KeyEnd] Skipping run ${latest.runId} — mapId is 0`);
              return;
            }

            let payload = buildV12Payload(latest);
            payload = enrichPayloadWithCombatLog(payload, latest);
            broadcast("run-update", latest);

            if (store.get("autoUpload")) {
              apiUploader.upload(payload).then((result) => {
                console.log("[KeyEnd] Upload result:", JSON.stringify(result));
                broadcast("upload-result", result);
                openRunInBrowser(result);
              });
            }
            return;
          }
        }

        if (attempts >= maxAttempts) {
          clearInterval(keyEndPollTimer);
          console.log("[KeyEnd] SV not updated after 30s — waiting for /reload as fallback");
          broadcast("key-end-timeout", { message: "Waiting for /reload — SV not flushed yet" });
        }
      } catch (err) {
        if (err.code !== "EBUSY") {
          console.error("[KeyEnd] SV read error:", err.message);
        }
      }
    }, 3000);
  }, 5000);
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
    try {
      combatLogParser.parseLine(line);
    } catch (err) {
      console.error("[CombatLog] Parse error:", err.message);
    }

    // Detect key completion from combat log lines
    if (line.includes("CHALLENGE_MODE_COMPLETED") || line.includes("CHALLENGE_MODE_END")) {
      onKeyEndDetected();
    }
  });

  combatLogWatcher.on("error", (err) => console.error("[CombatLog] Error:", err.message));
  combatLogWatcher.start();

  // Check if the combat log file exists
  const fs = require("fs");
  const logPath = getCombatLogPath();
  if (logPath && !fs.existsSync(logPath)) {
    console.warn("[CombatLog] WoWCombatLog.txt not found — enable Advanced Combat Logging in WoW");
    broadcast("combat-log-missing", { message: "Enable Advanced Combat Logging in WoW settings for automatic uploads" });
  }
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

    const safe = {
      wowPath       : settings.wowPath,
      accountName   : settings.accountName,
      hotkey        : settings.hotkey,
      autoUpload    : settings.autoUpload,
      startMinimized: settings.startMinimized,
    };
    Object.entries(safe).forEach(([k, v]) => store.set(k, v));

    // Wire startMinimized toggle to Windows auto-start via Registry
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
