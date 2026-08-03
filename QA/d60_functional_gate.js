/**
 * D60 gate 3 — functional test of the S8 confirm-before-redeem pairing gate.
 *
 * Method (same as D57's): drive the REAL on-disk source. `confirmDeepLinkPairing`
 * and `handleDeepLink` are EXTRACTED VERBATIM from src/main/main.js at runtime and
 * evaluated against fakes for the Electron surface (dialog / dashboard window) and
 * a fake electron-store, so Brian's real config is never touched. velaraAuth is the
 * REAL VelaraAuth class, so a confirmed pairing makes a REAL prod call.
 *
 * Asserts:
 *   (a) Cancel  -> dialog shown, ZERO network calls, no state change, nothing persisted
 *   (b) Confirm -> flow reaches linkWithCode, which fails cleanly on the invalid code
 *   (c) an already-linked Companion never even sees a dialog (the !isLinked gate)
 *   (d) a malformed velara:// URL still cannot throw out of the (now async) handler
 *
 * Run: node QA/d60_functional_gate.js     (from the repo root)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MAIN = path.join(__dirname, "..", "src", "main", "main.js");
const src = fs.readFileSync(MAIN, "utf8");

// ── extract the two functions verbatim from disk ────────────────────────────
function extract(name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`FAIL: ${name} not found in main.js`);
  // walk braces from the first { after the signature
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`FAIL: unbalanced braces extracting ${name}`);
}

const confirmSrc = extract("confirmDeepLinkPairing");
const handleSrc = extract("handleDeepLink");
console.log(`extracted confirmDeepLinkPairing (${confirmSrc.length} B) + handleDeepLink (${handleSrc.length} B) from disk`);

// ── fakes ───────────────────────────────────────────────────────────────────
class FakeStore {
  constructor() { this.data = {}; this.writes = 0; }
  get(k, d) { return k in this.data ? this.data[k] : d; }
  set(k, v) { this.data[k] = v; this.writes++; }
  delete(k) { delete this.data[k]; this.writes++; }
}

const { VelaraAuth } = require(path.join(__dirname, "..", "src", "services", "velaraAuth.js"));

function makeCtx({ response, linked }) {
  const calls = { dialogs: [], status: [], logs: [], shown: 0 };
  const store = new FakeStore();
  const auth = new VelaraAuth(store);
  if (linked) {
    // minimal "already linked" state via the real persistence path
    auth._token = "fake-token-not-used";
    auth._displayName = "Someone-Else";
  }

  const dashboardWindow = {
    isMinimized: () => false,
    restore: () => {},
    show: () => { calls.shown++; },
    focus: () => {},
    webContents: { send: (ch, payload) => calls.status.push(["ipc:" + ch, payload]) },
  };

  const sandbox = {
    URL,
    console: {
      log: (...a) => calls.logs.push(a.join(" ")),
      error: (...a) => calls.logs.push("ERR " + a.join(" ")),
      warn: (...a) => calls.logs.push("WARN " + a.join(" ")),
    },
    dialog: {
      showMessageBox: async (win, options) => {
        const opts = options === undefined ? win : options;
        calls.dialogs.push({ parented: options !== undefined, opts });
        return { response };
      },
    },
    createDashboard: () => {},
    dashboardWindow,
    velaraAuth: auth,
    apiUploader: { setAuthToken: (t) => calls.status.push(["setAuthToken", String(t).slice(0, 6)]) },
    broadcastStatus: (msg, type) => calls.status.push([type, msg]),
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${confirmSrc}\n${handleSrc}\n`, sandbox);
  return { sandbox, calls, store, auth };
}

// ── count real network calls without faking them away ───────────────────────
const https = require("https");
const realRequest = https.request;
let netCalls = [];
https.request = function (...args) {
  const a0 = args[0];
  netCalls.push(typeof a0 === "string" ? a0 : `${a0.method || "GET"} ${a0.host || ""}${a0.path || ""}`);
  return realRequest.apply(this, args);
};

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " :: " + detail : ""}`);
}

(async () => {
  // ── (a) Cancel ────────────────────────────────────────────────────────────
  {
    netCalls = [];
    const { sandbox, calls, store, auth } = makeCtx({ response: 0, linked: false });
    await sandbox.handleDeepLink("velara://link?code=TESTBAD");

    const d = calls.dialogs[0];
    check("(a) dialog shown before any redeem", calls.dialogs.length === 1);
    check("(a) dialog is parented to the dashboard window", !!d && d.parented === true);
    check("(a) dashboard surfaced for the prompt", calls.shown === 1);
    check("(a) Cancel is the default AND the cancel button",
      !!d && d.opts.defaultId === 0 && d.opts.cancelId === 0,
      d ? `defaultId=${d.opts.defaultId} cancelId=${d.opts.cancelId}` : "");
    check("(a) buttons are [Cancel, Link account]",
      !!d && JSON.stringify(d.opts.buttons) === JSON.stringify(["Cancel", "Link account"]),
      d ? JSON.stringify(d.opts.buttons) : "");
    check("(a) type=warning, title names the action",
      !!d && d.opts.type === "warning" && /Link Companion\?/.test(d.opts.title));
    check("(a) only the first 3 code chars are shown",
      !!d && /TES···/.test(d.opts.message) && !/TESTBAD/.test(d.opts.message + d.opts.detail),
      d ? d.opts.message : "");
    check("(a) copy tells the user where it came from + when to cancel",
      !!d && /from your browser/i.test(d.opts.detail) && /velaraintel\.com/.test(d.opts.detail));
    check("(a) ZERO network calls on Cancel", netCalls.length === 0, JSON.stringify(netCalls));
    check("(a) nothing persisted on Cancel", store.writes === 0, `store writes=${store.writes}`);
    check("(a) auth state unchanged on Cancel", auth.isLinked === false && !auth.getAuthToken());
    check("(a) cancel is logged + surfaced to the user",
      calls.logs.some(l => /declined/i.test(l)) &&
      calls.status.some(([, m]) => /cancelled/i.test(m)));
  }

  // ── (b) Confirm -> real linkWithCode, invalid code fails cleanly ──────────
  {
    netCalls = [];
    const { sandbox, calls, store, auth } = makeCtx({ response: 1, linked: false });
    await sandbox.handleDeepLink("velara://link?code=TESTBAD");
    await new Promise(r => setTimeout(r, 6000)); // let the real request settle

    check("(b) dialog shown", calls.dialogs.length === 1);
    check("(b) confirm reached the REAL linkWithCode (live request made)",
      netCalls.length >= 1, JSON.stringify(netCalls));
    check("(b) request went to the companion token endpoint",
      netCalls.some(c => /companion\/token/.test(c)), JSON.stringify(netCalls));
    check("(b) invalid code left it UNLINKED", auth.isLinked === false && !auth.getAuthToken());
    check("(b) nothing persisted for an invalid code", store.writes === 0, `store writes=${store.writes}`);
    check("(b) failure surfaced to the user, not swallowed",
      calls.status.some(([t, m]) => t === "error" && /failed to link/i.test(m)),
      JSON.stringify(calls.status));
    check("(b) uploader was NOT re-armed", !calls.status.some(([t]) => t === "setAuthToken"));
  }

  // ── (c) already linked -> no dialog at all ────────────────────────────────
  {
    netCalls = [];
    const { sandbox, calls } = makeCtx({ response: 1, linked: true });
    await sandbox.handleDeepLink("velara://link?code=TESTBAD");
    check("(c) linked Companion shows NO dialog (the !isLinked gate holds)", calls.dialogs.length === 0);
    check("(c) linked Companion makes no network call", netCalls.length === 0);
    check("(c) drive-by is reported as ignored",
      calls.logs.some(l => /already linked/i.test(l)));
  }

  // ── (d) malformed URL cannot escape the async handler ─────────────────────
  {
    netCalls = [];
    const { sandbox, calls } = makeCtx({ response: 1, linked: false });
    let threw = null;
    try { await sandbox.handleDeepLink("velara://link?code="); } catch (e) { threw = e; }
    try { await sandbox.handleDeepLink("not a url at all"); } catch (e) { threw = e; }
    check("(d) malformed/empty-code URLs never throw out of the handler", threw === null,
      threw ? threw.message : "");
    check("(d) no dialog, no network for an empty code",
      calls.dialogs.length === 0 && netCalls.length === 0);
  }

  https.request = realRequest;
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:", failed.map(f => f.name).join("; "));
    process.exit(1);
  }
  console.log("D60 FUNCTIONAL GATE: ALL PASS");
})();
