// Gate for subZoneEnrichment.js (D206). Runs the REAL production payload for
// run 2825-1788174653-0decaa71 and the REAL addon SavedVariables shape.
//
//   node src/services/_test_subZoneEnrichment.js <path-to-run1.json>
//
// ⛔ Keep in step with VelaraIntel-Overwolf/shared/subZoneEnrichment.js.

const fs = require("fs");
const {
  createSubZoneEnricher, collectPayloadDeaths, collectAddonSubZoneDeaths, matchSubZone,
} = require("./subZoneEnrichment");

const results = [];
function check(name, ok, detail) {
  results.push([name, ok]);
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "   " + detail : ""));
}

const payloadPath = process.argv[2];
if (!payloadPath) { console.error("usage: node _test_subZoneEnrichment.js <run.json>"); process.exit(2); }
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));

// ── the real numbers this was built from ──────────────────────────────────
const DEATH_TS = 1788175657650;     // parser side, from the stored payload
const DEATH_SEC = 1788175657;       // addon side, from the real SavedVariables
const SUBZONE = "The Heart of Rage";

const deaths = collectPayloadDeaths(payload);
check("reading control: the real payload yields exactly its 1 death",
      deaths.length === 1, JSON.stringify(deaths));
check("that death is the one measured, and has NO subZone",
      deaths.length === 1 && deaths[0].deathTs === DEATH_TS && !deaths[0].subZone,
      deaths.length ? JSON.stringify(deaths[0]) : "");

// The addon SV shape, as it actually is on disk: `runs` (not _activeRun),
// combatSegments, and a death with subZone + deathSec but NO name.
const svAfterReload = {
  runs: [{
    combatSegments: [{
      deaths: [{ role: "dps", class: "Warrior", unitToken: "party2",
                 subZone: SUBZONE, deathSec: DEATH_SEC }],
    }],
  }],
};
const svBeforeReload = { runs: [{ combatSegments: [{ deaths: [] }] }] };

const addon = collectAddonSubZoneDeaths(svAfterReload);
check("addon deaths are read from `runs`, not just _activeRun",
      addon.length === 1 && addon[0].subZone === SUBZONE, JSON.stringify(addon));

const m = matchSubZone(addon, DEATH_TS);
check("the real pair matches, and the delta is the measured 650 ms",
      !!m && m.deltaMs === 650, JSON.stringify(m));
check("a death 3 s outside the window does NOT match",
      matchSubZone(addon, DEATH_TS + 3000) === null);

// ── the enricher, with a fake transport ───────────────────────────────────
function makeEnricher(postImpl) {
  const posts = [];
  const logs = [];
  const e = createSubZoneEnricher({
    post: (path, body) => { posts.push({ path, body }); return postImpl(path, body); },
    log: (level, event, data) => logs.push({ level, event, data }),
  });
  return { e, posts, logs };
}
const OK = () => Promise.resolve({ ok: true, status: 200, body: { written: 1, aggregates: "reapplied" } });

(async () => {
  // 1. the whole sequence, in order
  let h = makeEnricher(OK);
  h.e.recordUpload("vr_VDbN3aCI0V", payload);
  check("upload with a missing subZone is recorded as pending",
        h.e._pendingCount() === 1);

  let r = await h.e.onSvParsed(svBeforeReload);
  check("BEFORE /reload: nothing is posted",
        h.posts.length === 0 && r.attempted === 0);
  check("BEFORE /reload: the reason is logged as no_addon_deaths, not silence",
        h.logs.some((l) => l.event === "subzone.enrich.no_addon_deaths"),
        h.logs.map((l) => l.event).join(","));

  r = await h.e.onSvParsed(svAfterReload);
  check("AFTER /reload: exactly one POST",
        h.posts.length === 1, JSON.stringify(h.posts.map((p) => p.path)));
  check("the POST body carries name from the PARSER and subZone from the ADDON",
        h.posts[0].body.deaths.length === 1 &&
        h.posts[0].body.deaths[0].subZone === SUBZONE &&
        h.posts[0].body.deaths[0].name === deaths[0].name &&
        h.posts[0].body.deaths[0].deathTs === DEATH_TS,
        JSON.stringify(h.posts[0].body));
  check("the run is dropped from pending once sent",
        h.e._pendingCount() === 0);

  // ⛔ The control that can actually fail: a SECOND snapshot must not re-POST.
  await h.e.onSvParsed(svAfterReload);
  check("a later snapshot does NOT post again (no double-apply from the client)",
        h.posts.length === 1, "posts=" + h.posts.length);

  // 2. /reload BEFORE upload — the directive's control. The payload already
  //    carries subZone, so nothing is pending and nothing is ever sent.
  h = makeEnricher(OK);
  const enriched = JSON.parse(JSON.stringify(payload));
  for (const seg of enriched.run.pulls) for (const d of (seg.deaths || [])) d.subZone = SUBZONE;
  for (const seg of enriched.run.combatSegments) for (const d of (seg.deaths || [])) d.subZone = SUBZONE;
  h.e.recordUpload("vr_VDbN3aCI0V", enriched);
  await h.e.onSvParsed(svAfterReload);
  check("/reload BEFORE upload: nothing pending, nothing posted (identical output)",
        h.e._pendingCount() === 0 && h.posts.length === 0);
  check("and it says so — record.complete, not silence",
        h.logs.some((l) => l.event === "subzone.record.complete"));

  // 3. failure keeps it pending and retries on the next snapshot
  let fail = true;
  h = makeEnricher(() => fail ? Promise.resolve({ ok: false, status: 500 }) : OK());
  h.e.recordUpload("vr_VDbN3aCI0V", payload);
  await h.e.onSvParsed(svAfterReload);
  check("a failed POST is logged and the run stays pending",
        h.e._pendingCount() === 1 && h.logs.some((l) => l.event === "subzone.enrich.post_failed"));
  fail = false;
  await h.e.onSvParsed(svAfterReload);
  check("the next snapshot retries and succeeds",
        h.posts.length === 2 && h.e._pendingCount() === 0);

  // 4. a throwing transport must not take the app down
  h = makeEnricher(() => { throw new Error("boom"); });
  h.e.recordUpload("vr_VDbN3aCI0V", payload);
  let threw = false;
  try { await h.e.onSvParsed(svAfterReload); } catch { threw = true; }
  check("a throwing transport is caught, logged, and left pending",
        !threw && h.e._pendingCount() === 1 &&
        h.logs.some((l) => l.event === "subzone.enrich.post_threw"));

  // 5. no-match branch reports the delta rather than saying nothing
  h = makeEnricher(OK);
  h.e.recordUpload("vr_VDbN3aCI0V", payload);
  const skewed = { runs: [{ combatSegments: [{ deaths: [
    { subZone: SUBZONE, deathSec: DEATH_SEC + 4 * 3600 },   // +4h, a timezone bug
  ] }] }] };
  await h.e.onSvParsed(skewed);
  const nm = h.logs.find((l) => l.event === "subzone.enrich.no_match");
  // The real pair is 650 ms apart, so a +4h skew lands at 4h MINUS 650 ms, not
  // exactly 4h. Asserting the round number would be asserting a fiction; what
  // matters is that a human reading the number sees "about four hours".
  const FOUR_H = 4 * 3600 * 1000;
  check("no-match logs the CLOSEST delta, so a timezone bug is visible as ~4h",
        !!nm && Math.abs(nm.data.closestDeltaMs - FOUR_H) < 1000,
        nm ? nm.data.closestDeltaMs + " ms (" + (nm.data.closestDeltaMs / 3600000).toFixed(3) + " h)" : "no no_match log");

  // 6. every branch is a vlog event
  const events = new Set(h.logs.concat(makeEnricher(OK).logs).map((l) => l.event));
  check("no branch uses console-only output (all events are structured)",
        Array.from(events).every((e) => e.indexOf("subzone.") === 0),
        Array.from(events).join(","));

  const failed = results.filter(([, ok]) => !ok);
  console.log("");
  console.log("=== " + (results.length - failed.length) + "/" + results.length + " PASS ===");
  process.exit(failed.length ? 1 : 0);
})();
