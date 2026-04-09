// combatLogRunBuilder.js — V2.0 (Companion v1.0.0)
// Hardened: dynamic segmentation, tiered party detection, fault-tolerant parser.
// ChatGPT-approved architecture — combat log is the single source of truth.

"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");

// ─── Spell allowlists (same as combatLogParser.js) ─────────────────────────

// ─── Defensive CD Tracking — Spec-Aware ─────────────────────────────────────
// Rule: Track meaningful defensive decisions only. 2min+ CD as general threshold.
// Rotational mitigation (Ignore Pain, Iron Fur, Shield of the Righteous, Demon Spikes) = NOT tracked.
// Short-CD absorbs (Ice Barrier, Crimson Vial) = NOT tracked.
// Exception: Feint IS tracked despite short CD — it's the primary Rogue M+ defensive.
// Some spells are spec-conditional (e.g., Frenzied Regen is rotational for Guardian but defensive for others).

const ALWAYS_TRACK_DEFENSIVES = new Set([
  // ── Death Knight ──
  48707,    // Anti-Magic Shell (1min)
  48792,    // Icebound Fortitude (3min)
  55233,    // Vampiric Blood (1.5min)
  49028,    // Dancing Rune Weapon (2min)
  51052,    // Anti-Magic Zone (2min)
  49039,    // Lichborne (2min)

  // ── Demon Hunter ──
  198589,   // Blur (1min) — short but DH's only personal DR
  196718,   // Darkness (3min)
  196555,   // Netherwalk (3min)
  187827,   // Metamorphosis (3-4min)
  204021,   // Fiery Brand (1min) — important tank CD

  // ── Druid ──
  61336,    // Survival Instincts (3min)
  102342,   // Ironbark (1.5min, external)

  // ── Evoker ──
  374348,   // Obsidian Scales (2.5min)
  374227,   // Zephyr (2min)
  370960,   // Emerald Communion (3min)

  // ── Hunter ──
  186265,   // Aspect of the Turtle (3min)
  109304,   // Exhilaration (2min)

  // ── Mage ──
  45438,    // Ice Block (4min)
  342245,   // Alter Time (1min) — snap back, meaningful decision
  55342,    // Mirror Image (2min)

  // ── Monk ──
  115203,   // Fortifying Brew (3min)
  122278,   // Dampen Harm (2min)
  122783,   // Diffuse Magic (1.5min)
  115176,   // Zen Meditation (5min)
  116849,   // Life Cocoon (2min, external)
  325197,   // Invoke Chi-Ji, the Red Crane (3min, Mistweaver)
  322118,   // Invoke Yu'lon, the Jade Serpent (3min, Mistweaver)

  // ── Paladin ──
  642,      // Divine Shield (5min)
  31850,    // Ardent Defender (2min)
  86659,    // Guardian of Ancient Kings (5min)
  633,      // Lay on Hands (10min, external)
  1022,     // Blessing of Protection (5min, external)
  6940,     // Blessing of Sacrifice (1min, external)
  204018,   // Blessing of Spellwarding (3min, external)

  // ── Priest ──
  47788,    // Guardian Spirit (3min, external)
  33206,    // Pain Suppression (3min, external)
  62618,    // Power Word: Barrier (3min, group)
  271466,   // Luminous Barrier (3min, Disc)
  15286,    // Vampiric Embrace (2min, Shadow)
  64843,    // Divine Hymn (3min, Holy)
  47585,    // Dispersion (2min, Shadow)

  // ── Rogue ──
  31224,    // Cloak of Shadows (2min)
  5277,     // Evasion (2min)
  1966,     // Feint (15s) — short CD but primary Rogue M+ defensive

  // ── Shaman ──
  108271,   // Astral Shift (1.5min)
  98008,    // Spirit Link Totem (3min, group)
  108280,   // Healing Tide Totem (3min, group)

  // ── Warlock ──
  104773,   // Unending Resolve (3min)
  108416,   // Dark Pact (1min)

  // ── Warrior ──
  871,      // Shield Wall (3min)
  12975,    // Last Stand (3min)
  184364,   // Enraged Regeneration (2min, Fury)
  97462,    // Rallying Cry (3min, group)
  118038,   // Die by the Sword (3min, Arms/Fury)
]);

// Spells that are only tracked for SPECIFIC specs
// Key = spell ID, Value = { track: Set of spec IDs to track, OR exclude: Set of spec IDs to NOT track }
const SPEC_CONDITIONAL_DEFENSIVES = {
  // Frenzied Regeneration: track for Balance(102), Feral(103), Resto(105) — NOT Guardian(104)
  22842:  { exclude: new Set([104]) },

  // Barkskin: track for all druid specs — 45s CD but core druid defensive, keep it
  22812:  { track: null },  // null = always track (same as ALWAYS_TRACK)

  // Incarnation: Guardian of Ursoc: track for Guardian(104) ONLY
  102558: { track: new Set([104]) },

  // Heart of the Wild: track for Balance(102), Feral(103), Resto(105) — NOT Guardian(104)
  319454: { exclude: new Set([104]) },

  // Divine Protection: track for all paladin specs — 1min but meaningful
  498:    { track: null },

  // Desperate Prayer: track for all priest specs — 1.5min self-heal
  19236:  { track: null },
};

/**
 * Check if a defensive spell should be tracked for a given spec.
 * @param {number} spellId
 * @param {number|null} specId - player's spec ID from COMBATANT_INFO (null if unknown)
 * @returns {boolean}
 */
function shouldTrackDefensive(spellId, specId) {
  // Check always-track list first
  if (ALWAYS_TRACK_DEFENSIVES.has(spellId)) return true;

  // Check spec-conditional list
  const cond = SPEC_CONDITIONAL_DEFENSIVES[spellId];
  if (!cond) return false;

  // If track is null, always track
  if (cond.track === null) return true;

  // If we don't know the spec, track it (benefit of the doubt)
  if (specId == null || specId === 0) return true;

  // If there's an exclude list, track UNLESS spec is excluded
  if (cond.exclude) return !cond.exclude.has(specId);

  // If there's a track list, only track if spec is in the list
  if (cond.track) return cond.track.has(specId);

  return false;
}

// ── Racial Abilities — tracked separately from defensives ───────────────
// Strategic racial cooldowns used in M+ for survivability, damage, or utility.
// They indicate race AND provide tactical intelligence.
const RACIAL_ABILITIES = new Map([
  // ── Alliance ──
  [20594,  { race: "Dwarf",           name: "Stoneform",         type: "cleanse_defensive" }],
  [265221, { race: "Dark Iron Dwarf",  name: "Fireblood",         type: "cleanse_offensive" }],
  [58984,  { race: "Night Elf",        name: "Shadowmeld",        type: "combat_drop" }],
  [256948, { race: "Void Elf",         name: "Spatial Rift",      type: "mobility" }],
  [259930, { race: "Kul Tiran",        name: "Haymaker",          type: "cc" }],
  [312924, { race: "Mechagnome",       name: "Hyper Organic Light Originator", type: "emergency_heal" }],
  [28880,  { race: "Draenei",          name: "Gift of the Naaru", type: "heal" }],
  [255654, { race: "Lightforged Draenei", name: "Light's Judgment", type: "damage" }],
  [69070,  { race: "Goblin",           name: "Rocket Jump",       type: "mobility" }],
  // ── Horde ──
  [20572,  { race: "Orc",             name: "Blood Fury",        type: "offensive" }],
  [26297,  { race: "Troll",           name: "Berserking",        type: "offensive" }],
  [33697,  { race: "Orc",             name: "Blood Fury",        type: "offensive" }],
  [33702,  { race: "Orc",             name: "Blood Fury",        type: "offensive" }],
  [7744,   { race: "Undead",          name: "Will of the Forsaken", type: "cleanse" }],
  [20549,  { race: "Tauren",          name: "War Stomp",         type: "cc" }],
  [69179,  { race: "Goblin",          name: "Rocket Barrage",    type: "damage" }],
  [255661, { race: "Highmountain Tauren", name: "Bull Rush",     type: "cc" }],
  [260364, { race: "Nightborne",      name: "Arcane Pulse",      type: "damage" }],
  [274738, { race: "Mag'har Orc",     name: "Ancestral Call",    type: "offensive" }],
  [291944, { race: "Zandalari Troll", name: "Regeneratin'",      type: "heal" }],
  [312411, { race: "Vulpera",         name: "Bag of Tricks",     type: "damage" }],
  // ── Neutral ──
  [107079, { race: "Pandaren",        name: "Quaking Palm",      type: "cc" }],
  // ── Dracthyr (Evoker-only race) ──
  [368970, { race: "Dracthyr",        name: "Tail Swipe",        type: "cc" }],
  [357214, { race: "Dracthyr",        name: "Wing Buffet",       type: "knockback" }],
  // ── Earthen (TWW) ──
  [446280, { race: "Earthen",         name: "Azerite Surge",     type: "damage" }],
  [448849, { race: "Earthen",         name: "Wide-Eyed Wonder",  type: "utility" }],
]);

const INTERRUPT_SPELLS = new Set([
  47528, 183752, 78675, 106839, 351338, 147362, 187707,
  2139, 116705, 96231, 15487, 1766, 57994, 6552, 119910,
]);

const FEIGN_DEATH_SPELL_ID = 5384;
const FEIGN_DEATH_LOOKAHEAD_MS = 15000; // 15 seconds — matches WCL's approach

// ─── Dungeon lookup ────────────────────────────────────────────────────────

const DUNGEON_NAMES = {
  2526: "Algeth'ar Academy",   210: "Algeth'ar Academy",
  2811: "Magisters' Terrace",  206: "Magisters' Terrace",
  502:  "Maisara Caverns",        2874: "Maisara Caverns",
  2915: "Nexus-Point Xenas",   503: "Nexus-Point Xenas",
  246:  "Pit of Saron",        658: "Pit of Saron",
  1753: "Seat of the Triumvirate", 504: "Seat of the Triumvirate",
  1209: "Skyreach",
  505:  "Windrunner Spire",
  2805: "Windrunner Spire",    2769: "Windrunner Spire",
};

// WoW class IDs from COMBATANT_INFO
const CLASS_BY_ID = {
  1: "WARRIOR", 2: "PALADIN", 3: "HUNTER", 4: "ROGUE", 5: "PRIEST",
  6: "DEATHKNIGHT", 7: "SHAMAN", 8: "MAGE", 9: "WARLOCK", 10: "MONK",
  11: "DRUID", 12: "DEMONHUNTER", 13: "EVOKER",
};

// ─── Spec ID → Spec Name + Role (from COMBATANT_INFO field 3) ──────────────
// This is the AUTHORITATIVE source for role detection. Spell inference is fallback only.
const SPEC_INFO = {
  // Death Knight
  250: { spec: "Blood",         class: "DEATHKNIGHT",  role: "tank" },
  251: { spec: "Frost",         class: "DEATHKNIGHT",  role: "dps" },
  252: { spec: "Unholy",        class: "DEATHKNIGHT",  role: "dps" },
  // Demon Hunter
  577: { spec: "Havoc",         class: "DEMONHUNTER",  role: "dps" },
  581: { spec: "Vengeance",     class: "DEMONHUNTER",  role: "tank" },
  1480:{ spec: "Devourer",      class: "DEMONHUNTER",  role: "dps" },
  // Druid
  102: { spec: "Balance",       class: "DRUID",        role: "dps" },
  103: { spec: "Feral",         class: "DRUID",        role: "dps" },
  104: { spec: "Guardian",      class: "DRUID",        role: "tank" },
  105: { spec: "Restoration",   class: "DRUID",        role: "healer" },
  // Evoker
  1467: { spec: "Devastation",  class: "EVOKER",       role: "dps" },
  1468: { spec: "Preservation", class: "EVOKER",       role: "healer" },
  1473: { spec: "Augmentation", class: "EVOKER",       role: "dps" },
  // Hunter
  253: { spec: "Beast Mastery",  class: "HUNTER",      role: "dps" },
  254: { spec: "Marksmanship",   class: "HUNTER",      role: "dps" },
  255: { spec: "Survival",       class: "HUNTER",      role: "dps" },
  // Mage
  62:  { spec: "Arcane",         class: "MAGE",        role: "dps" },
  63:  { spec: "Fire",           class: "MAGE",        role: "dps" },
  64:  { spec: "Frost",          class: "MAGE",        role: "dps" },
  // Monk
  268: { spec: "Brewmaster",     class: "MONK",        role: "tank" },
  269: { spec: "Windwalker",     class: "MONK",        role: "dps" },
  270: { spec: "Mistweaver",     class: "MONK",        role: "healer" },
  // Paladin
  65:  { spec: "Holy",           class: "PALADIN",     role: "healer" },
  66:  { spec: "Protection",     class: "PALADIN",     role: "tank" },
  70:  { spec: "Retribution",    class: "PALADIN",     role: "dps" },
  // Priest
  256: { spec: "Discipline",     class: "PRIEST",      role: "healer" },
  257: { spec: "Holy",           class: "PRIEST",      role: "healer" },
  258: { spec: "Shadow",         class: "PRIEST",      role: "dps" },
  // Rogue
  259: { spec: "Assassination",  class: "ROGUE",       role: "dps" },
  260: { spec: "Outlaw",         class: "ROGUE",       role: "dps" },
  261: { spec: "Subtlety",       class: "ROGUE",       role: "dps" },
  // Shaman
  262: { spec: "Elemental",      class: "SHAMAN",      role: "dps" },
  263: { spec: "Enhancement",    class: "SHAMAN",      role: "dps" },
  264: { spec: "Restoration",    class: "SHAMAN",      role: "healer" },
  // Warlock
  265: { spec: "Affliction",     class: "WARLOCK",     role: "dps" },
  266: { spec: "Demonology",     class: "WARLOCK",     role: "dps" },
  267: { spec: "Destruction",    class: "WARLOCK",     role: "dps" },
  // Warrior
  71:  { spec: "Arms",           class: "WARRIOR",     role: "dps" },
  72:  { spec: "Fury",           class: "WARRIOR",     role: "dps" },
  73:  { spec: "Protection",     class: "WARRIOR",     role: "tank" },
};

// ─── Constants ─────────────────────────────────────────────────────────────

// Dynamic segmentation — threshold set by _getSegmentGapThreshold() based on context
const DAMAGE_BUCKET_MS      = 1000;
const PRE_DEATH_WINDOW_MS   = 8000;
const PRE_DEATH_HIT_MAX     = 5;

// Minimum field counts per event type for fault tolerance
const MIN_FIELDS = {
  "CHALLENGE_MODE_START": 5,
  "CHALLENGE_MODE_END": 5,
  "ENCOUNTER_START": 5,
  "ENCOUNTER_END": 6,
  "COMBATANT_INFO": 26,
  "SWING_DAMAGE": 11,
  "SPELL_DAMAGE": 15,
  "RANGE_DAMAGE": 15,
  "SPELL_PERIODIC_DAMAGE": 15,
  "SPELL_HEAL": 14,
  "SPELL_PERIODIC_HEAL": 14,
  "SPELL_INTERRUPT": 14,
  "SPELL_CAST_SUCCESS": 12,
  "SPELL_CAST_START": 12,
  "SPELL_AURA_APPLIED": 12,
  "UNIT_DIED": 9,
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function isPlayerGuid(guid) {
  return typeof guid === "string" && guid.startsWith("Player-");
}
function isCreatureGuid(guid) {
  return typeof guid === "string" && guid.startsWith("Creature-");
}
function npcIdFromGuid(guid) {
  if (!isCreatureGuid(guid)) return null;
  const p = guid.split("-");
  return p.length >= 6 ? (parseInt(p[5], 10) || null) : null;
}

function parseTimestamp(ts) {
  try {
    const year = new Date().getFullYear();
    const [datePart, timePart] = ts.split(" ");
    const [month, day] = datePart.split("/").map(Number);
    const [hms, msStr] = timePart.split(".");
    const [h, m, s] = hms.split(":").map(Number);
    return new Date(year, month - 1, day, h, m, s, parseInt(msStr || "0", 10)).getTime();
  } catch { return 0; }
}

function splitFields(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === "," && !inQ) { fields.push(cur); cur = ""; }
    else cur += c;
  }
  fields.push(cur);
  return fields;
}

function randHex(n) { return crypto.randomBytes(n).toString("hex"); }

/**
 * Generate a deterministic run ID from the key's identity fields.
 * Same combat log data → same run_id every time → backend dedup works.
 * Format: "mapId-epochSec-hash" where hash is first 8 chars of SHA-256.
 */
function _deterministicRunId(mapId, startTs, keyLevel) {
  const epochSec = Math.floor(startTs / 1000);
  const input = `${mapId}-${epochSec}-${keyLevel}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex").substring(0, 8);
  return `${mapId}-${epochSec}-${hash}`;
}

// ── Advanced combat log detection ──────────────────────────────────────────
// ADVANCED_LOG_ENABLED=1 inserts a 19-field info block after the spell prefix.
// We detect it by checking if the field at the expected suffix start looks like
// a GUID string rather than a numeric damage/heal value.

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

// ─── CombatLogRunBuilder ──────────────────────────────────────────────────

class CombatLogRunBuilder extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.inKey           = false;
    this.run             = null;
    this.segments        = [];
    this.currentSeg      = null;
    this.lastDamageTs    = 0;
    this.bossEncounters  = [];
    this.openBoss        = null;
    this.guidToClass     = new Map();
    this.guidToRole      = new Map();
    this.guidToSpec      = new Map();
    this.guidToSpecId    = new Map();  // GUID → numeric spec ID
    this.guidToName      = new Map();  // GUID → "Name-Realm"
    this.damageBuffers   = new Map();  // per-player pre-death damage
    this.playerDamageTaken = new Map();  // GUID → total damage taken
    this.playerHealingDone = new Map();  // GUID → total healing done
    this.confirmedPartyGuids = new Set();
    this.segCounters     = { death: 0, cd: 0, int: 0, ec: 0 };
    this.lastCreatureDamageTs = 0;  // Last time ANY creature dealt or received damage
    this.knownInterruptibleSpells = new Map();  // spellId → { spellId, spellName, npcId, npcName, count }
    this._defensiveBuffer = [];  // buffered defensives when no segment is open
    this._pendingHunterDeaths = []; // deferred deaths awaiting lookahead confirmation
    this._authCharacters = [];     // character list from VelaraAuth (for GUID-based identity)
    this._feignDeathCasts = new Map(); // GUID → last Feign Death cast timestamp
    this.guidToTalents   = new Map();  // GUID → raw talent data from COMBATANT_INFO
    this.guidToStats     = new Map();  // GUID → parsed stats object from COMBATANT_INFO
    this.guidToRace      = new Map();  // GUID → race name (from auth characters or racial spell inference)
    this.guidToFaction   = new Map();  // GUID → "Alliance" or "Horde"
    this.lineCount       = 0;
    this.eventCount      = 0;
    // setAuthCharacters — called from main.js with VelaraAuth character list
    // Enables combat log GUID matching for uploader identity
    // uploaderIdentity is set externally from SavedVariables — preserve across reset
  }

  // Get player name for a GUID
  _playerName(guid) {
    return this.guidToName.get(guid) || "Unknown";
  }

  _getDmgBuf(guid) {
    if (!this.damageBuffers.has(guid)) this.damageBuffers.set(guid, []);
    return this.damageBuffers.get(guid);
  }

  _pushDmgBuf(guid, hit) {
    const buf = this._getDmgBuf(guid);
    buf.push(hit);
    const cutoff = hit.ts - PRE_DEATH_WINDOW_MS * 1.2;
    while (buf.length > 0 && buf[0].ts < cutoff) buf.shift();
  }

  // ── Dynamic segment gap threshold (safety net only) ────────────────────
  // NPC tracking is primary; this is a fallback for edge cases
  _getSegmentGapThreshold() {
    return 20000;  // 20 seconds — safety net only
  }

  // ── Close current segment if gap detected ─────────────────────────────
  _checkSegmentGap(ts) {
    if (!this.inKey || !this.currentSeg) return;
    const threshold = this._getSegmentGapThreshold();
    if (ts - this.lastDamageTs > threshold && this.lastDamageTs > 0) {
      this._closeSeg(this.lastDamageTs);
    }
  }

  _openSeg(ts) {
    if (this.currentSeg) return; // already open
    const idx = this.segments.length + 1;
    const segId = (this.run ? this.run.runId : "unk") + "-s" + idx;
    this.currentSeg = {
      segmentId: segId, index: idx, startTs: ts, finishTs: 0,
      segmentType: "combat", rawOutcome: "unknown",
      deaths: [],
      dmgPerSec: {},        // { secondOffset: totalDamage } — tiny
      healPerSec: {},       // { secondOffset: totalHealing }
      interrupts: [],       // max ~20 per segment
      defensives: [],       // max ~10
      enemyCasts: [],       // capped at 30
      deathBucketSecs: [],  // which seconds had deaths
    };
    this.segCounters = { death: 0, cd: 0, int: 0, ec: 0 };

    // Flush buffered defensives cast within 3s before segment opened
    const cutoff = ts - 3000;
    for (const buf of this._defensiveBuffer) {
      if (buf.ts >= cutoff) {
        console.log(`[RunBuilder] DEFENSIVE RECOVERED from buffer: ${buf.name} cast ${buf.spellName} (${buf.spellId}) ${ts - buf.ts}ms before segment`);
        this.currentSeg.defensives.push({
          ts: buf.ts, offsetMs: buf.ts - ts,  // negative offset = before pull
          spellName: buf.spellName, spellId: buf.spellId,
          name: buf.name, class: buf.cls, role: buf.role,
        });
      }
    }
    this._defensiveBuffer = [];
  }

  _closeSeg(ts) {
    if (!this.currentSeg) return;
    const seg = this.currentSeg;
    seg.finishTs = ts;
    seg.rawOutcome = seg.deaths.length >= 5 ? "wipe" : "regen_restored";
    this.currentSeg = null;
    this.segments.push(seg);
    this.lastCreatureDamageTs = 0;
  }

  /**
   * Check pending hunter deaths against lookahead window.
   * Called every line to check if any pending deaths should be
   * confirmed (real death) or suppressed (Feign Death).
   */
  _resolvePendingDeaths(ts, fields) {
    if (this._pendingHunterDeaths.length === 0) return;

    const event = fields ? fields[0] : "";
    const sourceGuid = fields ? (fields[1] || "") : "";

    // Activity events that prove the player is alive
    const activityEvents = new Set([
      "SPELL_CAST_SUCCESS", "SPELL_DAMAGE", "RANGE_DAMAGE",
      "SWING_DAMAGE", "SPELL_HEAL", "SPELL_PERIODIC_HEAL",
      "SPELL_PERIODIC_DAMAGE", "SPELL_CAST_START",
    ]);

    const resolved = [];

    for (let i = 0; i < this._pendingHunterDeaths.length; i++) {
      const pending = this._pendingHunterDeaths[i];
      const elapsed = ts - pending.ts;

      // Check if this hunter showed activity (they're alive → Feign Death)
      if (activityEvents.has(event) && isPlayerGuid(sourceGuid) && sourceGuid === pending.destGuid && elapsed > 0) {
        // Player is alive! This was Feign Death.
        console.log(`[RunBuilder] FEIGN DEATH suppressed for ${pending.deathData.name} (activity ${event} at +${elapsed}ms)`);
        resolved.push(i);
        continue;
      }

      // Check if lookahead window expired (15 seconds with no activity → real death)
      if (elapsed > FEIGN_DEATH_LOOKAHEAD_MS) {
        this._finalizePendingDeath(pending);
        console.log(`[RunBuilder] HUNTER DEATH CONFIRMED (no activity in ${FEIGN_DEATH_LOOKAHEAD_MS}ms): ${pending.deathData.name}`);
        resolved.push(i);
        continue;
      }
    }

    // Remove resolved entries (iterate in reverse to preserve indices)
    for (let i = resolved.length - 1; i >= 0; i--) {
      this._pendingHunterDeaths.splice(resolved[i], 1);
    }
  }

  /**
   * Finalize a pending hunter death as a REAL death.
   * Finds the correct segment and pushes the death data.
   */
  _finalizePendingDeath(pending) {
    // Find the segment this death belongs to
    const seg = this.currentSeg && this.currentSeg.segmentId === pending.segmentId
      ? this.currentSeg
      : this.segments.find(s => s.segmentId === pending.segmentId);

    if (!seg) {
      console.warn(`[RunBuilder] Could not find segment ${pending.segmentId} for pending death — discarding`);
      return;
    }

    // Assign deathId and firstDeathInPull now
    this.segCounters.death++;
    const deathId = (this.run ? this.run.runId : "unk") + "-" + seg.segmentId + "-d" + this.segCounters.death;
    pending.deathData.deathId = deathId;
    pending.deathData.firstDeathInPull = seg.deaths.length === 0;

    seg.deaths.push(pending.deathData);

    const deathSec = Math.floor((pending.ts - pending.segStartTs) / 1000);
    seg.deathBucketSecs.push(deathSec);
  }

  _addDmg(ts, amount) {
    const seg = this.currentSeg;
    if (!seg || amount <= 0) return;
    const sec = Math.floor((ts - seg.startTs) / 1000);
    seg.dmgPerSec[sec] = (seg.dmgPerSec[sec] || 0) + amount;
  }

  _addHeal(ts, amount) {
    const seg = this.currentSeg;
    if (!seg || amount <= 0) return;
    const sec = Math.floor((ts - seg.startTs) / 1000);
    seg.healPerSec[sec] = (seg.healPerSec[sec] || 0) + amount;
  }

  // ── Main line processor ───────────────────────────────────────────────
  processLine(rawLine) {
    this.lineCount++;
    try {
    const spaceIdx = rawLine.indexOf("  ");
    if (spaceIdx < 0) return null;

    const tsRaw = rawLine.substring(0, spaceIdx).trim();
    const body  = rawLine.substring(spaceIdx + 2).trim();
    const ts    = parseTimestamp(tsRaw);
    if (ts <= 0) return null;

    // ── Creature damage gap: 3s of no creature combat = pull boundary ──
    if (this.currentSeg && this.lastCreatureDamageTs > 0) {
      if (ts - this.lastCreatureDamageTs > 3000) {
        this._closeSeg(this.lastCreatureDamageTs);
      }
    }

    const fields = splitFields(body);
    const event  = fields[0];

    // ── Resolve pending hunter deaths (Feign Death lookahead) ────────
    this._resolvePendingDeaths(ts, fields);

    // Fault tolerance: check minimum field count
    const minFields = MIN_FIELDS[event];
    if (minFields !== undefined && fields.length < minFields) {
      return null;
    }

    // ── Key lifecycle ──────────────────────────────────────────────────
    if (event === "CHALLENGE_MODE_START") {
      const dungeonName = (fields[1] || "").replace(/"/g, "").trim();
      const mapId    = parseInt(fields[2], 10) || 0;
      const keyLevel = parseInt(fields[4], 10) || 0;
      this.reset();
      this.inKey = true;
      this.run = {
        runId: _deterministicRunId(mapId, ts, keyLevel),
        mapId, keyLevel, startTs: ts, finishTs: 0,
        dungeonName: DUNGEON_NAMES[mapId] || dungeonName || "Unknown",
      };
      console.log(`[RunBuilder] KEY START: ${this.run.dungeonName} +${keyLevel} mapId=${mapId}`);
      this.emit("keyStart", this.run);
      return null;
    }

    if (event === "CHALLENGE_MODE_END") {
      if (!this.inKey || !this.run) return null;
      const success  = parseInt(fields[2], 10) || 0;
      const keyLevel = parseInt(fields[3], 10) || 0;
      const timeMs   = parseInt(fields[4], 10) || 0;
      this.run.finishTs = ts;
      if (this.currentSeg) this._closeSeg(ts);
      if (this.openBoss) {
        this.bossEncounters.push({ ...this.openBoss, endTs: ts, success: 0 });
        this.openBoss = null;
      }

      // Finalize any remaining pending hunter deaths (no more lines to check)
      for (const pending of this._pendingHunterDeaths) {
        this._finalizePendingDeath(pending);
        console.log(`[RunBuilder] HUNTER DEATH CONFIRMED (key ended): ${pending.deathData.name}`);
      }
      this._pendingHunterDeaths = [];

      const payload = this._buildPayload(success, timeMs, keyLevel);
      console.log(`[RunBuilder] KEY END: ${this.run.dungeonName} +${keyLevel} success=${success} time=${timeMs}ms segs=${this.segments.length}`);
      this.inKey = false;
      this.emit("keyEnd", payload);
      return { complete: true, payload };
    }

    if (!this.inKey) return null;
    this.eventCount++;

    // ── Boss encounters ────────────────────────────────────────────────
    if (event === "ENCOUNTER_START") {
      const encId   = parseInt(fields[1], 10) || 0;
      const encName = (fields[2] || "").replace(/"/g, "");
      const diff    = parseInt(fields[3], 10) || 0;
      const size    = parseInt(fields[4], 10) || 5;
      this.openBoss = { encounterID: encId, encounterName: encName, startTs: ts, endTs: 0, success: 0, difficultyID: diff, groupSize: size };
      if (this.currentSeg) this.currentSeg.isBossPull = true;
      return null;
    }
    if (event === "ENCOUNTER_END") {
      const encId   = parseInt(fields[1], 10) || 0;
      const encName = (fields[2] || "").replace(/"/g, "");
      const success = parseInt(fields[5], 10) || 0;
      if (this.openBoss && this.openBoss.encounterID === encId) {
        this.openBoss.endTs = ts;
        this.openBoss.success = success;
        this.bossEncounters.push(this.openBoss);
        this.openBoss = null;
      }
      return null;
    }

    // ── COMBATANT_INFO — party member data ─────────────────────────────
    // We extract GUID, spec ID, and raw talent fields.
    // Item levels and gear data are intentionally ignored and never stored.
    // Spec ID is the AUTHORITATIVE source for class, spec, and role.
    if (event === "COMBATANT_INFO") {
      const guid = fields[1] || "";
      if (isPlayerGuid(guid)) {
        // Parse spec ID from field position 25 (zero-indexed)
        // Format: COMBATANT_INFO,GUID,Faction,Str,Agi,Sta,Int,...,Armor,CurrentSpecID,...
        // Blizzard moved spec ID from field 3 to field 25 in Midnight (TWW)
        // Field 25 is CurrentSpecID. Do NOT guess from spell IDs — this is the ONLY truth.
        const specId = parseInt(fields[25], 10) || 0;
        const specInfo = SPEC_INFO[specId];

        if (specInfo) {
          // Authoritative: COMBATANT_INFO spec ID overrides everything
          this.guidToClass.set(guid, specInfo.class);
          this.guidToRole.set(guid, specInfo.role);
          this.guidToSpec.set(guid, specInfo.spec);
          this.guidToSpecId.set(guid, specId);
          console.log(`[RunBuilder] COMBATANT_INFO: ${specInfo.class} ${specInfo.spec} (${specInfo.role}) specId=${specId}`);
        } else {
          // Unknown spec ID — register with UNKNOWN, spell inference will try later
          if (!this.guidToClass.has(guid)) {
            this.guidToClass.set(guid, "UNKNOWN");
          }
          if (!this.guidToRole.has(guid)) {
            this.guidToRole.set(guid, "unknown");
          }
          console.warn(`[RunBuilder] COMBATANT_INFO: unknown specId=${specId} for ${guid}`);
        }

        // Mark as confirmed via COMBATANT_INFO (highest tier)
        this.confirmedPartyGuids.add(guid);

        // ── Stat capture from COMBATANT_INFO (fields 3-23) ──────────────
        // Format: [0]event, [1]GUID, [2]Faction, [3]Str, [4]Agi, [5]Sta,
        //         [6]Int, [7]Dodge, [8]Parry, [9]Block, [10]CritM, [11]CritR,
        //         [12]CritS, [13]Speed, [14]Lifesteal, [15]HasteM, [16]HasteR,
        //         [17]HasteS, [18]Avoidance, [19]Mastery, [20]VersDmg,
        //         [21]VersHeal, [22]VersDR, [23]Armor, [24]???, [25]SpecID
        // Verified against Midnight (TWW) combat logs — field[2] is Faction flag.
        try {
          const stats = {
            strength:       parseInt(fields[3], 10) || 0,
            agility:        parseInt(fields[4], 10) || 0,
            stamina:        parseInt(fields[5], 10) || 0,
            intellect:      parseInt(fields[6], 10) || 0,
            dodge:          parseInt(fields[7], 10) || 0,
            parry:          parseInt(fields[8], 10) || 0,
            block:          parseInt(fields[9], 10) || 0,
            critMelee:      parseInt(fields[10], 10) || 0,
            critRanged:     parseInt(fields[11], 10) || 0,
            critSpell:      parseInt(fields[12], 10) || 0,
            speed:          parseInt(fields[13], 10) || 0,
            lifesteal:      parseInt(fields[14], 10) || 0,
            hasteMelee:     parseInt(fields[15], 10) || 0,
            hasteRanged:    parseInt(fields[16], 10) || 0,
            hasteSpell:     parseInt(fields[17], 10) || 0,
            avoidance:      parseInt(fields[18], 10) || 0,
            mastery:        parseInt(fields[19], 10) || 0,
            versatilityDmg: parseInt(fields[20], 10) || 0,
            versatilityHeal:parseInt(fields[21], 10) || 0,
            versatilityDR:  parseInt(fields[22], 10) || 0,
            armor:          parseInt(fields[23], 10) || 0,
          };
          this.guidToStats.set(guid, stats);
        } catch (err) {
          console.warn(`[RunBuilder] Stat capture failed for ${guid}: ${err.message}`);
        }

        // ── Talent capture (raw — Season 2 will parse and display) ──────
        try {
          const rawTalentFields = fields.slice(26);
          if (rawTalentFields.length > 0) {
            this.guidToTalents.set(guid, rawTalentFields.join(","));
          }
        } catch (err) {
          console.warn(`[RunBuilder] Talent capture failed for ${guid}: ${err.message}`);
        }
      }
      return null;
    }

    // ── Segment management via NPC tracking + damage gap safety net ────
    const isDamage = event === "SWING_DAMAGE" || event === "SPELL_DAMAGE" ||
                     event === "SPELL_PERIODIC_DAMAGE" || event === "RANGE_DAMAGE";
    const isEnvironmental = event === "ENVIRONMENTAL_DAMAGE";
    const isHeal   = event === "SPELL_HEAL" || event === "SPELL_PERIODIC_HEAL";
    const isCast   = event === "SPELL_CAST_SUCCESS";
    const isCastStart = event === "SPELL_CAST_START";
    const isAuraApplied = event === "SPELL_AURA_APPLIED";
    const isDied   = event === "UNIT_DIED";
    const isInterrupt = event === "SPELL_INTERRUPT";

    if (!isDamage && !isEnvironmental && !isHeal && !isCast && !isCastStart && !isAuraApplied && !isDied && !isInterrupt) return null;

    const sourceGuid = fields[1] || "";
    const sourceName = (fields[2] || "").replace(/"/g, "");
    const destGuid   = fields[5] || "";
    const destName   = (fields[6] || "").replace(/"/g, "");

    // ── Creature damage timestamp tracking (hostile only) ────────────────
    if (isDamage) {
      const sourceFlags = fields[3] || "0";
      const destFlags = fields[7] || "0";
      const hostileCreatureInvolved =
          (isCreatureGuid(sourceGuid) && isHostileUnit(sourceFlags)) ||
          (isCreatureGuid(destGuid) && isHostileUnit(destFlags));
      const playerInvolved = isPlayerGuid(sourceGuid) || isPlayerGuid(destGuid);
      if (hostileCreatureInvolved && playerInvolved) {
        this.lastCreatureDamageTs = ts;
        if (!this.currentSeg) this._openSeg(ts);
      }
    }

    // Safety-net gap check (20s fallback)
    if (isDamage || isCast || isInterrupt) {
      this._checkSegmentGap(ts);
      if (!this.currentSeg) this._openSeg(ts);
      this.lastDamageTs = ts;
    }

    // ── Extract player names from combat log ────────────────────────────
    if (isPlayerGuid(sourceGuid) && sourceName && !this.guidToName.has(sourceGuid)) {
      this.guidToName.set(sourceGuid, sourceName);
    }
    if (isPlayerGuid(destGuid) && destName && !this.guidToName.has(destGuid)) {
      this.guidToName.set(destGuid, destName);
    }

    // ── Spell-based class/role detection ────────────────────────────────
    if (isPlayerGuid(sourceGuid) && isCast) {
      const spellId = parseInt(fields[9], 10) || 0;
      this._detectClassFromSpell(sourceGuid, spellId);

      // Track Feign Death casts for death suppression
      if (spellId === FEIGN_DEATH_SPELL_ID && isPlayerGuid(sourceGuid)) {
        this._feignDeathCasts.set(sourceGuid, ts);
      }
    }

    // ── UNIT_DIED — player death tracking ──────────────────────────────
    // Feign Death (spell 5384) triggers a real UNIT_DIED event for hunters.
    // For hunters: defer the death and look ahead for activity (WCL approach).
    // For non-hunters: record immediately as before.
    if (isDied && isPlayerGuid(destGuid)) {
      const playerClass = this.guidToClass.get(destGuid) || "UNKNOWN";

      if (playerClass === "HUNTER") {
        // Check lookback: did this hunter cast Feign Death within 2s?
        const feignTs = this._feignDeathCasts.get(destGuid) || 0;
        const likelyFeign = (ts - feignTs) < 2000;

        // Defer this death — collect all the data we'd normally record
        if (!this.currentSeg) this._openSeg(ts);
        const seg = this.currentSeg;
        const buf = this._getDmgBuf(destGuid);
        const cutoff = ts - PRE_DEATH_WINDOW_MS;
        const window = buf.filter(h => h.ts >= cutoff);
        const preDeathHits = window.slice(-PRE_DEATH_HIT_MAX).map(h => ({
          normalizedTs: h.ts, offsetMs: h.ts - seg.startTs,
          spellId: h.spellId, spellName: h.spellName, amount: h.amount, overkill: h.overkill,
          sourceNpcId: h.sourceNpcId, sourceNpcName: h.sourceNpcName,
        }));
        const kb = [...window].reverse().find(h => h.overkill > 0) || window[window.length - 1] || null;
        const isEnvDeath = kb && kb.isEnvironmental === true;
        const envType = isEnvDeath ? (kb.envType || "Environmental") : null;

        this._pendingHunterDeaths.push({
          ts,
          destGuid,
          segmentId: seg.segmentId,
          segStartTs: seg.startTs,
          likelyFeign,
          deathData: {
            segmentId: seg.segmentId, deathTs: ts,
            offsetMs: ts - seg.startTs,
            name: this.guidToName.get(destGuid) || "Unknown",
            class: playerClass,
            role: this.guidToRole.get(destGuid) || "unknown",
            firstDeathInPull: false, // will be set when finalized
            killingBlow: kb ? { spellName: kb.spellName, amount: kb.amount } : null,
            isEnvironmental: isEnvDeath || false,
            environmentalType: envType,
            preDeathHits: preDeathHits.map(h => ({
              offsetMs: h.offsetMs, amount: h.amount,
              spellName: h.spellName, sourceNpcName: h.sourceNpcName,
            })),
          },
        });

        console.log(`[RunBuilder] HUNTER DEATH DEFERRED: ${this.guidToName.get(destGuid) || "Unknown"} at ${ts} (likelyFeign=${likelyFeign})`);
        return null;
      }

      // ── Non-hunter: record death immediately (EXISTING LOGIC — DO NOT CHANGE) ──
      if (!this.currentSeg) this._openSeg(ts);
      this.segCounters.death++;
      const seg = this.currentSeg;
      const deathId = this.run.runId + "-" + seg.segmentId + "-d" + this.segCounters.death;

      const buf = this._getDmgBuf(destGuid);
      const cutoff = ts - PRE_DEATH_WINDOW_MS;
      const window = buf.filter(h => h.ts >= cutoff);
      const preDeathHits = window.slice(-PRE_DEATH_HIT_MAX).map(h => ({
        normalizedTs: h.ts, offsetMs: h.ts - seg.startTs,
        spellId: h.spellId, spellName: h.spellName, amount: h.amount, overkill: h.overkill,
        sourceNpcId: h.sourceNpcId, sourceNpcName: h.sourceNpcName,
      }));
      const kb = [...window].reverse().find(h => h.overkill > 0) || window[window.length - 1] || null;

      const isEnvDeath = kb && kb.isEnvironmental === true;
      const envType = isEnvDeath ? (kb.envType || "Environmental") : null;

      seg.deaths.push({
        deathId, segmentId: seg.segmentId, deathTs: ts,
        offsetMs: ts - seg.startTs,
        name: this.guidToName.get(destGuid) || "Unknown",
        class: this.guidToClass.get(destGuid) || "UNKNOWN",
        role: this.guidToRole.get(destGuid) || "unknown",
        firstDeathInPull: seg.deaths.length === 0,
        killingBlow: kb ? { spellName: kb.spellName, amount: kb.amount } : null,
        isEnvironmental: isEnvDeath || false,
        environmentalType: envType,
        preDeathHits: preDeathHits.map(h => ({
          offsetMs: h.offsetMs, amount: h.amount,
          spellName: h.spellName, sourceNpcName: h.sourceNpcName,
        })),
      });

      const deathSec = Math.floor((ts - seg.startTs) / 1000);
      seg.deathBucketSecs.push(deathSec);
      return null;
    }

    // ── SPELL_INTERRUPT ─────────────────────────────────────────────────
    if (isInterrupt && isPlayerGuid(sourceGuid)) {
      if (!this.currentSeg) this._openSeg(ts);
      this.segCounters.int++;
      const spellId = parseInt(fields[9], 10) || 0;
      const spellName = (fields[10] || "").replace(/"/g, "");

      // Detect advanced info block for interrupted spell extraction
      const intAdvStart = 12;
      const intHasAdv = hasAdvancedInfo(fields, intAdvStart);
      const intSuffixStart = intHasAdv ? intAdvStart + ADVANCED_INFO_FIELD_COUNT : intAdvStart;

      const interruptedSpellId = parseInt(fields[intSuffixStart], 10) || 0;
      const interruptedSpellName = (fields[intSuffixStart + 1] || "").replace(/"/g, "");

      this.currentSeg.interrupts.push({
        ts, offsetMs: ts - this.currentSeg.startTs,
        spellId, spellName,
        sourceName: this.guidToName.get(sourceGuid) || "Unknown",
        sourceClass: this.guidToClass.get(sourceGuid) || "UNKNOWN",
        sourceRole: this.guidToRole.get(sourceGuid) || "unknown",
        targetSpellId: interruptedSpellId,
        targetSpellName: interruptedSpellName,
        targetNpcId: npcIdFromGuid(destGuid),
        targetNpcName: isCreatureGuid(destGuid) ? destName : null,
      });

      // Track interrupted spell for Learned Interrupt Database
      if (interruptedSpellId > 0 && isCreatureGuid(destGuid)) {
        if (!this.knownInterruptibleSpells) this.knownInterruptibleSpells = new Map();
        const key = interruptedSpellId;
        if (!this.knownInterruptibleSpells.has(key)) {
          this.knownInterruptibleSpells.set(key, {
            spellId: interruptedSpellId,
            spellName: interruptedSpellName,
            npcId: npcIdFromGuid(destGuid),
            npcName: destName || "Unknown",
            count: 0,
          });
        }
        this.knownInterruptibleSpells.get(key).count++;
      }
      return null;
    }

    // ── Damage (dynamic suffix detection for advanced combat log) ──────
    if (isDamage && isPlayerGuid(destGuid)) {
      let spellId = 0, spellName = "Melee", amount = 0, overkill = 0;
      if (event === "SWING_DAMAGE") {
        // Swing: no spell prefix — advanced info starts at field 9
        const swingAdvStart = 9;
        const swingHasAdv = hasAdvancedInfo(fields, swingAdvStart);
        const swingSuffixStart = swingHasAdv ? swingAdvStart + ADVANCED_INFO_FIELD_COUNT : swingAdvStart;
        amount   = parseInt(fields[swingSuffixStart],     10) || 0;
        overkill = parseInt(fields[swingSuffixStart + 1], 10) || 0;
      } else {
        // Spell/Range: spell prefix at fields 9-11, advanced info at field 12
        spellId   = parseInt(fields[9], 10) || 0;
        spellName = (fields[10] || "").replace(/"/g, "");
        const advStart = 12;
        const hasAdv = hasAdvancedInfo(fields, advStart);
        const suffixStart = hasAdv ? advStart + ADVANCED_INFO_FIELD_COUNT : advStart;
        amount   = parseInt(fields[suffixStart],     10) || 0;
        overkill = parseInt(fields[suffixStart + 1], 10) || 0;
      }

      if (isNaN(amount) || amount < 0) return null;

      this._pushDmgBuf(destGuid, {
        ts, spellId, spellName, amount, overkill,
        sourceNpcId: npcIdFromGuid(sourceGuid),
        sourceNpcName: isCreatureGuid(sourceGuid) ? sourceName : null,
      });

      // Accumulate damage taken per player for post-run role heuristic
      this.playerDamageTaken.set(destGuid, (this.playerDamageTaken.get(destGuid) || 0) + amount);

      this._addDmg(ts, amount);
      return null;
    }

    // ── ENVIRONMENTAL_DAMAGE (fall damage, lava, drowning, etc.) ────────
    // No spell prefix (like SWING_DAMAGE). Advanced info block at field 9.
    // envType is at suffix start, amount at suffix+1, overkill at suffix+2.
    if (isEnvironmental && isPlayerGuid(destGuid)) {
      const envAdvStart = 9;
      const envHasAdv = hasAdvancedInfo(fields, envAdvStart);
      const envSuffixStart = envHasAdv ? envAdvStart + ADVANCED_INFO_FIELD_COUNT : envAdvStart;
      const envType = (fields[envSuffixStart] || "").replace(/"/g, "").trim();
      const amount   = parseInt(fields[envSuffixStart + 1], 10) || 0;
      const overkill = parseInt(fields[envSuffixStart + 2], 10) || 0;

      if (amount > 0) {
        this._pushDmgBuf(destGuid, {
          ts, spellId: 0, spellName: envType || "Environmental",
          amount, overkill,
          sourceNpcId: null, sourceNpcName: "Environment",
          isEnvironmental: true, envType: envType || "Unknown",
        });
      }
      return null;
    }

    // ── Healing (dynamic suffix detection for advanced combat log) ──────
    if (isHeal) {
      // Heal suffix: spell prefix at fields 9-11, check for advanced info at field 12
      const healAdvStart = 12;
      const healHasAdv = hasAdvancedInfo(fields, healAdvStart);
      const healSuffixStart = healHasAdv ? healAdvStart + ADVANCED_INFO_FIELD_COUNT : healAdvStart;
      const healAmount = parseInt(fields[healSuffixStart], 10) || 0;
      const overhealAmount = parseInt(fields[healSuffixStart + 1], 10) || 0;

      // Healing done tracking (for post-run role heuristic)
      if (isPlayerGuid(sourceGuid)) {
        if (!isNaN(healAmount) && healAmount > 0) {
          this.playerHealingDone.set(sourceGuid, (this.playerHealingDone.get(sourceGuid) || 0) + healAmount);
        }
      }

      // Healing received
      if (isPlayerGuid(destGuid) && this.currentSeg) {
        if (!isNaN(healAmount) && healAmount > 0) {
          const effective = Math.max(0, healAmount - overhealAmount);
          this._addHeal(ts, effective);
        }
      }
      return null;
    }

    // ── Racial ability tracking (separate from defensives) ──────────────
    if (isCast && isPlayerGuid(sourceGuid)) {
      const racialSpellId = parseInt(fields[9], 10) || 0;
      const racialInfo = RACIAL_ABILITIES.get(racialSpellId);
      if (racialInfo) {
        const playerName = this.guidToName.get(sourceGuid) || "Unknown";
        // Infer race from the racial ability used
        this.guidToRace.set(sourceGuid, racialInfo.race);

        // Store the racial cast in the current segment
        if (this.currentSeg) {
          if (!this.currentSeg.racialCasts) this.currentSeg.racialCasts = [];
          this.currentSeg.racialCasts.push({
            ts, offsetMs: ts - this.currentSeg.startTs,
            spellName: racialInfo.name, spellId: racialSpellId,
            name: playerName,
            class: this.guidToClass.get(sourceGuid) || "UNKNOWN",
            role: this.guidToRole.get(sourceGuid) || "unknown",
            race: racialInfo.race,
            racialType: racialInfo.type,
          });
        }
      }
    }

    // ── Player cast/aura — check for defensive CDs (spec-aware) ─────────
    if ((isCast || isAuraApplied) && isPlayerGuid(sourceGuid)) {
      const spellId = parseInt(fields[9], 10) || 0;
      const spellName = (fields[10] || "").replace(/"/g, "");

      // Look up player's spec for spec-aware defensive tracking
      const playerSpecId = this.guidToSpecId.get(sourceGuid) || null;

      if (shouldTrackDefensive(spellId, playerSpecId)) {
        const playerName = this.guidToName.get(sourceGuid) || "Unknown";
        const playerClass = this.guidToClass.get(sourceGuid) || "UNKNOWN";
        const playerRole = this.guidToRole.get(sourceGuid) || "unknown";

        if (!this.currentSeg) {
          // No active segment — buffer for next segment open
          console.warn(`[RunBuilder] DEFENSIVE DROPPED (no segment): ${playerName} cast ${spellName} (${spellId}) via ${event}`);
          this._defensiveBuffer.push({ ts, spellId, spellName, sourceGuid, name: playerName, cls: playerClass, role: playerRole });
        } else {
          // Dedup: skip if same spell+player within 1s (prevents CAST_SUCCESS + AURA_APPLIED double-count)
          const isDupe = this.currentSeg.defensives.some(d =>
            d.spellName === spellName && d.name === playerName &&
            Math.abs(d.ts - ts) < 1000
          );
          if (!isDupe) {
            this.currentSeg.defensives.push({
              ts, offsetMs: ts - this.currentSeg.startTs,
              spellName, spellId,
              name: playerName, class: playerClass, role: playerRole,
            });
          }
        }
      }
      if (isCast) return null;
    }

    // ── Enemy cast start (capped at 30 per segment, hostile only) ────────
    const sourceFlags = fields[3] || "0";
    if (isCastStart && isCreatureGuid(sourceGuid) && isHostileUnit(sourceFlags) && this.currentSeg) {
      if (this.currentSeg.enemyCasts.length < 30) {
        const spellId = parseInt(fields[9], 10) || 0;
        const spellName = (fields[10] || "").replace(/"/g, "");
        if (spellId > 0) {
          this.currentSeg.enemyCasts.push({
            ts, offsetMs: ts - this.currentSeg.startTs,
            npcName: sourceName || null, spellId, spellName,
          });
        }
      }
      return null;
    }

    return null;
    } catch (err) {
      // Log but don't crash — skip this line and continue
      if (this.lineCount % 10000 === 0) {
        console.warn(`[RunBuilder] Skipped malformed line #${this.lineCount}: ${err.message}`);
      }
      return null;
    }
  }

  // ── Class detection from spells (FALLBACK ONLY) ───────────────────────
  // COMBATANT_INFO spec ID is the primary source. This only fires for players
  // whose COMBATANT_INFO was missing or had an unrecognized spec ID.
  _detectClassFromSpell(guid, spellId) {
    // If COMBATANT_INFO already identified this player, don't override
    if (this.confirmedPartyGuids.has(guid)) return;

    // Only set class if still UNKNOWN
    if (!this.guidToClass.get(guid) || this.guidToClass.get(guid) === "UNKNOWN") {
      const intClassMap = {
        47528: "DEATHKNIGHT", 183752: "DEMONHUNTER", 78675: "DRUID", 106839: "DRUID",
        351338: "EVOKER", 147362: "HUNTER", 187707: "HUNTER", 2139: "MAGE",
        116705: "MONK", 96231: "PALADIN", 15487: "PRIEST", 1766: "ROGUE",
        57994: "SHAMAN", 6552: "WARRIOR", 119910: "WARLOCK",
      };
      const defClassMap = {
        48707: "DEATHKNIGHT", 49028: "DEATHKNIGHT", 48792: "DEATHKNIGHT",
        22812: "DRUID", 61336: "DRUID", 374348: "EVOKER", 186265: "HUNTER",
        45438: "MAGE", 122278: "MONK", 116849: "MONK", 325197: "MONK", 322118: "MONK",
        642: "PALADIN", 498: "PALADIN", 31850: "PALADIN", 86659: "PALADIN",
        47788: "PRIEST", 33206: "PRIEST", 31224: "ROGUE", 5277: "ROGUE",
        108271: "SHAMAN", 871: "WARRIOR", 1160: "WARRIOR", 12975: "WARRIOR",
        108416: "WARLOCK", 6789: "WARLOCK",
      };

      const cls = intClassMap[spellId] || defClassMap[spellId];
      if (cls) this.guidToClass.set(guid, cls);
    }

    // Only set role if still "unknown" AND not confirmed by COMBATANT_INFO
    if (this.guidToRole.get(guid) === "unknown") {
      // Only use HEALER-ONLY spells for role inference (these are truly spec-specific)
      if ([47788, 33206, 116849, 325197, 322118].includes(spellId)) this.guidToRole.set(guid, "healer");
      // Do NOT infer tank from Shield Wall/Last Stand/etc — all warrior specs use these
      // Tank role should only come from COMBATANT_INFO or post-run heuristic
    }
  }

  // ── Merge segments shorter than 3 seconds into previous ────────────────
  _mergeShortSegments() {
    if (this.segments.length <= 1) return;

    const merged = [this.segments[0]];

    for (let i = 1; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const duration = seg.finishTs - seg.startTs;

      if (duration < 5000 && merged.length > 0) {
        // Merge into previous segment
        const prev = merged[merged.length - 1];
        prev.finishTs = seg.finishTs;
        // Merge arrays
        prev.deaths.push(...seg.deaths);
        prev.interrupts.push(...seg.interrupts);
        prev.defensives.push(...seg.defensives);
        prev.enemyCasts.push(...seg.enemyCasts);
        prev.deathBucketSecs.push(...seg.deathBucketSecs);
        // Merge damage/heal per second maps
        for (const [sec, dmg] of Object.entries(seg.dmgPerSec || {})) {
          const adjustedSec = parseInt(sec) + Math.floor((seg.startTs - prev.startTs) / 1000);
          prev.dmgPerSec[adjustedSec] = (prev.dmgPerSec[adjustedSec] || 0) + dmg;
        }
        for (const [sec, heal] of Object.entries(seg.healPerSec || {})) {
          const adjustedSec = parseInt(sec) + Math.floor((seg.startTs - prev.startTs) / 1000);
          prev.healPerSec[adjustedSec] = (prev.healPerSec[adjustedSec] || 0) + heal;
        }
        // Update outcome if merged segment was a wipe
        if (seg.rawOutcome === "wipe") prev.rawOutcome = "wipe";

        console.log(`[RunBuilder] Merged short segment (${duration}ms) into previous`);
      } else {
        merged.push(seg);
      }
    }

    // Re-index
    for (let i = 0; i < merged.length; i++) {
      merged[i].index = i + 1;
      merged[i].segmentId = (this.run ? this.run.runId : "unk") + "-s" + (i + 1);
    }

    this.segments = merged;
  }

  // ── Build final V1.2 payload ──────────────────────────────────────────
  _buildPayload(success, timeMs, keyLevel) {
    const run = this.run;

    // Merge micro-segments before building payload
    this._mergeShortSegments();

    // Finalize segments — ultra-compact output
    const finalSegments = this.segments.map(seg => {
      // Convert dmgPerSec/healPerSec to compact bucket array
      const allSecs = new Set([
        ...Object.keys(seg.dmgPerSec || {}).map(Number),
        ...Object.keys(seg.healPerSec || {}).map(Number),
      ]);
      const buckets = [...allSecs].sort((a, b) => a - b).map(sec => ({
        segmentId: seg.segmentId,
        bucketStartTs: seg.startTs + sec * 1000,
        bucketEndTs: seg.startTs + (sec + 1) * 1000,
        durationMs: 1000,
        partyDamageTaken: (seg.dmgPerSec || {})[sec] || 0,
        partyHealingReceived: (seg.healPerSec || {})[sec] || 0,
        deathCountInBucket: (seg.deathBucketSecs || []).filter(s => s === sec).length,
      }));

      return {
        segmentId: seg.segmentId, index: seg.index,
        startTs: seg.startTs, finishTs: seg.finishTs,
        segmentType: seg.segmentType, rawOutcome: seg.rawOutcome,
        deaths: seg.deaths,
        deathsEvidence: seg.deaths,
        damageBuckets: buckets,
        interrupts: seg.interrupts,
        defensives: seg.defensives,
        racialCasts: seg.racialCasts || [],
        enemyCasts: seg.enemyCasts,
      };
    });

    // Post-run role heuristic for any player still "unknown"
    const allDetectedGuids = [...this.guidToClass.keys()].filter(isPlayerGuid);
    if (allDetectedGuids.length >= 3) {
      const unknownRolePlayers = [];
      for (const [guid, role] of this.guidToRole) {
        if (role === "unknown" && isPlayerGuid(guid)) {
          unknownRolePlayers.push(guid);
        }
      }

      if (unknownRolePlayers.length > 0) {
        // Find the player with highest damage taken → likely tank
        let maxDmgTaken = 0, tankGuid = null;
        for (const guid of unknownRolePlayers) {
          const dmg = this.playerDamageTaken.get(guid) || 0;
          if (dmg > maxDmgTaken) { maxDmgTaken = dmg; tankGuid = guid; }
        }

        // Find the player with highest healing done → likely healer
        let maxHealDone = 0, healerGuid = null;
        for (const guid of unknownRolePlayers) {
          if (guid === tankGuid) continue;  // already assigned tank
          const heal = this.playerHealingDone.get(guid) || 0;
          if (heal > maxHealDone) { maxHealDone = heal; healerGuid = guid; }
        }

        // Only assign if the numbers are meaningful (not just incidental)
        if (tankGuid && maxDmgTaken > 10000) {
          this.guidToRole.set(tankGuid, "tank");
          console.log(`[RunBuilder] Post-run heuristic: assigned tank (dmg taken: ${maxDmgTaken})`);
        }
        if (healerGuid && maxHealDone > 10000) {
          this.guidToRole.set(healerGuid, "healer");
          console.log(`[RunBuilder] Post-run heuristic: assigned healer (heal done: ${maxHealDone})`);
        }
      }
    }

    // Build party list from detected GUIDs — includes character names
    const partyMembers = [];
    for (const [guid, cls] of this.guidToClass) {
      if (!isPlayerGuid(guid)) continue;
      partyMembers.push({
        name: this.guidToName.get(guid) || "Unknown",
        class: cls !== "UNKNOWN" && cls !== "DETECTED" ? cls : "UNKNOWN",
        role: this.guidToRole.get(guid) || "unknown",
        spec: this.guidToSpec.get(guid) || "",
        specId: this.guidToSpecId.get(guid) || 0,
        talents: this.guidToTalents.get(guid) || null,
        stats: this.guidToStats.get(guid) || null,
        race: this.guidToRace.get(guid) || null,
        faction: this.guidToFaction.get(guid) || null,
      });
    }

    // Enrich party members with race from auth characters (Blizzard API data)
    if (this._authCharacters.length > 0) {
      for (const pm of partyMembers) {
        if (!pm.race) {
          const matched = this._authCharacters.find(c =>
            c.fullName === pm.name ||
            c.characterName === pm.name ||
            (pm.name && pm.name.startsWith(c.fullName + "-"))
          );
          if (matched && matched.race) {
            pm.race = matched.race;
            pm.faction = matched.faction || null;
          }
        }
      }
    }

    // Also try racial spell inference for unmatched players
    for (const pm of partyMembers) {
      if (!pm.race) {
        for (const [guid, name] of this.guidToName) {
          if (name === pm.name && this.guidToRace.has(guid)) {
            pm.race = this.guidToRace.get(guid);
            break;
          }
        }
      }
    }

    const totalInts  = finalSegments.reduce((s, seg) => s + seg.interrupts.length, 0);
    const totalDefs  = finalSegments.reduce((s, seg) => s + seg.defensives.length, 0);
    const totalECs   = finalSegments.reduce((s, seg) => s + seg.enemyCasts.length, 0);
    const totalDeaths = finalSegments.reduce((s, seg) => s + seg.deaths.length, 0);
    const totalBuckets = finalSegments.reduce((s, seg) => s + seg.damageBuckets.length, 0);

    console.log(`[RunBuilder] Payload: ${finalSegments.length} segments, ${totalInts} interrupts, ${totalDefs} defensives, ${totalECs} enemy casts, ${totalDeaths} deaths, ${totalBuckets} damage buckets`);
    console.log(`[RunBuilder] Lines processed: ${this.lineCount}, events matched: ${this.eventCount}`);

    // Identity resolution priority:
    // 1. Combat log GUID match against authenticated character list (bulletproof)
    // 2. Addon SavedVariables uploaderIdentity (fixed in v0.8.9)
    // 3. First party member (fallback)
    let uploaderName = "Unknown";
    let identitySource = "unknown";
    let playerObj = partyMembers[0] || { name: "Unknown", class: "UNKNOWN", role: "dps" };
    let otherMembers = partyMembers.slice(1);

    // Priority 1: GUID match — check if any party member name matches an auth character
    if (this._authCharacters.length > 0) {
      for (let i = 0; i < partyMembers.length; i++) {
        const pm = partyMembers[i];
        const matched = this._authCharacters.find(c =>
          c.fullName === pm.name ||
          c.characterName === pm.name ||
          (pm.name && pm.name.startsWith(c.fullName + "-"))
        );
        if (matched) {
          playerObj = pm;
          otherMembers = partyMembers.filter((_, idx) => idx !== i);
          uploaderName = matched.fullName || pm.name;
          identitySource = "combat_log_guid_match";
          console.log(`[RunBuilder] GUID identity match: ${pm.name} → ${matched.fullName} (${matched.class})`);
          break;
        }
      }
    }

    // Priority 2: SavedVariables identity
    if (identitySource === "unknown" && this.uploaderIdentity) {
      uploaderName = this.uploaderIdentity;
      identitySource = "saved_variables";
      const uploaderIndex = partyMembers.findIndex(pm =>
        pm.name === this.uploaderIdentity ||
        pm.name.startsWith(this.uploaderIdentity + "-")
      );
      if (uploaderIndex >= 0) {
        playerObj = partyMembers[uploaderIndex];
        otherMembers = partyMembers.filter((_, i) => i !== uploaderIndex);
        console.log(`[RunBuilder] SV identity match: ${playerObj.name} (${playerObj.class} ${playerObj.spec} ${playerObj.role})`);
      } else {
        console.warn(`[RunBuilder] SV identity "${this.uploaderIdentity}" not found in party list — using first player`);
      }
    }

    // Priority 3: fallback to first party member
    if (identitySource === "unknown") {
      uploaderName = playerObj.name || "Unknown";
      identitySource = "fallback";
    }

    // Attach Blizzard talent export string to the uploader's player object
    if (this.playerTalentString) {
      playerObj.talentString = this.playerTalentString;
    }

    return {
      addon: "VelaraIntel",
      v: "1.1.0",
      uploadTs: Date.now(),
      uploadedBy: {
        clientId: this.clientId || "unknown",
        characterName: uploaderName,
        fullName: uploaderName,
        identitySource: identitySource,
      },
      clockOffsetMs: 0,
      clockSyncConfidence: "high",
      run: {
        runId: run.runId,
        mapId: run.mapId,
        dungeonName: run.dungeonName,
        keyLevel: keyLevel || run.keyLevel,
        affixes: [],
        startTs: run.startTs,
        finishTs: run.finishTs,
        durationMs: run.finishTs - run.startTs,
        runType: "private",
        runMode: "standard",
        privacyMode: "shareable",
        addonVersion: "1.1.0",
        exportVersion: "1.1.0",
        telemetryCapabilities: {
          hasCombatSegments: finalSegments.length > 0,
          hasEnemyRegistry: false,
          hasPartySnapshot: partyMembers.length > 0,
          hasDeathContext: totalDeaths > 0,
          hasDamageBuckets: totalBuckets > 0,
          hasEnemyCasts: totalECs > 0,
          hasInterrupts: totalInts > 0,
          hasEnemyHealthSnapshots: false,
          hasEnemyPositions: false,
          hasDefensives: totalDefs > 0,
          hasEncounterData: this.bossEncounters.length > 0,
        },
        player: playerObj,
        partyMembers: otherMembers,
        combatSegments: finalSegments,
        bossEncounters: this.bossEncounters,
        completionResult: { medal: success > 0 ? 1 : 0, timeMs, money: 0 },
        deathCountFinal: totalDeaths,
        interruptibleSpells: this.knownInterruptibleSpells
            ? [...this.knownInterruptibleSpells.values()]
            : [],
        pulls: [],
        wipes: [],
        damageBuckets: [],
        enemyRegistry: [],
      },
    };
  }
}

module.exports = { CombatLogRunBuilder };
