// combatLogParser.js — V1.2
// Velara Intelligence — Combat Log Evidence Extractor
//
// Responsibilities (V1.2):
//   1. Normalize combat log wall-clock timestamps using one global clock offset
//   2. Assign events to addon combat segments by time range + nearest-boundary fallback
//   3. Extract death evidence with pre-death hit windows
//   4. Extract cooldown events (allowlist-filtered)
//   5. Extract interrupt events (allowlist-filtered)
//   6. Extract enemy cast events
//   7. Build 1-second damage buckets per segment
//   8. Detect death chains per segment
//   9. Return one structured ParsedCombatEvidence object
//
// What this file does NOT do:
//   - Decide final pull truth (runAssembler owns that)
//   - Classify death causes
//   - Compute defensive availability (backend product)
//   - Do any frontend shaping
//
// Log line format (Midnight 12.x):
//   MM/DD HH:MM:SS.mmm  EVENT_NAME,field1,field2,...
//
// All output timestamps are epoch ms (Ts suffix per V1.2 contract).

"use strict";

// ─── Spell allowlists ─────────────────────────────────────────────────────────
// Parser filters to these lists. Do not track all player casts.
// Expand per class/season as needed.

const DEFENSIVE_CD_SPELLS = new Set([
  // Death Knight
  48707,  // Anti-Magic Shell
  49028,  // Dancing Rune Weapon
  48792,  // Icebound Fortitude
  // Druid
  22812,  // Barkskin
  61336,  // Survival Instincts
  // Evoker
  374348, // Obsidian Scales
  // Hunter
  186265, // Aspect of the Turtle
  // Mage
  45438,  // Ice Block
  // Monk
  122278, // Dampen Harm
  116849, // Life Cocoon (external)
  // Paladin
  642,    // Divine Shield
  498,    // Divine Protection
  31850,  // Ardent Defender
  86659,  // Guardian of Ancient Kings
  // Priest
  47788,  // Guardian Spirit (external)
  33206,  // Pain Suppression (external)
  // Rogue
  31224,  // Cloak of Shadows
  5277,   // Evasion
  // Shaman
  108271, // Astral Shift
  // Warrior
  871,    // Shield Wall
  1160,   // Demoralizing Shout
  12975,  // Last Stand
  // Warlock
  108416, // Dark Pact
  6789,   // Mortal Coil
]);

const INTERRUPT_SPELLS = new Set([
  // Death Knight
  47528,  // Mind Freeze
  // Demon Hunter
  183752, // Consume Magic
  // Druid
  78675,  // Solar Beam
  106839, // Skull Bash
  // Evoker
  351338, // Quell
  // Hunter
  147362, // Counter Shot
  187707, // Muzzle
  // Mage
  2139,   // Counterspell
  // Monk
  116705, // Spear Hand Strike
  // Paladin
  96231,  // Rebuke
  // Priest
  15487,  // Silence
  // Rogue
  1766,   // Kick
  // Shaman
  57994,  // Wind Shear
  // Warrior
  6552,   // Pummel
  // Warlock
  119910, // Spell Lock (Felhunter)
]);

// ─── Constants ────────────────────────────────────────────────────────────────

const SEGMENT_TOLERANCE_MS    = 1500;  // max ms outside segment boundary to still match
const PRE_DEATH_WINDOW_MS     = 8000;  // look back 8s before death for pre-death hits
const PRE_DEATH_HIT_BUFFER_MS = 10000; // rolling buffer retention per target
const PRE_DEATH_HIT_MAX       = 5;    // max pre-death hits to capture
const DAMAGE_BUCKET_MS        = 1000; // 1-second buckets per V1.2 contract

// ─── GUID helpers ─────────────────────────────────────────────────────────────

function isPlayerGuid(guid) {
  return typeof guid === "string" && guid.startsWith("Player-");
}

function isCreatureGuid(guid) {
  return typeof guid === "string" && guid.startsWith("Creature-");
}

// Extract NPC ID from Creature GUID: "Creature-0-XXXX-YYYY-ZZ-NPCID-XXXXXXXX"
function npcIdFromGuid(guid) {
  if (!isCreatureGuid(guid)) return null;
  const parts = guid.split("-");
  if (parts.length >= 6) {
    const id = parseInt(parts[5], 10);
    return isNaN(id) ? null : id;
  }
  return null;
}

// ─── Log line parsing ─────────────────────────────────────────────────────────

function splitLogLine(line) {
  const fields = [];
  let current  = "";
  let inQuote  = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// Parse combat log wall-clock "MM/DD HH:MM:SS.mmm" → raw epoch ms (current year assumed)
function parseLogTimestamp(ts) {
  try {
    const year = new Date().getFullYear();
    const [datePart, timePart] = ts.split(" ");
    const [month, day]         = datePart.split("/").map(Number);
    const [hms, msStr]         = timePart.split(".");
    const [h, m, s]            = hms.split(":").map(Number);
    return new Date(year, month - 1, day, h, m, s, parseInt(msStr || "0", 10)).getTime();
  } catch {
    return 0;
  }
}

// ─── Segment matching ─────────────────────────────────────────────────────────

function assignToSegment(normalizedTs, segments) {
  if (!segments || segments.length === 0) return null;

  // Stage 1: range match within tolerance
  for (const seg of segments) {
    const start = seg.startTs  - SEGMENT_TOLERANCE_MS;
    const end   = seg.finishTs + SEGMENT_TOLERANCE_MS;
    if (normalizedTs >= start && normalizedTs <= end) {
      const distance = Math.max(0,
        normalizedTs < seg.startTs  ? seg.startTs  - normalizedTs :
        normalizedTs > seg.finishTs ? normalizedTs - seg.finishTs : 0
      );
      return {
        segmentId : seg.segmentId,
        matchType : distance === 0 ? "exact" : "tolerance",
        distanceMs: distance,
      };
    }
  }

  // Stage 2: nearest boundary fallback
  let nearest = null;
  let minDist = Infinity;
  for (const seg of segments) {
    const dist = Math.min(
      Math.abs(normalizedTs - seg.startTs),
      Math.abs(normalizedTs - seg.finishTs)
    );
    if (dist < minDist) { minDist = dist; nearest = seg; }
  }
  if (nearest) {
    return { segmentId: nearest.segmentId, matchType: "nearest", distanceMs: minDist };
  }

  return { segmentId: null, matchType: "none", distanceMs: Infinity };
}

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * parseCombatLog({ run, combatLogLines, partyGuids })
 *
 * @param {object}   run             - Addon run object (V1.2 schema)
 * @param {string[]} combatLogLines  - Raw lines from WoWCombatLog.txt
 * @param {string[]} partyGuids      - Optional: known player GUIDs
 *
 * @returns {ParsedCombatEvidence}
 *   {
 *     clockOffsetMs, clockSyncConfidence,
 *     enrichedSegments[],
 *     capabilityFlags,
 *     parserDiagnostics
 *   }
 */
function parseCombatLog({ run, combatLogLines, partyGuids = [] }) {
  const segments = run.combatSegments || [];

  // ── Diagnostics ──────────────────────────────────────────────────────────────
  const diag = {
    totalLinesRead          : 0,
    relevantEventsRead      : 0,
    clockOffsetMs           : null,
    clockSyncConfidence     : "unknown",
    unmatchedEventCount     : 0,
    eventsMatchedExactly    : 0,
    eventsMatchedByTolerance: 0,
    eventsMatchedByNearest  : 0,
  };

  // ── Clock sync ───────────────────────────────────────────────────────────────
  // Addon startTs is already in ms (companion multiplied by 1000 from Lua seconds).
  const addonStartTs = run.startTs || 0;
  let clockOffsetMs  = 0;

  // Find first relevant log line to compute global offset
  for (const rawLine of combatLogLines) {
    const spaceIdx = rawLine.indexOf("  ");
    if (spaceIdx < 0) continue;
    const ts = parseLogTimestamp(rawLine.substring(0, spaceIdx).trim());
    if (ts > 0) {
      clockOffsetMs = addonStartTs > 0 ? addonStartTs - ts : 0;
      break;
    }
  }

  diag.clockOffsetMs = clockOffsetMs;

  // Confidence check: test first 20 events against first 2 segments
  if (segments.length >= 1 && addonStartTs > 0) {
    let tested = 0, goodFit = 0;
    const testSegs = segments.slice(0, 2);
    for (const rawLine of combatLogLines) {
      if (tested >= 20) break;
      const spaceIdx = rawLine.indexOf("  ");
      if (spaceIdx < 0) continue;
      const ts = parseLogTimestamp(rawLine.substring(0, spaceIdx).trim());
      if (ts <= 0) continue;
      const match = assignToSegment(ts + clockOffsetMs, testSegs);
      if (match && match.matchType !== "none" && match.matchType !== "nearest") goodFit++;
      tested++;
    }
    const fitRate = tested > 0 ? goodFit / tested : 0;
    diag.clockSyncConfidence =
      fitRate >= 0.6 ? "high"   :
      fitRate >= 0.3 ? "medium" : "low";
  } else {
    diag.clockSyncConfidence = addonStartTs === 0 ? "failed" : "medium";
  }

  // ── Per-player rolling damage buffer (for pre-death hit windows) ─────────────
  const damageBuffers = new Map(); // playerGuid → hit[]

  function getDamageBuffer(guid) {
    if (!damageBuffers.has(guid)) damageBuffers.set(guid, []);
    return damageBuffers.get(guid);
  }

  function pushToDamageBuffer(guid, hit) {
    const buf    = getDamageBuffer(guid);
    buf.push(hit);
    const cutoff = hit.normalizedTs - PRE_DEATH_HIT_BUFFER_MS;
    while (buf.length > 0 && buf[0].normalizedTs < cutoff) buf.shift();
  }

  // ── Per-segment accumulators ─────────────────────────────────────────────────
  const segmentData = new Map();

  function getSegData(segmentId) {
    if (!segmentData.has(segmentId)) {
      segmentData.set(segmentId, {
        deaths        : [],
        cooldownEvents: [],
        interrupts    : [],
        enemyCasts    : [],
        buckets       : new Map(), // bucketIdx → accumulator
        deathCounter  : 0,
        cdCounter     : 0,
        intCounter    : 0,
        ecCounter     : 0,
      });
    }
    return segmentData.get(segmentId);
  }

  function getSegment(segmentId) {
    return segments.find(s => s.segmentId === segmentId) || null;
  }

  function ensureBucket(segData, seg, bucketIdx) {
    if (!segData.buckets.has(bucketIdx)) {
      const bucketStartTs = seg.startTs + bucketIdx * DAMAGE_BUCKET_MS;
      segData.buckets.set(bucketIdx, {
        bucketIdx,
        bucketStartTs,
        bucketEndTs          : bucketStartTs + DAMAGE_BUCKET_MS,
        durationMs           : DAMAGE_BUCKET_MS,
        partyDamageTaken     : 0,
        tankDamageTaken      : 0,
        healerDamageTaken    : 0,
        dpsDamageTaken       : 0,
        partyHealingReceived : 0,
        tankHealingReceived  : 0,
        deathCountInBucket   : 0,
      });
    }
    return segData.buckets.get(bucketIdx);
  }

  // ── GUID → class/role maps (populated as we see casts) ──────────────────────
  const guidToClass = new Map();
  const guidToRole  = new Map();

  // Seed from player
  // Player GUID will be detected from their first SPELL_CAST_SUCCESS in the log
  if (run.player?.class && run.player?.role) {
    // We'll seed the player GUID once detected below
  }

  let playerGuid = null;

  // ── Event processors ─────────────────────────────────────────────────────────

  function processUnitDied(fields, normalizedTs, segmentId) {
    const destGuid = fields[5] || "";
    if (!isPlayerGuid(destGuid)) return;

    const seg     = getSegment(segmentId);
    const segData = getSegData(segmentId);
    segData.deathCounter++;
    const deathId = `${run.runId || "unk"}-${segmentId}-d${segData.deathCounter}`;

    // Extract pre-death hit window
    const buf        = getDamageBuffer(destGuid);
    const cutoff     = normalizedTs - PRE_DEATH_WINDOW_MS;
    const windowHits = buf.filter(h => h.normalizedTs >= cutoff);
    const preDeathHits = windowHits.slice(-PRE_DEATH_HIT_MAX).map(h => ({
      normalizedTs : h.normalizedTs,
      offsetMs     : seg ? h.normalizedTs - seg.startTs : 0,
      spellId      : h.spellId,
      spellName    : h.spellName,
      amount       : h.amount,
      overkill     : h.overkill,
      school       : h.school,
      sourceNpcId  : h.sourceNpcId,
      sourceNpcName: h.sourceNpcName,
    }));

    // Killing blow: last hit with overkill > 0, else last hit
    const kbHit = [...windowHits].reverse().find(h => h.overkill > 0)
               || windowHits[windowHits.length - 1]
               || null;

    const killingBlow = kbHit ? {
      spellId      : kbHit.spellId,
      spellName    : kbHit.spellName,
      amount       : kbHit.amount,
      overkill     : kbHit.overkill,
      school       : kbHit.school,
      sourceNpcId  : kbHit.sourceNpcId,
      sourceNpcName: kbHit.sourceNpcName,
    } : null;

    segData.deaths.push({
      deathId,
      segmentId,
      deathTs             : normalizedTs,
      offsetMs            : seg ? normalizedTs - seg.startTs : 0,
      playerGuid          : destGuid,
      class               : guidToClass.get(destGuid) || "UNKNOWN",
      role                : guidToRole.get(destGuid)  || "unknown",
      firstDeathInPull    : false, // set during assembly
      killingBlow,
      preDeathHits,
      defensiveCastHistory: [], // enriched by runAssembler from cooldownEvents
    });

    // Increment death in bucket
    if (seg) {
      const bIdx   = Math.floor((normalizedTs - seg.startTs) / DAMAGE_BUCKET_MS);
      const bucket = ensureBucket(segData, seg, bIdx);
      bucket.deathCountInBucket++;
    }
  }

  function processIncomingDamage(fields, normalizedTs, segmentId, event) {
    const destGuid   = fields[5] || "";
    const sourceGuid = fields[1] || "";
    const sourceName = (fields[2] || "").replace(/"/g, "");
    if (!isPlayerGuid(destGuid)) return;

    let spellId = 0, spellName = "Melee", amount = 0, overkill = 0, school = "1";

    if (event === "SWING_DAMAGE") {
      amount   = parseInt(fields[9],  10) || 0;
      overkill = parseInt(fields[10], 10) || 0;
      school   = fields[11] || "1";
    } else {
      // SPELL_DAMAGE / SPELL_PERIODIC_DAMAGE
      spellId   = parseInt(fields[9],  10) || 0;
      spellName = (fields[10] || "").replace(/"/g, "");
      school    = fields[11] || "0";
      amount    = parseInt(fields[12], 10) || 0;
      overkill  = parseInt(fields[13], 10) || 0;
    }

    const sourceNpcId   = npcIdFromGuid(sourceGuid);
    const sourceNpcName = isCreatureGuid(sourceGuid) ? sourceName : null;

    pushToDamageBuffer(destGuid, {
      normalizedTs, spellId, spellName, amount, overkill, school,
      sourceGuid, sourceNpcId, sourceNpcName,
    });

    // Accumulate into damage bucket
    const seg = getSegment(segmentId);
    if (seg && amount > 0) {
      const segData = getSegData(segmentId);
      const bIdx    = Math.floor((normalizedTs - seg.startTs) / DAMAGE_BUCKET_MS);
      const bucket  = ensureBucket(segData, seg, bIdx);
      const role    = guidToRole.get(destGuid) || "unknown";
      bucket.partyDamageTaken += amount;
      if (role === "tank")   bucket.tankDamageTaken   += amount;
      if (role === "healer") bucket.healerDamageTaken += amount;
      if (role === "dps")    bucket.dpsDamageTaken    += amount;
    }
  }

  function processPlayerCast(fields, normalizedTs, segmentId) {
    const sourceGuid = fields[1] || "";
    const sourceName = (fields[2] || "").replace(/"/g, "");
    const destGuid   = fields[5] || "";
    const destName   = (fields[6] || "").replace(/"/g, "");
    const spellId    = parseInt(fields[9],  10) || 0;
    const spellName  = (fields[10] || "").replace(/"/g, "");

    if (!isPlayerGuid(sourceGuid)) return;

    // Detect recording player's GUID on first cast
    if (!playerGuid) {
      playerGuid = sourceGuid;
      if (run.player?.class) guidToClass.set(sourceGuid, run.player.class);
      if (run.player?.role)  guidToRole.set(sourceGuid,  run.player.role);
    }

    const seg     = getSegment(segmentId);
    const segData = getSegData(segmentId);

    // Defensive cooldown
    if (DEFENSIVE_CD_SPELLS.has(spellId)) {
      segData.cdCounter++;
      segData.cooldownEvents.push({
        cooldownEventId: `${run.runId || "unk"}-${segmentId}-cd${segData.cdCounter}`,
        segmentId,
        castTs  : normalizedTs,
        offsetMs: seg ? normalizedTs - seg.startTs : 0,
        spellId,
        spellName,
        sourceGuid,
        class   : guidToClass.get(sourceGuid) || "UNKNOWN",
        role    : guidToRole.get(sourceGuid)  || "unknown",
      });
    }

    // Interrupt
    if (INTERRUPT_SPELLS.has(spellId)) {
      segData.intCounter++;
      segData.interrupts.push({
        interruptId   : `${run.runId || "unk"}-${segmentId}-int${segData.intCounter}`,
        segmentId,
        interruptTs   : normalizedTs,
        offsetMs      : seg ? normalizedTs - seg.startTs : 0,
        sourceGuid,
        sourceClass   : guidToClass.get(sourceGuid) || "UNKNOWN",
        sourceRole    : guidToRole.get(sourceGuid)  || "unknown",
        targetGuid    : destGuid,
        targetNpcId   : npcIdFromGuid(destGuid),
        targetNpcName : destName || null,
        spellId,
        spellName,
        result        : "success",
      });
    }
  }

  function processEnemyCast(fields, normalizedTs, segmentId, event) {
    const sourceGuid = fields[1] || "";
    const sourceName = (fields[2] || "").replace(/"/g, "");
    if (!isCreatureGuid(sourceGuid)) return;

    const spellId   = parseInt(fields[9],  10) || 0;
    const spellName = (fields[10] || "").replace(/"/g, "");
    if (!spellId) return;

    const seg     = getSegment(segmentId);
    const segData = getSegData(segmentId);
    segData.ecCounter++;
    segData.enemyCasts.push({
      enemyCastId       : `${run.runId || "unk"}-${segmentId}-ec${segData.ecCounter}`,
      segmentId,
      castStartTs       : normalizedTs,
      castStartOffsetMs : seg ? normalizedTs - seg.startTs : 0,
      enemyGuid         : sourceGuid,
      npcId             : npcIdFromGuid(sourceGuid),
      npcName           : sourceName || null,
      spellId,
      spellName,
      castOutcome       : event === "SPELL_CAST_SUCCESS" ? "success" : "casting",
      interruptAttempted: false, // runAssembler sets this by cross-referencing interrupts
    });
  }

  // ── Main parse loop ──────────────────────────────────────────────────────────

  const RELEVANT_EVENTS = new Set([
    "UNIT_DIED",
    "SWING_DAMAGE",
    "SPELL_DAMAGE",
    "SPELL_PERIODIC_DAMAGE",
    "SPELL_CAST_SUCCESS",
    "SPELL_CAST_START",
  ]);

  for (const rawLine of combatLogLines) {
    diag.totalLinesRead++;

    const spaceIdx = rawLine.indexOf("  ");
    if (spaceIdx < 0) continue;

    const rawTs = parseLogTimestamp(rawLine.substring(0, spaceIdx).trim());
    if (rawTs <= 0) continue;

    const bodyPart = rawLine.substring(spaceIdx + 2).trim();
    const fields   = splitLogLine(bodyPart);
    if (fields.length < 1) continue;

    const event = fields[0];
    if (!RELEVANT_EVENTS.has(event)) continue;

    diag.relevantEventsRead++;

    const normalizedTs = rawTs + clockOffsetMs;
    const match        = assignToSegment(normalizedTs, segments);

    if (!match || match.matchType === "none" || !match.segmentId) {
      diag.unmatchedEventCount++;
      continue;
    }

    if (match.matchType === "exact")     diag.eventsMatchedExactly++;
    if (match.matchType === "tolerance") diag.eventsMatchedByTolerance++;
    if (match.matchType === "nearest")   diag.eventsMatchedByNearest++;

    const segmentId = match.segmentId;

    switch (event) {
      case "UNIT_DIED":
        processUnitDied(fields, normalizedTs, segmentId);
        break;
      case "SWING_DAMAGE":
      case "SPELL_DAMAGE":
      case "SPELL_PERIODIC_DAMAGE":
        processIncomingDamage(fields, normalizedTs, segmentId, event);
        break;
      case "SPELL_CAST_SUCCESS":
        processPlayerCast(fields, normalizedTs, segmentId);
        processEnemyCast(fields, normalizedTs, segmentId, event);
        break;
      case "SPELL_CAST_START":
        processEnemyCast(fields, normalizedTs, segmentId, event);
        break;
    }
  }

  // ── Build death chains per segment ──────────────────────────────────────────

  function buildDeathChain(deaths) {
    if (!deaths || deaths.length === 0) return null;
    const sorted   = [...deaths].sort((a, b) => a.deathTs - b.deathTs);
    const timeSpan = sorted[sorted.length - 1].deathTs - sorted[0].deathTs;
    return {
      totalDeaths: deaths.length,
      isWipe     : deaths.length >= 5,
      timeSpanMs : timeSpan,
      sequence   : sorted.map(d => ({
        deathId         : d.deathId,
        offsetMs        : d.offsetMs,
        role            : d.role,
        class           : d.class,
        killingSpellName: d.killingBlow?.spellName || null,
      })),
    };
  }

  // ── Assemble output ──────────────────────────────────────────────────────────

  const enrichedSegments = [];

  for (const seg of segments) {
    const data = segmentData.get(seg.segmentId);

    if (!data) {
      enrichedSegments.push({
        segmentId     : seg.segmentId,
        deaths        : [],
        cooldownEvents: [],
        interrupts    : [],
        enemyCasts    : [],
        damageBuckets : [],
        deathChain    : null,
      });
      continue;
    }

    // Sort deaths chronologically and mark first
    data.deaths.sort((a, b) => a.deathTs - b.deathTs);
    if (data.deaths.length > 0) data.deaths[0].firstDeathInPull = true;

    const damageBuckets = [...data.buckets.values()]
      .sort((a, b) => a.bucketIdx - b.bucketIdx)
      .map(b => ({
        segmentId            : seg.segmentId,
        bucketStartTs        : b.bucketStartTs,
        bucketEndTs          : b.bucketEndTs,
        durationMs           : b.durationMs,
        partyDamageTaken     : b.partyDamageTaken,
        tankDamageTaken      : b.tankDamageTaken,
        healerDamageTaken    : b.healerDamageTaken,
        dpsDamageTaken       : b.dpsDamageTaken,
        partyHealingReceived : b.partyHealingReceived,
        tankHealingReceived  : b.tankHealingReceived,
        deathCountInBucket   : b.deathCountInBucket,
      }));

    enrichedSegments.push({
      segmentId     : seg.segmentId,
      deaths        : data.deaths,
      cooldownEvents: data.cooldownEvents,
      interrupts    : data.interrupts,
      enemyCasts    : data.enemyCasts,
      damageBuckets,
      deathChain    : buildDeathChain(data.deaths),
    });
  }

  // ── Capability flags ─────────────────────────────────────────────────────────

  const allDeaths  = enrichedSegments.flatMap(s => s.deaths);
  const allBuckets = enrichedSegments.flatMap(s => s.damageBuckets);
  const allInts    = enrichedSegments.flatMap(s => s.interrupts);
  const allECasts  = enrichedSegments.flatMap(s => s.enemyCasts);

  const capabilityFlags = {
    hasDeathContext : allDeaths.length > 0,
    hasPreDeathHits : allDeaths.some(d => d.preDeathHits?.length > 0),
    hasDamageBuckets: allBuckets.length > 0,
    hasInterrupts   : allInts.length > 0,
    hasEnemyCasts   : allECasts.length > 0,
  };

  diag.clockSyncConfidence = diag.clockSyncConfidence;

  return {
    clockOffsetMs,
    clockSyncConfidence: diag.clockSyncConfidence,
    enrichedSegments,
    capabilityFlags,
    parserDiagnostics: diag,
  };
}

// ─── CombatLogParser class wrapper (used by Electron main.js) ────────────────
const { EventEmitter } = require("events");

class CombatLogParser extends EventEmitter {
  constructor() {
    super();
    this._playerName  = null;
    this._lines       = [];
    this._segmentOpen = false;
    this._segStartMs  = 0;
    this._events      = [];
  }

  setPlayerName(name) {
    this._playerName = name;
  }

  parseLine(line) {
    if (!line || typeof line !== "string") return;

    // Detect ENCOUNTER_START / ZONE_CHANGE as pull boundaries
    // For now: buffer lines and emit pullEnd on ENCOUNTER_END or regen boundary
    this._lines.push(line);

    // Simple regen detection: SPELL_ENERGIZE on player after combat = pull end
    // This is a best-effort wrapper — real parsing happens in parseCombatLog()
    if (line.includes("ENCOUNTER_END") || line.includes("ZONE_CHANGE")) {
      this._flushPull();
    }
  }

  _flushPull() {
    if (this._lines.length === 0) return;
    const lines = this._lines.splice(0);
    // Emit raw lines as a pull object for the assembler
    this.emit("pullEnd", { rawLines: lines, playerName: this._playerName });
  }
}

module.exports = { parseCombatLog, CombatLogParser };
