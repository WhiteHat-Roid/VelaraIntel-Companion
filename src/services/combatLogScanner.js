// combatLogScanner.js
// Scans a WoWCombatLog.txt file for completed M+ runs and uploads any that
// haven't been uploaded yet. Used for:
//   1. Manual "Scan for missed runs" in the dashboard
//   2. Auto-scan on companion startup
//
// Reuses CombatLogRunBuilder in replay mode — feeds it every line from the
// log file and collects all keyEnd payloads. Skips runIds already in
// uploadedRunIds. Uploads the rest via ApiUploader.

const fs = require("fs");
const readline = require("readline");
const { CombatLogRunBuilder } = require("./combatLogRunBuilder");

class CombatLogScanner {
  constructor({ uploader, velaraAuth, uploadedRunIds, onProgress } = {}) {
    this.uploader       = uploader;
    this.velaraAuth     = velaraAuth;
    this.uploadedRunIds = uploadedRunIds || new Set();
    this.onProgress     = onProgress || (() => {});
  }

  async scanFile(logPath) {
    const result = { found: 0, uploaded: 0, skipped: 0, errors: 0 };

    if (!logPath) {
      this.onProgress("No combat log path configured", "err");
      return result;
    }

    if (!fs.existsSync(logPath)) {
      this.onProgress(`Combat log not found: ${logPath}`, "err");
      return result;
    }

    this.onProgress("Scanning combat log for missed runs...", "info");

    // Collect all completed run payloads from the log file
    const payloads = await this._collectPayloads(logPath);
    result.found = payloads.length;

    if (payloads.length === 0) {
      this.onProgress("Scan complete — no completed runs found in log", "info");
      return result;
    }

    this.onProgress(`Found ${payloads.length} completed run(s) — checking for new...`, "info");

    // Upload each run not already uploaded
    for (const payload of payloads) {
      const runId = payload.run?.runId;
      if (!runId) { result.errors++; continue; }

      if (this.uploadedRunIds.has(runId)) {
        result.skipped++;
        continue;
      }

      const dungeon  = payload.run.dungeonName || "Unknown";
      const keyLevel = payload.run.keyLevel    || "?";

      try {
        this.onProgress(`Uploading ${dungeon} +${keyLevel}...`, "info");

        // Inject auth token if linked
        if (this.velaraAuth?.isLinked && this.velaraAuth.getAuthToken) {
          if (this.uploader?.setAuthToken) {
            this.uploader.setAuthToken(this.velaraAuth.getAuthToken());
          }
        }

        const uploadResult = await this.uploader.upload(payload);

        if (uploadResult.ok) {
          this.onProgress(`Uploaded: ${dungeon} +${keyLevel}`, "ok");
          result.uploaded++;
        } else if (uploadResult.skipped) {
          result.skipped++;
        } else {
          this.onProgress(
            `Failed to upload ${dungeon} +${keyLevel}: ${uploadResult.error || uploadResult.status || "unknown"}`,
            "err"
          );
          result.errors++;
        }
      } catch (err) {
        this.onProgress(`Error uploading ${dungeon} +${keyLevel}: ${err.message}`, "err");
        result.errors++;
      }
    }

    const summary = `Scan complete — ${result.uploaded} uploaded, ${result.skipped} already on site, ${result.errors} errors`;
    this.onProgress(summary, result.uploaded > 0 ? "ok" : "info");

    return result;
  }

  // Feed every line in the log file through a CombatLogRunBuilder and collect
  // all keyEnd payloads. One builder instance handles the entire file — it
  // resets internal state on each CHALLENGE_MODE_START.
  async _collectPayloads(logPath) {
    return new Promise((resolve, reject) => {
      const payloads = [];
      const builder  = new CombatLogRunBuilder();

      builder.on("keyEnd", (payload) => {
        if (payload?.run?.runId) payloads.push(payload);
      });

      const stream = fs.createReadStream(logPath, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          try {
            builder.processLine(trimmed);
          } catch {
            // Ignore individual line errors — keep scanning
          }
        }
      });

      rl.on("close", () => resolve(payloads));
      rl.on("error", (err) => reject(err));
      stream.on("error", (err) => reject(err));
    });
  }
}

module.exports = { CombatLogScanner };
