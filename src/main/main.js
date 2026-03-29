// VelaraIntel Companion — Electron Main Process v1.0.0
// V1.0.0: ARCHITECTURE SHIFT — pure combat log pipeline with hardened parser.
//         Dynamic segmentation, tiered party detection, fault-tolerant parsing.
//         ChatGPT-approved architecture. This is a fundamentally new product.
// V0.5.5: ARCHITECTURE REWRITE — builds runs 100% from combat log (like WCL).
//         No more SavedVariables dependency for uploads. CombatLogRunBuilder.
// V0.5.4: Combat log auto-upload (no /reload), enrichment pipeline fix,
//         segmentId matching, getCombatLogPath dated files, tray status,
//         forceQuit, completionResult, community gate compat.
// V0.5.3: Auto-upload on key end (combat log detection), fix dedup cache,
//         real error logging on 422, retry on failure.
// V0.5.2: Fixed "Start with Windows" — uses Windows Registry instead of
//         Electron's broken setLoginItemSettings (fails with NSIS installers).
// V0.5.1: Auto-start with Windows wired to startMinimized toggle in settings.
// V0.5.0: Removed API key requirement. Added clientId UUID for rate tracking.

const BUILD_TIMESTAMP = "2026-03-29T12:00:00";

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
const { CombatLogRunBuilder } = require("../services/combatLogRunBuilder");
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
let cachedActiveRun  = null;  // In-memory copy of _activeRun for key-end upload

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

  // WoW creates either WoWCombatLog.txt or WoWCombatLog-MMDDYY_HHMMSS.txt
  // depending on Advanced Combat Logging settings. Find the most recent one.
  // ONLY search _retail_/Logs — do NOT search parent World of Warcraft/Logs
  // (that folder contains BlizzardBrowser and other non-combat-log content).
  const logsDir = path.join(wowPath, "Logs");

  if (!fs.existsSync(logsDir)) {
    console.warn(`[CombatLog] Logs directory not found: ${logsDir}`);
    return path.join(wowPath, "Logs", "WoWCombatLog.txt");
  }

  // Check for exact name first (non-dated combat log)
  const exact = path.join(logsDir, "WoWCombatLog.txt");
  if (fs.existsSync(exact)) {
    try {
      if (fs.statSync(exact).isFile()) return exact;
    } catch { /* skip */ }
  }

  // Find dated combat log files (WoWCombatLog-MMDDYY_HHMMSS.txt)
  try {
    const files = fs.readdirSync(logsDir)
      .filter(f => {
        if (!f.startsWith("WoWCombatLog") || !f.endsWith(".txt")) return false;
        // Ensure it's a file, not a directory
        try { return fs.statSync(path.join(logsDir, f)).isFile(); } catch { return false; }
      })
      .map(f => ({ name: f, full: path.join(logsDir, f), mtime: fs.statSync(path.join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);  // newest first

    if (files.length > 0) {
      console.log(`[CombatLog] Found ${files.length} log file(s) in ${logsDir}, using newest: ${files[0].name}`);
      return files[0].full;
    } else {
      console.warn(`[CombatLog] No WoWCombatLog*.txt files found in ${logsDir}`);
    }
  } catch (err) {
    console.error(`[CombatLog] Error scanning ${logsDir}:`, err.message);
  }

  // Fallback: return default path (file may be created later when /combatlog is enabled)
  return path.join(wowPath, "Logs", "WoWCombatLog.txt");
}

// ── Privacy — strip forbidden fields before upload ────────────────────────────
const FORBIDDEN_FIELDS = new Set(["guid", "battleTag", "accountId", "email", "ipAddress"]);
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
        hasDefensives          : false,
        hasEncounterData       : false,
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
      completionResult: latest.completionResult || null,
      deathCountFinal:  latest.deathCountFinal  || null,
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
    const stat = fs.statSync(logPath);
    console.log(`[Enrich] Combat log size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
    const logContent = fs.readFileSync(logPath, "utf8");
    const combatLogLines = logContent.split("\n").filter(l => l.trim().length > 0);
    console.log(`[Enrich] Combat log: ${combatLogLines.length} lines`);

    // Build a run object with ms timestamps for the parser
    const runStartTs  = (latest.startSec || 0) * 1000;
    const runFinishTs = (latest.finishSec || 0) * 1000 || Date.now();

    const rawSegments = (latest.combatSegments || []).map(seg => ({
      segmentId: seg.segmentId,
      startTs: (seg.startSec || 0) * 1000,
      finishTs: (seg.finishSec || 0) * 1000,
      rawOutcome: seg.rawOutcome,
    }));

    // Fix segments with finishTs=0 (WoW hasn't flushed SV yet)
    // Estimate finishTs from next segment's start or run end time
    let fixedCount = 0;
    for (let i = 0; i < rawSegments.length; i++) {
      if (rawSegments[i].finishTs <= 0 || rawSegments[i].finishTs <= rawSegments[i].startTs) {
        if (i + 1 < rawSegments.length && rawSegments[i + 1].startTs > 0) {
          rawSegments[i].finishTs = rawSegments[i + 1].startTs;
        } else {
          rawSegments[i].finishTs = runFinishTs;
        }
        fixedCount++;
      }
    }
    if (fixedCount > 0) {
      console.log(`[Enrich] Fixed ${fixedCount} segments with missing finishTs (SV not flushed)`);
    }

    // If we have ZERO segments (SV wasn't read during run), create one big segment
    // covering the entire run so the parser can still match events
    if (rawSegments.length === 0 && runStartTs > 0) {
      console.log(`[Enrich] No segments from addon — creating synthetic segment for full run window`);
      rawSegments.push({
        segmentId: `${latest.runId || "unk"}-s-synth`,
        startTs: runStartTs,
        finishTs: runFinishTs,
        rawOutcome: "synthetic",
      });
    }

    console.log(`[Enrich] Segments for parser: ${rawSegments.length} (startTs range: ${rawSegments.map(s => s.startTs).join(", ")})`);

    const run = {
      runId: latest.runId,
      startTs: runStartTs,
      finishTs: runFinishTs,
      mapId: latest.mapId,
      keyLevel: latest.keyLevel,
      player: latest.player,
      partyMembers: latest.partyMembers,
      combatSegments: rawSegments,
    };

    const result = parseCombatLog({ run, combatLogLines });
    console.log(`[Enrich] Parser diagnostics: ${JSON.stringify(result.parserDiagnostics)}`);

    console.log(`[Enrich] Parse complete: ${result.enrichedSegments.length} segments enriched`);
    console.log(`[Enrich] Clock sync: ${result.clockSyncConfidence}, offset: ${result.clockOffsetMs}ms`);
    console.log(`[Enrich] Data quality: ${JSON.stringify(result.dataQuality)}`);
    console.log(`[Enrich] Capabilities: ${JSON.stringify(result.capabilityFlags)}`);

    // Attach enriched data to payload combatSegments
    const evidenceMap = new Map();
    const evidenceByIndex = new Map();
    for (let i = 0; i < result.enrichedSegments.length; i++) {
      const eseg = result.enrichedSegments[i];
      evidenceMap.set(eseg.segmentId, eseg);
      evidenceByIndex.set(i, eseg);
    }

    const runObj = payload.run;
    const payloadSegIds = (runObj.combatSegments || []).map(s => s.segmentId);
    const enrichedSegIds = result.enrichedSegments.map(s => s.segmentId);
    console.log(`[Enrich] Payload segmentIds: [${payloadSegIds.join(", ")}]`);
    console.log(`[Enrich] Enriched segmentIds: [${enrichedSegIds.join(", ")}]`);

    let matchedById = 0, matchedByIndex = 0;

    // If payload has no segments (combat-log-only path) or segments don't match,
    // use enriched segments directly as the payload's combatSegments
    if (!runObj.combatSegments || runObj.combatSegments.length === 0) {
      console.log("[Enrich] Payload has no segments — using enriched segments directly");
      runObj.combatSegments = result.enrichedSegments.map((eseg, i) => ({
        segmentId: eseg.segmentId,
        index: i + 1,
        startTs: rawSegments[i]?.startTs || 0,
        finishTs: rawSegments[i]?.finishTs || 0,
        segmentType: "combat",
        rawOutcome: rawSegments[i]?.rawOutcome || "unknown",
        damageBuckets: eseg.damageBuckets || [],
        interrupts: eseg.interrupts || [],
        defensives: eseg.cooldownEvents || [],
        enemyCasts: eseg.enemyCasts || [],
        spikes: eseg.spikes || [],
        deathsEvidence: eseg.deaths && eseg.deaths.length > 0 ? eseg.deaths : undefined,
        healthMinBuckets: (eseg.damageBuckets || []).map(b => {
          const netDamage = (b.partyDamageTaken || 0) - (b.partyHealingReceived || 0);
          return Math.max(0, Math.min(100, Math.round(100 - (netDamage / 10000))));
        }),
      }));
      matchedById = runObj.combatSegments.length;
    } else {
      for (let i = 0; i < runObj.combatSegments.length; i++) {
        const seg = runObj.combatSegments[i];
        // Try by segmentId first, then fall back to index
        let evidence = evidenceMap.get(seg.segmentId);
        if (evidence) {
          matchedById++;
        } else if (evidenceByIndex.has(i)) {
          evidence = evidenceByIndex.get(i);
          matchedByIndex++;
          console.log(`[Enrich] Segment ${seg.segmentId} matched by index ${i} (enriched id: ${evidence.segmentId})`);
        }
        if (evidence) {
          seg.damageBuckets = evidence.damageBuckets || [];
          seg.interrupts = evidence.interrupts || [];
          seg.defensives = evidence.cooldownEvents || [];
          seg.enemyCasts = evidence.enemyCasts || [];
          seg.spikes = evidence.spikes || [];
          seg.healthMinBuckets = (evidence.damageBuckets || []).map(b => {
            const netDamage = (b.partyDamageTaken || 0) - (b.partyHealingReceived || 0);
            return Math.max(0, Math.min(100, Math.round(100 - (netDamage / 10000))));
          });
          if (evidence.deaths && evidence.deaths.length > 0) {
            seg.deathsEvidence = evidence.deaths;
          }
        }
      }
    }
    console.log(`[Enrich] Evidence matching: ${matchedById} by ID, ${matchedByIndex} by index, ${runObj.combatSegments.length} total segments`);

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
    // Enable DevTools with Ctrl+Shift+F12 (admin only — requires /videv mindset)
    dashboardWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' && input.control && input.shift) {
        dashboardWindow.webContents.toggleDevTools();
      }
    });
  });
  dashboardWindow.on("close",  (e) => {
    if (app.isQuitting) { dashboardWindow = null; return; }
    e.preventDefault(); dashboardWindow.hide();
  });
  dashboardWindow.on("closed", ()  => { dashboardWindow = null; });
}

function createOverlay() {
  if (overlayWindow) return;
  const bounds = store.get("overlayBounds");
  overlayWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: 120, height: 120,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: false,
    backgroundColor: "#00000000",
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-overlay.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  overlayWindow.loadFile(path.join(__dirname, "..", "renderer", "overlay_v2.html"));
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.on("moved", () => {
    const b = overlayWindow.getBounds();
    store.set("overlayBounds", { ...store.get("overlayBounds"), x: b.x, y: b.y });
  });
  overlayWindow.on("closed",  () => { overlayWindow = null; });
}

function toggleOverlay() {
  if (!overlayWindow) { createOverlay(); return; }
  overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
}

// ── Status broadcast helper ──────────────────────────────────────────────────
function broadcastStatus(msg, level) {
  broadcast("status-log", { msg, level });
  console.log(`[Status] [${level}] ${msg}`);
}

function forceQuit() {
  app.isQuitting = true;
  if (svWatcher) svWatcher.stop();
  if (combatLogWatcher) combatLogWatcher.stop();
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
  if (overlayWindow) { overlayWindow.destroy(); overlayWindow = null; }
  if (dashboardWindow) { dashboardWindow.destroy(); dashboardWindow = null; }
  app.exit(0);
}

function createTray() {
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
    { label: "Quit", click: forceQuit },
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
  svWatcher    = new FileWatcher(svPath, 10000);

  svWatcher.on("change", (content) => {
    try {
      const parsed = parser.parse(content);
      if (!parsed || !parsed.VelaraIntelDB) return;
      const db = parsed.VelaraIntelDB;

      if (db._activeRun && db._activeRun.runId) {
        const ar = db._activeRun;
        // Always cache the latest active run data (segments, deaths, etc. accumulate)
        cachedActiveRun = JSON.parse(JSON.stringify(ar));
        if (ar.runId !== lastActiveRunId) {
          lastActiveRunId = ar.runId;
          console.log(`[SV] Run opened: ${ar.dungeonName} +${ar.keyLevel} (${ar.runId})`);
          if (combatLogParser && ar.player && ar.player.name) combatLogParser.setPlayerName(ar.player.name);
          if (combatLogWatcher) combatLogWatcher.resetToEnd();
          runAssembler.openRun(ar);
          broadcast("run-opened", ar);
        }
      }

      // SV watcher NO LONGER uploads runs.
      // The CombatLogRunBuilder is the ONLY upload path now.
      // SV watcher only caches _activeRun for party member data.
      const runs = db.runs || [];
      if (runs.length > 0) {
        const latest = runs[0];
        if (latest.runId && latest.finishSec > 0 && latest.runId !== lastKnownRunId) {
          lastKnownRunId  = latest.runId;
          lastActiveRunId = null;
          console.log(`[SV] Run completed: ${latest.dungeonName} +${latest.keyLevel} (${latest.runId}) — NOT uploading (use GO button or Upload A Log)`);
        }
      }
    } catch (err) {
      console.error("[SV] Parse error:", err.message);
    }
  });

  svWatcher.on("error", (err) => console.error("[SV] Error:", err.message));
  svWatcher.start();
}

// ── Combat log key tracking ──────────────────────────────────────────────────
// WoW's combat log contains CHALLENGE_MODE_START and CHALLENGE_MODE_END with
// full run metadata (dungeonName, mapId, keyLevel, affixes, completion data).
// We capture this directly — no SavedVariables flush needed.

let activeKeyFromLog = null;  // metadata captured from CHALLENGE_MODE_START
let keyEndPollTimer  = null;

function onChallengeStart(line) {
  // Format: CHALLENGE_MODE_START,"Skyreach",1209,161,4,[165]
  //                               ^name     ^mapId ^? ^keyLevel ^affixes
  try {
    const parts = line.split(",");
    const dungeonName = (parts[1] || "").replace(/"/g, "").trim();
    const mapId       = parseInt(parts[2], 10) || 0;
    const keyLevel    = parseInt(parts[4], 10) || 0;

    const nowSec = Math.floor(Date.now() / 1000);
    const runId  = `${mapId}-${nowSec}-${crypto.randomBytes(2).toString("hex")}-${crypto.randomBytes(2).toString("hex")}`;

    activeKeyFromLog = {
      runId,
      dungeonName,
      mapId,
      keyLevel,
      startSec: nowSec,
      finishSec: 0,
      runType: "private",
      runMode: "standard",
      privacyMode: "shareable",
      addonVersion: "0.8.2",
      exportVersion: "1.0.0",
      combatSegments: [],
      bossEncounters: [],
      partyMembers: cachedActiveRun?.partyMembers || [],
      player: cachedActiveRun?.player || { class: "UNKNOWN", role: "dps" },
      telemetryCapabilities: {
        hasCombatSegments: true, hasEnemyRegistry: false, hasPartySnapshot: false,
        hasDeathContext: false, hasDamageBuckets: false, hasEnemyCasts: false,
        hasInterrupts: false, hasEnemyHealthSnapshots: false, hasEnemyPositions: false,
        hasDefensives: false, hasEncounterData: false,
      },
    };

    console.log(`[KeyStart] ${dungeonName} +${keyLevel} (mapId=${mapId}) runId=${runId}`);
    broadcast("run-opened", activeKeyFromLog);
  } catch (err) {
    console.error("[KeyStart] Failed to parse CHALLENGE_MODE_START:", err.message);
  }
}

function onChallengeEnd(line) {
  // Format: CHALLENGE_MODE_END,1209,1,4,1024935,199.621994,965.740173
  //                            ^mapId ^success ^keyLevel ^timeMs
  try {
    const parts     = line.split(",");
    const mapId     = parseInt(parts[1], 10) || 0;
    const success   = parseInt(parts[2], 10) || 0;
    const keyLevel  = parseInt(parts[3], 10) || 0;
    const timeMs    = parseInt(parts[4], 10) || 0;

    console.log(`[KeyEnd] CHALLENGE_MODE_END: mapId=${mapId} success=${success} key=+${keyLevel} time=${timeMs}ms`);
    broadcast("key-end-detected", { message: "Key completed — uploading..." });

    // Build run data from combat log metadata (no SV needed)
    let run = activeKeyFromLog;
    if (!run || run.mapId !== mapId) {
      // No matching start event — build minimal run from end event
      console.log("[KeyEnd] No matching CHALLENGE_MODE_START — building from end event");
      const nowSec = Math.floor(Date.now() / 1000);
      const startSec = timeMs > 0 ? nowSec - Math.floor(timeMs / 1000) : nowSec - 1800;
      run = {
        runId: `${mapId}-${nowSec}-${crypto.randomBytes(2).toString("hex")}-${crypto.randomBytes(2).toString("hex")}`,
        dungeonName: cachedActiveRun?.dungeonName || "Unknown",
        mapId,
        keyLevel,
        startSec,
        finishSec: nowSec,
        runType: "private",
        runMode: "standard",
        privacyMode: "shareable",
        addonVersion: "0.8.2",
        exportVersion: "1.0.0",
        combatSegments: cachedActiveRun?.combatSegments || [],
        bossEncounters: cachedActiveRun?.bossEncounters || [],
        partyMembers: cachedActiveRun?.partyMembers || [],
        player: cachedActiveRun?.player || { class: "UNKNOWN", role: "dps" },
        telemetryCapabilities: {
          hasCombatSegments: true, hasEnemyRegistry: false, hasPartySnapshot: false,
          hasDeathContext: false, hasDamageBuckets: false, hasEnemyCasts: false,
          hasInterrupts: false, hasEnemyHealthSnapshots: false, hasEnemyPositions: false,
          hasDefensives: false, hasEncounterData: false,
        },
      };
    } else {
      run.finishSec = Math.floor(Date.now() / 1000);
    }

    // Set completion result from combat log data
    run.completionResult = { medal: success > 0 ? 1 : 0, timeMs, money: 0 };
    run.deathCountFinal = run.deathCountFinal || null;

    console.log(`[KeyEnd] Uploading: ${run.dungeonName} +${run.keyLevel} (${run.runId})`);

    if (!run.mapId || run.mapId === 0) {
      console.log("[KeyEnd] Skipping — mapId is 0");
      activeKeyFromLog = null;
      return;
    }

    lastKnownRunId  = run.runId;
    lastActiveRunId = null;
    activeKeyFromLog = null;
    cachedActiveRun  = null;

    let payload = buildV12Payload(run);
    payload = enrichPayloadWithCombatLog(payload, run);
    broadcast("run-update", run);

    // DEAD CODE PATH — onChallengeEnd is not called by the line handler.
    // CombatLogRunBuilder handles key detection now. This block is kept for
    // reference only and MUST NOT upload.
    console.log(`[KeyEnd] Run data built but NOT uploading — use GO button or Upload A Log`);
  } catch (err) {
    console.error("[KeyEnd] Failed to process CHALLENGE_MODE_END:", err.message);
    console.error("[KeyEnd] Stack:", err.stack);
  }
}

// ── Pipeline: Combat log watcher ──────────────────────────────────────────────
function startCombatLogWatcher() {
  if (combatLogWatcher) combatLogWatcher.stop();
  const wowPath = store.get("wowPath");
  if (!wowPath) { console.warn("[CombatLog] No WoW path — skipping"); return; }

  // Use resolved combat log path for the watcher
  const resolvedLogPath = getCombatLogPath();
  console.log(`[CombatLog] Resolved path: ${resolvedLogPath}`);
  combatLogWatcher = new CombatLogWatcher(wowPath, 2000);
  if (resolvedLogPath) combatLogWatcher.logPath = resolvedLogPath;
  combatLogParser  = new CombatLogParser();

  // PRIMARY path: CombatLogRunBuilder builds full payload from combat log alone
  // Upload ONLY happens when user presses GO in the dashboard — never automatically
  const runBuilder = new CombatLogRunBuilder();
  let lastCompletedPayload = null;

  runBuilder.on("keyStart", (run) => {
    broadcast("run-opened", run);
    broadcastStatus("Key started: " + (run.dungeonName || "Unknown") + " +" + (run.keyLevel || "?"), "info");
  });

  runBuilder.on("keyEnd", (payload) => {
    lastCompletedPayload = payload;
    broadcast("run-completed", payload);
    broadcastStatus("Key completed: " + payload.run.dungeonName + " +" + payload.run.keyLevel, "info");

    const segs = payload.run.combatSegments || [];
    const deaths = segs.reduce((s, seg) => s + (seg.deaths?.length || 0), 0);
    const ints = segs.reduce((s, seg) => s + (seg.interrupts?.length || 0), 0);
    const defs = segs.reduce((s, seg) => s + (seg.defensives?.length || 0), 0);
    broadcastStatus(segs.length + " segments, " + deaths + " deaths, " + ints + " interrupts, " + defs + " defensives", "info");
  });

  combatLogWatcher.on("line", (line) => {
    try {
      runBuilder.processLine(line);
    } catch (err) {
      console.error("[RunBuilder] Line error:", err.message);
    }
  });

  combatLogWatcher.on("error", (err) => console.error("[CombatLog] Error:", err.message));
  combatLogWatcher.start();

  // Feed the last chunk of the combat log to the runBuilder so it picks up
  // any COMBATANT_INFO or CHALLENGE_MODE_START events that were written
  // before the watcher started tailing. This ensures spec/role detection
  // works even if the companion was opened mid-session.
  try {
    const recentLines = combatLogWatcher.readLastChunk(200000); // ~200KB
    if (recentLines.length > 0) {
      console.log(`[CombatLog] Processing ${recentLines.length} recent lines for COMBATANT_INFO catchup`);
      let combatantInfoCount = 0;
      for (const line of recentLines) {
        try {
          // Only process COMBATANT_INFO and key lifecycle events from the lookback
          // Skip damage/heal/death events to avoid duplicating segment data
          if (line.includes("COMBATANT_INFO") || line.includes("CHALLENGE_MODE_START")) {
            runBuilder.processLine(line);
            if (line.includes("COMBATANT_INFO")) combatantInfoCount++;
          }
        } catch {}
      }
      if (combatantInfoCount > 0) {
        console.log(`[CombatLog] Catchup: processed ${combatantInfoCount} COMBATANT_INFO events`);
      }
    }
  } catch (err) {
    console.warn("[CombatLog] Lookback catchup failed:", err.message);
  }

  // Check if the combat log file exists and broadcast status
  const logPath = getCombatLogPath();
  const logFound = logPath && fs.existsSync(logPath);
  broadcast("combat-log-status", { found: !!logFound, path: logPath || null });
  if (logFound) {
    broadcastStatus("Combat log found: " + path.basename(logPath), "ok");
  } else {
    console.warn("[CombatLog] WoWCombatLog.txt not found — enable Advanced Combat Logging in WoW");
    broadcastStatus("Combat log not found — type /combatlog in WoW", "warn");
    broadcast("combat-log-missing", { message: "Enable Advanced Combat Logging in WoW settings" });
  }
}

function setupUploader() {
  const clientId = ensureClientId();
  apiUploader    = new ApiUploader(clientId);
  runAssembler   = new RunAssembler({
    onReady: async (payload) => {
      // RunAssembler NO LONGER uploads. Only the GO button and Upload A Log upload.
      // This callback only broadcasts for UI awareness.
      broadcast("run-assembled", payload.run);
      console.log(`[RunAssembler] Run ready: ${payload.run?.dungeonName} — NOT auto-uploading (use GO button)`);
    },
  });
}

function setupIPC() {
  ipcMain.handle("get-build-info", () => ({
    version: require("../../../package.json").version,
    buildTimestamp: BUILD_TIMESTAMP,
  }));

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

  // ── Upload (GO button) ──────────────────────────────────────────────────
  ipcMain.handle("upload-run", async (_, { payload, runMode, privacyMode }) => {
    try {
      payload.run.runMode = runMode;
      payload.run.privacyMode = privacyMode;

      const payloadSize = JSON.stringify(payload).length;
      broadcastStatus("Uploading " + (payloadSize / 1024).toFixed(1) + " KB to velaraintel.com...", "info");

      const result = await apiUploader.upload(payload);

      if (result.ok) {
        broadcastStatus("Upload complete!", "ok");
        openRunInBrowser(result);
      } else {
        broadcastStatus("Upload failed: " + (result.error || result.status || "unknown"), "err");
      }

      broadcast("upload-result", result);
      return result;
    } catch (err) {
      broadcastStatus("Upload error: " + err.message, "err");
      return { ok: false, error: err.message };
    }
  });

  // ── Parse combat log file (Upload tab) ────────────────────────────────
  ipcMain.handle("parse-combat-log-file", async (_, filePath) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter(l => l.trim().length > 0);

      broadcastStatus("Parsing " + lines.length + " lines from " + path.basename(filePath) + "...", "info");

      const builder = new CombatLogRunBuilder();
      const runs = [];

      builder.on("keyEnd", (payload) => {
        runs.push(payload);
      });

      for (const line of lines) {
        try { builder.processLine(line); } catch {}
      }

      broadcastStatus("Found " + runs.length + " run(s) in file", "info");

      return {
        ok: true,
        runs: runs.map((p, i) => ({
          index: i,
          dungeonName: p.run.dungeonName,
          keyLevel: p.run.keyLevel,
          durationMs: p.run.durationMs,
          deaths: p.run.deathCountFinal || 0,
          segments: (p.run.combatSegments || []).length,
          timed: p.run.completionResult?.medal > 0,
          payload: p,
        })),
      };
    } catch (err) {
      broadcastStatus("Parse error: " + err.message, "err");
      return { ok: false, error: err.message, runs: [] };
    }
  });

  // ── Browse for combat log file ────────────────────────────────────────
  ipcMain.handle("browse-combat-log", async () => {
    const result = await dialog.showOpenDialog(dashboardWindow, {
      properties: ["openFile"],
      title: "Select a WoW Combat Log file",
      filters: [{ name: "Combat Log", extensions: ["txt"] }],
      defaultPath: getCombatLogPath() || "",
    });
    if (result.canceled || !result.filePaths.length) return { path: "" };
    return { path: result.filePaths[0] };
  });

  ipcMain.on("close-dashboard",    () => { if (dashboardWindow) dashboardWindow.hide(); });
  ipcMain.on("minimize-dashboard", () => { if (dashboardWindow) dashboardWindow.minimize(); });
}

app.whenReady().then(() => {
  const PKG_VERSION = require("../../../package.json").version;
  console.log(`[Velara] Companion v${PKG_VERSION} — build ${BUILD_TIMESTAMP}`);
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
