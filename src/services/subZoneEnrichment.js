// ─────────────────────────────────────────────────────────────────────────────
//  subZoneEnrichment.js — D206 LATE ENRICHMENT
//
//  ⛔ THIS FILE EXISTS TWICE, ON PURPOSE, IN TWO REPOSITORIES:
//        VelaraIntel-Companion/src/services/subZoneEnrichment.js
//        VelaraIntel-Overwolf/shared/subZoneEnrichment.js
//     They are separate git repos, so a shared import is not possible. Keep the
//     LOGIC identical and change both together — a fix in one is a bug in the
//     other, and the "Deadliest Areas" panel cannot tell you which client an
//     upload came from.
//
//  ── WHY ────────────────────────────────────────────────────────────────────
//  The addon records subZone on each death at the moment of death. We build
//  deaths from the combat log, which has no spatial context, and copy subZone
//  across by matching timestamps.
//
//  That copy CANNOT work at upload time. WoW flushes SavedVariables to disk
//  only on logout or /reload — never during play — and we upload seconds after
//  the key ends. Measured on run 2825-1788174653-0decaa71: the newest SV
//  snapshot available at upload was written 8.8 minutes BEFORE the run started,
//  and the addon's record of that run (subZone "The Heart of Rage") first
//  reached disk TWELVE MINUTES AFTER the payload was already stored.
//
//  The join is not broken. For that run's death, addon deathSec*1000 and parser
//  deathTs differ by 650 ms — well inside the ±2000 ms window. The epoch is
//  right, the window is right, the capture is right. The data is simply not on
//  disk yet.
//
//  So: remember which uploaded deaths are missing subZone, and when a LATER SV
//  snapshot arrives carrying them, send them to the backend, which patches the
//  stored run through its existing allow-listed backfill.
//
//  ⛔ Widening the window would NOT help and would start matching the wrong
//     deaths. Delaying the upload would not help either. Do neither.
//
//  ── PORTABILITY ────────────────────────────────────────────────────────────
//  No require()s. Both dependencies are injected, because the two hosts have
//  different HTTP stacks (Electron: node https; Overwolf: browser fetch):
//    post(path, bodyObject) -> Promise<{ok, status, body}>
//    log(level, event, data) -> void        ("info" | "warn" | "error")
// ─────────────────────────────────────────────────────────────────────────────

// Same window the in-process stamp uses. Not a tuning knob — see above.
const MATCH_WINDOW_MS = 2000;

// A session does not upload unbounded runs. Bounds memory if a /reload never
// comes; oldest is dropped first.
const MAX_PENDING_RUNS = 50;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Deaths live in pulls[] and/or combatSegments[] depending on which side built
// the payload. Read BOTH and de-duplicate by (name, deathTs) — the same death
// commonly appears in both containers, and counting it twice would make
// "3 deaths missing subZone" report 6.
function collectPayloadDeaths(payload) {
  const run = (payload && payload.run) || payload || {};
  const seen = new Set();
  const out = [];
  for (const containerKey of ["pulls", "combatSegments"]) {
    const segs = run[containerKey] || [];
    if (!Array.isArray(segs)) continue;
    for (const seg of segs) {
      for (const d of ((seg && seg.deaths) || [])) {
        if (!d || typeof d !== "object") continue;
        const name = d.name;
        const deathTs = d.deathTs;
        if (!isNonEmptyString(name) || typeof deathTs !== "number") continue;
        const key = name + "@" + deathTs;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, deathTs, subZone: d.subZone });
      }
    }
  }
  return out;
}

// Every addon-side death that carries a subZone, from the whole SavedVariables
// DB. ⚠ Deliberately NOT limited to _activeRun: by the time a snapshot reaches
// disk the run has ended and the addon has moved it into `runs`, so reading
// only _activeRun is reading the one place the finished run is not.
function collectAddonSubZoneDeaths(db) {
  const out = [];
  const containers = [];

  if (db && db._activeRun) containers.push(db._activeRun);
  const runs = (db && db.runs) || null;
  if (Array.isArray(runs)) {
    for (const r of runs) if (r) containers.push(r);
  } else if (runs && typeof runs === "object") {
    for (const k of Object.keys(runs)) if (runs[k]) containers.push(runs[k]);
  }

  for (const r of containers) {
    const segs = r.segments || r.combatSegments || [];
    if (!Array.isArray(segs)) continue;
    for (const seg of segs) {
      for (const ad of ((seg && seg.deaths) || [])) {
        if (!ad || typeof ad !== "object") continue;
        if (!isNonEmptyString(ad.subZone)) continue;
        if (typeof ad.deathSec !== "number") continue;
        out.push({ tsMs: ad.deathSec * 1000, subZone: ad.subZone.trim() });
      }
    }
  }
  return out;
}

// The addon death record carries unitToken/role/class — it has NO character
// name. So the NAME always comes from our own parser side; the addon supplies
// only the subZone, selected by nearest timestamp. This mirrors the in-process
// stamp exactly rather than inventing a second matching rule.
function matchSubZone(addonDeaths, deathTs) {
  let best = "";
  let bestDt = Infinity;
  for (const ad of addonDeaths) {
    const dt = Math.abs(ad.tsMs - deathTs);
    if (dt < bestDt && dt <= MATCH_WINDOW_MS) {
      bestDt = dt;
      best = ad.subZone;
    }
  }
  return best ? { subZone: best, deltaMs: bestDt } : null;
}

function createSubZoneEnricher(deps) {
  const post = deps && deps.post;
  const log = (deps && deps.log) || function () {};
  if (typeof post !== "function") {
    throw new Error("createSubZoneEnricher requires a post(path, body) function");
  }

  // runToken -> [{name, deathTs}] still missing subZone.
  const pending = new Map();
  // How many times recordUpload has been reached this process. This is the
  // field that separates "the queue drained" from "nobody ever called me".
  let recordCalls = 0;

  function recordUpload(runToken, payload) {
    // ⛔ Emitted on ENTRY, before any branch, and deliberately NOT conditional
    // on the outcome. The D206 failure was that nothing ever CALLED this on two
    // of the three upload paths. The only trace was subzone.enrich.idle later
    // reporting an empty queue — truthful, and it read as "nothing to do" when
    // it meant "nobody told me". An upload.result with no `registered` after it
    // names that in a single read.
    recordCalls += 1;
    log("info", "subzone.enrich.registered", {
      runToken: isNonEmptyString(runToken) ? runToken : null,
      builderSource: (payload && payload._builderSource)
        || (payload && payload.run && payload.run._builderSource) || "unknown",
      queuedBefore: pending.size,
    });
    if (!isNonEmptyString(runToken) || runToken.indexOf("vr_") !== 0) {
      log("warn", "subzone.record.skipped", { reason: "no usable runToken", runToken: runToken || null });
      return 0;
    }
    const all = collectPayloadDeaths(payload);
    const missing = all.filter((d) => !isNonEmptyString(d.subZone))
                       .map((d) => ({ name: d.name, deathTs: d.deathTs }));

    if (all.length === 0) {
      log("info", "subzone.record.none", { runToken, reason: "run has no deaths" });
      return 0;
    }
    if (missing.length === 0) {
      // Every death already carries subZone. Nothing to enrich later.
      log("info", "subzone.record.complete", { runToken, deaths: all.length });
      return 0;
    }

    if (pending.size >= MAX_PENDING_RUNS) {
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
      log("warn", "subzone.pending.evicted", { evicted: oldest, cap: MAX_PENDING_RUNS });
    }
    pending.set(runToken, missing);
    log("info", "subzone.record.pending", {
      runToken, deaths: all.length, missingSubZone: missing.length,
    });
    return missing.length;
  }

  // Call on EVERY successful SavedVariables parse.
  async function onSvParsed(db) {
    if (pending.size === 0) {
      // `queued` is 0 by construction in this branch; it is here because the
      // queue size belongs on the event that reports the queue. The field that
      // actually discriminates is recordedSinceStart — 0 means nothing ever
      // reached recordUpload (the 2026-09-03 bug), >0 means runs were queued
      // and have already drained.
      log("info", "subzone.enrich.idle", {
        reason: "no uploaded runs awaiting subZone",
        queued: pending.size,
        recordedSinceStart: recordCalls,
      });
      return { attempted: 0, written: 0 };
    }

    const addonDeaths = collectAddonSubZoneDeaths(db);
    if (addonDeaths.length === 0) {
      // ⛔ Distinct from "matched nothing". This says the SNAPSHOT carried no
      // subZone at all, which is the normal state until the player /reloads.
      log("info", "subzone.enrich.no_addon_deaths", {
        pendingRuns: pending.size,
        reason: "SV snapshot carries no deaths with subZone yet (expected before a /reload)",
      });
      return { attempted: 0, written: 0 };
    }

    let attempted = 0;
    let written = 0;

    for (const [runToken, deaths] of Array.from(pending.entries())) {
      const matched = [];
      let closestMiss = Infinity;
      for (const d of deaths) {
        const hit = matchSubZone(addonDeaths, d.deathTs);
        if (hit) matched.push({ name: d.name, deathTs: d.deathTs, subZone: hit.subZone });
        else {
          for (const ad of addonDeaths) {
            const dt = Math.abs(ad.tsMs - d.deathTs);
            if (dt < closestMiss) closestMiss = dt;
          }
        }
      }

      if (matched.length === 0) {
        // ⛔ The third branch, and the one that used to be invisible. Reporting
        // the CLOSEST delta turns "it did not match" into a number someone can
        // act on: a clean multiple of 3600000 is a timezone bug, a few seconds
        // is drift, Infinity means there was nothing to compare against.
        log("warn", "subzone.enrich.no_match", {
          runToken,
          pendingDeaths: deaths.length,
          addonDeathsWithSubZone: addonDeaths.length,
          closestDeltaMs: Number.isFinite(closestMiss) ? closestMiss : null,
          windowMs: MATCH_WINDOW_MS,
        });
        continue;
      }

      attempted += matched.length;
      let res;
      try {
        res = await post(`/v1/runs/${encodeURIComponent(runToken)}/death-subzones`,
                         { deaths: matched });
      } catch (err) {
        log("error", "subzone.enrich.post_threw", {
          runToken, sent: matched.length, error: (err && err.message) || String(err),
        });
        continue;   // keep it pending; a later snapshot retries
      }

      if (!res || !res.ok) {
        log("warn", "subzone.enrich.post_failed", {
          runToken, sent: matched.length,
          status: (res && res.status) || null,
          error: (res && res.error) || null,
        });
        continue;   // keep it pending
      }

      const body = (res && res.body) || {};
      const wrote = typeof body.written === "number" ? body.written : null;
      written += wrote || 0;
      log("info", "subzone.enrich.posted", {
        runToken, sent: matched.length, written: wrote,
        aggregates: body.aggregates || null,
      });

      // Drop the deaths we just sent. The server refuses to overwrite a value
      // that is already present, so re-sending is harmless — but retrying
      // forever would spam a POST on every snapshot for the rest of the session.
      const sentKeys = new Set(matched.map((m) => m.name + "@" + m.deathTs));
      const left = deaths.filter((d) => !sentKeys.has(d.name + "@" + d.deathTs));
      if (left.length === 0) pending.delete(runToken);
      else pending.set(runToken, left);
    }

    return { attempted, written };
  }

  return {
    recordUpload,
    onSvParsed,
    _pendingCount: () => pending.size,
    _pendingFor: (t) => (pending.get(t) || []).slice(),
  };
}

// CommonJS for Electron; plain window global for the Overwolf browser context,
// which loads shared/ modules with <script src> and has no module system.
// ⚠ Both branches are required — the Overwolf copy is the SAME file, and a
// CommonJS-only export would leave it defining nothing there while still
// loading without error.
const _subZoneExports = {
  createSubZoneEnricher,
  collectPayloadDeaths,
  collectAddonSubZoneDeaths,
  matchSubZone,
  MATCH_WINDOW_MS,
};
if (typeof module !== "undefined" && module.exports) {
  module.exports = _subZoneExports;
}
if (typeof window !== "undefined") {
  window.createSubZoneEnricher = createSubZoneEnricher;
  window.VelaraSubZoneEnrichment = _subZoneExports;
}
