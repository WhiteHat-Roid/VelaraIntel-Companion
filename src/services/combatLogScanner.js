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
const path = require("path");
const readline = require("readline");
const { CombatLogRunBuilder } = require("./combatLogRunBuilder");

class CombatLogScanner {
  constructor({ uploader, velaraAuth, uploadedRunIds, onProgress, lookbackDays } = {}) {
    this.uploader       = uploader;
    this.velaraAuth     = velaraAuth;
    this.uploadedRunIds = uploadedRunIds || new Set();
    this.onProgress     = onProgress || (() => {});
    this.lookbackDays   = lookbackDays ?? 7;  // default 7 days; 0 = scan all
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

        let uploadResult = await this.uploader.upload(payload);

        // Rate limited — wait and retry once
        if (uploadResult.status === 429) {
          const waitSec = uploadResult.retryAfter || 60;
          this.onProgress(
            `Rate limited — waiting ${waitSec}s before retry...`, "warn"
          );
          await new Promise(r => setTimeout(r, waitSec * 1000));
          uploadResult = await this.uploader.upload(payload);
        }

        if (uploadResult.ok) {
          this.onProgress(`Uploaded: ${dungeon} +${keyLevel}`, "ok");
          result.uploaded++;
          // Pace uploads — stay under backend 60/min rate limit (30/min max).
          // Only after a successful upload; skips/errors/retries don't add delay.
          await new Promise(r => setTimeout(r, 2000));
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

  // Scan every WoWCombatLog*.txt file in a directory, oldest first, calling
  // scanFile on each. uploadedRunIds is shared across files so a run that
  // happens to appear in two logs only uploads once.
  async scanDirectory(logsDir) {
    const agg = { filesScanned: 0, totalFiles: 0, found: 0, uploaded: 0, skipped: 0, errors: 0 };

    if (!logsDir) {
      this.onProgress("No combat log directory configured", "err");
      return agg;
    }
    if (!fs.existsSync(logsDir)) {
      this.onProgress(`Logs directory not found: ${logsDir}`, "err");
      return agg;
    }

    let entries;
    try { entries = fs.readdirSync(logsDir); }
    catch (err) {
      this.onProgress(`Failed to list ${logsDir}: ${err.message}`, "err");
      return agg;
    }

    const logFiles = entries
      .filter(name => name.startsWith("WoWCombatLog") && name.endsWith(".txt"))
      .map(name => {
        const full = path.join(logsDir, name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* skip */ }
        return { name, full, mtime };
      })
      .filter(f => f.mtime > 0)
      .sort((a, b) => a.mtime - b.mtime);  // oldest first so newer dedup wins

    // Limit to the lookback window (by file mtime). lookbackDays = 0 scans all.
    const cutoff = Date.now() - (this.lookbackDays * 24 * 60 * 60 * 1000);
    const filteredFiles = this.lookbackDays > 0
      ? logFiles.filter(f => f.mtime >= cutoff)
      : logFiles;

    agg.totalFiles = filteredFiles.length;
    if (filteredFiles.length === 0) {
      const noneMsg = this.lookbackDays > 0
        ? `No WoWCombatLog*.txt files from the last ${this.lookbackDays} days in ${logsDir}`
        : `No WoWCombatLog*.txt files in ${logsDir}`;
      this.onProgress(noneMsg, "warn");
      return agg;
    }

    const windowMsg = this.lookbackDays > 0
      ? ` from last ${this.lookbackDays} days`
      : "";
    this.onProgress(
      `Found ${filteredFiles.length} combat log file(s)${windowMsg} — scanning oldest first`,
      "info"
    );

    for (let i = 0; i < filteredFiles.length; i++) {
      const f = filteredFiles[i];
      this.onProgress(`Scanning file ${i + 1}/${filteredFiles.length}: ${f.name}`, "info");
      const r = await this.scanFile(f.full);
      agg.filesScanned++;
      agg.found    += r.found    || 0;
      agg.uploaded += r.uploaded || 0;
      agg.skipped  += r.skipped  || 0;
      agg.errors   += r.errors   || 0;
    }

    const summary = `Directory scan complete — ${agg.uploaded} uploaded, ${agg.skipped} already on site, ${agg.errors} errors across ${agg.filesScanned} file(s)`;
    this.onProgress(summary, agg.uploaded > 0 ? "ok" : "info");
    return agg;
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
