// runAssembler.js — V1.2
// Velara Intelligence — Contract Construction Layer
//
// Takes three inputs:
//   addonRun              — addon SavedVariables run object (V1.2 schema)
//   parsedCombatEvidence  — output from combatLogParser.js
//   resolvedPulls         — array of resolvePull() outputs from packResolver.js
//
// Produces one output:
//   A valid, internally consistent V1.2 upload payload.
//
// Assembly pipeline (11 explicit passes):
//   Pass 1  — Normalize run envelope
//   Pass 2  — Normalize enemy registry
//   Pass 3  — Construct final pull objects
//   Pass 4  — Assign evidence objects to pulls
//   Pass 5  — Enrich anchor-bearing child objects
//   Pass 6  — Compute first-death fields
//   Pass 7  — Build wipe objects
//   Pass 8  — Build death chains
//   Pass 9  — Normalize damage buckets
//   Pass 10 — Finalize capability flags
//   Pass 11 — Final integrity validation
//
// What this file does NOT do:
//   - Classify death causes
//   - Compute mitigation gaps
//   - Decide hardest pull
//   - Compute pull severity (backend product)
//   - Derive coaching summaries
//   - Shape for frontend convenience
//
// Spike definition (factual only):
//   A spike is a single damage event exceeding SPIKE_THRESHOLD_ABSOLUTE (80,000)
//   or any single hit representing >= SPIKE_THRESHOLD_PCT (40%) of a player's
//   estimated health pool. Parser emits these; assembler attaches them.
//   Spikes are evidence, not judgments.

"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────

const ADDON_NAME    = "VelaraIntel";
const PAYLOAD_V     = "1.0.0";
const WIPE_DEATH_COUNT = 5; // all 5 players dead = wipe per V1.2 contract

// ─── ID generators ───────────────────────────────────────────────────────────

function pullId(runId, index)      { return `${runId}-p${index}`; }
function wipeId(runId, pullIndex)  { return `${runId}-p${pullIndex}-w1`; }
function bucketId(pullId, bIdx)    { return `${pullId}-b${String(bIdx).padStart(3, "0")}`; }

// ─── Null-safe anchor clone ───────────────────────────────────────────────────

function cloneAnchor(anchor) {
  if (!anchor) return { x: 50.0, y: 50.0 };
  return { x: anchor.x ?? 50.0, y: anchor.y ?? 50.0 };
}

// ─── Main assembler ───────────────────────────────────────────────────────────

/**
 * assembleRunPayload({ addonRun, parsedCombatEvidence, resolvedPulls, options })
 *
 * @param {object}   addonRun             V1.2 addon run object
 * @param {object}   parsedCombatEvidence parseCombatLog() output
 * @param {object[]} resolvedPulls        Array of resolvePull() outputs, one per pull
 * @param {object}   options              { dev: boolean } — dev enables diagnostics
 *
 * @returns {{ ok: boolean, payload?: object, errors?: string[], diagnostics?: object }}
 */
function assembleRunPayload({ addonRun, parsedCombatEvidence, resolvedPulls, options = {} }) {
  const DEV = options.dev === true;

  // Assembler diagnostics (available in dev mode)
  const diag = {
    unmatchedDeaths          : [],
    unmatchedBuckets         : [],
    unmatchedCooldownEvents  : [],
    unmatchedEnemyCasts      : [],
    unmatchedInterrupts      : [],
    unmatchedSpikes          : [],
    pullsWithFallbackAnchors : [],
    pullsWithLowPackConfidence: [],
    integrityWarnings        : [],
  };

  const pce = parsedCombatEvidence || {};
  const run = addonRun             || {};

  // ── Pass 1: Normalize run envelope ─────────────────────────────────────────

  const runId      = run.runId       || "unknown-run";
  const startTs    = run.startTs     || 0;
  const finishTs   = run.finishTs    || 0;
  const durationMs = finishTs > startTs ? finishTs - startTs : 0;

  const payload = {
    addon               : ADDON_NAME,
    v                   : PAYLOAD_V,
    uploadTs            : Date.now(),
    clockOffsetMs       : pce.clockOffsetMs       ?? null,
    clockSyncConfidence : pce.clockSyncConfidence ?? "unknown",
    run: {
      runId        : runId,
      mapId        : run.mapId        || 0,
      dungeonName  : run.dungeonName  || "",
      keyLevel     : run.keyLevel     || 0,
      affixes      : Array.isArray(run.affixes) ? [...run.affixes] : [],
      startTs,
      finishTs,
      durationMs,
      runType      : run.runType      || "private",
      addonVersion : run.addonVersion || "unknown",
      exportVersion: run.exportVersion|| "1.0.0",
      telemetryCapabilities: {
        hasCombatSegments       : false,
        hasEnemyRegistry        : false,
        hasPartySnapshot        : false,
        hasDeathContext         : false,
        hasDamageBuckets        : false,
        hasEnemyCasts           : false,
        hasInterrupts           : false,
        hasEnemyHealthSnapshots : false,
        hasEnemyPositions       : false,
      },
      player       : normalizePlayer(run.player),
      partyMembers : normalizePartyMembers(run.partyMembers),
      pulls        : [],
      enemyRegistry: [],
      damageBuckets: [],
      wipes        : [],
    },
  };

  const R = payload.run; // shorthand

  // ── Pass 2: Normalize enemy registry ───────────────────────────────────────

  if (Array.isArray(run.enemyRegistry)) {
    R.enemyRegistry = run.enemyRegistry.map(e => ({
      guid               : e.guid                || "",
      npcId              : e.npcId               || null,
      npcName            : e.npcName             || null,
      isBoss             : e.isBoss              ?? false,
      firstSeenTs        : e.firstSeenTs         || null,
      lastSeenTs         : e.lastSeenTs          || null,
      combatFirstSeenTs  : e.combatFirstSeenTs   || null,
      combatLastSeenTs   : e.combatLastSeenTs    || null,
      firstSeenSegmentId : e.firstSeenSegmentId  || null,
      seenSegmentIds     : Array.isArray(e.seenSegmentIds) ? [...e.seenSegmentIds] : [],
    }));
  }

  // ── Pass 3: Construct final pull objects ────────────────────────────────────

  // Build segment → pull index map
  // Each resolvedPull corresponds to one final pull.
  // resolvedPulls are already ordered by pull index.
  const segmentToPullIdx = new Map(); // segmentId → pull array index (0-based)
  const addonSegments    = run.combatSegments || [];

  // Map from segmentId → addon segment object
  const segmentMap = new Map();
  for (const seg of addonSegments) {
    segmentMap.set(seg.segmentId, seg);
  }

  // If resolvedPulls was provided, use it directly.
  // Each resolvedPull must have: segmentIds[], packId, regionId, floor, anchor,
  //   anchorType, anchorPrecision, packMatchConfidence, enemyCount, npcIds
  // If resolvedPulls is empty/null, fall back to building pulls directly from combatSegments.

  const pullSources = resolvedPulls && resolvedPulls.length > 0
    ? resolvedPulls
    : buildPullsFromSegments(addonSegments, run.runId);

  for (let i = 0; i < pullSources.length; i++) {
    const src      = pullSources[i];
    const pIdx     = i + 1; // 1-based pull index
    const pid      = pullId(runId, pIdx);
    const segIds   = src.segmentIds || (src.segmentId ? [src.segmentId] : []);

    // Map all this pull's segmentIds to this pull index
    for (const sid of segIds) {
      segmentToPullIdx.set(sid, i);
    }

    // Timing: use the earliest segment startTs and latest finishTs
    let pullStartTs  = src.startTs  || 0;
    let pullFinishTs = src.finishTs || 0;
    if (!pullStartTs || !pullFinishTs) {
      for (const sid of segIds) {
        const seg = segmentMap.get(sid);
        if (seg) {
          if (!pullStartTs  || seg.startTs  < pullStartTs)  pullStartTs  = seg.startTs;
          if (!pullFinishTs || seg.finishTs > pullFinishTs) pullFinishTs = seg.finishTs;
        }
      }
    }

    const pullDurationMs = pullFinishTs > pullStartTs ? pullFinishTs - pullStartTs : 0;

    // Outcome: default "clear", override if wipe detected later (Pass 7)
    const rawOutcome = segIds.length > 0
      ? (segmentMap.get(segIds[0])?.rawOutcome || "unknown")
      : "unknown";
    const outcome = rawOutcome === "zone_change" ? "wipe" : "clear";

    const pullObj = {
      pullId              : pid,
      index               : pIdx,
      startTs             : pullStartTs,
      finishTs            : pullFinishTs,
      durationMs          : pullDurationMs,
      outcome             : outcome,
      segmentIds          : [...segIds],
      pullDetectionMethod : src.pullDetectionMethod || "regen_boundary",
      pullConfidence      : src.pullConfidence      ?? 0.9,
      npcIds              : Array.isArray(src.npcIds) ? [...src.npcIds]
                          : collectNpcIds(segIds, segmentMap),
      packId              : src.packId              || null,
      packMatchConfidence : src.packMatchConfidence ?? 0,
      anchor              : cloneAnchor(src.anchor),
      anchorType          : src.anchorType          || "unknown",
      anchorPrecision     : src.anchorPrecision     || "fallback",
      floor               : src.floor               || null,
      regionId            : src.regionId            || null,
      enemyCount          : src.enemyCount          ?? 0,
      deaths              : [],
      deathChain          : null,
      cooldownEvents      : [],
      spikes              : [],
      enemyCasts          : [],
      interrupts          : [],
      enemyHealthSnapshots: [],
      firstDeathId        : null,
      firstDeathRole      : null,
      timeToFirstDeathMs  : null,
      wipeId              : null,
    };

    R.pulls.push(pullObj);

    // Track fallback/low-confidence for diagnostics
    if (DEV) {
      if (pullObj.anchorType !== "pack_centroid") {
        diag.pullsWithFallbackAnchors.push(pid);
      }
      if (pullObj.packMatchConfidence < 0.40) {
        diag.pullsWithLowPackConfidence.push(pid);
      }
    }
  }

  // Build pullId lookup map
  const pullById = new Map();
  for (const p of R.pulls) pullById.set(p.pullId, p);

  // Helper: resolve segmentId → pull object
  function pullForSegment(segmentId) {
    const idx = segmentToPullIdx.get(segmentId);
    return idx != null ? R.pulls[idx] : null;
  }

  // ── Pass 4: Assign evidence objects to pulls ────────────────────────────────

  const enrichedSegments = pce.enrichedSegments || [];

  // Build a flat evidence map from parser output
  const allDeaths       = [];
  const allCooldowns    = [];
  const allInterrupts   = [];
  const allEnemyCasts   = [];
  const allSpikes       = [];
  const allBuckets      = [];
  const allHealthSnaps  = [];

  for (const eseg of enrichedSegments) {
    const pull = pullForSegment(eseg.segmentId);

    for (const d of (eseg.deaths         || [])) {
      d._targetPull = pull;
      allDeaths.push(d);
    }
    for (const c of (eseg.cooldownEvents || [])) {
      c._targetPull = pull;
      allCooldowns.push(c);
    }
    for (const it of (eseg.interrupts    || [])) {
      it._targetPull = pull;
      allInterrupts.push(it);
    }
    for (const ec of (eseg.enemyCasts    || [])) {
      ec._targetPull = pull;
      allEnemyCasts.push(ec);
    }
    for (const b of (eseg.damageBuckets  || [])) {
      b._targetPull = pull;
      allBuckets.push(b);
    }
    // Health snapshots (if present)
    for (const hs of (eseg.enemyHealthSnapshots || [])) {
      hs._targetPull = pull;
      allHealthSnaps.push(hs);
    }
  }

  // Attach deaths to pulls
  for (const d of allDeaths) {
    const pull = d._targetPull;
    if (!pull) {
      if (DEV) diag.unmatchedDeaths.push(d.deathId || "unknown");
      continue;
    }
    pull.deaths.push(d);
  }

  // Attach cooldowns
  for (const c of allCooldowns) {
    const pull = c._targetPull;
    if (!pull) {
      if (DEV) diag.unmatchedCooldownEvents.push(c.cooldownEventId || "unknown");
      continue;
    }
    pull.cooldownEvents.push(c);
  }

  // Attach interrupts
  for (const it of allInterrupts) {
    const pull = it._targetPull;
    if (!pull) {
      if (DEV) diag.unmatchedInterrupts.push(it.interruptId || "unknown");
      continue;
    }
    pull.interrupts.push(it);
  }

  // Attach enemy casts — also cross-reference interrupts to set interruptAttempted
  const interruptTargetGuids = new Set(
    allInterrupts
      .filter(it => it._targetPull)
      .map(it => `${it._targetPull.pullId}:${it.targetGuid}`)
  );

  for (const ec of allEnemyCasts) {
    const pull = ec._targetPull;
    if (!pull) {
      if (DEV) diag.unmatchedEnemyCasts.push(ec.enemyCastId || "unknown");
      continue;
    }
    // Set interruptAttempted if an interrupt targeted this enemy in this pull
    const key = `${pull.pullId}:${ec.enemyGuid}`;
    if (interruptTargetGuids.has(key)) ec.interruptAttempted = true;

    pull.enemyCasts.push(ec);
  }

  // Attach health snapshots
  for (const hs of allHealthSnaps) {
    const pull = hs._targetPull;
    if (!pull) continue;
    pull.enemyHealthSnapshots.push(hs);
  }

  // ── Pass 5: Enrich anchor-bearing child objects ──────────────────────────────

  // All anchor-bearing objects inherit pull anchor in V1 unless stronger evidence exists.
  for (const pull of R.pulls) {
    const pullAnchor  = cloneAnchor(pull.anchor);
    const pullFloor   = pull.floor;
    const pullRegion  = pull.regionId;
    const pullPackId  = pull.packId;

    function enrichSpatial(obj) {
      obj.anchor   = pullAnchor;
      obj.floor    = pullFloor;
      obj.regionId = pullRegion;
      if ("packId" in obj) obj.packId = pullPackId;
    }

    for (const d  of pull.deaths)               enrichSpatial(d);
    for (const c  of pull.cooldownEvents)        enrichSpatial(c);
    for (const ec of pull.enemyCasts)            enrichSpatial(ec);
    for (const it of pull.interrupts)            enrichSpatial(it);
    for (const hs of pull.enemyHealthSnapshots)  enrichSpatial(hs);
    // Spikes attached in Pass 9 — handled there
  }

  // ── Pass 6: Compute first-death fields ──────────────────────────────────────

  for (const pull of R.pulls) {
    if (pull.deaths.length === 0) continue;

    // Sort deaths chronologically
    pull.deaths.sort((a, b) => a.deathTs - b.deathTs);

    // Recompute offsetMs relative to pull start
    for (const d of pull.deaths) {
      d.offsetMs = pull.startTs > 0 ? d.deathTs - pull.startTs : d.offsetMs ?? 0;
      d.pullId   = pull.pullId;
    }

    const first = pull.deaths[0];
    first.firstDeathInPull = true;

    pull.firstDeathId      = first.deathId;
    pull.firstDeathRole    = first.role || null;
    pull.timeToFirstDeathMs = pull.startTs > 0
      ? first.deathTs - pull.startTs
      : null;

    // Enrich defensiveCastHistory per death
    // Look back through pull's cooldownEvents for each dead player's class defensives
    for (const death of pull.deaths) {
      death.defensiveCastHistory = buildDefensiveHistory(death, pull.cooldownEvents, pull.startTs);
    }
  }

  // ── Pass 7: Build wipe objects ───────────────────────────────────────────────

  for (const pull of R.pulls) {
    const deaths = pull.deaths;
    const isWipe = deaths.length >= WIPE_DEATH_COUNT;

    if (!isWipe) continue;

    pull.outcome = "wipe";

    const sortedDeaths = [...deaths].sort((a, b) => a.deathTs - b.deathTs);
    const firstDeath   = sortedDeaths[0];
    const lastDeath    = sortedDeaths[sortedDeaths.length - 1];
    const timeFromFirstDeathMs = lastDeath.deathTs - firstDeath.deathTs;

    // Mark firstDeathInWipe on the first death
    firstDeath.firstDeathInWipe = true;

    const wid = wipeId(runId, pull.index);
    pull.wipeId = wid;

    // Collapse confidence: rough heuristic — more deaths close together = higher confidence
    const collapseConfidence = timeFromFirstDeathMs < 10000 ? 0.95
                             : timeFromFirstDeathMs < 20000 ? 0.80
                             : 0.65;

    R.wipes.push({
      wipeId               : wid,
      pullId               : pull.pullId,
      wipeTs               : lastDeath.deathTs,
      deathIds             : sortedDeaths.map(d => d.deathId),
      firstDeathId         : firstDeath.deathId,
      firstDeathRole       : firstDeath.role || null,
      timeFromFirstDeathMs,
      anchor               : cloneAnchor(pull.anchor),
      floor                : pull.floor,
      regionId             : pull.regionId,
      packId               : pull.packId,
      collapseConfidence,
    });
  }

  // ── Pass 8: Build death chains ───────────────────────────────────────────────

  for (const pull of R.pulls) {
    if (pull.deaths.length === 0) {
      pull.deathChain = null;
      continue;
    }

    const sorted    = [...pull.deaths].sort((a, b) => a.deathTs - b.deathTs);
    const timeSpan  = sorted[sorted.length - 1].deathTs - sorted[0].deathTs;

    pull.deathChain = {
      totalDeaths: sorted.length,
      isWipe     : sorted.length >= WIPE_DEATH_COUNT,
      timeSpanMs : timeSpan,
      sequence   : sorted.map(d => ({
        deathId         : d.deathId,
        offsetMs        : d.offsetMs ?? 0,
        role            : d.role     || "unknown",
        class           : d.class    || "UNKNOWN",
        killingSpellName: d.killingBlow?.spellName || null,
      })),
    };
  }

  // ── Pass 9: Normalize damage buckets ────────────────────────────────────────

  // Spikes are also emitted from parser as part of the bucket damage evidence.
  // They live in enrichedSegments. We extract them here as spike objects and
  // attach to pulls.
  // Spikes definition: single damage event >= 80,000 OR >= 40% of approximate
  // player health pool. Parser is the source of spike evidence; assembler attaches.

  let spikeCounter = 0;

  for (const eseg of enrichedSegments) {
    const pull = pullForSegment(eseg.segmentId);
    if (!pull) continue;

    // Attach spikes if parser provided them
    for (const sp of (eseg.spikes || [])) {
      spikeCounter++;
      const spikeObj = {
        spikeId  : `${runId}-${pull.pullId}-sp${spikeCounter}`,
        pullId   : pull.pullId,
        spikeTs  : sp.spikeTs  || sp.normalizedTs || 0,
        offsetMs : sp.offsetMs ?? (pull.startTs > 0 ? (sp.spikeTs || 0) - pull.startTs : 0),
        damage   : sp.damage   || sp.amount || 0,
        role     : sp.role     || "unknown",
        anchor   : cloneAnchor(pull.anchor),
        floor    : pull.floor,
        regionId : pull.regionId,
      };
      pull.spikes.push(spikeObj);
    }
  }

  // Build run-level damageBuckets[]
  // Buckets come from parsedCombatEvidence enrichedSegments.
  // Assign pullId, build bucketId, enrich with spatial data from pull.

  let globalBucketIdx = 0;

  for (const b of allBuckets) {
    const pull = b._targetPull;
    if (!pull) {
      if (DEV) diag.unmatchedBuckets.push(`bucket@${b.bucketStartTs}`);
      continue;
    }
    globalBucketIdx++;

    const bIdx    = Math.floor((b.bucketStartTs - pull.startTs) / 1000);
    const bid     = bucketId(pull.pullId, bIdx);

    R.damageBuckets.push({
      bucketId             : bid,
      pullId               : pull.pullId,
      bucketStartTs        : b.bucketStartTs,
      bucketEndTs          : b.bucketEndTs,
      durationMs           : b.durationMs || 1000,
      partyDamageTaken     : b.partyDamageTaken      || 0,
      tankDamageTaken      : b.tankDamageTaken        || 0,
      healerDamageTaken    : b.healerDamageTaken      || 0,
      dpsDamageTaken       : b.dpsDamageTaken         || 0,
      partyHealingReceived : b.partyHealingReceived   || 0,
      tankHealingReceived  : b.tankHealingReceived    || 0,
      deathCountInBucket   : b.deathCountInBucket     || 0,
      anchor               : cloneAnchor(pull.anchor),
      floor                : pull.floor,
      regionId             : pull.regionId,
    });
  }

  // ── Pass 10: Finalize capability flags ───────────────────────────────────────

  const caps = R.telemetryCapabilities;

  caps.hasCombatSegments      = addonSegments.length > 0;
  caps.hasEnemyRegistry       = R.enemyRegistry.length > 0;
  caps.hasPartySnapshot       = !!R.player?.class && Array.isArray(R.partyMembers);
  caps.hasDeathContext        = R.pulls.some(p =>
    p.deaths.some(d => d.killingBlow != null || d.preDeathHits?.length > 0)
  );
  caps.hasDamageBuckets       = R.damageBuckets.length > 0;
  caps.hasEnemyCasts          = R.pulls.some(p => p.enemyCasts.length > 0);
  caps.hasInterrupts          = R.pulls.some(p => p.interrupts.length > 0);
  caps.hasEnemyHealthSnapshots = R.pulls.some(p => p.enemyHealthSnapshots.length > 0);
  caps.hasEnemyPositions      = false; // never true in V1

  // ── Pass 11: Final integrity validation ─────────────────────────────────────

  const errors = validatePayload(payload, diag, DEV);

  if (errors.length > 0) {
    return {
      ok          : false,
      errors,
      diagnostics : DEV ? diag : undefined,
    };
  }

  // Strip internal _targetPull references before returning
  stripInternalFields(payload);

  return {
    ok          : true,
    payload,
    diagnostics : DEV ? diag : undefined,
  };
}

// ─── Validation (Pass 11) ─────────────────────────────────────────────────────

function validatePayload(payload, diag, DEV) {
  const errors = [];
  const R      = payload.run;

  // Run timing sanity
  if (R.startTs <= 0)   errors.push("run.startTs is missing or zero");
  if (R.finishTs <= 0)  errors.push("run.finishTs is missing or zero");
  if (R.finishTs > 0 && R.startTs > 0 && R.finishTs <= R.startTs) {
    errors.push("run.finishTs must be greater than run.startTs");
  }

  const pullIds   = new Set(R.pulls.map(p => p.pullId));
  const deathIds  = new Set();

  for (const pull of R.pulls) {
    // Pull within run bounds (with 500ms tolerance)
    if (R.startTs && pull.startTs < R.startTs - 500) {
      if (DEV) diag.integrityWarnings.push(`Pull ${pull.pullId} startTs before run startTs`);
    }
    if (R.finishTs && pull.finishTs > R.finishTs + 500) {
      if (DEV) diag.integrityWarnings.push(`Pull ${pull.pullId} finishTs after run finishTs`);
    }

    // Anchor-bearing pull must have floor
    if (!pull.floor) {
      if (DEV) diag.integrityWarnings.push(`Pull ${pull.pullId} missing floor`);
    }

    // Deaths
    for (const d of pull.deaths) {
      if (!d.deathId) { errors.push(`Death in pull ${pull.pullId} missing deathId`); continue; }
      deathIds.add(d.deathId);

      // Death within pull bounds (500ms tolerance)
      if (pull.startTs && d.deathTs < pull.startTs - 500) {
        if (DEV) diag.integrityWarnings.push(`Death ${d.deathId} before pull start`);
      }
    }

    // wipeId reference
    if (pull.wipeId) {
      const wipeExists = R.wipes.some(w => w.wipeId === pull.wipeId);
      if (!wipeExists) errors.push(`pull.wipeId ${pull.wipeId} does not reference an existing wipe`);
    }

    // firstDeathId reference
    if (pull.firstDeathId && !deathIds.has(pull.firstDeathId)) {
      // Death might be registered later in iteration — check after loop
    }
  }

  // Cross-check firstDeathId after all deaths collected
  for (const pull of R.pulls) {
    if (pull.firstDeathId && !deathIds.has(pull.firstDeathId)) {
      errors.push(`pull.firstDeathId ${pull.firstDeathId} does not reference an existing death`);
    }
  }

  // Wipes reference valid pulls and deaths
  for (const wipe of R.wipes) {
    if (!pullIds.has(wipe.pullId)) {
      errors.push(`wipe.pullId ${wipe.pullId} does not reference an existing pull`);
    }
    for (const did of (wipe.deathIds || [])) {
      if (!deathIds.has(did)) {
        errors.push(`wipe.deathId ${did} does not reference an existing death`);
      }
    }
  }

  // Buckets reference valid pulls
  for (const b of R.damageBuckets) {
    if (!pullIds.has(b.pullId)) {
      errors.push(`damageBucket pullId ${b.pullId} does not reference an existing pull`);
    }
  }

  // No null required arrays
  if (!Array.isArray(R.pulls))        errors.push("run.pulls is not an array");
  if (!Array.isArray(R.enemyRegistry)) errors.push("run.enemyRegistry is not an array");
  if (!Array.isArray(R.damageBuckets)) errors.push("run.damageBuckets is not an array");
  if (!Array.isArray(R.wipes))         errors.push("run.wipes is not an array");

  return errors;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePlayer(player) {
  if (!player) return { class: "UNKNOWN", spec: null, role: "unknown" };
  return {
    class: player.class || "UNKNOWN",
    spec : player.spec  || null,
    role : player.role  || "unknown",
  };
}

function normalizePartyMembers(members) {
  if (!Array.isArray(members)) return [];
  return members.map(m => ({
    class          : m.class           || "UNKNOWN",
    spec           : m.spec            || null,
    role           : m.role            || "unknown",
    specConfidence : m.specConfidence  || "unknown",
  }));
}

// Collect NPC IDs from segment map if not provided by resolver
function collectNpcIds(segIds, segmentMap) {
  const ids = new Set();
  for (const sid of segIds) {
    const seg = segmentMap.get(sid);
    if (seg?.npcIds) seg.npcIds.forEach(id => ids.add(id));
  }
  return [...ids];
}

// Fallback: build minimal pull objects directly from addon combatSegments
// Used when packResolver hasn't been run yet (e.g. testing, placeholder M+ data)
function buildPullsFromSegments(segments, runId) {
  return segments.map((seg, i) => ({
    segmentIds          : [seg.segmentId],
    startTs             : seg.startTs    || 0,
    finishTs            : seg.finishTs   || 0,
    npcIds              : seg.npcIds     || [],
    enemyCount          : (seg.npcIds || []).length,
    packId              : null,
    regionId            : null,
    floor               : null,
    anchor              : { x: 50.0, y: 50.0 },
    anchorType          : "unknown",
    anchorPrecision     : "fallback",
    packMatchConfidence : 0,
    pullDetectionMethod : "regen_boundary",
    pullConfidence      : 0.5,
  }));
}

// Build defensive cast history for a death from pull's cooldown events
function buildDefensiveHistory(death, cooldownEvents, pullStartTs) {
  if (!death || !Array.isArray(cooldownEvents)) return [];

  // Filter to cooldowns belonging to the same player GUID
  const playerCDs = cooldownEvents.filter(c => c.sourceGuid === death.playerGuid);

  // Group by spellId — keep last cast before death
  const lastCastBySpell = new Map();
  for (const cd of playerCDs) {
    if (cd.castTs <= death.deathTs) {
      const existing = lastCastBySpell.get(cd.spellId);
      if (!existing || cd.castTs > existing.castTs) {
        lastCastBySpell.set(cd.spellId, cd);
      }
    }
  }

  return [...lastCastBySpell.values()].map(cd => ({
    spellId          : cd.spellId,
    spellName        : cd.spellName,
    lastCastTs       : cd.castTs,
    // Negative if cast happened before pull started (per V1.2 contract)
    lastCastOffsetMs : pullStartTs > 0 ? cd.castTs - pullStartTs : null,
  }));
}

// Strip internal assembly fields (_targetPull etc.) before returning payload
function stripInternalFields(payload) {
  const R = payload.run;
  for (const pull of R.pulls) {
    for (const arr of [
      pull.deaths, pull.cooldownEvents, pull.enemyCasts,
      pull.interrupts, pull.enemyHealthSnapshots, pull.spikes,
    ]) {
      for (const obj of arr) {
        delete obj._targetPull;
        delete obj.normalizedTs;
        delete obj.playerGuid; // strip GUID from upload (privacy)
        delete obj.sourceGuid;
      }
    }
  }
  for (const b of R.damageBuckets) {
    delete b._targetPull;
  }
  for (const w of R.wipes) {
    delete w._targetPull;
  }
}

// ─── RunAssembler class wrapper (used by Electron main.js) ──────────────────
class RunAssembler {
  constructor({ onReady } = {}) {
    this.onReady      = onReady || (() => {});
    this.isOpen       = false;
    this.currentRunID = null;
    this._addonRun    = null;
    this._pulls       = [];
  }
  openRun(addonRun) {
    this._addonRun    = addonRun;
    this._pulls       = [];
    this.isOpen       = true;
    this.currentRunID = addonRun?.runId || null;
  }
  addPull(pull) {
    if (!this.isOpen) return;
    this._pulls.push(pull);
  }
  closeRun() {
    if (!this.isOpen) return;
    this.isOpen = false;
    const result = assembleRunPayload({
      addonRun: this._addonRun,
      parsedCombatEvidence: { enrichedSegments: this._pulls },
      resolvedPulls: [],
      options: { dev: false },
    });
    this._addonRun    = null;
    this._pulls       = [];
    this.currentRunID = null;
    if (result.ok) this.onReady(result.payload);
    else console.error("[RunAssembler] Assembly failed:", result.errors);
  }
}

module.exports = { assembleRunPayload, RunAssembler };
