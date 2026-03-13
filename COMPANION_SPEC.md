# Velara Intelligence — Companion App Spec
## For Cowork — READ THIS FIRST

---

## CRITICAL RULES — DO NOT VIOLATE

1. **ONLY work inside this folder:** `C:\Users\Brian\ClaudeWorkspace\Velara_Code\VelaraIntel-Companion\`
2. **NEVER touch, read, modify, or delete ANY files outside this folder**
3. **NEVER touch these repos — they are OFF LIMITS:**
   - `VelaraIntel-Web\` (frontend — managed separately)
   - `VelaraIntel-Backend\` (backend API — managed separately)
   - `VelaraIntel-Addon\` (WoW addon — managed separately)
4. **NEVER delete any files or folders under any circumstance** — only create, write, or overwrite
5. **NEVER push to any git repo** without Brian's explicit approval
6. **NEVER run commands on any server or droplet**
7. **Ask before executing** — explain what you plan to do, wait for approval

---

## What This App Is

A lightweight desktop overlay that runs alongside World of Warcraft. It does two things:

1. **Reads WoW's SavedVariables file** from disk and pushes run data to the Velara API automatically (eliminates manual copy-paste export)
2. **Displays a small overlay** on top of WoW showing pull intelligence during dungeon runs

### How It Works

```
WoW Addon (in-game)
    ↓ writes to disk
SavedVariables/VelaraIntel.lua
    ↓ companion app reads file
Companion App (desktop)
    ↓ HTTP POST
api.velaraintel.com/v1/ingest/validate
    ↓ also renders
Overlay Window (on top of WoW)
```

### What It Does NOT Do
- Does NOT inject into WoW's memory
- Does NOT modify game files
- Does NOT use WoW's addon API for network calls
- Only reads a file from disk that WoW writes
- Same model as Warcraftlogs companion app — Blizzard allows this

---

## Tech Stack

- **Electron** — desktop app shell (cross-platform, transparent always-on-top windows)
- **React** — overlay UI
- **chokidar** (npm) — efficient file watching
- **luaparse** (npm) — parsing WoW SavedVariables Lua format into JS objects
- **electron-globalShortcut** — global hotkey for show/hide

---

## File Watcher Details

The app monitors this file path:
```
[WoW Install Path]/WTF/Account/[ACCOUNT_NAME]/SavedVariables/VelaraIntel.lua
```

- Poll every 3-5 seconds for file modification time changes
- When change detected, read the file, parse the Lua table, extract run data
- Compare against last known state to detect new/updated runs
- If new run data found, POST to API

### Auto-Detect WoW Install Path
Check these common locations in order:
1. `C:\Program Files (x86)\World of Warcraft\_retail_\`
2. `C:\Program Files\World of Warcraft\_retail_\`
3. `D:\World of Warcraft\_retail_\`
4. `D:\Games\World of Warcraft\_retail_\`

If not found, show a "Browse for WoW folder" dialog.

### Account Name Detection
Once WoW path is found, list directories in `WTF/Account/` — if only one account, auto-select. If multiple, let user pick.

---

## API Integration

**Endpoint:** `POST https://api.velaraintel.com/v1/ingest/validate`

**Headers:**
```
Content-Type: application/json
X-API-Key: [stored in app config]
```

**Payload format** (JSON — same as addon export):
```json
{
  "addon": "VelaraIntel",
  "v": "0.2.0",
  "ts": 1741564800,
  "run": {
    "mapID": 999001,
    "dungeonName": "The Dawnbreaker",
    "keyLevel": 14,
    "affixes": ["Fortified", "Bolstering"],
    "totalPulls": 12,
    "totalDeaths": 23,
    "bestTime": "24:37",
    "player": {
      "class": "WARRIOR",
      "spec": "Protection",
      "role": "TANK"
    },
    "wipes": [...]
  }
}
```

---

## Overlay Window Requirements

- **Always-on-top** transparent window
- **Draggable** — user can position it anywhere on screen
- **Global hotkey** to show/hide (default: `Ctrl+Shift+V`, user configurable)
- **Small** — roughly 300x200px default, resizable
- **System tray icon** when minimized (use the Velara shield icon)
- **No window frame** — frameless, transparent background

### Overlay Content (Phase 1 — Keep It Simple)
- Current dungeon name + key level
- Pull count
- Death count
- Last death info (role, timestamp)
- Status indicator: "Watching" / "Run in progress" / "Run complete"

---

## Brand / Design

Match the Velara website exactly:
- Background: `#080A0C`
- Amber accent: `#E8A030`
- Cyan accent: `#00C8FF`
- Text: `#C8D4DC`
- Muted text: `#556677`
- Borders: `#2A3A4A`
- Red (deaths/danger): `#C0392B`
- Green (success): `#27AE60`

Fonts:
- Headers: `Barlow Condensed` (bold/900)
- Body: `Barlow` (light/300, regular/400)
- Mono/data: `Share Tech Mono`

---

## Project Structure

```
VelaraIntel-Companion/
├── COMPANION_SPEC.md          ← this file
├── package.json
├── electron/
│   ├── main.ts                ← Electron main process
│   ├── preload.ts             ← preload script
│   ├── fileWatcher.ts         ← SavedVariables file watcher
│   ├── luaParser.ts           ← Lua table → JS object parser
│   ├── apiClient.ts           ← HTTP client for Velara API
│   └── tray.ts                ← system tray setup
├── src/
│   ├── App.tsx                ← overlay React app
│   ├── components/
│   │   ├── OverlayPanel.tsx   ← main overlay UI
│   │   ├── StatusBar.tsx      ← connection/watching status
│   │   └── RunSummary.tsx     ← current run info
│   └── styles/
│       └── overlay.css
├── assets/
│   └── icon.png               ← shield icon for tray
└── dist/                       ← built output
```

---

## Phase 1 Milestones (Build in This Order)

1. **Electron shell** — basic window opens, system tray works, hotkey toggles window
2. **File watcher** — detects WoW path, watches SavedVariables file, logs changes to console
3. **Lua parser** — parses VelaraIntelDB from Lua format to JSON
4. **API client** — POSTs parsed run data to the API endpoint
5. **Overlay UI** — React overlay showing run status and basic stats
6. **Polish** — dragging, resizing, settings panel for WoW path and hotkey config

---

## What NOT to Build Yet
- No login/auth system
- No user accounts
- No auto-updater
- No installer — we'll package it later
- No complex analytics in the overlay — keep Phase 1 minimal
