// One-time script — adds CombatLogParser class to combatLogParser.js
// Run once: node addCombatLogParserClass.js
// Then delete this file.

const fs = require("fs");
const file = "combatLogParser.js";

const classCode = `
// ─── CombatLogParser class wrapper (used by Electron main.js) ────────────────
const { EventEmitter } = require("events");

class CombatLogParser extends EventEmitter {
  constructor() {
    super();
    this._playerName  = null;
    this._lines       = [];
    this._segmentOpen = false;
    this._segStartMs  = 0;
    this._events      = [];
  }

  setPlayerName(name) {
    this._playerName = name;
  }

  parseLine(line) {
    if (!line || typeof line !== "string") return;

    // Detect ENCOUNTER_START / ZONE_CHANGE as pull boundaries
    // For now: buffer lines and emit pullEnd on ENCOUNTER_END or regen boundary
    this._lines.push(line);

    // Simple regen detection: SPELL_ENERGIZE on player after combat = pull end
    // This is a best-effort wrapper — real parsing happens in parseCombatLog()
    if (line.includes("ENCOUNTER_END") || line.includes("ZONE_CHANGE")) {
      this._flushPull();
    }
  }

  _flushPull() {
    if (this._lines.length === 0) return;
    const lines = this._lines.splice(0);
    // Emit raw lines as a pull object for the assembler
    this.emit("pullEnd", { rawLines: lines, playerName: this._playerName });
  }
}

module.exports = { parseCombatLog, CombatLogParser };
`;

let content = fs.readFileSync(file, "utf8");

if (content.includes("class CombatLogParser")) {
  console.log("CombatLogParser class already present — nothing to do.");
  process.exit(0);
}

content = content.replace(
  /\nmodule\.exports = \{ parseCombatLog \};[\s\S]*$/,
  classCode
);

fs.writeFileSync(file, content, "utf8");
console.log("Done — CombatLogParser class added to combatLogParser.js");
