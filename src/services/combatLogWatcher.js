// combatLogWatcher.js
// Tails WoWCombatLog.txt in real-time using fs.watch + periodic reads.
// Emits "line" for each new log line as WoW flushes it to disk.
// WoW only flushes the log when you zone out or a buffer fills — we poll
// every 2s as well to catch any delayed flushes.

const fs   = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

class CombatLogWatcher extends EventEmitter {
  constructor(wowPath, intervalMs = 2000) {
    super();
    this.wowPath    = wowPath;
    this.logPath    = path.join(wowPath, "Logs", "WoWCombatLog.txt");
    this.intervalMs = intervalMs;
    this.filePos    = 0;   // byte offset — only read new bytes
    this.timer      = null;
    this.watcher    = null;
    this.active     = false;
  }

  get path() {
    return this.logPath;
  }

  start() {
    if (this.active) return;
    this.active = true;

    // Seek to end of file on start so we don't replay old history
    try {
      const stat = fs.statSync(this.logPath);
      this.filePos = stat.size;
    } catch {
      this.filePos = 0;
    }

    console.log(`[CombatLogWatcher] Watching: ${this.logPath} from byte ${this.filePos}`);

    // Poll every intervalMs for new content
    this.timer = setInterval(() => this._read(), this.intervalMs);

    // Also use fs.watch for faster response when the file changes
    try {
      this.watcher = fs.watch(this.logPath, () => this._read());
    } catch {
      // File may not exist yet — polling will catch it when it appears
    }
  }

  stop() {
    this.active = false;
    if (this.timer)   { clearInterval(this.timer); this.timer = null; }
    if (this.watcher) { this.watcher.close();       this.watcher = null; }
    console.log("[CombatLogWatcher] Stopped");
  }

  // Reset to end of file (call this when a new dungeon run starts so we
  // don't pick up events from a previous session)
  resetToEnd() {
    try {
      const stat = fs.statSync(this.logPath);
      this.filePos = stat.size;
    } catch {
      this.filePos = 0;
    }
  }

  // Read the last N bytes of the file and return them as lines.
  // Used to pick up COMBATANT_INFO events that were written before the watcher started.
  readLastChunk(bytes = 200000) {
    try {
      const stat = fs.statSync(this.logPath);
      const startPos = Math.max(0, stat.size - bytes);
      const fd = fs.openSync(this.logPath, "r");
      const buf = Buffer.alloc(stat.size - startPos);
      fs.readSync(fd, buf, 0, buf.length, startPos);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      return text.split("\n").filter(l => l.trim().length > 0);
    } catch (err) {
      console.error("[CombatLogWatcher] readLastChunk error:", err.message);
      return [];
    }
  }

  _read() {
    if (!this.active) return;

    let stat;
    try {
      stat = fs.statSync(this.logPath);
    } catch {
      return; // file not there yet
    }

    // File was truncated / rotated — reset
    if (stat.size < this.filePos) {
      this.filePos = 0;
    }

    if (stat.size === this.filePos) return; // nothing new

    // Read only the new bytes
    const fd = fs.openSync(this.logPath, "r");
    const bytesToRead = stat.size - this.filePos;
    const buf = Buffer.alloc(bytesToRead);

    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, bytesToRead, this.filePos);
    } catch (e) {
      fs.closeSync(fd);
      return;
    }
    fs.closeSync(fd);

    this.filePos += bytesRead;

    const text  = buf.toString("utf8", 0, bytesRead);
    const lines = text.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        this.emit("line", trimmed);
      }
    }
  }
}

module.exports = { CombatLogWatcher };
