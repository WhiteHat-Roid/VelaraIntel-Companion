// ─────────────────────────────────────────────────────────────
//  Velara Intelligence  |  File logger
//
//  WHY THIS EXISTS: the Companion previously logged only to console.log,
//  which is discarded for a packaged Electron app. When a Temple +2 upload
//  landed unowned and with no identity, the HTTP status and response body it
//  actually received had never been written anywhere — not by us, not by the
//  server. That was unrecoverable after the fact and cost an hour.
//
//  ⛔ SECURITY — NO CREDENTIAL MAY REACH THIS FILE.
//  The log lives on disk in userData and may be pasted into a bug report or a
//  Discord channel. Everything written goes through redact() first, which:
//    - drops any key whose NAME looks like a credential (token/auth/secret/…)
//    - rewrites anything shaped like a Bearer header or a JWT, wherever it sits
//  Callers must still never hand it a raw token. redact() is the backstop, not
//  the contract. Auth is recorded as a BOOLEAN (hasAuth) and never a value.
//
//  Rotation: single file, size-capped, one generation of history. Two files
//  bounded at MAX_BYTES each — a log that grows without bound is its own defect.
// ─────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const MAX_BYTES = 2 * 1024 * 1024;   // 2 MB per file, 2 files => 4 MB ceiling
const MAX_FIELD = 4000;              // truncate any single stringified field

// Resolve a log directory without hard-requiring electron — this module is used
// from services that also run outside the main process (and under test).
let _dir = null;
function logDir() {
  if (_dir) return _dir;
  let base;
  try {
    const { app } = require("electron");
    base = app && app.getPath ? app.getPath("userData") : null;
  } catch { base = null; }
  if (!base) base = path.join(os.tmpdir(), "velara-companion");
  _dir = path.join(base, "logs");
  try { fs.mkdirSync(_dir, { recursive: true }); } catch { /* best effort */ }
  return _dir;
}

function logPath()    { return path.join(logDir(), "velara.log"); }
function logPathOld() { return path.join(logDir(), "velara.log.1"); }

// ── Redaction ────────────────────────────────────────────────────────────────
// Key-name based (catches `token`, `authToken`, `Authorization`, `apiKey`, …)
const SECRET_KEY = /(token|auth|secret|password|passwd|credential|bearer|api[-_]?key|cookie|session)/i;
// Value-shape based, applied to every string regardless of its key.
// ⚠ Segment lengths are deliberately UNBOUNDED-low. An earlier version required
// {5,} per segment and let a short `eyJa.bbb.ccc` through — every JWT begins with
// `eyJ` (base64 of `{"`), so the prefix plus two dots is the signal; segment length
// is not. Found by the redaction control, not by reading the regex.
const JWT_SHAPE    = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const BEARER_SHAPE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

function scrubString(s) {
  if (typeof s !== "string") return s;
  let out = s.replace(JWT_SHAPE, "<redacted:jwt>").replace(BEARER_SHAPE, "Bearer <redacted>");
  if (out.length > MAX_FIELD) out = out.slice(0, MAX_FIELD) + `…<truncated ${out.length - MAX_FIELD}b>`;
  return out;
}

function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return "<depth-limit>";
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && typeof v !== "boolean" && typeof v !== "number") {
        // Record presence and length only — never the value.
        // ⚠ Booleans and numbers are exempt BY TYPE, not by name. A credential is
        // never a boolean, and the name rule is deliberately broad enough to catch
        // `hasAuth` — which is exactly the field that tells us whether a Bearer was
        // attached to a failed upload. Redacting it destroyed the most diagnostic
        // value in the record while looking like the logger was working. Caught by
        // the positive control, not by review.
        out[k] = v == null || v === "" ? "<absent>" : `<redacted:${String(v).length}b>`;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

// ── Rotation ─────────────────────────────────────────────────────────────────
function rotateIfNeeded() {
  try {
    const st = fs.statSync(logPath());
    if (st.size < MAX_BYTES) return;
    try { fs.unlinkSync(logPathOld()); } catch { /* may not exist */ }
    fs.renameSync(logPath(), logPathOld());
  } catch { /* no file yet — nothing to rotate */ }
}

// ── Write ────────────────────────────────────────────────────────────────────
function write(level, event, data) {
  // Redact ONCE and reuse for both sinks. The console must get the same scrubbed,
  // truncated value as the file — echoing the raw object would both leak a
  // credential to stdout and dump megabytes into a terminal.
  const safe = data === undefined ? undefined : redact(data);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(safe !== undefined ? { data: safe } : {}),
  });
  try {
    rotateIfNeeded();
    fs.appendFileSync(logPath(), line + "\n", "utf8");
  } catch { /* logging must never break the app */ }
  const c = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  c(`[${event}]`, safe !== undefined ? safe : "");
}

const info  = (event, data) => write("info",  event, data);
const warn  = (event, data) => write("warn",  event, data);
const error = (event, data) => write("error", event, data);

module.exports = { info, warn, error, redact, logPath, logPathOld, logDir, MAX_BYTES };
