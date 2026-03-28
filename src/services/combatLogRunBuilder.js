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
  502:  "Maisara Caverns",
  2915: "Nexus-Point Xenas",   503: "Nexus-Point Xenas",
  246:  "Pit of Saron",        658: "Pit of Saron",
  1753: "Seat of the Triumvirate", 504: "Seat of the Triumvirate",
  1209: "Skyreach",
  2805: "Windrunner Spire",    2769: "Windrunner Spire",
};

// WoW class IDs from COMBATANT_INFO
const CLASS_BY_ID = {
  1: "WARRIOR", 2: "PALADIN", 3: "HUNTER", 4: "ROGUE", 5: "PRIEST",
  6: "DEATHKNIGHT", 7: "SHAMAN", 8: "MAGE", 9: "WARLOCK", 10: "MONK",
  11: "DRUID", 12: "DEMONHUNTER", 13: "EVOKER",
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
  "COMBATANT_INFO": 2,
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
    this.guidToAnon      = new Map();  // GUID → "Player-1" etc
    this.anonCounter     = 0;
    this.damageBuffers   = new Map();  // per-player pre-death damage
    this.playerDamageTaken = new Map();  // GUID → total damage taken
    this.playerHealingDone = new Map();  // GUID → total healing done
    this.confirmedPartyGuids = new Set();
    this.segCounters     = { death: 0, cd: 0, int: 0, ec: 0 };
    this.lineCount       = 0;
    this.eventCount      = 0;
  }

  // Get anonymized label for a player GUID
  _anon(guid) {
    if (!guid) return "Unknown";
    if (!this.guidToAnon.has(guid)) {
      this.anonCounter++;
      this.guidToAnon.set(guid, "Player-" + this.anonCounter);
    }
    return this.guidToAnon.get(guid);
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

  // ── Dynamic segment gap threshold based on context ─────────────────────
  _getSegmentGapThreshold() {
    // Boss RP phases, intermissions, and phase transitions can have 10+ second gaps
    if (this.openBoss) {
      return 12000;  // 12 seconds during boss fights
    }
    // For trash, use a shorter threshold
    return 5000;  // 5 seconds for trash packs
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
    // PRIVACY: COMBATANT_INFO contains talent trees, item levels, gear data.
    // We ONLY extract GUID for party membership tracking.
    // All other fields are intentionally ignored and never stored.
    if (event === "COMBATANT_INFO") {
      const guid = fields[1] || "";
      if (isPlayerGuid(guid)) {
        // Register as confirmed party member
        if (!this.guidToClass.has(guid)) {
          this.guidToClass.set(guid, "UNKNOWN");
        }
        if (!this.guidToRole.has(guid)) {
          this.guidToRole.set(guid, "unknown");
        }
        // Mark as confirmed via COMBATANT_INFO (highest tier)
        this.confirmedPartyGuids.add(guid);
      }
      return null;
    }

    // ── Segment management via damage gaps ──────────────────────────────
    const isDamage = event === "SWING_DAMAGE" || event === "SPELL_DAMAGE" ||
                     event === "SPELL_PERIODIC_DAMAGE" || event === "RANGE_DAMAGE";
    const isHeal   = event === "SPELL_HEAL" || event === "SPELL_PERIODIC_HEAL";
    const isCast   = event === "SPELL_CAST_SUCCESS";
    const isCastStart = event === "SPELL_CAST_START";
    const isDied   = event === "UNIT_DIED";
    const isInterrupt = event === "SPELL_INTERRUPT";

    if (!isDamage && !isHeal && !isCast && !isCastStart && !isDied && !isInterrupt) return null;

    // Check for segment gap before processing
    if (isDamage || isCast || isInterrupt) {
      this._checkSegmentGap(ts);
      if (!this.currentSeg) this._openSeg(ts);
      this.lastDamageTs = ts;
    }

    const sourceGuid = fields[1] || "";
    const sourceName = (fields[2] || "").replace(/"/g, "");
    const destGuid   = fields[5] || "";
    const destName   = (fields[6] || "").replace(/"/g, "");

    // ── Spell-based class/role detection ────────────────────────────────
    if (isPlayerGuid(sourceGuid) && isCast) {
      const spellId = parseInt(fields[9], 10) || 0;
      this._detectClassFromSpell(sourceGuid, spellId);
    }

    // ── UNIT_DIED ───────────────────────────────────────────────────────
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
      const tgtSpellId = parseInt(fields[12], 10) || 0;
      const tgtSpellName = (fields[13] || "").replace(/"/g, "");
      this.currentSeg.interrupts.push({
        ts, offsetMs: ts - this.currentSeg.startTs,
        spellName,
        sourceClass: this.guidToClass.get(sourceGuid) || "UNKNOWN",
        sourceRole: this.guidToRole.get(sourceGuid) || "unknown",
        targetSpellName: tgtSpellName,
        targetNpcName: isCreatureGuid(destGuid) ? destName : null,
      });
      return null;
    }

    // ── Damage ──────────────────────────────────────────────────────────
    if (isDamage && isPlayerGuid(destGuid)) {
      let spellId = 0, spellName = "Melee", amount = 0, overkill = 0;
      if (event === "SWING_DAMAGE") {
        amount = parseInt(fields[9], 10) || 0;
        overkill = parseInt(fields[10], 10) || 0;
      } else {
        spellId = parseInt(fields[9], 10) || 0;
        spellName = (fields[10] || "").replace(/"/g, "");
        amount = parseInt(fields[12], 10) || 0;
        overkill = parseInt(fields[13], 10) || 0;
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

    // ── Healing done tracking (for post-run role heuristic) ───────────
    if (isHeal && isPlayerGuid(sourceGuid)) {
      const healAmount = parseInt(fields[12], 10) || 0;
      if (!isNaN(healAmount) && healAmount > 0) {
        this.playerHealingDone.set(sourceGuid, (this.playerHealingDone.get(sourceGuid) || 0) + healAmount);
      }
    }

    // ── Healing received ────────────────────────────────────────────────
    if (isHeal && isPlayerGuid(destGuid) && this.currentSeg) {
      const amount = parseInt(fields[12], 10) || 0;
      if (isNaN(amount) || amount < 0) return null;
      const overheal = parseInt(fields[13], 10) || 0;
      const effective = Math.max(0, amount - overheal);
      this._addHeal(ts, effective);
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
          class: this.guidToClass.get(sourceGuid) || "UNKNOWN",
          role: this.guidToRole.get(sourceGuid) || "unknown",
        });
      }
      return null;
    }

    // ── Enemy cast start (capped at 30 per segment) ─────────────────────
    if (isCastStart && isCreatureGuid(sourceGuid) && this.currentSeg) {
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

  // ── Class detection from spells ───────────────────────────────────────
  _detectClassFromSpell(guid, spellId) {
    if (this.guidToClass.get(guid) && this.guidToClass.get(guid) !== "UNKNOWN") return;

    // Map interrupt spell → class
    const intClassMap = {
      47528: "DEATHKNIGHT", 183752: "DEMONHUNTER", 78675: "DRUID", 106839: "DRUID",
      351338: "EVOKER", 147362: "HUNTER", 187707: "HUNTER", 2139: "MAGE",
      116705: "MONK", 96231: "PALADIN", 15487: "PRIEST", 1766: "ROGUE",
      57994: "SHAMAN", 6552: "WARRIOR", 119910: "WARLOCK",
    };
    // Map defensive spell → class
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

    // Detect role from defensive/healing spells
    if ([47788, 33206, 116849].includes(spellId)) this.guidToRole.set(guid, "healer");
    if ([49028, 86659, 871, 12975, 31850].includes(spellId)) this.guidToRole.set(guid, "tank");
  }

  // ── Merge segments shorter than 3 seconds into previous ────────────────
  _mergeShortSegments() {
    if (this.segments.length <= 1) return;

    const merged = [this.segments[0]];

    for (let i = 1; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const duration = seg.finishTs - seg.startTs;

      if (duration < 3000 && merged.length > 0) {
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

    // Build anonymous party list from detected GUIDs
    const partyMembers = [];
    for (const [guid, cls] of this.guidToClass) {
      if (!isPlayerGuid(guid)) continue;
      partyMembers.push({
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
      v: "0.8.3",
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
        addonVersion: "0.8.3",
        exportVersion: "1.0.0",
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
        player: partyMembers[0] || { class: "UNKNOWN", role: "dps" },
        partyMembers: partyMembers.slice(1),
        combatSegments: finalSegments,
        bossEncounters: this.bossEncounters,
        completionResult: { medal: success > 0 ? 1 : 0, timeMs, money: 0 },
        deathCountFinal: totalDeaths,
        pulls: [],
        wipes: [],
        damageBuckets: [],
        enemyRegistry: [],
      },
    };
  }
}

module.exports = { CombatLogRunBuilder };
