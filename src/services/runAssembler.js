// runAssembler.js — V1.2.1
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
//   Pass 3  — Construct final pull objects (now with encounter/boss fields)
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
// V1.2.1 changes:
//   - Boss encounter fields threaded into pull objects (isBossPull, encounterId,
//     encounterName, encounterStartOffsetMs, encounterEndOffsetMs)
//   - Encounter matching: if an ENCOUNTER_START/END overlaps the pull time range,
//     that pull is marked as a boss pull. Addon/companion owns encounter truth.
//     Backend consumes, may validate, but never infers.
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

// ─── Encounter Matching ───────────────────────────────────────────────────────

function buildEncounterList(addonRun) {
  const encounters = addonRun.encounterEvents || addonRun.encounters || [];
  if (!Array.isArray(encounters)) return [];

  return encounters
    .filter(e => e && (e.encounterId || e.id))
    .map(e => ({
      encounterId:   e.encounterId || e.id || 0,
      encounterName: e.encounterName || e.name || null,
      startTs:       e.startTs || e.startSec * 1000 || 0,
      endTs:         e.endTs   || e.endSec * 1000   || 0,
    }));
}

function matchEncounterToPull(pullStartTs, pullFinishTs, encounters) {
  if (!encounters || encounters.length === 0) return null;
  if (!pullStartTs || !pullFinishTs) return null;

  for (const enc of encounters) {
    if (!enc.startTs || !enc.endTs) continue;
    if (enc.startTs <= pullFinishTs && enc.endTs >= pullStartTs) {
      return enc;
    }
  }
  return null;
}

// ─── Main assembler ───────────────────────────────────────────────────────────

function assembleRunPayload({ addonRun, parsedCombatEvidence, resolvedPulls, options = {} }) {
  const DEV = options.dev === true;

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
    encounterMatches         : [],
  };

  const pce = parsedCombatEvidence || {};
  const run = addonRun             || {};

  const encounters = buildEncounterList(run);

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
      runId, mapId: run.mapId || 0, dungeonName: run.dungeonName || "",
      keyLevel: run.keyLevel || 0,
      affixes: Array.isArray(run.affixes) ? [...run.affixes] : [],
      startTs, finishTs, durationMs,
      runType: run.runType || "private",
      runMode: run.runMode || "standard",
      privacyMode: run.privacyMode || "shareable",
      addonVersion: run.addonVersion || "unknown",
      exportVersion: run.exportVersion || "1.0.0",
      telemetryCapabilities: {
        hasCombatSegments: false, hasEnemyRegistry: false, hasPartySnapshot: false,
        hasDeathContext: false, hasDamageBuckets: false, hasEnemyCasts: false,
        hasInterrupts: false, hasEnemyHealthSnapshots: false, hasEnemyPositions: false,
        hasEncounterData: encounters.length > 0,
      },
      player: normalizePlayer(run.player),
      partyMembers: normalizePartyMembers(run.partyMembers),
      equipmentRegistry: Array.isArray(run.equipmentRegistry) ? run.equipmentRegistry.map(e => ({
        spellId   : Number(e.spellId) || 0,
        spellName : String(e.spellName || ""),
        itemId    : Number(e.itemId) || 0,
        itemName  : String(e.itemName || ""),
        itemIcon  : String(e.itemIcon || ""),
        slot      : Number(e.slot) || 0,
        ownerName : String(e.ownerName || ""),
      })) : [],
      pulls: [], enemyRegistry: [], damageBuckets: [], wipes: [],
    },
  };

  const R = payload.run;

  // ── Pass 2: Normalize enemy registry ───────────────────────────────────────

  if (Array.isArray(run.enemyRegistry)) {
    R.enemyRegistry = run.enemyRegistry.map(e => ({
      guid: e.guid || "", npcId: e.npcId || null, npcName: e.npcName || null,
      isBoss: e.isBoss ?? false, firstSeenTs: e.firstSeenTs || null,
      lastSeenTs: e.lastSeenTs || null, combatFirstSeenTs: e.combatFirstSeenTs || null,
      combatLastSeenTs: e.combatLastSeenTs || null, firstSeenSegmentId: e.firstSeenSegmentId || null,
      seenSegmentIds: Array.isArray(e.seenSegmentIds) ? [...e.seenSegmentIds] : [],
    }));
  }

  // ── Pass 3: Construct final pull objects ────────────────────────────────────

  const segmentToPullIdx = new Map();
  const addonSegments = run.combatSegments || [];
  const segmentMap = new Map();
  for (const seg of addonSegments) segmentMap.set(seg.segmentId, seg);

  const pullSources = resolvedPulls && resolvedPulls.length > 0
    ? resolvedPulls : buildPullsFromSegments(addonSegments, run.runId);

  for (let i = 0; i < pullSources.length; i++) {
    const src = pullSources[i];
    const pIdx = i + 1;
    const pid = pullId(runId, pIdx);
    const segIds = src.segmentIds || (src.segmentId ? [src.segmentId] : []);

    for (const sid of segIds) segmentToPullIdx.set(sid, i);

    let pullStartTs = src.startTs || 0;
    let pullFinishTs = src.finishTs || 0;
    if (!pullStartTs || !pullFinishTs) {
      for (const sid of segIds) {
        const seg = segmentMap.get(sid);
        if (seg) {
          if (!pullStartTs || seg.startTs < pullStartTs) pullStartTs = seg.startTs;
          if (!pullFinishTs || seg.finishTs > pullFinishTs) pullFinishTs = seg.finishTs;
        }
      }
    }

    const pullDurationMs = pullFinishTs > pullStartTs ? pullFinishTs - pullStartTs : 0;
    const rawOutcome = segIds.length > 0 ? (segmentMap.get(segIds[0])?.rawOutcome || "unknown") : "unknown";
    const outcome = rawOutcome === "zone_change" ? "wipe" : "clear";

    // Encounter matching
    const matchedEncounter = matchEncounterToPull(pullStartTs, pullFinishTs, encounters);
    const isBossPull = matchedEncounter !== null;

    if (DEV && matchedEncounter) {
      diag.encounterMatches.push({ pullId: pid, encounterId: matchedEncounter.encounterId, encounterName: matchedEncounter.encounterName });
    }

    const pullObj = {
      pullId: pid, index: pIdx, startTs: pullStartTs, finishTs: pullFinishTs,
      durationMs: pullDurationMs, outcome, segmentIds: [...segIds],
      pullDetectionMethod: src.pullDetectionMethod || "regen_boundary",
      pullConfidence: src.pullConfidence ?? 0.9,
      npcIds: Array.isArray(src.npcIds) ? [...src.npcIds] : collectNpcIds(segIds, segmentMap),
      packId: src.packId || null, packMatchConfidence: src.packMatchConfidence ?? 0,
      anchor: cloneAnchor(src.anchor), anchorType: src.anchorType || "unknown",
      anchorPrecision: src.anchorPrecision || "fallback",
      floor: src.floor || null, regionId: src.regionId || null,
      enemyCount: src.enemyCount ?? 0,
      // Encounter/boss fields (V1.2.1)
      isBossPull, encounterId: matchedEncounter ? matchedEncounter.encounterId : null,
      encounterName: matchedEncounter ? matchedEncounter.encounterName : null,
      encounterStartOffsetMs: matchedEncounter && pullStartTs > 0 ? matchedEncounter.startTs - pullStartTs : null,
      encounterEndOffsetMs: matchedEncounter && pullStartTs > 0 ? matchedEncounter.endTs - pullStartTs : null,
      deaths: [], deathChain: null, cooldownEvents: [], spikes: [],
      enemyCasts: [], interrupts: [], enemyHealthSnapshots: [],
      firstDeathId: null, firstDeathRole: null, timeToFirstDeathMs: null, wipeId: null,
    };

    R.pulls.push(pullObj);

    if (DEV) {
      if (pullObj.anchorType !== "pack_centroid") diag.pullsWithFallbackAnchors.push(pid);
      if (pullObj.packMatchConfidence < 0.40) diag.pullsWithLowPackConfidence.push(pid);
    }
  }

  const pullById = new Map();
  for (const p of R.pulls) pullById.set(p.pullId, p);

  function pullForSegment(segmentId) {
    const idx = segmentToPullIdx.get(segmentId);
    return idx != null ? R.pulls[idx] : null;
  }

  // ── Pass 4: Assign evidence objects to pulls ────────────────────────────────

  const enrichedSegments = pce.enrichedSegments || [];
  const allDeaths = [], allCooldowns = [], allInterrupts = [];
  const allEnemyCasts = [], allSpikes = [], allBuckets = [], allHealthSnaps = [];

  for (const eseg of enrichedSegments) {
    const pull = pullForSegment(eseg.segmentId);
    for (const d of (eseg.deaths || [])) { d._targetPull = pull; allDeaths.push(d); }
    for (const c of (eseg.cooldownEvents || [])) { c._targetPull = pull; allCooldowns.push(c); }
    for (const it of (eseg.interrupts || [])) { it._targetPull = pull; allInterrupts.push(it); }
    for (const ec of (eseg.enemyCasts || [])) { ec._targetPull = pull; allEnemyCasts.push(ec); }
    for (const b of (eseg.damageBuckets || [])) { b._targetPull = pull; allBuckets.push(b); }
    for (const hs of (eseg.enemyHealthSnapshots || [])) { hs._targetPull = pull; allHealthSnaps.push(hs); }
  }

  for (const d of allDeaths) { if (!d._targetPull) { if (DEV) diag.unmatchedDeaths.push(d.deathId || "unknown"); continue; } d._targetPull.deaths.push(d); }
  for (const c of allCooldowns) { if (!c._targetPull) { if (DEV) diag.unmatchedCooldownEvents.push(c.cooldownEventId || "unknown"); continue; } c._targetPull.cooldownEvents.push(c); }
  for (const it of allInterrupts) { if (!it._targetPull) { if (DEV) diag.unmatchedInterrupts.push(it.interruptId || "unknown"); continue; } it._targetPull.interrupts.push(it); }

  const interruptTargetGuids = new Set(allInterrupts.filter(it => it._targetPull).map(it => `${it._targetPull.pullId}:${it.targetGuid}`));
  for (const ec of allEnemyCasts) {
    if (!ec._targetPull) { if (DEV) diag.unmatchedEnemyCasts.push(ec.enemyCastId || "unknown"); continue; }
    const key = `${ec._targetPull.pullId}:${ec.enemyGuid}`;
    if (interruptTargetGuids.has(key)) ec.interruptAttempted = true;
    ec._targetPull.enemyCasts.push(ec);
  }
  for (const hs of allHealthSnaps) { if (!hs._targetPull) continue; hs._targetPull.enemyHealthSnapshots.push(hs); }

  // ── Pass 5: Enrich anchor-bearing child objects ──────────────────────────────

  for (const pull of R.pulls) {
    const pullAnchor = cloneAnchor(pull.anchor);
    const pullFloor = pull.floor, pullRegion = pull.regionId, pullPackId = pull.packId;
    function enrichSpatial(obj) { obj.anchor = pullAnchor; obj.floor = pullFloor; obj.regionId = pullRegion; if ("packId" in obj) obj.packId = pullPackId; }
    for (const d of pull.deaths) enrichSpatial(d);
    for (const c of pull.cooldownEvents) enrichSpatial(c);
    for (const ec of pull.enemyCasts) enrichSpatial(ec);
    for (const it of pull.interrupts) enrichSpatial(it);
    for (const hs of pull.enemyHealthSnapshots) enrichSpatial(hs);
  }

  // ── Pass 6: Compute first-death fields ──────────────────────────────────────

  for (const pull of R.pulls) {
    if (pull.deaths.length === 0) continue;
    pull.deaths.sort((a, b) => a.deathTs - b.deathTs);
    for (const d of pull.deaths) { d.offsetMs = pull.startTs > 0 ? d.deathTs - pull.startTs : d.offsetMs ?? 0; d.pullId = pull.pullId; }
    const first = pull.deaths[0];
    first.firstDeathInPull = true;
    pull.firstDeathId = first.deathId;
    pull.firstDeathRole = first.role || null;
    pull.timeToFirstDeathMs = pull.startTs > 0 ? first.deathTs - pull.startTs : null;
    for (const death of pull.deaths) { death.defensiveCastHistory = buildDefensiveHistory(death, pull.cooldownEvents, pull.startTs); }
  }

  // ── Pass 7: Build wipe objects ───────────────────────────────────────────────

  for (const pull of R.pulls) {
    if (pull.deaths.length < WIPE_DEATH_COUNT) continue;
    pull.outcome = "wipe";
    const sortedDeaths = [...pull.deaths].sort((a, b) => a.deathTs - b.deathTs);
    const firstDeath = sortedDeaths[0], lastDeath = sortedDeaths[sortedDeaths.length - 1];
    const timeFromFirstDeathMs = lastDeath.deathTs - firstDeath.deathTs;
    firstDeath.firstDeathInWipe = true;
    const wid = wipeId(runId, pull.index);
    pull.wipeId = wid;
    const collapseConfidence = timeFromFirstDeathMs < 10000 ? 0.95 : timeFromFirstDeathMs < 20000 ? 0.80 : 0.65;
    R.wipes.push({ wipeId: wid, pullId: pull.pullId, wipeTs: lastDeath.deathTs, deathIds: sortedDeaths.map(d => d.deathId), firstDeathId: firstDeath.deathId, firstDeathRole: firstDeath.role || null, timeFromFirstDeathMs, anchor: cloneAnchor(pull.anchor), floor: pull.floor, regionId: pull.regionId, packId: pull.packId, collapseConfidence });
  }

  // ── Pass 8: Build death chains ───────────────────────────────────────────────

  for (const pull of R.pulls) {
    if (pull.deaths.length === 0) { pull.deathChain = null; continue; }
    const sorted = [...pull.deaths].sort((a, b) => a.deathTs - b.deathTs);
    const timeSpan = sorted[sorted.length - 1].deathTs - sorted[0].deathTs;
    pull.deathChain = { totalDeaths: sorted.length, isWipe: sorted.length >= WIPE_DEATH_COUNT, timeSpanMs: timeSpan, sequence: sorted.map(d => ({ deathId: d.deathId, offsetMs: d.offsetMs ?? 0, role: d.role || "unknown", class: d.class || "UNKNOWN", killingSpellName: d.killingBlow?.spellName || null })) };
  }

  // ── Pass 9: Normalize damage buckets ────────────────────────────────────────

  let spikeCounter = 0;
  for (const eseg of enrichedSegments) {
    const pull = pullForSegment(eseg.segmentId);
    if (!pull) continue;
    for (const sp of (eseg.spikes || [])) {
      spikeCounter++;
      pull.spikes.push({ spikeId: `${runId}-${pull.pullId}-sp${spikeCounter}`, pullId: pull.pullId, spikeTs: sp.spikeTs || sp.normalizedTs || 0, offsetMs: sp.offsetMs ?? (pull.startTs > 0 ? (sp.spikeTs || 0) - pull.startTs : 0), damage: sp.damage || sp.amount || 0, role: sp.role || "unknown", anchor: cloneAnchor(pull.anchor), floor: pull.floor, regionId: pull.regionId });
    }
  }

  let globalBucketIdx = 0;
  for (const b of allBuckets) {
    const pull = b._targetPull;
    if (!pull) { if (DEV) diag.unmatchedBuckets.push(`bucket@${b.bucketStartTs}`); continue; }
    globalBucketIdx++;
    const bIdx = Math.floor((b.bucketStartTs - pull.startTs) / 1000);
    R.damageBuckets.push({ bucketId: bucketId(pull.pullId, bIdx), pullId: pull.pullId, bucketStartTs: b.bucketStartTs, bucketEndTs: b.bucketEndTs, durationMs: b.durationMs || 1000, partyDamageTaken: b.partyDamageTaken || 0, tankDamageTaken: b.tankDamageTaken || 0, healerDamageTaken: b.healerDamageTaken || 0, dpsDamageTaken: b.dpsDamageTaken || 0, partyHealingReceived: b.partyHealingReceived || 0, tankHealingReceived: b.tankHealingReceived || 0, deathCountInBucket: b.deathCountInBucket || 0, anchor: cloneAnchor(pull.anchor), floor: pull.floor, regionId: pull.regionId });
  }

  // ── Pass 10: Finalize capability flags ───────────────────────────────────────

  const caps = R.telemetryCapabilities;
  caps.hasCombatSegments = addonSegments.length > 0;
  caps.hasEnemyRegistry = R.enemyRegistry.length > 0;
  caps.hasPartySnapshot = !!R.player?.class && Array.isArray(R.partyMembers);
  caps.hasDeathContext = R.pulls.some(p => p.deaths.some(d => d.killingBlow != null || d.preDeathHits?.length > 0));
  caps.hasDamageBuckets = R.damageBuckets.length > 0;
  caps.hasEnemyCasts = R.pulls.some(p => p.enemyCasts.length > 0);
  caps.hasInterrupts = R.pulls.some(p => p.interrupts.length > 0);
  caps.hasEnemyHealthSnapshots = R.pulls.some(p => p.enemyHealthSnapshots.length > 0);
  caps.hasEnemyPositions = false;
  caps.hasEncounterData = R.pulls.some(p => p.isBossPull === true);

  // ── Pass 11: Final integrity validation ─────────────────────────────────────

  const errors = validatePayload(payload, diag, DEV);
  if (errors.length > 0) return { ok: false, errors, diagnostics: DEV ? diag : undefined };

  stripInternalFields(payload);
  return { ok: true, payload, diagnostics: DEV ? diag : undefined };
}

// ─── Validation (Pass 11) ─────────────────────────────────────────────────────

function validatePayload(payload, diag, DEV) {
  const errors = [];
  const R = payload.run;
  if (R.startTs <= 0) errors.push("run.startTs is missing or zero");
  if (R.finishTs <= 0) errors.push("run.finishTs is missing or zero");
  if (R.finishTs > 0 && R.startTs > 0 && R.finishTs <= R.startTs) errors.push("run.finishTs must be greater than run.startTs");

  const pullIds = new Set(R.pulls.map(p => p.pullId));
  const deathIds = new Set();

  for (const pull of R.pulls) {
    if (R.startTs && pull.startTs < R.startTs - 500) { if (DEV) diag.integrityWarnings.push(`Pull ${pull.pullId} startTs before run startTs`); }
    if (R.finishTs && pull.finishTs > R.finishTs + 500) { if (DEV) diag.integrityWarnings.push(`Pull ${pull.pullId} finishTs after run finishTs`); }
    if (!pull.floor) { if (DEV) diag.integrityWarnings.push(`Pull ${pull.pullId} missing floor`); }
    for (const d of pull.deaths) { if (!d.deathId) { errors.push(`Death in pull ${pull.pullId} missing deathId`); continue; } deathIds.add(d.deathId); if (pull.startTs && d.deathTs < pull.startTs - 500) { if (DEV) diag.integrityWarnings.push(`Death ${d.deathId} before pull start`); } }
    if (pull.wipeId) { if (!R.wipes.some(w => w.wipeId === pull.wipeId)) errors.push(`pull.wipeId ${pull.wipeId} does not reference an existing wipe`); }
  }

  for (const pull of R.pulls) { if (pull.firstDeathId && !deathIds.has(pull.firstDeathId)) errors.push(`pull.firstDeathId ${pull.firstDeathId} does not reference an existing death`); }
  for (const wipe of R.wipes) { if (!pullIds.has(wipe.pullId)) errors.push(`wipe.pullId ${wipe.pullId} does not reference an existing pull`); for (const did of (wipe.deathIds || [])) { if (!deathIds.has(did)) errors.push(`wipe.deathId ${did} does not reference an existing death`); } }
  for (const b of R.damageBuckets) { if (!pullIds.has(b.pullId)) errors.push(`damageBucket pullId ${b.pullId} does not reference an existing pull`); }
  if (!Array.isArray(R.pulls)) errors.push("run.pulls is not an array");
  if (!Array.isArray(R.enemyRegistry)) errors.push("run.enemyRegistry is not an array");
  if (!Array.isArray(R.damageBuckets)) errors.push("run.damageBuckets is not an array");
  if (!Array.isArray(R.wipes)) errors.push("run.wipes is not an array");
  return errors;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePlayer(player) {
  if (!player) return { class: "UNKNOWN", spec: null, role: "unknown" };
  const out = { class: player.class || "UNKNOWN", spec: player.spec || null, role: player.role || "unknown" };
  if (typeof player.itemLevel === "number" && player.itemLevel > 0) out.itemLevel = player.itemLevel;
  return out;
}
function normalizePartyMembers(members) { if (!Array.isArray(members)) return []; return members.map(m => ({ class: m.class || "UNKNOWN", spec: m.spec || null, role: m.role || "unknown", specConfidence: m.specConfidence || "unknown" })); }
function collectNpcIds(segIds, segmentMap) { const ids = new Set(); for (const sid of segIds) { const seg = segmentMap.get(sid); if (seg?.npcIds) seg.npcIds.forEach(id => ids.add(id)); } return [...ids]; }
function buildPullsFromSegments(segments, runId) { return segments.map((seg, i) => ({ segmentIds: [seg.segmentId], startTs: seg.startTs || 0, finishTs: seg.finishTs || 0, npcIds: seg.npcIds || [], enemyCount: (seg.npcIds || []).length, packId: null, regionId: null, floor: null, anchor: { x: 50.0, y: 50.0 }, anchorType: "unknown", anchorPrecision: "fallback", packMatchConfidence: 0, pullDetectionMethod: "regen_boundary", pullConfidence: 0.5 })); }

function buildDefensiveHistory(death, cooldownEvents, pullStartTs) {
  if (!death || !Array.isArray(cooldownEvents)) return [];
  const playerCDs = cooldownEvents.filter(c => c.sourceGuid === death.playerGuid);
  const lastCastBySpell = new Map();
  for (const cd of playerCDs) { if (cd.castTs <= death.deathTs) { const existing = lastCastBySpell.get(cd.spellId); if (!existing || cd.castTs > existing.castTs) lastCastBySpell.set(cd.spellId, cd); } }
  return [...lastCastBySpell.values()].map(cd => ({ spellId: cd.spellId, spellName: cd.spellName, lastCastTs: cd.castTs, lastCastOffsetMs: pullStartTs > 0 ? cd.castTs - pullStartTs : null }));
}

function stripInternalFields(payload) {
  const R = payload.run;
  for (const pull of R.pulls) { for (const arr of [pull.deaths, pull.cooldownEvents, pull.enemyCasts, pull.interrupts, pull.enemyHealthSnapshots, pull.spikes]) { for (const obj of arr) { delete obj._targetPull; delete obj.normalizedTs; delete obj.playerGuid; delete obj.sourceGuid; } } }
  for (const b of R.damageBuckets) delete b._targetPull;
  for (const w of R.wipes) delete w._targetPull;
}

class RunAssembler {
  constructor({ onReady } = {}) { this.onReady = onReady || (() => {}); this.isOpen = false; this.currentRunID = null; this._addonRun = null; this._pulls = []; }
  openRun(addonRun) { this._addonRun = addonRun; this._pulls = []; this.isOpen = true; this.currentRunID = addonRun?.runId || null; }
  addPull(pull) { if (!this.isOpen) return; this._pulls.push(pull); }
  closeRun() { if (!this.isOpen) return; this.isOpen = false; const result = assembleRunPayload({ addonRun: this._addonRun, parsedCombatEvidence: { enrichedSegments: this._pulls }, resolvedPulls: [], options: { dev: false } }); this._addonRun = null; this._pulls = []; this.currentRunID = null; if (result.ok) this.onReady(result.payload); else console.error("[RunAssembler] Assembly failed:", result.errors); }
}

module.exports = { assembleRunPayload, RunAssembler };
