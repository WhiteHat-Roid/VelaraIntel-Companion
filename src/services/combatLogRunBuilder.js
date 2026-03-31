// combatLogRunBuilder.js — V2.0 (Companion v1.0.0)
// Hardened: dynamic segmentation, tiered party detection, fault-tolerant parser.
// ChatGPT-approved architecture — combat log is the single source of truth.

"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");

// ─── Spell allowlists (same as combatLogParser.js) ─────────────────────────

const DEFENSIVE_CD_SPELLS = new Set([
  48707, 49028, 48792,          // DK: AMS, DRW, IBF
  22812, 61336,                 // Druid: Barkskin, Survival Instincts
  374348,                       // Evoker: Obsidian Scales
  186265,                       // Hunter: Turtle
  45438,                        // Mage: Ice Block
  122278, 116849,               // Monk: Dampen Harm, Life Cocoon
  642, 498, 31850, 86659,       // Paladin: Bubble, DP, AD, GoAK
  47788, 33206,                 // Priest: Guardian Spirit, Pain Suppression
  31224, 5277,                  // Rogue: Cloak, Evasion
  108271,                       // Shaman: Astral Shift
  871, 1160, 12975,             // Warrior: Shield Wall, Demo Shout, Last Stand
  108416, 6789,                 // Warlock: Dark Pact, Mortal Coil
]);

const INTERRUPT_SPELLS = new Set([
  47528, 183752, 78675, 106839, 351338, 147362, 187707,
  2139, 116705, 96231, 15487, 1766, 57994, 6552, 119910,
]);

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
    this.guidToName      = new Map();  // GUID → "Name-Realm"
    this.damageBuffers   = new Map();  // per-player pre-death damage
    this.playerDamageTaken = new Map();  // GUID → total damage taken
    this.playerHealingDone = new Map();  // GUID → total healing done
    this.confirmedPartyGuids = new Set();
    this.segCounters     = { death: 0, cd: 0, int: 0, ec: 0 };
    this.lastCreatureDamageTs = 0;  // Last time ANY creature dealt or received damage
    this.knownInterruptibleSpells = new Map();  // spellId → { spellId, spellName, npcId, npcName, count }
    this.lineCount       = 0;
    this.eventCount      = 0;
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
        runId: mapId + "-" + Math.floor(ts / 1000) + "-" + randHex(2) + "-" + randHex(2),
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
    // PRIVACY: We extract GUID + spec ID only. Talent trees, item levels,
    // gear data are intentionally ignored and never stored.
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
      }
      return null;
    }

    // ── Segment management via NPC tracking + damage gap safety net ────
    const isDamage = event === "SWING_DAMAGE" || event === "SPELL_DAMAGE" ||
                     event === "SPELL_PERIODIC_DAMAGE" || event === "RANGE_DAMAGE";
    const isHeal   = event === "SPELL_HEAL" || event === "SPELL_PERIODIC_HEAL";
    const isCast   = event === "SPELL_CAST_SUCCESS";
    const isCastStart = event === "SPELL_CAST_START";
    const isDied   = event === "UNIT_DIED";
    const isInterrupt = event === "SPELL_INTERRUPT";

    if (!isDamage && !isHeal && !isCast && !isCastStart && !isDied && !isInterrupt) return null;

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
    }

    // ── UNIT_DIED — player death tracking ──────────────────────────────
    if (isDied && isPlayerGuid(destGuid)) {
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

      seg.deaths.push({
        deathId, segmentId: seg.segmentId, deathTs: ts,
        offsetMs: ts - seg.startTs,
        name: this.guidToName.get(destGuid) || "Unknown",
        class: this.guidToClass.get(destGuid) || "UNKNOWN",
        role: this.guidToRole.get(destGuid) || "unknown",
        firstDeathInPull: seg.deaths.length === 0,
        killingBlow: kb ? { spellName: kb.spellName, amount: kb.amount } : null,
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
        spellName,
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

    // ── Player cast — check for defensive CDs ──────────────────────────
    if (isCast && isPlayerGuid(sourceGuid) && this.currentSeg) {
      const spellId = parseInt(fields[9], 10) || 0;
      const spellName = (fields[10] || "").replace(/"/g, "");
      if (DEFENSIVE_CD_SPELLS.has(spellId)) {
        this.currentSeg.defensives.push({
          ts, offsetMs: ts - this.currentSeg.startTs,
          spellName,
          name: this.guidToName.get(sourceGuid) || "Unknown",
          class: this.guidToClass.get(sourceGuid) || "UNKNOWN",
          role: this.guidToRole.get(sourceGuid) || "unknown",
        });
      }
      return null;
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
            npcName: sourceName || null, spellName,
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
        45438: "MAGE", 122278: "MONK", 116849: "MONK",
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
      if ([47788, 33206, 116849].includes(spellId)) this.guidToRole.set(guid, "healer");
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
      });
    }

    const totalInts  = finalSegments.reduce((s, seg) => s + seg.interrupts.length, 0);
    const totalDefs  = finalSegments.reduce((s, seg) => s + seg.defensives.length, 0);
    const totalECs   = finalSegments.reduce((s, seg) => s + seg.enemyCasts.length, 0);
    const totalDeaths = finalSegments.reduce((s, seg) => s + seg.deaths.length, 0);
    const totalBuckets = finalSegments.reduce((s, seg) => s + seg.damageBuckets.length, 0);

    console.log(`[RunBuilder] Payload: ${finalSegments.length} segments, ${totalInts} interrupts, ${totalDefs} defensives, ${totalECs} enemy casts, ${totalDeaths} deaths, ${totalBuckets} damage buckets`);
    console.log(`[RunBuilder] Lines processed: ${this.lineCount}, events matched: ${this.eventCount}`);

    return {
      addon: "VelaraIntel",
      v: "1.1.0",
      uploadTs: Date.now(),
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
        player: partyMembers[0] || { name: "Unknown", class: "UNKNOWN", role: "dps" },
        partyMembers: partyMembers.slice(1),
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
