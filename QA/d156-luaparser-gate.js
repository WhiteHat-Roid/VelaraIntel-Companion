#!/usr/bin/env node
/* eslint-disable no-console */
//  D156 GATE — the string-aware Lua comment stripper, in BOTH clients.
//
//  ⛔ WHY THIS GATE IS SHAPED THE WAY IT IS, AND WHY A NORMAL UNIT TEST IS WORSE THAN
//  NOTHING HERE:
//
//  The bug is that `--` inside a QUOTED VALUE was treated as the start of a comment. A
//  hand-written fixture does not contain such a value, because nobody writes one on
//  purpose. So a synthetic fixture PASSES against the BROKEN parser — it would have
//  gone green every day for the month the pipeline was dead, and it would have been
//  cited as coverage.
//
//  Therefore this gate:
//    1. runs the OLD stripping strategy against a REAL captured file and REQUIRES it to
//       FAIL. If the negative control passes, the fixture no longer reproduces the bug
//       and the gate refuses to certify anything.
//    2. runs the SHIPPED (fixed) parser against the same file and requires the whole
//       table back, by count, not by "no exception".
//    3. proves the change is ADDITIVE: on a file with no poisoned values, old and new
//       must return byte-identical structures.
//    4. does all of it for the Companion copy AND the Overwolf copy, which is a
//       byte-identical port (D24) and therefore carried the identical bug.
//
//  Run:  node QA/d156-luaparser-gate.js
//  Exit: 0 all pass · 1 a check failed · 2 the fixture is missing or has drifted

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

// ── The fixture ────────────────────────────────────────────────────────────────
// A REAL SavedVariables capture taken 2026-08-22, before Recipe C was applied to the
// live file.
//
// ⛔ DELIBERATELY NOT COMMITTED. `_Build_Artifacts/` is gitignored, and this file
// carries real player GUIDs, character names and equipment. The sha256 below is the
// contract; the bytes stay out of history. See D156.
//
// ⛔ ══ IF THIS GATE CANNOT FIND ITS FIXTURE, THAT IS THE GATE WORKING. ══
//
//  DO NOT wrap the read below in a try/catch. DO NOT `return` early, skip, warn-and-
//  continue, or substitute a synthetic file. Every one of those converts exit 2 into a
//  green run, and a green run without this fixture certifies NOTHING — a hand-written
//  fixture PASSES against the BROKEN parser, which is the entire reason this gate is
//  shaped the way it is (see the header above). Turning the loud failure into a silent
//  skip reintroduces the exact defect D156 exists to prevent: a branch that says
//  nothing while the pipeline is dead.
//
//  The fixture is LOCAL-ONLY BY RULING, not by oversight — Brian, 2026-08-25, D176
//  Option C. Rejected alternatives, so they are not re-proposed: committing the real
//  bytes (git-LFS or a private repo) is permanent retention of OTHER PLAYERS' names
//  and GUIDs; a redacted vendored fixture (Option A) stays open if this ever needs to
//  run in CI, and would require re-measuring every EXPECT constant below.
//
//  ⚠ CORRECTION 2026-08-25: an earlier version of this comment called this file "the
//  only artifact that reproduces the bug." That is FALSE and was falsified by
//  measurement. The LIVE SavedVariables file carried 1 poisoned literal on 2026-08-25
//  (vs 22 here) and the old stripper FAILS on it too — because D156 fixed the READER
//  and nothing has yet fixed the WRITER, so the addon keeps re-poisoning the file.
//  So the fixture IS replaceable by a fresh capture. It is not a drop-in: every
//  EXPECT constant below was measured against the pinned bytes and would all move.
//  ⛔ Re-measuring against a file you just captured is how a wrong constant gets
//  blessed — if you re-capture, re-derive each expectation deliberately, not by
//  reading it back off the new file.
const FIXTURE = path.resolve(
  __dirname,
  "../../_Build_Artifacts/D156-sv-fixture/VelaraIntel.lua.pre-D156-20260822"
);
const FIXTURE_SHA = "1203701d2f06ae7e6d93d1d28446368f419132b60f4d68d23491275b8ec3a2b0";

const COMPANION_PARSER = path.resolve(__dirname, "../src/services/luaParser.js");
const OVERWOLF_PARSER = path.resolve(__dirname, "../../VelaraIntel-Overwolf/shared/luaParser.js");

// ── Expectations, measured on the fixture 2026-08-22 ───────────────────────────
const EXPECT = {
  uiMapIds: 199,
  races: 2588,
  uploaderIdentity: "Literoid-Illidan",
  // Ruby Life Pools f2/f1 and Voidscar Arena f1/f2 — the floors the S2 work needs.
  requiredUiMaps: ["2094", "2095", "2572", "2574"],
  // Voidscar f3 has never been captured. Asserted ABSENT so a future harvest that
  // gains it trips this gate and gets noticed rather than sliding in unremarked.
  knownAbsentUiMap: "2573",
  poisonedLiterals: 22,
};

let failures = 0;
const ok = (label, pass, detail) => {
  if (!pass) failures++;
  console.log(`  ${pass ? "✅ PASS" : "⛔ FAIL"}  ${label.padEnd(56)} ${detail === undefined ? "" : detail}`);
};
const die = (code, msg) => { console.error(`\n⛔ ${msg}`); process.exit(code); };

// ── The OLD stripping strategy, reproduced verbatim ────────────────────────────
// Kept here on purpose rather than read out of git: the gate must be able to
// demonstrate the defect forever, without depending on what HEAD happens to be.
function oldStrip(luaSource) {
  let src = luaSource.replace(/--\[\[[\s\S]*?\]\]/g, "");
  src = src.replace(/--[^\n]*/g, "");
  return src;
}

// Count string literals containing the comment token — the thing that must be present
// for the fixture to be a valid reproduction.
function poisonedLiteralCount(s) {
  let n = 0, i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      let j = i + 1, buf = '"';
      while (j < s.length) {
        if (s[j] === "\\") { buf += s[j] + s[j + 1]; j += 2; continue; }
        buf += s[j];
        if (s[j] === '"') { j++; break; }
        j++;
      }
      if (buf.includes("--")) n++;
      i = j;
      continue;
    }
    i++;
  }
  return n;
}

// Recipe C, in memory — turns the poisoned fixture into its clean twin so check 3 has
// a control without needing a second artifact on disk.
function recipeC(s) {
  for (const key of ["_inspectProbe", "_inspectLevelProbe", "_gearOverlayPanel", "_gearOverlayGeom"]) {
    const k = s.indexOf(`["${key}"]`);
    if (k === -1) continue;
    const open = s.indexOf("{", k);
    let d = 0, end = -1;
    for (let i = open; i < s.length; i++) {
      if (s[i] === "{") d++;
      else if (s[i] === "}") { d--; if (d === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    let tail = end + 1;
    while (tail < s.length && /[\s,]/.test(s[tail])) tail++;
    s = s.slice(0, k) + s.slice(tail);
  }
  return s.split("expirationTime secret -- durationLeft").join("expirationTime secret - durationLeft");
}

// ── Load both parser copies ────────────────────────────────────────────────────
function loadCompanion() {
  delete require.cache[require.resolve(COMPANION_PARSER)];
  return require(COMPANION_PARSER).LuaParser;
}
// Overwolf's copy publishes onto `window` instead of module.exports — same class, no
// export shim. Evaluate it in a sandbox with a window object rather than editing it.
function loadOverwolf() {
  const code = fs.readFileSync(OVERWOLF_PARSER, "utf8");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: OVERWOLF_PARSER });
  if (!sandbox.window.VelaraLuaParser || !sandbox.window.VelaraLuaParser.LuaParser) {
    die(1, "Overwolf parser did not publish window.VelaraLuaParser.LuaParser");
  }
  return sandbox.window.VelaraLuaParser.LuaParser;
}

// Parse using a supplied strip strategy, reusing the class's own value parser so the
// only variable between arms is the stripper.
function parseWith(LuaParserClass, source, strip) {
  const p = new LuaParserClass();
  const src = strip(source);
  const result = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/g;
  let m;
  const warn = console.warn;
  console.warn = () => {};
  try {
    while ((m = re.exec(src)) !== null) {
      try { const [v] = p._parseValue(src, m.index + m[0].length); result[m[1]] = v; } catch (_) { /* per-var, as parse() does */ }
    }
  } finally { console.warn = warn; }
  return result;
}
function parseShipped(LuaParserClass, source) {
  const warn = console.warn;
  console.warn = () => {};
  try { return new LuaParserClass().parse(source); } finally { console.warn = warn; }
}

// ── Go ─────────────────────────────────────────────────────────────────────────
console.log("D156 GATE — string-aware Lua comment stripper\n");

if (!fs.existsSync(FIXTURE)) {
  die(2, `Fixture missing:\n   ${FIXTURE}\n\n` +
         `   It is a real SavedVariables capture and is deliberately NOT in git.\n` +
         `   Without it this gate cannot reproduce the defect, and a synthetic file\n` +
         `   PASSES against the broken parser. Restore it (sha256 ${FIXTURE_SHA})\n` +
         `   or re-capture a poisoned SV before certifying any parser change.`);
}
const fixture = fs.readFileSync(FIXTURE, "utf8");
const sha = crypto.createHash("sha256").update(fs.readFileSync(FIXTURE)).digest("hex");
if (sha !== FIXTURE_SHA) {
  die(2, `Fixture sha256 drifted.\n   got ${sha}\n   exp ${FIXTURE_SHA}\n` +
         `   The expectations below were measured against the pinned bytes. Re-measure\n` +
         `   before trusting them.`);
}
console.log(`fixture: ${path.basename(FIXTURE)}  ${fixture.length} bytes  sha256 ${sha.slice(0, 16)}…`);

console.log("\n── 0. the fixture still reproduces the defect ──");
const poisoned = poisonedLiteralCount(fixture);
ok("string literals carrying the comment token", poisoned === EXPECT.poisonedLiterals, `${poisoned} (expected ${EXPECT.poisonedLiterals})`);
if (poisoned === 0) die(2, "Fixture carries no poisoned literal — it cannot reproduce the bug. Gate is void.");

const clean = recipeC(fixture);
ok("derived clean twin has zero poisoned literals", poisonedLiteralCount(clean) === 0, String(poisonedLiteralCount(clean)));

for (const [name, LuaParserClass] of [["Companion", loadCompanion()], ["Overwolf", loadOverwolf()]]) {
  console.log(`\n── ${name} · ${name === "Companion" ? "src/services/luaParser.js" : "shared/luaParser.js"} ──`);

  // 1. NEGATIVE CONTROL — the old strategy must fail. This is the check that makes the
  //    rest of the gate mean anything.
  const oldOnPoison = parseWith(LuaParserClass, fixture, oldStrip);
  ok("NEGATIVE CONTROL: old stripper FAILS on the real file", !oldOnPoison.VelaraIntelDB,
     oldOnPoison.VelaraIntelDB ? "it parsed — fixture no longer reproduces the bug" : "VelaraIntelDB absent, as it must be");

  // 2. the shipped parser recovers the table
  const db = parseShipped(LuaParserClass, fixture).VelaraIntelDB;
  ok("shipped parser recovers VelaraIntelDB", !!db, db ? "present" : "ABSENT");
  if (db) {
    const mb = (db.mapBounds && typeof db.mapBounds === "object") ? db.mapBounds : {};
    ok("mapBounds uiMapID count", Object.keys(mb).length === EXPECT.uiMapIds, `${Object.keys(mb).length} (expected ${EXPECT.uiMapIds})`);
    for (const id of EXPECT.requiredUiMaps) ok(`uiMap ${id} present`, !!mb[id], mb[id] ? "yes" : "MISSING");
    ok(`uiMap ${EXPECT.knownAbsentUiMap} still absent (Voidscar f3, never captured)`, !mb[EXPECT.knownAbsentUiMap],
       mb[EXPECT.knownAbsentUiMap] ? "APPEARED — re-measure, do not silence" : "absent, as expected");
    ok("uploaderIdentity", db.uploaderIdentity === EXPECT.uploaderIdentity, JSON.stringify(db.uploaderIdentity));
    ok("races", db.races && Object.keys(db.races).length === EXPECT.races, db.races ? Object.keys(db.races).length : "ABSENT");
    ok("playerTalentString", !!db.playerTalentString, db.playerTalentString ? "present" : "ABSENT");
  }

  // 3. ADDITIVE — on a file with nothing poisoned, old and new must agree exactly.
  //    Without this the fix could be "works on the fixture, changes everything else".
  const oldClean = JSON.stringify(parseWith(LuaParserClass, clean, oldStrip));
  const newClean = JSON.stringify(parseShipped(LuaParserClass, clean));
  ok("ADDITIVE: old and new agree on an unpoisoned file", oldClean === newClean,
     oldClean === newClean ? `identical (${newClean.length} chars)` : `DIVERGED (${oldClean.length} vs ${newClean.length})`);

  // 4. the comment stripper still strips actual comments
  const probe = 'A = {\n  ["x"] = 1, -- a real line comment\n  --[[ a real block comment ]]\n  ["y"] = "keeps -- this",\n}\n';
  const pr = parseShipped(LuaParserClass, probe).A;
  ok("real line + block comments still stripped", !!pr && pr.x === 1 && pr.y === "keeps -- this",
     pr ? `x=${pr.x} y=${JSON.stringify(pr.y)}` : "parse failed");
}

console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `⛔ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
