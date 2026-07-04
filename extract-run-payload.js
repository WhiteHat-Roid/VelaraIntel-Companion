// extract-run-payload.js — DIRECTIVE_139 helper.
//
// Re-parses a raw WoWCombatLog.txt through the CURRENT (fixed) parser and
// writes the exact upload payload(s) to JSON files — WITHOUT uploading. Because
// it never POSTs, it does NOT touch the backend and does NOT hit the normal
// duplicate-check. The JSON it writes is byte-identical to what the Companion
// WOULD upload for that run, so it is a valid "corrected payload" to feed to the
// backend reprocess override (app/scripts/reprocess_run.py).
//
// This is dev tooling (repo root, like test-upload.js) — it is NOT bundled into
// the shipped app and changes nothing the parser captures. It just drives the
// existing CombatLogRunBuilder in replay mode, the same way combatLogScanner
// does, minus the upload step.
//
// Usage:
//   node extract-run-payload.js <path-to-WoWCombatLog.txt> [outDir]
//
// Example:
//   node extract-run-payload.js "C:\...\_retail_\Logs\WoWCombatLog-052624.txt" .\corrected
//
// It prints every completed run found in the log with identifying fields, and
// writes each to <outDir>/<runId>.json. Pick the two you need (match by dungeon
// + date + key level; the reprocess script re-verifies identity before writing).

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { CombatLogRunBuilder } = require("./src/services/combatLogRunBuilder");

const logPath = process.argv[2];
const outDir  = process.argv[3] || ".";

if (!logPath) {
  console.error("Usage: node extract-run-payload.js <WoWCombatLog.txt> [outDir]");
  process.exit(1);
}
if (!fs.existsSync(logPath)) {
  console.error(`Combat log not found: ${logPath}`);
  process.exit(1);
}
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function countDeaths(run) {
  const pulls = (run && run.pulls) || [];
  return pulls.reduce((n, p) => n + ((p && p.deaths) ? p.deaths.length : 0), 0);
}

async function collectPayloads() {
  return new Promise((resolve, reject) => {
    const payloads = [];
    const builder  = new CombatLogRunBuilder();      // the current, fixed parser
    builder.on("keyEnd", (payload) => {
      if (payload && payload.run && payload.run.runId) payloads.push(payload);
    });

    const stream = fs.createReadStream(logPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const t = line.trim();
      if (t.length > 0) {
        try { builder.processLine(t); } catch { /* ignore per-line errors */ }
      }
    });
    rl.on("close", () => resolve(payloads));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

(async () => {
  console.log(`Re-parsing ${logPath} through the current parser (no upload)...\n`);
  const payloads = await collectPayloads();

  if (payloads.length === 0) {
    console.log("No completed runs found in this log file.");
    return;
  }

  console.log(`Found ${payloads.length} completed run(s):\n`);
  for (const p of payloads) {
    const run = p.run;
    const startIso = run.startTs ? new Date(run.startTs).toISOString() : "?";
    const outFile = path.join(outDir, `${run.runId}.json`);
    fs.writeFileSync(outFile, JSON.stringify(p, null, 2), "utf8");
    console.log(
      `  runId=${run.runId}\n` +
      `    dungeon=${run.dungeonName || "?"}  mapId=${run.mapId}  +${run.keyLevel}\n` +
      `    startTs=${run.startTs} (${startIso})\n` +
      `    pulls=${(run.pulls || []).length}  deaths=${countDeaths(run)}\n` +
      `    → wrote ${outFile}\n`
    );
  }
  console.log("Done. Feed the matching JSON to app/scripts/reprocess_run.py --payload <file>.");
})().catch((err) => { console.error("FAILED:", err); process.exit(1); });
