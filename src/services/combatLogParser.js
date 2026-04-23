// combatLogParser.js — V1.3
// Velara Intelligence — Combat Log Evidence Extractor
//
// V1.3 changes (ChatGPT architecture approved 2026-03-17):
//   1. GUID mapping — primary from addon partyMembers (now includes guid field)
//      Spell-based detection is FALLBACK ONLY, not primary
//   2. Healing received — effective healing + overhealing tracked separately
//   3. Spike detection — hybrid threshold (80k absolute OR 30% estimated HP)
//   4. Data quality / confidence output
//   5. Targeting info preserved on spikes (targetGuid, targetRole)
//   6. Source NPC tagging clean on all damage/spike objects
//
// Responsibilities:
//   1. Normalize combat log wall-clock timestamps using one global clock offset
//   2. Assign events to addon combat segments by time range + nearest-boundary fallback
//   3. Extract death evidence with pre-death hit windows
//   4. Extract cooldown events (allowlist-filtered)
//   5. Extract interrupt events (allowlist-filtered)
//   6. Extract enemy cast events
//   7. Build 1-second damage buckets per segment (with healing + overhealing)
//   8. Detect spikes (hybrid threshold)
//   9. Detect death chains per segment
//   10. Return structured ParsedCombatEvidence with dataQuality
//
// What this file does NOT do:
//   - Decide final pull truth (runAssembler owns that)
//   - Classify death causes
//   - Compute defensive availability (backend product)
//   - Do any frontend shaping

"use strict";

// ─── Spell allowlists ─────────────────────────────────────────────────────────

// Defensive CD spells — Map<spellId, { name, category }>
// category: "defensive" = self-only, "external" = cast on another player
// Matches ALWAYS_TRACK_DEFENSIVES from combatLogRunBuilder.js (Overwolf parity).
// Map.has() semantics are identical to Set.has() so prior call sites keep working.
const DEFENSIVE_CD_SPELLS = new Map([
  // ── Death Knight ──
  [48792,  { name: "Icebound Fortitude",       category: "defensive" }],
  [55233,  { name: "Vampiric Blood",            category: "defensive" }],
  [49028,  { name: "Dancing Rune Weapon",       category: "defensive" }],
  [51052,  { name: "Anti-Magic Zone",           category: "defensive" }],
  [49039,  { name: "Lichborne",                 category: "defensive" }],
  // ── Demon Hunter ──
  [198589, { name: "Blur",                      category: "defensive" }],
  [196718, { name: "Darkness",                  category: "defensive" }],
  [196555, { name: "Netherwalk",                category: "defensive" }],
  [187827, { name: "Metamorphosis (Veng)",      category: "defensive" }],
  [204021, { name: "Fiery Brand",               category: "defensive" }],
  // ── Druid ──
  [22812,  { name: "Barkskin",                  category: "defensive" }],
  [61336,  { name: "Survival Instincts",        category: "defensive" }],
  [102342, { name: "Ironbark",                  category: "external"  }],
  [22842,  { name: "Frenzied Regeneration",     category: "defensive" }],
  [102558, { name: "Incarnation: Guardian of Ursoc", category: "defensive" }],
  [319454, { name: "Heart of the Wild",         category: "defensive" }],
  // ── Evoker ──
  [374348, { name: "Obsidian Scales",           category: "defensive" }],
  [374227, { name: "Zephyr",                    category: "defensive" }],
  [370960, { name: "Emerald Communion",         category: "defensive" }],
  // ── Hunter ──
  [186265, { name: "Aspect of the Turtle",      category: "defensive" }],
  [109304, { name: "Exhilaration",              category: "defensive" }],
  // ── Mage ──
  [45438,  { name: "Ice Block",                 category: "defensive" }],
  [342245, { name: "Alter Time",                category: "defensive" }],
  [55342,  { name: "Mirror Image",              category: "defensive" }],
  // ── Monk ──
  [115203, { name: "Fortifying Brew",           category: "defensive" }],
  [122278, { name: "Dampen Harm",               category: "defensive" }],
  [122783, { name: "Diffuse Magic",             category: "defensive" }],
  [115176, { name: "Zen Meditation",            category: "defensive" }],
  [116849, { name: "Life Cocoon",               category: "external"  }],
  [325197, { name: "Invoke Chi-Ji",             category: "external"  }],
  [322118, { name: "Invoke Yu'lon",             category: "external"  }],
  // ── Paladin ──
  [642,    { name: "Divine Shield",             category: "defensive" }],
  [498,    { name: "Divine Protection",         category: "defensive" }],
  [31850,  { name: "Ardent Defender",           category: "defensive" }],
  [86659,  { name: "Guardian of Ancient Kings", category: "defensive" }],
  [633,    { name: "Lay on Hands",              category: "external"  }],
  [1022,   { name: "Blessing of Protection",    category: "external"  }],
  [6940,   { name: "Blessing of Sacrifice",     category: "external"  }],
  [204018, { name: "Blessing of Spellwarding",  category: "external"  }],
  // ── Priest ──
  [47788,  { name: "Guardian Spirit",           category: "external"  }],
  [33206,  { name: "Pain Suppression",          category: "external"  }],
  [19236,  { name: "Desperate Prayer",          category: "defensive" }],
  [62618,  { name: "Power Word: Barrier",       category: "external"  }],
  [271466, { name: "Luminous Barrier",          category: "external"  }],
  [15286,  { name: "Vampiric Embrace",          category: "defensive" }],
  [64843,  { name: "Divine Hymn",               category: "external"  }],
  [47585,  { name: "Dispersion",                category: "defensive" }],
  // ── Rogue ──
  [31224,  { name: "Cloak of Shadows",          category: "defensive" }],
  [5277,   { name: "Evasion",                   category: "defensive" }],
  // ── Shaman ──
  [108271, { name: "Astral Shift",              category: "defensive" }],
  [98008,  { name: "Spirit Link Totem",         category: "external"  }],
  [108280, { name: "Healing Tide Totem",        category: "external"  }],
  // ── Warlock ──
  [104773, { name: "Unending Resolve",          category: "defensive" }],
  [108416, { name: "Dark Pact",                 category: "defensive" }],
  // ── Warrior ──
  [871,    { name: "Shield Wall",               category: "defensive" }],
  [12975,  { name: "Last Stand",                category: "defensive" }],
  [184364, { name: "Enraged Regeneration",      category: "defensive" }],
  [97462,  { name: "Rallying Cry",              category: "external"  }],
  [118038, { name: "Die by the Sword",          category: "defensive" }],
]);

// Offensive CDs — copied verbatim from combatLogRunBuilder.js OFFENSIVE_COOLDOWNS (Overwolf parity).
// type: "group_offensive" = Bloodlust-class raid buff, "personal_offensive" = personal DPS CD.
const OFFENSIVE_COOLDOWNS = new Map([
  [2825,   { name: "Bloodlust",            type: "group_offensive",    cd: 300 }],
  [32182,  { name: "Heroism",              type: "group_offensive",    cd: 300 }],
  [80353,  { name: "Time Warp",            type: "group_offensive",    cd: 300 }],
  [264667, { name: "Primal Rage",          type: "group_offensive",    cd: 300 }],
  [390386, { name: "Fury of the Aspects",  type: "group_offensive",    cd: 300 }],
  [47568,  { name: "Empower Rune Weapon",  type: "personal_offensive", cd: 120 }],
  [207289, { name: "Unholy Assault",       type: "personal_offensive", cd: 90  }],
  [51271,  { name: "Pillar of Frost",      type: "personal_offensive", cd: 60  }],
  [275699, { name: "Apocalypse",           type: "personal_offensive", cd: 75  }],
  [191427, { name: "Metamorphosis (Havoc)", type: "personal_offensive", cd: 240 }],
  [258920, { name: "Immolation Aura",      type: "personal_offensive", cd: 30  }],
  [194223, { name: "Celestial Alignment",  type: "personal_offensive", cd: 180 }],
  [106951, { name: "Berserk (Feral)",      type: "personal_offensive", cd: 180 }],
  [375087, { name: "Dragonrage",           type: "personal_offensive", cd: 120 }],
  [288613, { name: "Trueshot",             type: "personal_offensive", cd: 120 }],
  [19574,  { name: "Bestial Wrath",        type: "personal_offensive", cd: 90  }],
  [360952, { name: "Coordinated Assault",  type: "personal_offensive", cd: 120 }],
  [12472,  { name: "Icy Veins",            type: "personal_offensive", cd: 120 }],
  [190319, { name: "Combustion",           type: "personal_offensive", cd: 120 }],
  [365350, { name: "Arcane Surge",         type: "personal_offensive", cd: 90  }],
  [137639, { name: "Storm, Earth, and Fire", type: "personal_offensive", cd: 90 }],
  [152173, { name: "Serenity",             type: "personal_offensive", cd: 90  }],
  [31884,  { name: "Avenging Wrath",       type: "personal_offensive", cd: 120 }],
  [231895, { name: "Crusade",              type: "personal_offensive", cd: 120 }],
  [10060,  { name: "Power Infusion",       type: "personal_offensive", cd: 120 }],
  [228260, { name: "Void Eruption",        type: "personal_offensive", cd: 90  }],
  [13750,  { name: "Adrenaline Rush",      type: "personal_offensive", cd: 180 }],
  [121471, { name: "Shadow Blades",        type: "personal_offensive", cd: 180 }],
  [360194, { name: "Deathmark",            type: "personal_offensive", cd: 120 }],
  [114050, { name: "Ascendance",           type: "personal_offensive", cd: 180 }],
  [191634, { name: "Stormkeeper",          type: "personal_offensive", cd: 60  }],
  [51533,  { name: "Feral Spirit",         type: "personal_offensive", cd: 90  }],
  [1122,   { name: "Summon Infernal",      type: "personal_offensive", cd: 180 }],
  [111898, { name: "Grimoire: Felguard",   type: "personal_offensive", cd: 120 }],
  [205180, { name: "Summon Darkglare",     type: "personal_offensive", cd: 120 }],
  [107574, { name: "Avatar",               type: "personal_offensive", cd: 90  }],
  [1719,   { name: "Recklessness",         type: "personal_offensive", cd: 90  }],
  [227847, { name: "Bladestorm",           type: "personal_offensive", cd: 90  }],
  [228920, { name: "Ravager",              type: "personal_offensive", cd: 90  }],
]);

const INTERRUPT_SPELLS = new Set([
  47528,  // Mind Freeze (DK)
  183752, // Consume Magic (DH)
  78675,  // Solar Beam (Druid)
  106839, // Skull Bash (Druid)
  351338, // Quell (Evoker)
  147362, // Counter Shot (Hunter)
  187707, // Muzzle (Hunter)
  2139,   // Counterspell (Mage)
  116705, // Spear Hand Strike (Monk)
  96231,  // Rebuke (Paladin)
  15487,  // Silence (Priest)
  1766,   // Kick (Rogue)
  57994,  // Wind Shear (Shaman)
  6552,   // Pummel (Warrior)
  119910, // Spell Lock (Warlock Felhunter)
]);

// Player-cast CC applied to NPCs. Narrow allowlist keeps noise out of the
// Stuns overlay — incapacitates and high-value roots included for M+ utility.
// Frontend at UnifiedRunTimeline.tsx:522 consumes these via pull.ccEvents[].
const CC_SPELL_IDS = new Set([
  // Stuns
  853,     // Hammer of Justice (Paladin)
  119381,  // Leg Sweep (Monk)
  30283,   // Shadowfury (Warlock)
  179057,  // Chaos Nova (Demon Hunter)
  46968,   // Shockwave (Warrior)
  5211,    // Mighty Bash (Druid)
  199530,  // Sundering (Shaman)
  108194,  // Asphyxiate (Death Knight)
  221562,  // Asphyxiate (Unholy DK)
  91800,   // Gnaw (DK Ghoul)
  24394,   // Intimidation (Hunter)
  255723,  // Bull Rush (Highmountain Tauren racial)
  20549,   // War Stomp (Tauren racial)
  1833,    // Cheap Shot (Rogue)
  408,     // Kidney Shot (Rogue)
  192058,  // Capacitor Totem (Shaman)
  372245,  // Terror of the Skies (Evoker)
  // Incapacitates
  6770,    // Sap (Rogue)
  2094,    // Blind (Rogue)
  118,     // Polymorph (Mage)
  28272,   // Polymorph Pig
  28271,   // Polymorph Turtle
  61305,   // Polymorph Cat
  61721,   // Polymorph Rabbit
  61780,   // Polymorph Turkey
  161354,  // Polymorph Monkey
  277787,  // Polymorph Direhorn
  277792,  // Polymorph Bumblebee
  391622,  // Polymorph Duck
  710,     // Banish (Warlock)
  6358,    // Seduction (Warlock pet)
  187650,  // Freezing Trap (Hunter)
  3355,    // Freezing Trap debuff ID (Hunter)
  20066,   // Repentance (Paladin)
  9484,    // Shackle Undead (Priest)
  // Roots
  339,     // Entangling Roots (Druid)
  102359,  // Mass Entanglement (Druid)
  122,     // Frost Nova (Mage)
]);

// ─── Constants ────────────────────────────────────────────────────────────────

const SEGMENT_TOLERANCE_MS    = 1500;
const PRE_DEATH_WINDOW_MS     = 8000;
const PRE_DEATH_HIT_BUFFER_MS = 10000;
const PRE_DEATH_HIT_MAX       = 5;
const DAMAGE_BUCKET_MS        = 1000;

// Spike thresholds (ChatGPT approved: hybrid)
const SPIKE_THRESHOLD_ABSOLUTE = 80000;
const SPIKE_THRESHOLD_PCT      = 0.30;
const ESTIMATED_PLAYER_HP      = 800000; // conservative Season 1 baseline
const SPIKE_THRESHOLD_RELATIVE = Math.floor(SPIKE_THRESHOLD_PCT * ESTIMATED_PLAYER_HP); // 240,000

// ─── GUID helpers ─────────────────────────────────────────────────────────────

function isPlayerGuid(guid) {
  return typeof guid === "string" && guid.startsWith("Player-");
}

function isCreatureGuid(guid) {
  return typeof guid === "string" && guid.startsWith("Creature-");
}

function npcIdFromGuid(guid) {
  if (!isCreatureGuid(guid)) return null;
  const parts = guid.split("-");
  if (parts.length >= 6) {
    const id = parseInt(parts[5], 10);
    return isNaN(id) ? null : id;
  }
  return null;
}

// ── Advanced combat log detection ──────────────────────────────────────────
// ADVANCED_LOG_ENABLED=1 inserts a 19-field info block after the spell prefix.

const ADVANCED_INFO_FIELD_COUNT = 19;

function hasAdvancedInfo(fields, checkIndex) {
  const val = fields[checkIndex] || "";
  return val.includes("-") || val === "0000000000000000";
}

function isHostileUnit(flagsHex) {
  const flags = parseInt(flagsHex, 16);
  if (isNaN(flags)) return false;
  return (flags & 0x40) !== 0;  // COMBATLOG_OBJECT_REACTION_HOSTILE
}

// ─── GUID → Class/Role/Spec Map Builder ───────────────────────────────────────
// PRIMARY: Addon provides guid on player + partyMembers
// FALLBACK: Spell-based detection (last resort only per ChatGPT ruling)

function buildGuidMap(run) {
  const guidToClass = new Map();
  const guidToRole  = new Map();
  const guidToSpec  = new Map();

  // Seed from recording player
  if (run.player) {
    const pg = run.player.guid;
    if (pg) {
      guidToClass.set(pg, run.player.class || "UNKNOWN");
      guidToRole.set(pg,  run.player.role  || "unknown");
      guidToSpec.set(pg,  run.player.spec  || "");
    }
  }

  // Seed from party members (V1.3: now includes guid field from addon)
  if (Array.isArray(run.partyMembers)) {
    for (const m of run.partyMembers) {
      if (m.guid) {
        guidToClass.set(m.guid, m.class || "UNKNOWN");
        guidToRole.set(m.guid,  m.role  || "unknown");
        guidToSpec.set(m.guid,  m.spec  || "");
      }
    }
  }

  return { guidToClass, guidToRole, guidToSpec };
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

  for (const seg of segments) {
    const start = seg.startTs  - SEGMENT_TOLERANCE_MS;
    const end_  = seg.finishTs + SEGMENT_TOLERANCE_MS;
    if (normalizedTs >= start && normalizedTs <= end_) {
      const distance = Math.max(0,
        normalizedTs < seg.startTs  ? seg.startTs  - normalizedTs :
        normalizedTs > seg.finishTs ? normalizedTs - seg.finishTs : 0
      );
      return { segmentId: seg.segmentId, matchType: distance === 0 ? "exact" : "tolerance", distanceMs: distance };
    }
  }

  let nearest = null, minDist = Infinity;
  for (const seg of segments) {
    const dist = Math.min(Math.abs(normalizedTs - seg.startTs), Math.abs(normalizedTs - seg.finishTs));
    if (dist < minDist) { minDist = dist; nearest = seg; }
  }
  if (nearest) return { segmentId: nearest.segmentId, matchType: "nearest", distanceMs: minDist };
  return { segmentId: null, matchType: "none", distanceMs: Infinity };
}

// ─── Main parser ──────────────────────────────────────────────────────────────

function parseCombatLog({ run, combatLogLines, partyGuids = [] }) {
  const segments = run.combatSegments || [];

  // ── Build GUID map (PRIMARY: addon-provided GUIDs) ──────────────────────────
  const { guidToClass, guidToRole, guidToSpec } = buildGuidMap(run);
  let playerGuid = run.player?.guid || null;

  // ── Equipment-use registry (per Track A WI1 redesign) ───────────────────────
  // Addon snapshots equipped slot-11/12/13/14 spell IDs into run.equipmentRegistry
  // at run start. Build a lookup so SPELL_CAST_SUCCESS for any equipment-use spell
  // gets routed as a trinket_offensive cooldown without needing a hardcoded
  // allowlist. Defensive trinkets/rings classified as offensive for now —
  // pre-classification needs item-tooltip parsing the addon doesn't expose.
  const equipmentBySpellId = new Map();
  if (Array.isArray(run.equipmentRegistry)) {
    for (const e of run.equipmentRegistry) {
      const sid = Number(e?.spellId) || 0;
      if (sid > 0) equipmentBySpellId.set(sid, e);
    }
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────────
  const diag = {
    totalLinesRead           : 0,
    relevantEventsRead       : 0,
    clockOffsetMs            : null,
    clockSyncConfidence      : "unknown",
    unmatchedEventCount      : 0,
    eventsMatchedExactly     : 0,
    eventsMatchedByTolerance : 0,
    eventsMatchedByNearest   : 0,
  };

  // ── Clock sync ───────────────────────────────────────────────────────────────
  const addonStartTs = run.startTs || 0;
  let clockOffsetMs  = 0;

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

  // Clock sync confidence check
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
    diag.clockSyncConfidence = fitRate >= 0.6 ? "high" : fitRate >= 0.3 ? "medium" : "low";
  } else {
    diag.clockSyncConfidence = addonStartTs === 0 ? "failed" : "medium";
  }

  // ── Per-player rolling damage buffer ─────────────────────────────────────────
  const damageBuffers = new Map();

  function getDamageBuffer(guid) {
    if (!damageBuffers.has(guid)) damageBuffers.set(guid, []);
    return damageBuffers.get(guid);
  }

  function pushToDamageBuffer(guid, hit) {
    const buf = getDamageBuffer(guid);
    buf.push(hit);
    const cutoff = hit.normalizedTs - PRE_DEATH_HIT_BUFFER_MS;
    while (buf.length > 0 && buf[0].normalizedTs < cutoff) buf.shift();
  }

  // ── Per-segment accumulators ─────────────────────────────────────────────────
  const segmentData = new Map();

  function getSegData(segmentId) {
    if (!segmentData.has(segmentId)) {
      segmentData.set(segmentId, {
        deaths         : [],
        cooldownEvents : [],
        defensives     : [],
        offensiveCDs   : [],
        interrupts     : [],
        enemyCasts     : [],
        ccEvents       : [],
        spikes         : [],
        absorbs        : [],
        buckets        : new Map(),
        deathCounter   : 0,
        cdCounter      : 0,
        intCounter     : 0,
        ecCounter      : 0,
        ccCounter      : 0,
        spikeCounter   : 0,
        absorbCounter  : 0,
      });
    }
    return segmentData.get(segmentId);
  }

  function getSegment(segmentId) {
    return segments.find(s => s.segmentId === segmentId) || null;
  }

  function extractTopSpells(hits, count) {
    const spellMap = new Map();
    for (const h of hits) {
      const key = h.spellId || 0;
      if (!spellMap.has(key)) {
        spellMap.set(key, { spellId: h.spellId, spellName: h.spellName, school: h.school, totalDamage: 0, hitCount: 0 });
      }
      const entry = spellMap.get(key);
      entry.totalDamage += h.amount;
      entry.hitCount++;
    }
    return [...spellMap.values()]
      .sort((a, b) => b.totalDamage - a.totalDamage)
      .slice(0, count)
      .map(s => ({ spellId: s.spellId, spellName: s.spellName, school: s.school, totalDamage: s.totalDamage, hitCount: s.hitCount }));
  }

  function ensureBucket(segData, seg, bucketIdx) {
    if (!segData.buckets.has(bucketIdx)) {
      const bucketStartTs = seg.startTs + bucketIdx * DAMAGE_BUCKET_MS;
      segData.buckets.set(bucketIdx, {
        bucketIdx,
        bucketStartTs,
        bucketEndTs            : bucketStartTs + DAMAGE_BUCKET_MS,
        durationMs             : DAMAGE_BUCKET_MS,
        partyDamageTaken       : 0,
        tankDamageTaken        : 0,
        healerDamageTaken      : 0,
        dpsDamageTaken         : 0,
        partyHealingReceived   : 0,
        tankHealingReceived    : 0,
        partyOverhealing       : 0,
        tankOverhealing        : 0,
        deathCountInBucket     : 0,
        byPlayer               : {},
      });
    }
    return segData.buckets.get(bucketIdx);
  }

  // ── Fallback GUID detection (spell-based — LAST RESORT ONLY) ─────────────────
  // Only used if addon didn't provide guid on a party member

  function tryDetectPlayerFromCast(sourceGuid, spellId) {
    if (!isPlayerGuid(sourceGuid)) return;
    if (guidToClass.has(sourceGuid)) return; // already known

    // Detect recording player's GUID on first player cast
    if (!playerGuid) {
      playerGuid = sourceGuid;
      if (run.player?.class) guidToClass.set(sourceGuid, run.player.class);
      if (run.player?.role)  guidToRole.set(sourceGuid,  run.player.role);
      if (run.player?.spec)  guidToSpec.set(sourceGuid,  run.player.spec);
      return;
    }

    // For unknown party GUIDs: try to match against unmatched partyMembers by class
    // This is fallback — we try to infer from defensive/interrupt spells
    if (DEFENSIVE_CD_SPELLS.has(spellId) || INTERRUPT_SPELLS.has(spellId)) {
      // We know this GUID is a player but we don't know their class
      // Mark as detected but unresolved — will attempt match after parse
      if (!guidToClass.has(sourceGuid)) {
        guidToClass.set(sourceGuid, "DETECTED");
        guidToRole.set(sourceGuid, "unknown");
      }
    }
  }

  // ── Event processors ─────────────────────────────────────────────────────────

  function processUnitDied(fields, normalizedTs, segmentId) {
    const destGuid = fields[5] || "";
    if (!isPlayerGuid(destGuid)) return;

    const seg     = getSegment(segmentId);
    const segData = getSegData(segmentId);
    segData.deathCounter++;
    const deathId = `${run.runId || "unk"}-${segmentId}-d${segData.deathCounter}`;

    const buf        = getDamageBuffer(destGuid);
    const cutoff     = normalizedTs - PRE_DEATH_WINDOW_MS;
    const windowHits = buf.filter(h => h.normalizedTs >= cutoff);
    const preDeathHits = windowHits.slice(-PRE_DEATH_HIT_MAX).map(h => ({
      normalizedTs  : h.normalizedTs,
      offsetMs      : seg ? h.normalizedTs - seg.startTs : 0,
      spellId       : h.spellId,
      spellName     : h.spellName,
      amount        : h.amount,
      overkill      : h.overkill,
      school        : h.school,
      sourceNpcId   : h.sourceNpcId,
      sourceNpcName : h.sourceNpcName,
    }));

    const kbHit = [...windowHits].reverse().find(h => h.overkill > 0)
               || windowHits[windowHits.length - 1]
               || null;

    const killingBlow = kbHit ? {
      spellId       : kbHit.spellId,
      spellName     : kbHit.spellName,
      amount        : kbHit.amount,
      overkill      : kbHit.overkill,
      school        : kbHit.school,
      sourceNpcId   : kbHit.sourceNpcId,
      sourceNpcName : kbHit.sourceNpcName,
    } : null;

    segData.deaths.push({
      deathId,
      segmentId,
      deathTs              : normalizedTs,
      offsetMs             : seg ? normalizedTs - seg.startTs : 0,
      playerGuid           : destGuid,
      class                : guidToClass.get(destGuid) || "UNKNOWN",
      role                 : guidToRole.get(destGuid)  || "unknown",
      spec                 : guidToSpec.get(destGuid)  || "",
      firstDeathInPull     : false,
      killingBlow,
      preDeathHits,
      defensiveCastHistory : [],
    });

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
      // Swing: no spell prefix — advanced info starts at field 9
      const swingAdvStart = 9;
      const swingHasAdv = hasAdvancedInfo(fields, swingAdvStart);
      const swingSuffixStart = swingHasAdv ? swingAdvStart + ADVANCED_INFO_FIELD_COUNT : swingAdvStart;
      amount   = parseInt(fields[swingSuffixStart],     10) || 0;
      overkill = parseInt(fields[swingSuffixStart + 1], 10) || 0;
      school   = fields[swingSuffixStart + 2] || "1";
    } else {
      // Spell/Range/Periodic: spell prefix at fields 9-11, check for advanced info at 12
      spellId   = parseInt(fields[9],  10) || 0;
      spellName = (fields[10] || "").replace(/"/g, "");
      school    = fields[11] || "0";
      const advStart = 12;
      const hasAdv = hasAdvancedInfo(fields, advStart);
      const suffixStart = hasAdv ? advStart + ADVANCED_INFO_FIELD_COUNT : advStart;
      amount    = parseInt(fields[suffixStart],     10) || 0;
      overkill  = parseInt(fields[suffixStart + 1], 10) || 0;
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
      if (role === "healer") bucket.healerDamageTaken  += amount;
      if (role === "dps")    bucket.dpsDamageTaken     += amount;

      // Per-player damage tracking
      if (!bucket.byPlayer[destGuid]) {
        bucket.byPlayer[destGuid] = { guid: destGuid, damage: 0, topHits: [] };
      }
      const playerBucket = bucket.byPlayer[destGuid];
      playerBucket.damage += amount;
      playerBucket.topHits.push({ spellId, spellName, amount, school });
      if (playerBucket.topHits.length > 10) {
        playerBucket.topHits.sort((a, b) => b.amount - a.amount);
        playerBucket.topHits = playerBucket.topHits.slice(0, 10);
      }
    }

    // ── Spike detection (hybrid threshold — ChatGPT approved) ──────────────────
    if (amount >= SPIKE_THRESHOLD_ABSOLUTE || amount >= SPIKE_THRESHOLD_RELATIVE) {
      const seg2    = getSegment(segmentId);
      const segData = getSegData(segmentId);
      segData.spikeCounter++;
      segData.spikes.push({
        spikeId       : `${run.runId || "unk"}-${segmentId}-sp${segData.spikeCounter}`,
        segmentId,
        spikeTs       : normalizedTs,
        offsetMs      : seg2 ? normalizedTs - seg2.startTs : 0,
        damage        : amount,
        targetGuid    : destGuid,
        targetRole    : guidToRole.get(destGuid) || "unknown",
        spellId,
        spellName,
        school,
        sourceNpcId,
        sourceNpcName,
      });
    }
  }

  // ── Healing received (V1.3 — effective healing + overhealing) ─────────────────

  function processIncomingHealing(fields, normalizedTs, segmentId) {
    const destGuid = fields[5] || "";
    if (!isPlayerGuid(destGuid)) return;

    const spellId     = parseInt(fields[9],  10) || 0;
    const spellName   = (fields[10] || "").replace(/"/g, "");
    // Heal suffix: spell prefix at fields 9-11, check for advanced info at field 12
    const healAdvStart = 12;
    const healHasAdv = hasAdvancedInfo(fields, healAdvStart);
    const healSuffixStart = healHasAdv ? healAdvStart + ADVANCED_INFO_FIELD_COUNT : healAdvStart;
    const amount      = parseInt(fields[healSuffixStart], 10) || 0;
    const overhealing = parseInt(fields[healSuffixStart + 1], 10) || 0;
    const effective   = Math.max(0, amount - overhealing);

    const seg = getSegment(segmentId);
    if (seg && (effective > 0 || overhealing > 0)) {
      const segData = getSegData(segmentId);
      const bIdx    = Math.floor((normalizedTs - seg.startTs) / DAMAGE_BUCKET_MS);
      const bucket  = ensureBucket(segData, seg, bIdx);
      const role    = guidToRole.get(destGuid) || "unknown";

      bucket.partyHealingReceived += effective;
      bucket.partyOverhealing     += overhealing;

      if (role === "tank") {
        bucket.tankHealingReceived += effective;
        bucket.tankOverhealing     += overhealing;
      }
    }
  }

  function processPlayerCast(fields, normalizedTs, segmentId) {
    const sourceGuid = fields[1] || "";
    const destGuid   = fields[5] || "";
    const destName   = (fields[6] || "").replace(/"/g, "");
    const spellId    = parseInt(fields[9],  10) || 0;
    const spellName  = (fields[10] || "").replace(/"/g, "");

    if (!isPlayerGuid(sourceGuid)) return;

    // Fallback GUID detection (last resort — only if addon didn't provide guid)
    tryDetectPlayerFromCast(sourceGuid, spellId);

    const seg     = getSegment(segmentId);
    const segData = getSegData(segmentId);

    // Defensive cooldown — dual-populate: legacy cooldownEvents + Overwolf-parity defensives with category
    const defInfo = DEFENSIVE_CD_SPELLS.get(spellId);
    if (defInfo) {
      segData.cdCounter++;
      segData.cooldownEvents.push({
        cooldownEventId : `${run.runId || "unk"}-${segmentId}-cd${segData.cdCounter}`,
        segmentId,
        castTs   : normalizedTs,
        offsetMs : seg ? normalizedTs - seg.startTs : 0,
        spellId,
        spellName,
        sourceGuid,
        class    : guidToClass.get(sourceGuid) || "UNKNOWN",
        role     : guidToRole.get(sourceGuid)  || "unknown",
        spec     : guidToSpec.get(sourceGuid)  || "",
      });
      segData.defensives.push({
        ts       : normalizedTs,
        offsetMs : seg ? normalizedTs - seg.startTs : 0,
        spellId,
        spellName: defInfo.name || spellName,
        name     : (fields[2] || "").replace(/"/g, "") || "Unknown",
        class    : guidToClass.get(sourceGuid) || "UNKNOWN",
        role     : guidToRole.get(sourceGuid)  || "unknown",
        spec     : guidToSpec.get(sourceGuid)  || "",
        category : defInfo.category,
      });
    }

    // Offensive cooldown (Bloodlust, personal DPS CDs) — Overwolf parity
    const offInfo = OFFENSIVE_COOLDOWNS.get(spellId);
    if (offInfo && segData.offensiveCDs.length < 30) {
      const playerName = (fields[2] || "").replace(/"/g, "") || "Unknown";
      const isDupe = segData.offensiveCDs.some(o =>
        o.spellId === spellId && o.name === playerName && Math.abs(o.ts - normalizedTs) < 1000
      );
      if (!isDupe) {
        segData.offensiveCDs.push({
          ts       : normalizedTs,
          offsetMs : seg ? normalizedTs - seg.startTs : 0,
          spellId,
          spellName: offInfo.name,
          name     : playerName,
          class    : guidToClass.get(sourceGuid) || "UNKNOWN",
          role     : guidToRole.get(sourceGuid)  || "unknown",
          cdType   : offInfo.type,
        });
      }
    }

    // Equipment-use cooldown (trinket / on-use ring) — registry-driven match
    const equipMeta = equipmentBySpellId.get(spellId);
    if (equipMeta) {
      segData.cdCounter++;
      segData.cooldownEvents.push({
        cooldownEventId : `${run.runId || "unk"}-${segmentId}-cd${segData.cdCounter}`,
        segmentId,
        castTs   : normalizedTs,
        offsetMs : seg ? normalizedTs - seg.startTs : 0,
        spellId,
        spellName : spellName || equipMeta.spellName || "",
        sourceGuid,
        class    : guidToClass.get(sourceGuid) || "UNKNOWN",
        role     : guidToRole.get(sourceGuid)  || "unknown",
        spec     : guidToSpec.get(sourceGuid)  || "",
        cdType   : "trinket_offensive",
        itemId   : equipMeta.itemId || 0,
        itemName : equipMeta.itemName || "",
        itemIcon : equipMeta.itemIcon || "",
        slot     : equipMeta.slot || 0,
      });
    }

    // Interrupt detection moved to SPELL_INTERRUPT event handler (processSpellInterrupt)
    // which can extract the actual interrupted spell name/ID from the combat log.
  }

  function processEnemyCast(fields, normalizedTs, segmentId, event) {
    const sourceGuid = fields[1] || "";
    const sourceName = (fields[2] || "").replace(/"/g, "");
    const sourceFlags = fields[3] || "0";
    if (!isCreatureGuid(sourceGuid)) return;
    if (!isHostileUnit(sourceFlags)) return;  // Skip friendly creatures (Mirror Image, pets, totems)

    const spellId   = parseInt(fields[9],  10) || 0;
    const spellName = (fields[10] || "").replace(/"/g, "");
    const spellSchool = fields[11] || "0";
    if (!spellId) return;

    const seg     = getSegment(segmentId);
    const segData = getSegData(segmentId);
    segData.ecCounter++;
    segData.enemyCasts.push({
      enemyCastId        : `${run.runId || "unk"}-${segmentId}-ec${segData.ecCounter}`,
      segmentId,
      castStartTs        : normalizedTs,
      castStartOffsetMs  : seg ? normalizedTs - seg.startTs : 0,
      enemyGuid          : sourceGuid,
      npcId              : npcIdFromGuid(sourceGuid),
      npcName            : sourceName || null,
      spellId,
      spellName,
      spellSchool,
      castOutcome        : event === "SPELL_CAST_SUCCESS" ? "success" : "casting",
      interruptAttempted : false,
    });
  }

  // ── SPELL_INTERRUPT — extract interrupted spell with advanced info detection ──

  function processSpellInterrupt(fields, normalizedTs, segmentId) {
    const sourceGuid = fields[1] || "";
    const destGuid   = fields[5] || "";
    const destName   = (fields[6] || "").replace(/"/g, "");
    if (!isPlayerGuid(sourceGuid)) return;

    const spellId   = parseInt(fields[9], 10) || 0;
    const spellName = (fields[10] || "").replace(/"/g, "");

    // Detect advanced info block for interrupted spell extraction
    const intAdvStart = 12;
    const intHasAdv = hasAdvancedInfo(fields, intAdvStart);
    const intSuffixStart = intHasAdv ? intAdvStart + ADVANCED_INFO_FIELD_COUNT : intAdvStart;

    const interruptedSpellId   = parseInt(fields[intSuffixStart], 10) || 0;
    const interruptedSpellName = (fields[intSuffixStart + 1] || "").replace(/"/g, "");

    const seg     = getSegment(segmentId);
    const segData = getSegData(segmentId);
    segData.intCounter++;
    segData.interrupts.push({
      interruptId    : `${run.runId || "unk"}-${segmentId}-int${segData.intCounter}`,
      segmentId,
      interruptTs    : normalizedTs,
      offsetMs       : seg ? normalizedTs - seg.startTs : 0,
      sourceGuid,
      sourceClass    : guidToClass.get(sourceGuid) || "UNKNOWN",
      sourceRole     : guidToRole.get(sourceGuid)  || "unknown",
      targetGuid     : destGuid,
      targetNpcId    : npcIdFromGuid(destGuid),
      targetNpcName  : destName || null,
      spellId,
      spellName,
      targetSpellId  : interruptedSpellId,
      targetSpellName: interruptedSpellName,
      result         : "success",
    });
  }

  // ── SPELL_AURA_APPLIED — capture player-cast CC/stuns on NPCs ──────────────
  // Frontend Stuns overlay (UnifiedRunTimeline.tsx:522) consumes pull.ccEvents[].
  // Shape mirrors cooldownEvents: source + target names, spellId/spellName,
  // offsetMs relative to segment start. Only CC_SPELL_IDS entries land here —
  // everything else (player buffs, non-CC debuffs) is filtered out up front.

  function processSpellAuraApplied(fields, normalizedTs, segmentId) {
    if (fields.length < 13) return;

    const auraType = (fields[12] || "").replace(/"/g, "");
    if (auraType !== "DEBUFF") return;

    const sourceGuid = (fields[1] || "").replace(/"/g, "");
    const destGuid   = (fields[5] || "").replace(/"/g, "");

    if (!sourceGuid.startsWith("Player-")) return;
    if (!destGuid.startsWith("Creature-") && !destGuid.startsWith("Vehicle-")) return;

    const spellId = parseInt((fields[9] || "").replace(/"/g, ""), 10);
    if (!CC_SPELL_IDS.has(spellId)) return;

    const seg     = getSegment(segmentId);
    const segData = getSegData(segmentId);

    const sourceNameRaw = (fields[2] || "").replace(/"/g, "");
    const playerName    = sourceNameRaw.split("-")[0];
    const targetName    = (fields[6] || "").replace(/"/g, "");
    const spellName     = (fields[10] || "").replace(/"/g, "");

    segData.ccCounter++;
    segData.ccEvents.push({
      ccEventId  : `${run.runId || "unk"}-${segmentId}-cc${segData.ccCounter}`,
      segmentId,
      castTs     : normalizedTs,
      offsetMs   : seg ? normalizedTs - seg.startTs : 0,
      spellId,
      spellName,
      sourceGuid,
      playerName,
      targetName,
      targetGuid : destGuid,
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
    "SPELL_INTERRUPT",
    "SPELL_HEAL",
    "SPELL_PERIODIC_HEAL",
    "SPELL_ABSORBED",
    "SPELL_AURA_APPLIED",
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
      case "SPELL_INTERRUPT":
        processSpellInterrupt(fields, normalizedTs, segmentId);
        break;
      case "SPELL_HEAL":
      case "SPELL_PERIODIC_HEAL":
        processIncomingHealing(fields, normalizedTs, segmentId);
        break;
      case "SPELL_ABSORBED":
        processSpellAbsorbed(fields, normalizedTs, segmentId);
        break;
      case "SPELL_AURA_APPLIED":
        processSpellAuraApplied(fields, normalizedTs, segmentId);
        break;
    }
  }

  // ── SPELL_ABSORBED ─────────────────────────────────────────────────────────
  // Field layout is variable: when a SPELL hit was absorbed there are 3 spell
  // fields up front (the original damaging spell), when a SWING hit was
  // absorbed those fields are absent. Normalize by walking from the END of
  // the fields (always: absorbSpellId, absorbSpellName, absorbSpellSchool,
  // absorbedAmount, critical) and from the FRONT (always: src + dest blocks).
  // Cap per segment to 100 to bound payload growth on heavy-shield comps.
  // Absorbs ship as a separate stream this pass — spike-merge integration
  // (so a 300k-hit-150k-absorbed reads as 300k for spike threshold) is a
  // follow-up; data capture beats perfect analytics.
  function processSpellAbsorbed(fields, normalizedTs, segmentId) {
    const seg = getSegment(segmentId);
    if (!seg) return;
    const segData = getSegData(segmentId);
    if (segData.absorbs.length >= 100) return;

    // Front block: dest is at offsets 5-8, source at 1-4 (combat-log convention).
    const destGuid = (fields[5] || "").replace(/"/g, "");
    const destName = (fields[6] || "").replace(/"/g, "");
    if (!destGuid) return;

    // Tail block: last 5 fields are absorbSpellId, absorbSpellName,
    // absorbSpellSchool, absorbedAmount, critical.
    const n = fields.length;
    const absorbedAmount = parseInt(fields[n - 2], 10) || 0;
    if (absorbedAmount <= 0) return;
    const absorbSpellSchool = parseInt(fields[n - 3], 10) || 0;
    const absorbSpellName = (fields[n - 4] || "").replace(/"/g, "");
    const absorbSpellId = parseInt(fields[n - 5], 10) || 0;

    // sourceHit is the spell that was absorbed. Heuristic: when the field
    // count indicates there was a SPELL_* prefix, fields[9..11] hold it;
    // otherwise (SWING_DAMAGE absorbed) those fields are absent.
    let sourceHitSpellId = 0;
    let sourceHitSpellName = "";
    if (n >= 19) {
      sourceHitSpellId = parseInt(fields[9], 10) || 0;
      sourceHitSpellName = (fields[10] || "").replace(/"/g, "");
    }

    segData.absorbCounter++;
    segData.absorbs.push({
      absorbId       : `${run.runId || "unk"}-${segmentId}-ab${segData.absorbCounter}`,
      segmentId,
      absorbTs       : normalizedTs,
      offsetMs       : normalizedTs - seg.startTs,
      destGuid,
      destName,
      absorbSpellId,
      absorbSpellName,
      absorbSpellSchool,
      absorbedAmount,
      sourceHitSpellId,
      sourceHitSpellName,
    });
  }

  // ── Build death chains per segment ──────────────────────────────────────────

  function buildDeathChain(deaths) {
    if (!deaths || deaths.length === 0) return null;
    const sorted   = [...deaths].sort((a, b) => a.deathTs - b.deathTs);
    const timeSpan = sorted[sorted.length - 1].deathTs - sorted[0].deathTs;
    return {
      totalDeaths : deaths.length,
      isWipe      : deaths.length >= 5,
      timeSpanMs  : timeSpan,
      sequence    : sorted.map(d => ({
        deathId          : d.deathId,
        offsetMs         : d.offsetMs,
        role             : d.role,
        class            : d.class,
        spec             : d.spec,
        killingSpellName : d.killingBlow?.spellName || null,
      })),
    };
  }

  // ── Assemble output ──────────────────────────────────────────────────────────

  const enrichedSegments = [];

  for (const seg of segments) {
    const data = segmentData.get(seg.segmentId);

    if (!data) {
      enrichedSegments.push({
        segmentId      : seg.segmentId,
        deaths         : [],
        cooldownEvents : [],
        defensives     : [],
        offensiveCDs   : [],
        interrupts     : [],
        enemyCasts     : [],
        ccEvents       : [],
        spikes         : [],
        damageBuckets  : [],
        deathChain     : null,
      });
      continue;
    }

    data.deaths.sort((a, b) => a.deathTs - b.deathTs);
    if (data.deaths.length > 0) data.deaths[0].firstDeathInPull = true;

    const damageBuckets = [...data.buckets.values()]
      .sort((a, b) => a.bucketIdx - b.bucketIdx)
      .map(b => ({
        segmentId              : seg.segmentId,
        bucketStartTs          : b.bucketStartTs,
        bucketEndTs            : b.bucketEndTs,
        durationMs             : b.durationMs,
        partyDamageTaken       : b.partyDamageTaken,
        tankDamageTaken        : b.tankDamageTaken,
        healerDamageTaken      : b.healerDamageTaken,
        dpsDamageTaken         : b.dpsDamageTaken,
        partyHealingReceived   : b.partyHealingReceived,
        tankHealingReceived    : b.tankHealingReceived,
        partyOverhealing       : b.partyOverhealing,
        tankOverhealing        : b.tankOverhealing,
        deathCountInBucket     : b.deathCountInBucket,
        byPlayer               : Object.values(b.byPlayer).map(p => ({
          guid: p.guid,
          damage: p.damage,
          topSpells: extractTopSpells(p.topHits, 3),
        })),
      }));

    enrichedSegments.push({
      segmentId      : seg.segmentId,
      deaths         : data.deaths,
      cooldownEvents : data.cooldownEvents.filter(cd => isPlayerGuid(cd.sourceGuid)),
      defensives     : data.defensives,
      offensiveCDs   : data.offensiveCDs,
      interrupts     : data.interrupts,
      enemyCasts     : data.enemyCasts,
      ccEvents       : data.ccEvents.filter(cc => isPlayerGuid(cc.sourceGuid)),
      spikes         : data.spikes,
      absorbs        : data.absorbs,
      damageBuckets,
      deathChain     : buildDeathChain(data.deaths),
    });
  }

  // ── Data quality output (ChatGPT required) ──────────────────────────────────

  const allPlayerGuidsDetected = new Set();
  for (const [guid] of guidToClass) {
    if (isPlayerGuid(guid)) allPlayerGuidsDetected.add(guid);
  }
  const guidsWithRole = [...allPlayerGuidsDetected].filter(g => {
    const r = guidToRole.get(g);
    return r && r !== "unknown";
  });
  const guidsWithClass = [...allPlayerGuidsDetected].filter(g => {
    const c = guidToClass.get(g);
    return c && c !== "UNKNOWN" && c !== "DETECTED";
  });

  const totalRelevant = diag.relevantEventsRead || 1;
  const matchedPct = (diag.eventsMatchedExactly + diag.eventsMatchedByTolerance) / totalRelevant;

  const dataQuality = {
    eventCoverage              : matchedPct >= 0.7 ? "high" : matchedPct >= 0.4 ? "medium" : "low",
    guidCompleteness           : guidsWithClass.length,
    totalPlayerGuidsDetected   : allPlayerGuidsDetected.size,
    totalPlayerGuidsWithRole   : guidsWithRole.length,
    totalPlayerGuidsWithClass  : guidsWithClass.length,
    missingFields              : [],
  };

  if (guidsWithClass.length < 5) dataQuality.missingFields.push("incomplete_guid_class_mapping");
  if (guidsWithRole.length < 5)  dataQuality.missingFields.push("incomplete_guid_role_mapping");
  if (diag.clockSyncConfidence === "low" || diag.clockSyncConfidence === "failed") {
    dataQuality.missingFields.push("clock_sync_unreliable");
  }

  // ── Capability flags ─────────────────────────────────────────────────────────

  const allDeaths  = enrichedSegments.flatMap(s => s.deaths);
  const allBuckets = enrichedSegments.flatMap(s => s.damageBuckets);
  const allInts    = enrichedSegments.flatMap(s => s.interrupts);
  const allECasts  = enrichedSegments.flatMap(s => s.enemyCasts);
  const allSpikes  = enrichedSegments.flatMap(s => s.spikes);
  const allAbsorbs = enrichedSegments.flatMap(s => s.absorbs || []);

  const capabilityFlags = {
    hasDeathContext  : allDeaths.length > 0,
    hasPreDeathHits  : allDeaths.some(d => d.preDeathHits?.length > 0),
    hasDamageBuckets : allBuckets.length > 0,
    hasHealingData   : allBuckets.some(b => b.partyHealingReceived > 0),
    hasInterrupts    : allInts.length > 0,
    hasEnemyCasts    : allECasts.length > 0,
    hasSpikes        : allSpikes.length > 0,
    hasAbsorbs       : allAbsorbs.length > 0,
  };

  return {
    clockOffsetMs,
    clockSyncConfidence : diag.clockSyncConfidence,
    enrichedSegments,
    capabilityFlags,
    dataQuality,
    parserDiagnostics   : diag,
  };
}

// ─── CombatLogParser class wrapper (used by Electron main.js) ────────────────
const { EventEmitter } = require("events");

class CombatLogParser extends EventEmitter {
  constructor() {
    super();
    this._playerName = null;
    this._lines      = [];
  }

  setPlayerName(name) {
    this._playerName = name;
  }

  parseLine(line) {
    if (!line || typeof line !== "string") return;
    this._lines.push(line);

    if (line.includes("ENCOUNTER_END") || line.includes("ZONE_CHANGE")) {
      this._flushPull();
    }
  }

  _flushPull() {
    if (this._lines.length === 0) return;
    const lines = this._lines.splice(0);
    this.emit("pullEnd", { rawLines: lines, playerName: this._playerName });
  }
}

module.exports = { parseCombatLog, CombatLogParser };
