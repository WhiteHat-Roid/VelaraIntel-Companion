// One-time script — adds RunAssembler class to runAssembler.js
// Run once from this directory: node addRunAssemblerClass.js
// Then delete this file.

const fs = require("fs");
const file = "runAssembler.js";

const classCode = `
// ─── RunAssembler class wrapper (used by Electron main.js) ──────────────────
class RunAssembler {
  constructor({ onReady } = {}) {
    this.onReady      = onReady || (() => {});
    this.isOpen       = false;
    this.currentRunID = null;
    this._addonRun    = null;
    this._pulls       = [];
  }
  openRun(addonRun) {
    this._addonRun    = addonRun;
    this._pulls       = [];
    this.isOpen       = true;
    this.currentRunID = addonRun?.runId || null;
  }
  addPull(pull) {
    if (!this.isOpen) return;
    this._pulls.push(pull);
  }
  closeRun() {
    if (!this.isOpen) return;
    this.isOpen = false;
    const result = assembleRunPayload({
      addonRun: this._addonRun,
      parsedCombatEvidence: { enrichedSegments: this._pulls },
      resolvedPulls: [],
      options: { dev: false },
    });
    this._addonRun    = null;
    this._pulls       = [];
    this.currentRunID = null;
    if (result.ok) this.onReady(result.payload);
    else console.error("[RunAssembler] Assembly failed:", result.errors);
  }
}

module.exports = { assembleRunPayload, RunAssembler };
`;

let content = fs.readFileSync(file, "utf8");

if (content.includes("class RunAssembler")) {
  console.log("RunAssembler class already present — nothing to do.");
  process.exit(0);
}

// Replace the old export line with class + new export
content = content.replace(
  /\nmodule\.exports = \{ assembleRunPayload \};[\s\S]*$/,
  classCode
);

fs.writeFileSync(file, content, "utf8");
console.log("Done — RunAssembler class added to runAssembler.js");
