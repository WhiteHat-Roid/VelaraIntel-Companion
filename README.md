# Velara Intelligence — Companion App

Desktop overlay for WoW Mythic+ pull intelligence. Watches your addon's SavedVariables file and automatically uploads run data to the Velara API.

## What It Does

1. **File Watcher** — Monitors `VelaraIntel.lua` in your WoW SavedVariables folder
2. **Auto-Upload** — Sends new run data to `api.velaraintel.com` automatically
3. **Overlay** — Small HUD overlay on top of WoW showing current run stats
4. **Hotkey** — `Ctrl+Shift+V` to show/hide the overlay (configurable)

## Setup

```bash
cd VelaraIntel-Companion
npm install
npm start
```

## First Run

1. The app will try to auto-detect your WoW install path
2. If not found, click **Browse** in Settings to select your `_retail_` folder
3. Select your WoW account from the dropdown
4. Enter your Velara API key
5. Click **Save Settings**

## How It Works

- The companion reads `WTF/Account/[NAME]/SavedVariables/VelaraIntel.lua` every 3 seconds
- When the file changes (after a run ends), it parses the Lua data into JSON
- If auto-upload is on, it POSTs the run to the Velara API
- The overlay shows live run stats (dungeon, key level, deaths, pulls, wipes)

## Not a Cheat

This app does NOT:
- Inject into WoW's memory
- Modify any game files
- Use WoW's addon API for network calls

It only reads a file that WoW writes to disk — the same approach Warcraftlogs uses.

## Project Structure

```
VelaraIntel-Companion/
├── package.json
├── assets/
│   └── icon.png              ← tray icon (copy your shield PNG here)
├── src/
│   ├── main/
│   │   ├── main.js           ← Electron main process
│   │   ├── preload-dashboard.js
│   │   └── preload-overlay.js
│   ├── services/
│   │   ├── fileWatcher.js    ← polls SavedVariables
│   │   ├── luaParser.js      ← Lua → JS parser
│   │   └── apiUploader.js    ← HTTPS client
│   └── renderer/
│       ├── overlay.html      ← overlay HUD
│       └── dashboard.html    ← settings + dashboard
└── COMPANION_SPEC.md
```
