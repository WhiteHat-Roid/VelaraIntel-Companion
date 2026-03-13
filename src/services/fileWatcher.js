// FileWatcher — polls VelaraIntel.lua for changes
// Uses stat-based detection (mtime + size) to avoid lock conflicts with WoW

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

class FileWatcher extends EventEmitter {
  constructor(filePath, intervalMs = 3000) {
    super();
    this.filePath = filePath;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastMtime = 0;
    this.lastSize = 0;
  }

  start() {
    if (this.timer) return;
    console.log(`[FileWatcher] Watching: ${this.filePath} (every ${this.intervalMs}ms)`);
    this.timer = setInterval(() => this._poll(), this.intervalMs);
    this._poll(); // immediate first check
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[FileWatcher] Stopped");
    }
  }

  _poll() {
    try {
      const stat = fs.statSync(this.filePath);
      const mtime = stat.mtimeMs;
      const size = stat.size;

      // No change
      if (mtime === this.lastMtime && size === this.lastSize) return;

      this.lastMtime = mtime;
      this.lastSize = size;

      // Small delay to let WoW finish writing
      setTimeout(() => {
        try {
          const content = fs.readFileSync(this.filePath, "utf8");
          if (content && content.length > 10) {
            this.emit("change", content);
          }
        } catch (readErr) {
          // EBUSY = WoW is still writing, skip this cycle
          if (readErr.code !== "EBUSY") {
            this.emit("error", readErr);
          }
        }
      }, 500);
    } catch (err) {
      if (err.code === "ENOENT") {
        // File doesn't exist yet — WoW hasn't created it
        return;
      }
      if (err.code !== "EBUSY") {
        this.emit("error", err);
      }
    }
  }
}

module.exports = { FileWatcher };
