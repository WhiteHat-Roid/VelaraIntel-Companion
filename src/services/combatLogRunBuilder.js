// combatLogRunBuilder.js — V2.0 (Companion v1.0.0)
// Hardened: dynamic segmentation, tiered party detection, fault-tolerant parser.
// ChatGPT-approved architecture — combat log is the single source of truth.

"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { version: COMPANION_VERSION } = require("../../package.json");

// ─── Spell allowlists (same as combatLogParser.js) ─────────────────────────

// ─── Defensive CD Tracking — Spec-Aware ─────────────────────────────────────
// Rule: Track meaningful defensive decisions only. 2min+ CD as general threshold.
// Rotational mitigation: Ironfur, Demon Spikes, Ignore Pain, Shield Block,
// Shield of the Righteous, Bone Shield — NOW TRACKED (Mitigation Phase 2, 2026-05-17).
// Short-CD absorbs (Ice Barrier, Crimson Vial) = NOT tracked.
// Exception: Feint IS tracked despite short CD — it's the primary Rogue M+ defensive.
// Some spells are spec-conditional (e.g., Frenzied Regen is rotational for Guardian but defensive for others).

const ALWAYS_TRACK_DEFENSIVES = new Map([
  // ── Death Knight ──
  [48707,  { name: "Anti-Magic Shell",       category: "defensive" }],
  [48792,  { name: "Icebound Fortitude",     category: "defensive" }],
  [55233,  { name: "Vampiric Blood",         category: "defensive" }],
  [49028,  { name: "Dancing Rune Weapon",    category: "defensive" }],
  [51052,  { name: "Anti-Magic Zone",        category: "external"  }],
  [49039,  { name: "Lichborne",              category: "defensive" }],

  // ── Demon Hunter ──
  [198589, { name: "Blur",                   category: "defensive" }],
  [196718, { name: "Darkness",               category: "external"  }],
  [196555, { name: "Netherwalk",             category: "defensive" }],
  [187827, { name: "Metamorphosis (Veng)",   category: "defensive" }],
  [204021, { name: "Fiery Brand",            category: "defensive" }],

  // ── Druid ──
  [61336,  { name: "Survival Instincts",     category: "defensive" }],
  [102342, { name: "Ironbark",               category: "external" }],

  // ── Evoker ──
  [374348, { name: "Obsidian Scales",        category: "defensive" }],
  [374227, { name: "Zephyr",                 category: "external"  }],
  [370960, { name: "Emerald Communion",      category: "defensive" }],

  // ── Hunter ──
  [186265, { name: "Aspect of the Turtle",   category: "defensive" }],
  [109304, { name: "Exhilaration",           category: "defensive" }],

  // ── Mage ──
  [45438,  { name: "Ice Block",              category: "defensive" }],
  [342245, { name: "Alter Time",             category: "defensive" }],
  [55342,  { name: "Mirror Image",           category: "defensive" }],

  // ── Monk ──
  [115203, { name: "Fortifying Brew",        category: "defensive" }],
  [122278, { name: "Dampen Harm",            category: "defensive" }],
  [122783, { name: "Diffuse Magic",          category: "defensive" }],
  [115176, { name: "Zen Meditation",         category: "defensive" }],
  [116849, { name: "Life Cocoon",            category: "external" }],
  [325197, { name: "Invoke Chi-Ji",          category: "external" }],
  [322118, { name: "Invoke Yu'lon",          category: "external" }],
  [132578, { name: "Invoke Niuzao, the Black Ox", category: "defensive" }],
  [322507, { name: "Celestial Brew",         category: "defensive" }],
  [115399, { name: "Black Ox Brew",          category: "defensive" }],

  // ── Paladin ──
  [642,    { name: "Divine Shield",          category: "defensive" }],
  [31850,  { name: "Ardent Defender",        category: "defensive" }],
  [86659,  { name: "Guardian of Ancient Kings", category: "defensive" }],
  [633,    { name: "Lay on Hands",           category: "external" }],
  [1022,   { name: "Blessing of Protection", category: "external" }],
  [6940,   { name: "Blessing of Sacrifice",  category: "external" }],
  [204018, { name: "Blessing of Spellwarding", category: "external" }],

  // ── Priest ──
  [47788,  { name: "Guardian Spirit",        category: "external" }],
  [33206,  { name: "Pain Suppression",       category: "external" }],
  [62618,  { name: "Power Word: Barrier",    category: "external" }],
  [271466, { name: "Luminous Barrier",       category: "external" }],
  [15286,  { name: "Vampiric Embrace",       category: "external"  }],
  [64843,  { name: "Divine Hymn",            category: "external" }],
  [47585,  { name: "Dispersion",             category: "defensive" }],

  // ── Rogue ──
  [31224,  { name: "Cloak of Shadows",       category: "defensive" }],
  [5277,   { name: "Evasion",                category: "defensive" }],
  [1966,   { name: "Feint",                  category: "defensive" }],

  // ── Shaman ──
  [108271, { name: "Astral Shift",           category: "defensive" }],
  [98008,  { name: "Spirit Link Totem",      category: "external" }],
  [108280, { name: "Healing Tide Totem",     category: "external" }],

  // ── Warlock ──
  [104773, { name: "Unending Resolve",       category: "defensive" }],
  [108416, { name: "Dark Pact",              category: "defensive" }],

  // ── Warrior ──
  [871,    { name: "Shield Wall",            category: "defensive" }],
  [12975,  { name: "Last Stand",             category: "defensive" }],
  [184364, { name: "Enraged Regeneration",   category: "defensive" }],
  [97462,  { name: "Rallying Cry",           category: "external" }],
  [118038, { name: "Die by the Sword",       category: "defensive" }],

  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // Personal defensives missing from prior coverage. Master registry sourced from
  // VELARA_COMPLETE_SPELL_REGISTRY.md (Patch 12.0.5). Categories follow existing
  // shape: `defensive` (personal DR/heal), `external` (cast on others).
  // ── Death Knight ──
  [194679, { name: "Rune Tap",               category: "defensive" }],
  [219809, { name: "Tombstone",              category: "defensive" }],
  // ── Demon Hunter ──
  [263648, { name: "Soul Barrier",           category: "defensive" }],
  // ── Druid ──
  [200851, { name: "Rage of the Sleeper",    category: "defensive" }],
  [740,    { name: "Tranquility",            category: "external"  }],
  // ── Evoker ──
  [363916, { name: "Obsidian Scales",        category: "defensive" }],  // alt CLEU ID; 374348 already registered
  [363534, { name: "Rewind",                 category: "external"  }],
  [370984, { name: "Time Spiral",            category: "external"  }],
  // ── Hunter ──
  [264735, { name: "Survival of the Fittest", category: "defensive" }],
  [5384,   { name: "Feign Death",            category: "defensive" }],
  // ── Mage ──
  [11426,  { name: "Ice Barrier",            category: "defensive" }],   // also absorb
  [235313, { name: "Blazing Barrier",        category: "defensive" }],   // also absorb
  [235450, { name: "Prismatic Barrier",      category: "defensive" }],   // also absorb
  [110959, { name: "Greater Invisibility",   category: "defensive" }],
  // ── Monk ──
  [243435, { name: "Fortifying Brew (WW/MW)", category: "defensive" }],
  [115310, { name: "Revival",                category: "external"  }],
  // ── Paladin ──
  [184662, { name: "Shield of Vengeance",    category: "defensive" }],   // also absorb
  [205191, { name: "Eye for an Eye",         category: "defensive" }],
  // ── Priest ──
  [586,    { name: "Fade",                   category: "defensive" }],
  // ── Rogue ──
  [1856,   { name: "Vanish",                 category: "defensive" }],
  [185311, { name: "Crimson Vial",           category: "defensive" }],
  // ── Shaman ──
  [198103, { name: "Earth Elemental",        category: "defensive" }],
  [207399, { name: "Ancestral Protection Totem", category: "external"  }],
  [325174, { name: "Spirit Link Totem",      category: "external"  }],   // alt CLEU ID; 98008 already registered
  // ── Warlock ──
  [6229,   { name: "Twilight Ward",          category: "defensive" }],
  // ── Warrior ──
  [23920,  { name: "Spell Reflection",       category: "defensive" }],

  // ── Mitigation Phase 2 — 2026-05-17 — Rotational tank mitigation ──
  // Previously excluded per original comment. Added to support Mitigation overlay.
  // These are SPELL_AURA_APPLIED events (buff on tank), not SPELL_CAST_SUCCESS.
  // shouldTrackDefensive() handles both isCast and isAuraApplied — no new
  // event handler needed.
  // ── Death Knight ──
  [195181, { name: "Bone Shield",                category: "defensive" }],  // Blood DK — high freq, fires on each charge consumed
  // ── Demon Hunter ──
  [203720, { name: "Demon Spikes",               category: "defensive" }],  // Vengeance DH
  // ── Druid ──
  [192081, { name: "Ironfur",                    category: "defensive" }],  // Guardian Druid
  // ── Paladin ──
  [53600,  { name: "Shield of the Righteous",    category: "defensive" }],  // Prot Paladin
  // ── Warrior ──
  [190456, { name: "Ignore Pain",                category: "defensive" }],  // Prot Warrior
  [2565,   { name: "Shield Block",               category: "defensive" }],  // Prot Warrior
]);

// Spells that are only tracked for SPECIFIC specs
// Key = spell ID, Value = { track: Set of spec IDs to track, OR exclude: Set of spec IDs to NOT track }
const SPEC_CONDITIONAL_DEFENSIVES = {
  22842:  { exclude: new Set([104]), category: "defensive" },  // Frenzied Regen
  22812:  { track: null, category: "defensive" },              // Barkskin
  102558: { track: new Set([104]), category: "defensive" },    // Incarnation: Guardian
  // 319454: { exclude: new Set([104]), category: "utility" },  // Heart of the Wild
  // RETIRED 2026-05-31 — old spellbook ID never fires in Midnight CLEU.
  // Real IDs 1261870 + 1261868 now tracked in OFFENSIVE_COOLDOWNS. Do not delete.
  498:    { track: null, category: "defensive" },              // Divine Protection
  19236:  { track: null, category: "defensive" },              // Desperate Prayer
};

/**
 * Check if a defensive spell should be tracked for a given spec.
 * @param {number} spellId
 * @param {number|null} specId - player's spec ID from COMBATANT_INFO (null if unknown)
 * @returns {boolean}
 */
function stripRegionSuffix(name) {
  if (!name || typeof name !== "string") return name;
  return name.replace(/-(US|EU|KR|TW|CN)$/i, "");
}

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
  // 273104 is the combat-log-emitted ID for Fireblood (the 265221 in the spellbook
  // never fires in CLEU). Same lesson as absorb spell IDs: Wowhead/spellbook IDs
  // and combat log IDs can diverge. Both kept; either may surface depending on
  // toy/transformation state.
  [273104, { race: "Dark Iron Dwarf",  name: "Fireblood",         type: "cleanse_offensive" }],
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
  [59752,  { race: "Human",           name: "Every Man for Himself", type: "cleanse" }],
  [20549,  { race: "Tauren",          name: "War Stomp",         type: "cc" }],
  // 69179 was previously labeled "Goblin Rocket Barrage" — Wowhead 2026-05-07 verifies
  // 69179 is actually the Blood Elf Warrior variant of Arcane Torrent. Real Goblin
  // Rocket Barrage is 69041 (added below). Relabeling is data-integrity per CLAUDE.md
  // Rule 9; the spell ID stays in the registry.
  [69179,  { race: "Blood Elf",       name: "Arcane Torrent",    type: "offensive" }],
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

  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // Blood Elf Arcane Torrent fires per-class spell IDs in CLEU. Register ALL of them.
  // 69179 already relabeled above (Warrior variant). 28730 is the Wowhead spellbook
  // root; the others are spec/class CLEU IDs.
  [28730,  { race: "Blood Elf",       name: "Arcane Torrent",    type: "offensive" }],   // Mage/Warlock
  [155145, { race: "Blood Elf",       name: "Arcane Torrent",    type: "offensive" }],   // Paladin
  [80483,  { race: "Blood Elf",       name: "Arcane Torrent",    type: "offensive" }],   // Hunter
  [129597, { race: "Blood Elf",       name: "Arcane Torrent",    type: "offensive" }],   // Monk
  [25046,  { race: "Blood Elf",       name: "Arcane Torrent",    type: "offensive" }],   // Rogue
  [50613,  { race: "Blood Elf",       name: "Arcane Torrent",    type: "offensive" }],   // Death Knight
  [202719, { race: "Blood Elf",       name: "Arcane Torrent",    type: "offensive" }],   // Demon Hunter
  [232633, { race: "Blood Elf",       name: "Arcane Torrent",    type: "offensive" }],   // Priest

  // Worgen / Goblin / Kul Tiran / Dracthyr utility racials missing from prior set.
  [68992,  { race: "Worgen",          name: "Darkflight",        type: "mobility" }],
  [69041,  { race: "Goblin",          name: "Rocket Barrage",    type: "damage" }],     // real Rocket Barrage ID
  [287712, { race: "Kul Tiran",       name: "Haymaker",          type: "cc" }],         // alt CLEU ID; 259930 also registered
  [358733, { race: "Dracthyr",        name: "Glide",             type: "mobility" }],
  // ── Earthen (TWW) ──
  [446280, { race: "Earthen",         name: "Azerite Surge",     type: "damage" }],
  [448849, { race: "Earthen",         name: "Wide-Eyed Wonder",  type: "utility" }],
]);

const INTERRUPT_SPELLS = new Set([
  47528, 183752, 78675, 106839, 351338, 147362, 187707,
  2139, 116705, 96231, 15487, 1766, 57994, 6552, 119910,
  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // Pet interrupts: source GUID is the pet, parser must attribute to owner.
  19647,   // Spell Lock (Felhunter pet bar)
  132409,  // Spell Lock (Command Demon — player-cast variant)
  212619,  // Call Felhunter (Demonology PvP talent — also interrupts)
  89766,   // Axe Toss (Felguard) — also a stun, dual-purpose
  // CLEU divergence: SPELL_INTERRUPT events fire under DIFFERENT spell IDs than the
  // cast events for these abilities. Register both so either branch resolves.
  97547,   // Solar Beam (interrupt event ID; cast 78675)
  93985,   // Skull Bash (interrupt event ID; cast 106839)
  220543,  // Silence (interrupt event ID; cast 15487)
]);

// ── CC/Crowd Control spells — enemy abilities that incapacitate players ─────
// Track when these are applied TO a player (SPELL_AURA_APPLIED where dest is player).
// These answer: "Was the kicker CC'd when the dangerous cast went off?"
const CC_SPELLS = new Map([
  // ── Generic dungeon CC ──
  // Stuns
  [424888, { type: "stun",        name: "Thunderous Clap" }],
  [424966, { type: "stun",        name: "Crushing Slam" }],
  // Fears
  [196748, { type: "fear",        name: "Terror" }],
  [240443, { type: "fear",        name: "Burst of Fear" }],
  // Silences
  [196543, { type: "silence",     name: "Arcane Lockdown" }],
  // Incapacitates
  [118,    { type: "incapacitate", name: "Polymorph" }],
  [6770,   { type: "incapacitate", name: "Sap" }],
  // Disorients
  [31661,  { type: "disorient",   name: "Dragon's Breath" }],
  [207167, { type: "disorient",   name: "Blinding Sleet" }],
  // Knockbacks
  [132764, { type: "knockback",   name: "NPC Knockback" }],
]);
// NOTE: This is a STARTER list. We will expand it as we see real dungeon data.
// The combat log also provides the spell name, so we capture ALL auras from
// hostile creatures onto players — the CC_SPELLS map just tags the CC type.
// Unknown hostile auras get type: "debuff".

// ── Offensive Cooldowns — major DPS/group CDs ──────────────────────────────
// Track SPELL_CAST_SUCCESS by players for these spells.
// Answers: "Did the group use Lust on this pull? Did DPS pop CDs?"
const OFFENSIVE_COOLDOWNS = new Map([
  // ── Group-wide ──
  [2825,   { name: "Bloodlust",          type: "group_offensive",  cd: 300 }],
  [32182,  { name: "Heroism",            type: "group_offensive",  cd: 300 }],
  [80353,  { name: "Time Warp",          type: "group_offensive",  cd: 300 }],
  [264667, { name: "Primal Rage",        type: "group_offensive",  cd: 300 }],
  [272678, { name: "Primal Rage",        type: "group_offensive",  cd: 300 }],  // pet-cast ID — inert until OFFENSIVE_CD_03 pet attribution (OFFENSIVE_CD_02)
  [390386, { name: "Fury of the Aspects", type: "group_offensive", cd: 300 }],
  // ── Death Knight ──
  [47568,  { name: "Empower Rune Weapon", type: "personal_offensive", cd: 120 }],
  [207289, { name: "Unholy Assault",      type: "personal_offensive", cd: 90 }],
  [51271,  { name: "Pillar of Frost",     type: "personal_offensive", cd: 60 }],
  // Apocalypse (275699) removed — deleted from the game in Midnight 12.0 (OFFENSIVE_CD_02)
  // ── Demon Hunter ──
  [191427, { name: "Metamorphosis (Havoc)", type: "personal_offensive", cd: 240 }],
  [258920, { name: "Immolation Aura",      type: "personal_offensive", cd: 30 }],
  // ── Druid ──
  [194223, { name: "Celestial Alignment",  type: "personal_offensive", cd: 180 }],
  [106951, { name: "Berserk (Feral)",      type: "personal_offensive", cd: 180 }],
  // ── Evoker ──
  [375087, { name: "Dragonrage",           type: "personal_offensive", cd: 120 }],
  // ── Hunter ──
  [288613, { name: "Trueshot",             type: "personal_offensive", cd: 120 }],
  [19574,  { name: "Bestial Wrath",        type: "personal_offensive", cd: 90 }],
  [360952, { name: "Coordinated Assault",  type: "personal_offensive", cd: 120 }],
  // ── Mage ──
  [12472,  { name: "Icy Veins",            type: "personal_offensive", cd: 120 }],
  [190319, { name: "Combustion",           type: "personal_offensive", cd: 120 }],
  [365350, { name: "Arcane Surge",         type: "personal_offensive", cd: 90 }],
  // ── Monk ──
  [137639, { name: "Storm, Earth, and Fire", type: "personal_offensive", cd: 90 }],
  [152173, { name: "Serenity",              type: "personal_offensive", cd: 90 }],
  // ── Paladin ──
  [31884,  { name: "Avenging Wrath",       type: "personal_offensive", cd: 120 }],
  [454351, { name: "Avenging Wrath",       type: "personal_offensive", cd: 120 }],  // Midnight 12.0 alt cast ID (both fire; OFFENSIVE_CD_02)
  [231895, { name: "Crusade",              type: "personal_offensive", cd: 120 }],
  // ── Priest ──
  [10060,  { name: "Power Infusion",       type: "personal_offensive", cd: 120 }],
  [228260, { name: "Void Eruption",        type: "personal_offensive", cd: 90 }],
  // ── Rogue ──
  [13750,  { name: "Adrenaline Rush",      type: "personal_offensive", cd: 180 }],
  [121471, { name: "Shadow Blades",        type: "personal_offensive", cd: 180 }],
  [360194, { name: "Deathmark",            type: "personal_offensive", cd: 120 }],
  // ── Shaman ──
  [114050, { name: "Ascendance",           type: "personal_offensive", cd: 180 }],
  [191634, { name: "Stormkeeper",          type: "personal_offensive", cd: 60 }],
  [51533,  { name: "Feral Spirit",         type: "personal_offensive", cd: 90 }],
  // ── Warlock ──
  [1122,   { name: "Summon Infernal",      type: "personal_offensive", cd: 180 }],
  [111898, { name: "Grimoire: Felguard",   type: "personal_offensive", cd: 120 }],
  [205180, { name: "Summon Darkglare",     type: "personal_offensive", cd: 120 }],
  // ── Warrior ──
  [107574, { name: "Avatar",              type: "personal_offensive", cd: 90 }],
  [1719,   { name: "Recklessness",        type: "personal_offensive", cd: 90 }],
  [227847, { name: "Bladestorm",          type: "personal_offensive", cd: 90 }],
  [228920, { name: "Ravager",             type: "personal_offensive", cd: 90 }],
  // ── Death Knight (additions 2026-05-03) ──
  [48265,  { name: "Death's Advance",        type: "personal_offensive", cd: 45 }],  // Midnight 12.0 emitted ID (was 96268; OFFENSIVE_CD_02)
  // ── Demon Hunter (additions 2026-05-03) ──
  [198013, { name: "Eye Beam",               type: "personal_offensive", cd: 30 }],
  [200166, { name: "Metamorphosis (Veng)",   type: "personal_offensive", cd: 240 }],
  // ── Druid (additions 2026-05-03) ──
  [323764, { name: "Convoke the Spirits",    type: "personal_offensive", cd: 120 }],
  [102560, { name: "Incarnation: Chosen of Elune", type: "personal_offensive", cd: 180 }],
  [102543, { name: "Incarnation: King of the Jungle", type: "personal_offensive", cd: 180 }],
  // ── Hunter (additions 2026-05-03) ──
  [260243, { name: "Volley",                 type: "personal_offensive", cd: 45 }],
  [400456, { name: "Salvo",                  type: "personal_offensive", cd: 45 }],
  // ── Mage (additions 2026-05-03) ──
  [55342,  { name: "Mirror Image",           type: "personal_offensive", cd: 120 }],
  // ── Paladin (additions 2026-05-03) ──
  [255937, { name: "Wake of Ashes",          type: "personal_offensive", cd: 60 }],
  [343721, { name: "Final Reckoning",        type: "personal_offensive", cd: 60 }],
  [343527, { name: "Execution Sentence",     type: "personal_offensive", cd: 60 }],
  // ── Priest (additions 2026-05-03) ──
  [123040, { name: "Mindbender",             type: "personal_offensive", cd: 60 }],
  [34433,  { name: "Shadowfiend",            type: "personal_offensive", cd: 180 }],
  [47536,  { name: "Rapture",                type: "personal_offensive", cd: 90 }],
  [391109, { name: "Dark Ascension",         type: "personal_offensive", cd: 60 }],
  // ── Rogue (additions 2026-05-03) ──
  [343142, { name: "Dreadblades",            type: "personal_offensive", cd: 90 }],
  // ── Shaman (additions 2026-05-03) ──
  [192249, { name: "Storm Elemental",        type: "personal_offensive", cd: 150 }],
  [198067, { name: "Fire Elemental",         type: "personal_offensive", cd: 150 }],
  // ── Warlock (additions 2026-05-03) ──
  [265187, { name: "Summon Demonic Tyrant",  type: "personal_offensive", cd: 90 }],
  [113858, { name: "Dark Soul: Instability", type: "personal_offensive", cd: 120 }],
  // ── Warrior (additions 2026-05-03) ──
  [376079, { name: "Spear of Bastion",       type: "personal_offensive", cd: 60 }],
  [262161, { name: "Warbreaker",             type: "personal_offensive", cd: 45 }],
  // ── Spec coverage expansion 2026-05-07 (registry gap audit) ──
  [391528, { name: "Convoke the Spirits",    type: "personal_offensive", cd: 120 }],  // Resto/Balance/Feral talented (modern ID)
  [258860, { name: "Essence Break",          type: "personal_offensive", cd: 40  }],  // Havoc DH
  [370965, { name: "The Hunt",               type: "personal_offensive", cd: 90  }],  // DH (Havoc + Vengeance)
  [212084, { name: "Fel Devastation",        type: "personal_offensive", cd: 60  }],  // Vengeance DH
  [84714,  { name: "Frozen Orb",             type: "personal_offensive", cd: 60  }],  // Frost Mage
  [212283, { name: "Symbols of Death",       type: "personal_offensive", cd: 30  }],  // Sub Rogue
  [185313, { name: "Shadow Dance",           type: "personal_offensive", cd: 60  }],  // Sub Rogue
  [51690,  { name: "Killing Spree",          type: "personal_offensive", cd: 90  }],  // Outlaw Rogue
  [193530, { name: "Aspect of the Wild",     type: "personal_offensive", cd: 120 }],  // BM Hunter
  [152279, { name: "Breath of Sindragosa",   type: "personal_offensive", cd: 120 }],  // Frost DK
  [1233448, { name: "Dark Transformation",   type: "personal_offensive", cd: 60  }],  // Unholy DK — Midnight 12.0 emitted ID (was 63560; OFFENSIVE_CD_02)
  [200183, { name: "Apotheosis",             type: "personal_offensive", cd: 90  }],  // Holy Priest
  [64901,  { name: "Symbol of Hope",         type: "group_offensive",    cd: 300 }],  // Holy Priest (group)
  [265202, { name: "Holy Word: Salvation",   type: "group_offensive",    cd: 720 }],  // Holy Priest (group heal CD)
  [322118, { name: "Invoke Yu'lon, the Jade Serpent", type: "personal_offensive", cd: 180 }],  // Mistweaver
  [399491, { name: "Sheilun's Gift",         type: "personal_offensive", cd: 60  }],  // Mistweaver

  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // Spec-coverage gaps surfaced by VELARA_COMPLETE_SPELL_REGISTRY.md plus drum/lust
  // variants. Every ID Wowhead-verified pre-commit. Existing entries (e.g. 360952
  // Coordinated Assault, 114050 Ascendance) NOT removed even where the master
  // suggests an alt ID — both kept to handle CLEU divergence.
  // ── Death Knight ──
  [42650,  { name: "Army of the Dead",       type: "personal_offensive", cd: 90  }],  // Unholy — tracked burst; Gargoyle (49206) removed, now auto-summoned by Army in 12.0 (OFFENSIVE_CD_02)
  [1265384, { name: "Frostwyrm's Fury",      type: "personal_offensive", cd: 180 }],  // Frost — Midnight 12.0 emitted ID (was 279302; OFFENSIVE_CD_02)
  [343294, { name: "Soul Reaper",            type: "personal_offensive", cd: 6   }],  // tracking major hits per master
  // ── Demon Hunter ──
  [258925, { name: "Fel Barrage",            type: "personal_offensive", cd: 90  }],  // Havoc
  // ── Druid ──
  [50334,  { name: "Berserk (Guardian)",     type: "personal_offensive", cd: 180 }],
  // ── Evoker ──
  [370452, { name: "Shattering Star",        type: "personal_offensive", cd: 20  }],  // Devastation
  [395152, { name: "Ebon Might",             type: "personal_offensive", cd: 30  }],  // Augmentation
  [396286, { name: "Upheaval",               type: "personal_offensive", cd: 40  }],  // Augmentation
  [404977, { name: "Time Skip",              type: "personal_offensive", cd: 180 }],  // Augmentation
  // ── Hunter ──
  [201430, { name: "Stampede",               type: "personal_offensive", cd: 120 }],  // talent
  // ── Mage ──
  [153561, { name: "Meteor",                 type: "personal_offensive", cd: 45  }],  // Fire talent
  [321507, { name: "Touch of the Magi",      type: "personal_offensive", cd: 45  }],  // Arcane
  [205021, { name: "Ray of Frost",           type: "personal_offensive", cd: 75  }],  // Frost talent
  // ── Monk ──
  [123904, { name: "Invoke Xuen, the White Tiger", type: "personal_offensive", cd: 120 }],  // WW
  [387184, { name: "Weapons of Order",       type: "personal_offensive", cd: 120 }],  // WW talent
  [325197, { name: "Invoke Chi-Ji, the Red Crane", type: "personal_offensive", cd: 180 }],  // MW (also tracked as external in defensives)
  // ── Paladin ──
  [375576, { name: "Divine Toll",            type: "personal_offensive", cd: 60  }],  // talent
  [327193, { name: "Moment of Glory",        type: "personal_offensive", cd: 90  }],  // Protection
  [389539, { name: "Sentinel",               type: "personal_offensive", cd: 120 }],  // Ret talent
  // ── Priest ──
  [200174, { name: "Mindbender",             type: "personal_offensive", cd: 60  }],  // master Mindbender ID; 123040 already registered as alt
  [472433, { name: "Evangelism",             type: "personal_offensive", cd: 90  }],  // Disc — Midnight 12.0 emitted ID (was 246287; OFFENSIVE_CD_02)
  [421453, { name: "Ultimate Penitence",     type: "personal_offensive", cd: 60  }],  // Disc hero talent
  // ── Rogue ──
  [13877,  { name: "Blade Flurry",           type: "personal_offensive", cd: 30  }],  // Outlaw
  [79140,  { name: "Vendetta",               type: "personal_offensive", cd: 120 }],  // Assassination (legacy ID; pre-Deathmark)
  [385627, { name: "Kingsbane",              type: "personal_offensive", cd: 60  }],  // Assassination
  // ── Shaman ──
  [384352, { name: "Doom Winds",             type: "personal_offensive", cd: 60  }],  // Enhancement
  [114051, { name: "Ascendance (Elemental)", type: "personal_offensive", cd: 180 }],  // alt Ascendance ID; 114050 retained
  // ── Warlock ──
  [267217, { name: "Nether Portal",          type: "personal_offensive", cd: 180 }],  // Demonology
  [113860, { name: "Dark Soul: Misery",      type: "personal_offensive", cd: 120 }],  // Affliction
  [386997, { name: "Soul Rot",               type: "personal_offensive", cd: 60  }],  // talent
  // ── Warrior ──
  [46924,  { name: "Bladestorm (Fury)",      type: "personal_offensive", cd: 60  }],  // Fury variant; 227847 retained for Arms
  [152277, { name: "Ravager (Protection)",   type: "personal_offensive", cd: 45  }],  // Prot variant; 228920 retained for Arms talent
  [167105, { name: "Colossus Smash",         type: "personal_offensive", cd: 45  }],  // Arms
  [401150, { name: "Avatar (Fury)",          type: "personal_offensive", cd: 90  }],  // Fury variant; 107574 retained for Arms/Prot
  // ── Drums (Bloodlust-class items) ──
  [178207, { name: "Drums of Fury",          type: "group_offensive",    cd: 600 }],  // Leatherworking
  [309658, { name: "Drums of Deathly Ferocity", type: "group_offensive", cd: 600 }],  // TWW drums
  [381301, { name: "Feral Hide Drums",       type: "group_offensive",    cd: 600 }],  // DF drums

  // ── Full roster expansion 2026-05-31 (OFFENSIVE_CD_05b) ──────────────────────
  // Real emitted IDs, every one re-verified present in logs before writing (CD_05b Step 1).
  // CAST id is the canonical "used it" event; aura/summon ids only where no cast exists.
  // NOTE: aura/summon-only entries below are handled by the AURA_ONLY_OFFENSIVE_CDS branch
  // added in OFFENSIVE_CD_05c (2026-05-31). They now fire on SPELL_AURA_APPLIED.
  // IDs must remain in OFFENSIVE_COOLDOWNS for the aura branch's offInfo lookup to work.
  // ── Warrior ──
  [446035, { name: "Bladestorm",             type: "personal_offensive", cd: 90  }],  // Arms/Fury (Midnight ID)
  [260708, { name: "Sweeping Strikes",       type: "personal_offensive", cd: 30  }],  // Arms
  [385059, { name: "Odyn's Fury",            type: "personal_offensive", cd: 45  }],  // Fury (385059 cast ID; 385062 was wrong — OFFENSIVE_CD_ICONS_01)
  // ── Mage ──
  [108853, { name: "Fire Blast",             type: "personal_offensive", cd: 12  }],  // Fire (Mage only; 57984 is Shaman pet)
  [157980, { name: "Supernova",              type: "personal_offensive", cd: 45  }],  // Arcane
  [31661,  { name: "Dragon's Breath",        type: "personal_offensive", cd: 45  }],  // Fire (damage + CC)
  // ── Hunter ──
  [392060, { name: "Wailing Arrow",          type: "personal_offensive", cd: 60  }],  // MM/BM
  [212431, { name: "Explosive Shot",         type: "personal_offensive", cd: 30  }],  // SV/MM
  [321538, { name: "Bloodshed",              type: "personal_offensive", cd: 60  }],  // BM — AURA-ONLY (pet); inert until parser aura branch
  // ── Warlock ──
  [196099, { name: "Grimoire of Sacrifice",  type: "personal_offensive", cd: 30  }],  // AURA-ONLY; inert until parser aura branch
  [1276672,{ name: "Summon Doomguard",       type: "personal_offensive", cd: 90  }],  // Demo
  [104316, { name: "Call Dreadstalkers",     type: "personal_offensive", cd: 20  }],  // Demo (core CD despite cadence)
  [1276452,{ name: "Grimoire: Imp Lord",     type: "personal_offensive", cd: 120 }],  // Demo
  [1276467,{ name: "Grimoire: Fel Ravager",  type: "personal_offensive", cd: 120 }],  // Demo
  // ── Priest ──
  [1280172,{ name: "Shadowfiend",            type: "personal_offensive", cd: 180 }],  // Midnight ID — AURA+SUMMON, no cast; inert until parser branch
  [263165, { name: "Void Torrent",           type: "personal_offensive", cd: 45  }],  // Shadow
  [32379,  { name: "Shadow Word: Death",     type: "personal_offensive", cd: 20  }],  // execute (borderline)
  // ── Rogue ──
  [381623, { name: "Thistle Tea",            type: "personal_offensive", cd: 60  }],
  [381989, { name: "Keep It Rolling",        type: "personal_offensive", cd: 420 }],  // Outlaw
  // ── Monk ──
  [322109, { name: "Touch of Death",         type: "personal_offensive", cd: 120 }],
  [443028, { name: "Celestial Conduit",      type: "personal_offensive", cd: 90  }],
  [132578, { name: "Invoke Niuzao, the Black Ox", type: "personal_offensive", cd: 90 }],  // BrM
  [152175, { name: "Whirling Dragon Punch",  type: "personal_offensive", cd: 24  }],  // WW (borderline)
  // ── Shaman ──
  [469270, { name: "Doom Winds",             type: "personal_offensive", cd: 60  }],  // Enh (Midnight ID)
  [469332, { name: "Feral Spirit",           type: "personal_offensive", cd: 90  }],  // SUMMON-only (alt build); inert until parser branch
  [469322, { name: "Feral Spirit",           type: "personal_offensive", cd: 90  }],  // SUMMON-only (alt build); inert until parser branch
  [188592, { name: "Fire Elemental",         type: "personal_offensive", cd: 150 }],  // Midnight ID — AURA+SUMMON, no cast; inert until parser branch
  [157299, { name: "Storm Elemental",        type: "personal_offensive", cd: 150 }],  // SUMMON-only; inert until parser branch
  [1218090,{ name: "Primordial Storm",       type: "personal_offensive", cd: 30  }],  // Enh
  [197214, { name: "Sundering",              type: "personal_offensive", cd: 40  }],  // Enh
  // ── Druid ──
  [102558, { name: "Incarnation: Guardian of Ursoc", type: "personal_offensive", cd: 180 }],
  [274837, { name: "Feral Frenzy",           type: "personal_offensive", cd: 45  }],  // Feral
  [202770, { name: "Fury of Elune",          type: "personal_offensive", cd: 60  }],  // Balance (borderline)
  [204066, { name: "Lunar Beam",             type: "personal_offensive", cd: 75  }],  // Guardian
  // ── Druid — Heart of the Wild (Midnight 12.0 emitted IDs — 319454 never fires in CLEU) ──
  // Each Druid form emits a different spell ID (Brian-confirmed 2026-06-01):
  [1261867, { name: "Heart of the Wild", type: "personal_offensive", cd: 180 }],  // non-shapeshifted
  [1261868, { name: "Heart of the Wild", type: "personal_offensive", cd: 180 }],  // Cat form
  [1261870, { name: "Heart of the Wild", type: "personal_offensive", cd: 180 }],  // Boomkin
  [1261872, { name: "Heart of the Wild", type: "personal_offensive", cd: 180 }],  // Bear / Healer
  // ── Demon Hunter ──
  [187827, { name: "Metamorphosis (Veng)",   type: "personal_offensive", cd: 180 }],  // Veng cast (distinct spec from 191427/200166)
  [370966, { name: "The Hunt",               type: "personal_offensive", cd: 90  }],  // emitted cast ID (alt to 370965)
  [204596, { name: "Sigil of Flame",         type: "personal_offensive", cd: 30  }],
  [452497, { name: "Abyssal Gaze",           type: "personal_offensive", cd: 120 }],  // Veng
  // ── Evoker ──
  [370553, { name: "Tip the Scales",         type: "personal_offensive", cd: 120 }],
  [442204, { name: "Breath of Eons",         type: "personal_offensive", cd: 120 }],  // Aug
  [357210, { name: "Deep Breath",            type: "personal_offensive", cd: 120 }],  // Deva
  [357208, { name: "Fire Breath",            type: "personal_offensive", cd: 30  }],  // empower core CD
  // ── Death Knight ──
  [439843, { name: "Reaper's Mark",          type: "personal_offensive", cd: 45  }],  // Deathbringer hero burst
  [49028,  { name: "Dancing Rune Weapon",    type: "personal_offensive", cd: 120 }],  // Blood
  [1249658,{ name: "Breath of Sindragosa",   type: "personal_offensive", cd: 120 }],  // Frost (Midnight ID; 152279 retained)
  [46585,  { name: "Raise Dead",             type: "personal_offensive", cd: 120 }],  // Unholy/Frost pet summon
]);

// ── Aura/Summon-only offensive CDs ─────────────────────────────────────────
// These abilities never fire SPELL_CAST_SUCCESS from the player.
// They are tracked via SPELL_AURA_APPLIED on the PLAYER sourceGuid instead.
// Subset of OFFENSIVE_COOLDOWNS — IDs here MUST also exist in OFFENSIVE_COOLDOWNS.
// Added 2026-05-31 (OFFENSIVE_CD_05c).
const AURA_ONLY_OFFENSIVE_CDS = new Set([
  321538,   // Bloodshed (BM Hunter) — aura on player after pet use
  196099,   // Grimoire of Sacrifice (Warlock) — aura applied on player
  469332,   // Feral Spirit (Shaman) — aura variant
  469322,   // Feral Spirit alt (Shaman) — aura variant
  188592,   // Fire Elemental (Shaman Midnight ID) — aura on player
  157299,   // Storm Elemental (Shaman) — aura on player
  1280172,  // Shadowfiend (Priest Midnight ID) — aura on player
]);

// ── Player Stun Spells (player-cast stuns on enemies) ──────────────────────
// Drives the Playbook "Crowd Control" pill. Tracked via SPELL_CAST_SUCCESS.
// Verbatim copy of Overwolf shared/combatLogRunBuilder.js to keep the two
// pipelines in shape parity. Narrower than CC_SPELLS (which also covers
// incapacitates and roots).
const PLAYER_STUN_SPELLS = new Set([
  // Paladin
  853,      // Hammer of Justice
  // Monk
  119381,   // Leg Sweep
  // Warrior
  46968,    // Shockwave
  132169,   // Storm Bolt
  // DK
  91800,    // Gnaw (Ghoul stun)
  // Druid
  5211,     // Mighty Bash
  // Hunter
  24394,    // Intimidation
  // DH
  179057,   // Chaos Nova
  211881,   // Fel Eruption
  // Shaman
  118905,   // Static Charge (Capacitor Totem)
  // Warlock
  30283,    // Shadowfury
  89766,    // Axe Toss (Felguard)
  // Priest
  200200,   // Holy Word: Chastise (Censure)
  // Racials
  20549,    // War Stomp (Tauren)
  255661,   // Bull Rush (Highmountain Tauren)

  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // Per directive Phase 2: PLAYER_STUN_SPELLS expanded to cover the full CC palette
  // (incaps, disorients, knockbacks, silences, roots) since the Playbook "Crowd
  // Control" pill currently reads ONLY pull.stunEvents. PM directive: single-stream
  // is fine; HALT only if a separate stream is required. The set name keeps its
  // historical "STUN" prefix for compat — content is the broader CC allowlist.
  // Hard stuns (additional)
  107570,   // Storm Bolt (Warrior talent — caster variant; 132169 also registered)
  221562,   // Asphyxiate (Unholy DK)
  108194,   // Asphyxiate (DK alt)
  408,      // Kidney Shot (Rogue)
  1833,     // Cheap Shot (Rogue)
  199804,   // Between the Eyes (Outlaw)
  88625,    // Holy Word: Chastise (master ID; 200200 already registered as Censure)
  305483,   // Lightning Lasso (Shaman talent)
  199530,   // Sundering (Enhancement)
  192058,   // Capacitor Totem placement (Shaman)
  372245,   // Terror of the Skies (Evoker)
  // Incapacitates
  20066,    // Repentance (Paladin talent)
  115078,   // Paralysis (Monk)
  6770,     // Sap (Rogue)
  1776,     // Gouge (Rogue)
  217832,   // Imprison (DH)
  118,      // Polymorph (Mage)
  82691,    // Ring of Frost (Mage)
  31661,    // Dragon's Breath (Fire)
  51514,    // Hex (Shaman)
  710,      // Banish (Warlock)
  6789,     // Mortal Coil (Warlock — horror)
  5484,     // Howl of Terror (Warlock — AoE fear)
  605,      // Mind Control (Priest)
  8122,     // Psychic Scream (Priest)
  64044,    // Psychic Horror (Shadow)
  2637,     // Hibernate (Druid)
  99,       // Incapacitating Roar (Druid)
  3355,     // Freezing Trap (Hunter — debuff ID)
  187650,   // Freezing Trap (Hunter — alt CLEU ID)
  19386,    // Wyvern Sting (Hunter talent)
  213691,   // Scatter Shot (Hunter)
  5246,     // Intimidating Shout (Warrior)
  207167,   // Blinding Sleet (DK talent)
  // Knockbacks
  132469,   // Typhoon (Druid)
  102793,   // Ursol's Vortex (Druid)
  116844,   // Ring of Peace (Monk)
  157981,   // Blast Wave (Fire)
  51490,    // Thunderstorm (Elemental)
  // Silences
  202137,   // Sigil of Silence (DH)
  204490,   // Sigil of Silence (DH — ground placement variant)
  // Polymorph variants (Mage cosmetic forms emit different IDs)
  28272,    // Polymorph: Pig
  28271,    // Polymorph: Turtle
  61305,    // Polymorph: Cat
  61721,    // Polymorph: Rabbit
  61780,    // Polymorph: Turkey
  161354,   // Polymorph: Monkey
  277787,   // Polymorph: Direhorn
  277792,   // Polymorph: Bumblebee
  391622,   // Polymorph: Duck
  // Roots
  339,      // Entangling Roots (Druid)
  102359,   // Mass Entanglement (Druid)
  122,      // Frost Nova (Mage)
  // Pet CC — sourceGuid is the pet; parser must attribute to owner
  6358,     // Seduction (Succubus)
  9484,     // Shackle Undead (Priest — niche)
]);

// ── On-Use Trinkets — Season 1 Midnight ────────────────────────────────────
// Tracked via SPELL_CAST_SUCCESS. Category determines where it shows up.
// This list will be updated each season.
const TRACKED_TRINKETS = new Map([
  // ── Defensive Trinkets ──
  // Add specific Season 1 defensive trinket spell IDs here as we identify them
  // Example format:
  // [SPELL_ID, { name: "Trinket Name", category: "trinket_defensive" }],

  // ── Offensive Trinkets ──
  // Add specific Season 1 offensive trinket spell IDs here as we identify them
  // Example format:
  // [SPELL_ID, { name: "Trinket Name", category: "trinket_offensive" }],
]);

const FEIGN_DEATH_SPELL_ID = 5384;
const FEIGN_DEATH_LOOKAHEAD_MS = 15000; // 15 seconds — matches WCL's approach

// ── Consumables — healthstones, potions ───────────────────────────────────
// Track SPELL_CAST_SUCCESS for these spells by players.
// Spell names are also checked as fallback for potions with variable IDs.
// ── Consumables — strict allowlist (TWW S1) ────────────────────────
// Only these spell IDs land in pull.consumablesUsed[]. Everything else
// the player self-casts is dropped from this stream.
// Verified against Wowhead 2026-05-03. Update each season.
const CONSUMABLE_SPELL_IDS = new Map([
  // ── Healthstones / In-combat heals ──
  [6262,    { name: "Healthstone",                    type: "health" }],
  // ── Health Potions ──
  [431416,  { name: "Algari Healing Potion",          type: "health" }],
  [431417,  { name: "Cavedweller's Delight",          type: "health" }],
  // ── Mana Potions ──
  [431418,  { name: "Algari Mana Potion",             type: "mana" }],
  // ── Stat Potions ──
  [431932,  { name: "Tempered Potion",                type: "stat" }],
  [431934,  { name: "Potion of Unwavering Focus",     type: "stat" }],
  // ── Flasks ──
  [431940,  { name: "Flask of Alchemical Chaos",      type: "flask" }],
  [431941,  { name: "Flask of Tempered Mastery",      type: "flask" }],
  [431942,  { name: "Flask of Tempered Versatility",  type: "flask" }],
  [431943,  { name: "Flask of Tempered Swiftness",    type: "flask" }],
  [431944,  { name: "Flask of Tempered Aggression",   type: "flask" }],
  // ── Weapon Stones ──
  [29532,   { name: "Adamantite Weapon Stone",        type: "weapon" }],

  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // WARNING: Every entry below is UNVERIFIED in CLEU. Spell IDs from
  // VELARA_COMPLETE_SPELL_REGISTRY.md are spellbook/item-use IDs from Wowhead;
  // the buff IDs that actually fire SPELL_AURA_APPLIED in the combat log may
  // differ. Brian will swap with verified buff IDs from his SpellID addon.
  // Wowhead names alongside each ID so wrong matches surface fast.
  // ── TWW Flasks (Wowhead-verified) ──
  [431972,  { name: "Flask of Tempered Swiftness",     type: "flask" }],   // UNVERIFIED CLEU
  [431973,  { name: "Flask of Tempered Versatility",   type: "flask" }],   // UNVERIFIED CLEU
  [431974,  { name: "Flask of Tempered Mastery",       type: "flask" }],   // UNVERIFIED CLEU
  // 431975 master claimed flask but Wowhead resolves to "Condensed Shadowflame" — NOT a flask. Skipped.
  // 431976 master claimed flask but Wowhead resolves to "[DNT] Win BULL-E" placeholder. Skipped.
  // ── Brian-provided IDs (Wowhead-resolution noted; CLEU verification pending) ──
  [241325,  { name: "Flask of the Blood Knights",      type: "flask" }],   // UNVERIFIED CLEU. Wowhead 241325 = "Fel Cannonball" — ID likely wrong.
  [243733,  { name: "Thalassian Phoenix Oil",          type: "weapon" }],  // UNVERIFIED CLEU
  [241305,  { name: "Silvermoon Health Potion",        type: "health" }],  // UNVERIFIED CLEU
  [242275,  { name: "Royal Roast",                     type: "food" }],    // UNVERIFIED CLEU
  [255845,  { name: "Silvermoon Parade",               type: "food" }],    // UNVERIFIED CLEU
  [1264426, { name: "Void-Touched Augment Rune",       type: "augment" }], // VERIFIED CLEU 2026-05-07 via Brian SpellID addon

  // ── Midnight S1 Consumables (2026-05-08) — Archon.gg S1 meta + Wowhead verification ──

  // ── FLASKS ──
  // Flask of the Magisters (Archon S1: 58.6%)
  [241322,  { name: "Flask of the Magisters",         type: "flask"  }],  // Item ID: 241322 | Craft: 1230876 | Buff: 1235108 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1230876, { name: "Flask of the Magisters",         type: "flask"  }],  // Item ID: 241322 | Effect spell: 1230876 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1235108, { name: "Flask of the Magisters",         type: "flask"  }],  // Item ID: 241322 | Effect spell: 1235108 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  // Flask of the Shattered Sun (Archon S1: 16.2%)
  [241326,  { name: "Flask of the Shattered Sun",     type: "flask"  }],  // Item ID: 241326 | Craft: 1230878 | Buff: 1235111 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1230878, { name: "Flask of the Shattered Sun",     type: "flask"  }],  // Item ID: 241326 | Effect spell: 1230878 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1235111, { name: "Flask of the Shattered Sun",     type: "flask"  }],  // Item ID: 241326 | Effect spell: 1235111 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  // Flask of the Blood Knights (Archon S1: 3.8%) — item 241325 already registered; adding craft+buff IDs
  [1230877, { name: "Flask of the Blood Knights",     type: "flask"  }],  // Item ID: 241325 | Effect spell: 1230877 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1235110, { name: "Flask of the Blood Knights",     type: "flask"  }],  // Item ID: 241325 | Effect spell: 1235110 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08

  // ── HEALTH POTIONS ──
  // Silvermoon Health Potion (Archon S1: 31.4%) — item 241305 already registered; adding effect spell
  [1234768, { name: "Silvermoon Health Potion",       type: "health" }],  // Item ID: 241305 | Effect spell: 1234768 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  // Potent Healing Potion (Archon S1: 6.4%)
  [258138,  { name: "Potent Healing Potion",          type: "health" }],  // Item ID: 258138 | Effect spell: 1262857 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1262857, { name: "Potent Healing Potion",          type: "health" }],  // Item ID: 258138 | Effect spell: 1262857 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  // Invigorating Healing Potion (Archon S1: 1.1%)
  [244839,  { name: "Invigorating Healing Potion",    type: "health" }],  // UNVERIFIED — may be wrong expansion (Wowhead shows TWW 11.2.0), Brian to confirm via SpellID addon
  [1238009, { name: "Invigorating Healing Potion",    type: "health" }],  // UNVERIFIED — may be wrong expansion, Brian to confirm via SpellID addon

  // ── COMBAT POTIONS ──
  // Light's Potential (Archon S1: 63.8%)
  [241309,  { name: "Light's Potential",              type: "stat"   }],  // Item ID: 241309 | Craft: 1243219 | Buff aura: 1230869 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1243219, { name: "Light's Potential",              type: "stat"   }],  // Item ID: 241309 | Effect spell: 1243219 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1230869, { name: "Light's Potential",              type: "stat"   }],  // Item ID: 241309 | Effect spell: 1230869 | Midnight 12.0.5 verified | Source: Wowhead spell 1243219 aura lookup 2026-05-08
  // Potion of Recklessness (Archon S1: 5.4%)
  [241288,  { name: "Potion of Recklessness",         type: "stat"   }],  // Item ID: 241288 | Buff spell: 1236994 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1236994, { name: "Potion of Recklessness",         type: "stat"   }],  // Item ID: 241288 | Effect spell: 1236994 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08

  // ── FOOD / FEASTS ──
  // Hearty Harandar Celebration (Archon S1: 42.9%)
  [266996,  { name: "Hearty Harandar Celebration",    type: "food"   }],  // Item ID: 266996 | Effect spell: 1278929 | UNVERIFIED — Well Fed buff spell unknown; Brian to confirm via SpellID addon | Midnight 12.0.5 verified | Source: Archon S1 meta 2026-05-08
  [1278929, { name: "Hearty Harandar Celebration",    type: "food"   }],  // UNVERIFIED — may be craft/feast spell not Well Fed buff; Brian to confirm via SpellID addon
  // Hearty Royal Roast (Archon S1: 20.9%)
  [242747,  { name: "Hearty Royal Roast",             type: "food"   }],  // Item ID: 242747 | UNVERIFIED — buff spell unknown; Brian to confirm via SpellID addon | Midnight 12.0.5 verified | Source: Archon S1 meta 2026-05-08
  // Hearty Glitter Skewers (Archon S1: 2.7%)
  [242753,  { name: "Hearty Glitter Skewers",         type: "food"   }],  // Item ID: 242753 | UNVERIFIED — buff spell unknown; Brian to confirm via SpellID addon | Midnight 12.0.5 verified | Source: Archon S1 meta 2026-05-08

  // ── WEAPON BUFFS ──
  // Thalassian Phoenix Oil (Archon S1: 75.4%) — item 243733 already registered UNVERIFIED; adding verified item+buff IDs
  [243734,  { name: "Thalassian Phoenix Oil",         type: "weapon" }],  // Item ID: 243734 | Buff: 1237006 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1237006, { name: "Thalassian Phoenix Oil",         type: "weapon" }],  // Item ID: 243734 | Effect spell: 1237006 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  // Refulgent Whetstone (Archon S1: 0.8%)
  [237370,  { name: "Refulgent Whetstone",            type: "weapon" }],  // Item ID: 237370 | Buff: 1224328 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
  [1224328, { name: "Refulgent Whetstone",            type: "weapon" }],  // Item ID: 237370 | Effect spell: 1224328 | Midnight 12.0.5 verified | Source: Archon S1 meta + Wowhead 2026-05-08
]);

// Kept for reference only. No longer consulted by the consumables block.
// Removal of this set requires Brian's explicit instruction.
const CONSUMABLE_SPELL_NAMES = new Set([
  "Healthstone", "Healing Potion", "Algari Healing Potion",
  "Algari Mana Potion", "Dreamwalker's Healing Potion",
]);
void CONSUMABLE_SPELL_NAMES;

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

// ─── Spike thresholds (Overwolf parity, ported 2026-05-06) ─────────────────
const SPIKE_THRESHOLD_ABSOLUTE = 80000;
const SPIKE_THRESHOLD_PCT      = 0.30;
const ESTIMATED_PLAYER_HP      = 800000;
const SPIKE_THRESHOLD_RELATIVE = Math.floor(SPIKE_THRESHOLD_PCT * ESTIMATED_PLAYER_HP);

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
    this.segCounters     = { death: 0, cd: 0, int: 0, ec: 0, spike: 0, absorb: 0 };
    this.lastCreatureDamageTs = 0;  // Last time ANY creature dealt or received damage
    this.knownInterruptibleSpells = new Map();  // spellId → { spellId, spellName, npcId, npcName, count }
    this._defensiveBuffer = [];  // buffered defensives when no segment is open
    this._pendingHunterDeaths = []; // deferred deaths awaiting lookahead confirmation
    this._authCharacters = [];     // character list from VelaraAuth (for GUID-based identity)
    this._feignDeathCasts = new Map(); // GUID → last Feign Death cast timestamp
    this.guidToPosition  = new Map();  // GUID → { x, y, mapId, ts } last known WoW world position
    this._positionsCaptured = 0;       // count of positions captured (drives telemetry flag)
    this.guidToTalents   = new Map();  // GUID → raw talent data from COMBATANT_INFO
    this.guidToStats     = new Map();  // GUID → parsed stats object from COMBATANT_INFO
    this.guidToRace      = new Map();  // GUID → race name (from auth characters or racial spell inference)
    this.guidToFaction   = new Map();  // GUID → "Alliance" or "Horde"
    this.lineCount       = 0;
    this.eventCount      = 0;
    this._wowVersion     = null;  // e.g. "12.0.5"  — from combat log header
    this._wowBuild       = null;  // e.g. "56713"   — from combat log header
    this._wowToc         = null;  // e.g. "120005"  — derived from BUILD_VERSION
    // setAuthCharacters — called from main.js with VelaraAuth character list
    // Enables combat log GUID matching for uploader identity
    // uploaderIdentity is set externally from SavedVariables — preserve across reset
  }

  /**
   * Called by main.js when the combat log header line is detected.
   * Header format: COMBAT_LOG_VERSION,20,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,X.Y.Z,...
   * @param {string} buildVersion - e.g. "12.0.5"
   * @param {string} [buildNumber] - e.g. "56713" (optional, may be absent)
   */
  setWowVersion(buildVersion, buildNumber) {
    this._wowVersion = buildVersion || null;
    this._wowBuild   = buildNumber  || null;
    if (buildVersion) {
      const parts = buildVersion.split(".").map(Number);
      if (parts.length >= 3 && parts.every(n => !isNaN(n))) {
        this._wowToc = String(parts[0] * 10000 + parts[1] * 100 + parts[2]);
      }
    }
    console.log(`[RunBuilder] WoW version: ${this._wowVersion} build: ${this._wowBuild} toc: ${this._wowToc}`);
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

  /**
   * Extract WoW world position from an advanced info block.
   * @param {string[]} fields  - split combat log fields
   * @param {number}   advStart - index where the 19-field advanced block starts
   * @returns {{ x: number, y: number, mapId: number } | null}
   */
  _extractPosition(fields, advStart) {
    if (!hasAdvancedInfo(fields, advStart)) return null;
    const x = parseFloat(fields[advStart + 13]);
    const y = parseFloat(fields[advStart + 14]);
    const mapId = parseInt(fields[advStart + 15], 10) || 0;
    // Reject zero/NaN coords — means the unit had no valid position at this moment
    if (!isFinite(x) || !isFinite(y) || (x === 0 && y === 0)) return null;
    return { x, y, mapId };
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
      overhealPerSec: {},   // { secondOffset: totalOverhealing }
      healEvents: [],       // per-heal events (capped to top-200-by-effective at payload build)
      interrupts: [],       // max ~20 per segment
      defensives: [],       // max ~10
      enemyCasts: [],       // capped at 30
      deathBucketSecs: [],  // which seconds had deaths
      playerDamageDone: {}, // { playerGuid: totalDamage } — per-player DPS context
      playerHealingDone: {},  // { playerGuid: totalHealing } — per-player HPS context
      playerHealingReceived: {}, // { playerGuid: totalHealing } — who got healed
      playerDamageTakenSeg: {}, // { playerGuid: totalDmgTaken } — per-segment breakdown
      ccEvents: [],           // CC/debuffs applied to players by enemies (capped at 50)
      stunEvents: [],         // player-cast stuns on enemies (drives Playbook CC pill, capped at 50)
      offensiveCDs: [],       // major offensive cooldowns used by players (capped at 30)
      // ── Week 2 data streams ──
      dispels: [],              // SPELL_DISPEL/SPELL_STOLEN events (capped at 50)
      damageTakenByAbility: {}, // { playerGuid: { spellName: { spellId, spellSchool, total, count, maxHit } } }
      playerOverhealing: {},    // { playerGuid: { healing: total, overhealing: total } }
      resurrections: [],        // SPELL_RESURRECT events (capped at 20)
      consumablesUsed: [],      // healthstones, potions (capped at 30)
      absorbs: [],              // SPELL_ABSORBED events (capped at 100)
      spikes: [],               // high-damage spike events for Deadliest Enemy Abilities chart
    };
    this.segCounters = { death: 0, cd: 0, int: 0, ec: 0, spike: 0, absorb: 0 };

    // Flush buffered defensives cast within 3s before segment opened
    const cutoff = ts - 3000;
    for (const buf of this._defensiveBuffer) {
      if (buf.ts >= cutoff) {
        console.log(`[RunBuilder] DEFENSIVE RECOVERED from buffer: ${buf.name} cast ${buf.spellName} (${buf.spellId}) ${ts - buf.ts}ms before segment`);
        this.currentSeg.defensives.push({
          ts: buf.ts, offsetMs: buf.ts - ts,  // negative offset = before pull
          spellName: buf.spellName, spellId: buf.spellId,
          name: buf.name, class: buf.cls, role: buf.role,
          category: buf.category || "defensive",
          mapX: buf.mapX ?? null,
          mapY: buf.mapY ?? null,
          mapId: buf.mapId ?? null,
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
    const isDispel = event === "SPELL_DISPEL" || event === "SPELL_STOLEN";
    const isResurrect = event === "SPELL_RESURRECT";
    const isAbsorbed = event === "SPELL_ABSORBED";

    if (!isDamage && !isEnvironmental && !isHeal && !isCast && !isCastStart && !isAuraApplied && !isDied && !isInterrupt && !isDispel && !isResurrect && !isAbsorbed) return null;

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

      // ── Position capture from cast events (caster = source) ──────────
      {
        const castPos = this._extractPosition(fields, 12);
        if (castPos) {
          this.guidToPosition.set(sourceGuid, { ...castPos, ts });
          this._positionsCaptured++;
        }
      }

      // Track Feign Death casts for death suppression
      if (spellId === FEIGN_DEATH_SPELL_ID && isPlayerGuid(sourceGuid)) {
        this._feignDeathCasts.set(sourceGuid, ts);
      }
    }

    // ── Hostile aura applied to player (CC/debuff tracking) ─────────────
    if (isAuraApplied && isPlayerGuid(destGuid) && isCreatureGuid(sourceGuid)) {
      if (this.currentSeg && this.currentSeg.ccEvents.length < 50) {
        const spellId = parseInt(fields[9], 10) || 0;
        const spellName = (fields[10] || "").replace(/"/g, "");
        if (spellId > 0) {
          const ccInfo = CC_SPELLS.get(spellId);
          this.currentSeg.ccEvents.push({
            ts, offsetMs: ts - this.currentSeg.startTs,
            spellId, spellName,
            ccType: ccInfo ? ccInfo.type : "debuff",
            targetName: this.guidToName.get(destGuid) || "Unknown",
            targetClass: this.guidToClass.get(destGuid) || "UNKNOWN",
            targetRole: this.guidToRole.get(destGuid) || "unknown",
            sourceNpcName: sourceName || "Unknown",
            sourceNpcId: npcIdFromGuid(sourceGuid),
          });
        }
      }
      // Do NOT return null — let it continue to other handlers
    }

    // ── SPELL_DISPEL / SPELL_STOLEN — dispel tracking ──────────────────
    // Format: ...sourceGUID, sourceName, ..., destGUID, destName, ..., spellId, spellName, spellSchool, extraSpellId, extraSpellName, extraSpellSchool, auraType
    if (isDispel && isPlayerGuid(sourceGuid)) {
      if (this.currentSeg && this.currentSeg.dispels.length < 50) {
        const spellId = parseInt(fields[9], 10) || 0;
        const spellName = (fields[10] || "").replace(/"/g, "");
        const spellSchool = parseInt(fields[11]) || 0;
        // Extra spell fields (the debuff that was removed) — follow spell prefix
        const advStart = 12;
        const hasAdv = hasAdvancedInfo(fields, advStart);
        const suffixStart = hasAdv ? advStart + ADVANCED_INFO_FIELD_COUNT : advStart;
        const extraSpellId = parseInt(fields[suffixStart], 10) || 0;
        const extraSpellName = (fields[suffixStart + 1] || "").replace(/"/g, "");
        const extraSpellSchool = parseInt(fields[suffixStart + 2]) || 0;

        this.currentSeg.dispels.push({
          ts, offsetMs: ts - this.currentSeg.startTs,
          sourceName: this.guidToName.get(sourceGuid) || sourceName || null,
          sourceClass: this.guidToClass.get(sourceGuid) || null,
          sourceRole: this.guidToRole.get(sourceGuid) || null,
          targetName: this.guidToName.get(destGuid) || destName || null,
          spellId, spellName,
          removedSpellId: extraSpellId,
          removedSpellName: extraSpellName,
          removedSpellSchool: extraSpellSchool,
          wasStolen: event === "SPELL_STOLEN",
        });
      }
      return null;
    }

    // ── SPELL_RESURRECT — resurrection / battle rez tracking ────────────
    if (isResurrect && isPlayerGuid(sourceGuid) && isPlayerGuid(destGuid)) {
      if (this.currentSeg && this.currentSeg.resurrections.length < 20) {
        const spellId = parseInt(fields[9], 10) || 0;
        const spellName = (fields[10] || "").replace(/"/g, "");

        this.currentSeg.resurrections.push({
          ts, offsetMs: ts - this.currentSeg.startTs,
          sourceName: this.guidToName.get(sourceGuid) || sourceName || null,
          sourceClass: this.guidToClass.get(sourceGuid) || "UNKNOWN",
          sourceRole: this.guidToRole.get(sourceGuid) || "unknown",
          // Frontend aggregate keys rows on `class`/`name` and drops UNKNOWN-class rows;
          // mirror sourceClass into `class` so PlaybookTable renders the rez row with
          // the caster's class color rather than dropping it. Without this, badge==len
          // counts the entry but aggregate hides it, producing the badge/table mismatch.
          class: this.guidToClass.get(sourceGuid) || "UNKNOWN",
          targetName: this.guidToName.get(destGuid) || destName || null,
          spellId, spellName,
          isCombatRez: this.inKey && this.currentSeg != null,
        });
      }
      return null;
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
            mapX: (this.guidToPosition.get(destGuid) || {}).x ?? null,
            mapY: (this.guidToPosition.get(destGuid) || {}).y ?? null,
            mapId: (this.guidToPosition.get(destGuid) || {}).mapId ?? null,
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
        mapX: (this.guidToPosition.get(destGuid) || {}).x ?? null,
        mapY: (this.guidToPosition.get(destGuid) || {}).y ?? null,
        mapId: (this.guidToPosition.get(destGuid) || {}).mapId ?? null,
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

    // ── SPELL_ABSORBED — true incoming damage signal (Overwolf parity, ported 2026-05-06) ──
    // When a hit is absorbed by Power Word: Shield etc., SPELL_DAMAGE shows
    // the post-absorb amount. We need the absorbed portion to know the
    // *true* hit so spike detection and threat analytics aren't fooled.
    //
    // Blizzard CLEU SPELL_ABSORBED has two forms:
    //   Form 1 (SWING absorbed): caster block at fields[9]
    //   Form 2 (SPELL_* absorbed): source-spell prefix (3 fields) before caster block
    // Absorb block layout (last 6 fields): [absorbSpellId, absorbSpellName,
    //   absorbSpellSchool, absorbedAmount, totalAmount, critical].
    if (isAbsorbed && this.currentSeg && this.currentSeg.absorbs.length < 100) {
      const SPELL_ABSORBED_BASE = 9;
      const fieldAtBase = fields[SPELL_ABSORBED_BASE] || "";
      const isFormTwo = /^\d+$/.test(fieldAtBase);
      const casterStart = isFormTwo ? SPELL_ABSORBED_BASE + 3 : SPELL_ABSORBED_BASE;
      const absorbBlockStart = casterStart + 4;
      const absorbSpellId = parseInt(fields[absorbBlockStart], 10) || 0;
      const absorbSpellName = (fields[absorbBlockStart + 1] || "").replace(/"/g, "");
      const absorbSpellSchool = parseInt(fields[absorbBlockStart + 2], 10) || 0;
      const absorbedAmount = parseInt(fields[absorbBlockStart + 3], 10) || 0;

      if (absorbedAmount > 0 && destGuid) {
        let sourceHitSpellId = 0;
        let sourceHitSpellName = "";
        if (isFormTwo) {
          sourceHitSpellId = parseInt(fields[SPELL_ABSORBED_BASE], 10) || 0;
          sourceHitSpellName = (fields[SPELL_ABSORBED_BASE + 1] || "").replace(/"/g, "");
        }

        this.segCounters.absorb++;
        const segId = this.currentSeg.segmentId;
        const runId = this.run ? this.run.runId : "unk";
        this.currentSeg.absorbs.push({
          absorbId       : `${runId}-${segId}-ab${this.segCounters.absorb}`,
          segmentId      : segId,
          absorbTs       : ts,
          offsetMs       : ts - this.currentSeg.startTs,
          destGuid,
          destName,
          destRole       : this.guidToRole.get(destGuid) || "unknown",
          destClass      : this.guidToClass.get(destGuid) || "UNKNOWN",
          absorbSpellId,
          absorbSpellName,
          absorbSpellSchool,
          absorbedAmount,
          sourceHitSpellId,
          sourceHitSpellName,
          sourceNpcId    : npcIdFromGuid(sourceGuid),
          sourceNpcName  : isCreatureGuid(sourceGuid) ? sourceName : null,
        });
      }
      return null;
    }

    // ── Damage (dynamic suffix detection for advanced combat log) ──────
    if (isDamage && isPlayerGuid(destGuid)) {
      let spellId = 0, spellName = "Melee", spellSchool = 1, amount = 0, overkill = 0;
      if (event === "SWING_DAMAGE") {
        // Swing: no spell prefix — advanced info starts at field 9
        const swingAdvStart = 9;
        const swingHasAdv = hasAdvancedInfo(fields, swingAdvStart);
        const swingSuffixStart = swingHasAdv ? swingAdvStart + ADVANCED_INFO_FIELD_COUNT : swingAdvStart;
        amount   = parseInt(fields[swingSuffixStart],     10) || 0;
        overkill = parseInt(fields[swingSuffixStart + 1], 10) || 0;
      } else {
        // Spell/Range: spell prefix at fields 9-11, advanced info at field 12
        spellId     = parseInt(fields[9], 10) || 0;
        spellName   = (fields[10] || "").replace(/"/g, "");
        // No radix on spellSchool — WoW sometimes sends hex (0x1, 0x20). Matches
        // the enemy-cast school read at this file's CC branch (auto-detect base).
        spellSchool = parseInt(fields[11]) || 0;
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

      // ── Position capture from advanced info block ─────────────────────
      // The advanced block describes the DESTINATION unit (player being hit).
      // Store as last known position for use when recording deaths and CDs.
      {
        const advS = event === "SWING_DAMAGE" ? 9 : 12;
        const pos = this._extractPosition(fields, advS);
        if (pos) {
          this.guidToPosition.set(destGuid, { ...pos, ts });
          this._positionsCaptured++;
        }
      }

      // Accumulate damage taken per player for post-run role heuristic
      this.playerDamageTaken.set(destGuid, (this.playerDamageTaken.get(destGuid) || 0) + amount);

      // Per-segment damage taken tracking
      if (this.currentSeg && amount > 0) {
        this.currentSeg.playerDamageTakenSeg[destGuid] =
          (this.currentSeg.playerDamageTakenSeg[destGuid] || 0) + amount;

        // ── Damage taken by ability (per-player, per-spell breakdown) ──
        if (!this.currentSeg.damageTakenByAbility[destGuid]) {
          this.currentSeg.damageTakenByAbility[destGuid] = {};
        }
        const abilities = this.currentSeg.damageTakenByAbility[destGuid];
        const abilityKey = spellName || "Melee";
        if (!abilities[abilityKey]) {
          const spellSchool = (event !== "SWING_DAMAGE") ? (parseInt(fields[11]) || 1) : 1;
          abilities[abilityKey] = { spellId: spellId || 0, spellSchool, total: 0, count: 0, maxHit: 0 };
        }
        abilities[abilityKey].total += amount;
        abilities[abilityKey].count += 1;
        if (amount > abilities[abilityKey].maxHit) abilities[abilityKey].maxHit = amount;
      }

      // Spike detection — hybrid threshold (Overwolf parity, ported 2026-05-06).
      // Shape matches normalize_segments.py → pull.spikes round-trip without translation.
      if (this.currentSeg && (amount >= SPIKE_THRESHOLD_ABSOLUTE || amount >= SPIKE_THRESHOLD_RELATIVE)) {
        this.segCounters.spike++;
        const segId = this.currentSeg.segmentId;
        const runId = this.run ? this.run.runId : "unk";
        this.currentSeg.spikes.push({
          spikeId       : `${runId}-${segId}-sp${this.segCounters.spike}`,
          segmentId     : segId,
          spikeTs       : ts,
          offsetMs      : ts - this.currentSeg.startTs,
          damage        : amount,
          targetGuid    : destGuid,
          targetRole    : this.guidToRole.get(destGuid) || "unknown",
          spellId,
          spellName,
          spellSchool,
          sourceNpcId   : npcIdFromGuid(sourceGuid),
          sourceNpcName : isCreatureGuid(sourceGuid) ? sourceName : null,
        });
      }

      this._addDmg(ts, amount);
      return null;
    }

    // ── Player damage DONE (to creatures) — per-segment tracking ────────
    if (isDamage && isPlayerGuid(sourceGuid) && isCreatureGuid(destGuid)) {
      if (this.currentSeg) {
        let amount = 0;
        if (event === "SWING_DAMAGE") {
          const swingAdvStart = 9;
          const swingHasAdv = hasAdvancedInfo(fields, swingAdvStart);
          const swingSuffixStart = swingHasAdv ? swingAdvStart + ADVANCED_INFO_FIELD_COUNT : swingAdvStart;
          amount = parseInt(fields[swingSuffixStart], 10) || 0;
        } else {
          const advStart = 12;
          const hasAdv = hasAdvancedInfo(fields, advStart);
          const suffixStart = hasAdv ? advStart + ADVANCED_INFO_FIELD_COUNT : advStart;
          amount = parseInt(fields[suffixStart], 10) || 0;
        }
        if (amount > 0) {
          this.currentSeg.playerDamageDone[sourceGuid] =
            (this.currentSeg.playerDamageDone[sourceGuid] || 0) + amount;
        }
      }
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
      // WoW 12.0.5 inserted a rawHeal field at +1, pushing overheal to +2.
      // Reading +1 (old position) returned rawHeal ≈ healAmount → effective = 0
      // on every heal, silently breaking _addHeal / partyHealingReceived.
      const overhealAmount = parseInt(fields[healSuffixStart + 2], 10) || 0;

      // Healing done tracking (for post-run role heuristic)
      if (isPlayerGuid(sourceGuid)) {
        if (!isNaN(healAmount) && healAmount > 0) {
          this.playerHealingDone.set(sourceGuid, (this.playerHealingDone.get(sourceGuid) || 0) + healAmount);
        }
      }

      // Healing received + per-event capture
      if (isPlayerGuid(destGuid) && this.currentSeg) {
        if (!isNaN(healAmount) && healAmount > 0) {
          const effective = Math.max(0, healAmount - overhealAmount);
          this._addHeal(ts, effective);
          if (overhealAmount > 0) {
            const ohSec = Math.floor((ts - this.currentSeg.startTs) / 1000);
            this.currentSeg.overhealPerSec[ohSec] =
              (this.currentSeg.overhealPerSec[ohSec] || 0) + overhealAmount;
          }
          // Per-heal event capture — truncated to top-200-by-effective at payload build
          const healSpellId = parseInt(fields[9], 10) || 0;
          const healSpellName = (fields[10] || "").replace(/"/g, "");
          this.currentSeg.healEvents.push({
            ts,
            offsetMs: ts - this.currentSeg.startTs,
            playerName: sourceName,
            sourceGuid,
            targetName: destName || this.guidToName.get(destGuid) || "",
            targetGuid: destGuid,
            spellId: healSpellId,
            spellName: healSpellName,
            amount: healAmount,
            overheal: overhealAmount,
            effective,
          });
        }
      }

      // ── Per-segment healing tracking ──────────────────────────────────
      if (this.currentSeg) {
        // Healing done by this player (source)
        if (isPlayerGuid(sourceGuid)) {
          const healAmt = (!isNaN(healAmount) && healAmount > 0) ? healAmount : 0;
          if (healAmt > 0) {
            this.currentSeg.playerHealingDone[sourceGuid] =
              (this.currentSeg.playerHealingDone[sourceGuid] || 0) + healAmt;
          }
        }
        // Healing received by this player (dest)
        if (isPlayerGuid(destGuid)) {
          const healAmt = (!isNaN(healAmount) && healAmount > 0) ? healAmount : 0;
          if (healAmt > 0) {
            this.currentSeg.playerHealingReceived[destGuid] =
              (this.currentSeg.playerHealingReceived[destGuid] || 0) + healAmt;
          }
        }

        // ── Overhealing tracking (per-player, per-segment) ──────────────
        if (isPlayerGuid(sourceGuid) && !isNaN(healAmount) && healAmount > 0) {
          if (!this.currentSeg.playerOverhealing[sourceGuid]) {
            this.currentSeg.playerOverhealing[sourceGuid] = { healing: 0, overhealing: 0 };
          }
          this.currentSeg.playerOverhealing[sourceGuid].healing += healAmount;
          this.currentSeg.playerOverhealing[sourceGuid].overhealing += (overhealAmount || 0);
        }
      }
      return null;
    }

    // ── Racial ability tracking (separate from defensives) ──────────────
    // Some racials (Fireblood 273104) emit only SPELL_AURA_APPLIED in CLEU and
    // never SPELL_CAST_SUCCESS. Mirror the defensives gate (isCast||isAuraApplied)
    // with a 1s per-(player,spellId) dedup so a single use that fires both events
    // doesn't double-count.
    if ((isCast || isAuraApplied) && isPlayerGuid(sourceGuid)) {
      const racialSpellId = parseInt(fields[9], 10) || 0;
      const racialInfo = RACIAL_ABILITIES.get(racialSpellId);
      if (racialInfo) {
        const playerName = this.guidToName.get(sourceGuid) || "Unknown";
        // Infer race from the racial ability used
        this.guidToRace.set(sourceGuid, racialInfo.race);

        // Store the racial cast in the current segment
        if (this.currentSeg) {
          if (!this.currentSeg.racialCasts) this.currentSeg.racialCasts = [];
          const isDupe = this.currentSeg.racialCasts.some(r =>
            r.spellId === racialSpellId && r.name === playerName &&
            Math.abs(r.ts - ts) < 1000
          );
          if (!isDupe) {
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
    }

    // ── Consumable usage — strict allowlist ───────────────────────────
    // Only spells in CONSUMABLE_SPELL_IDS land here. Class spells the
    // player happens to self-cast (Power Word: Radiance, Tiger's Lust,
    // Arcane Intellect, etc.) are NOT consumables and are dropped from
    // this stream. The previous catch-all gated against 5 allowlists was
    // too wide and dumped utility/heal class spells into Consumables.
    if (isCast && isPlayerGuid(sourceGuid)) {
      const consSpellId = parseInt(fields[9], 10) || 0;
      const consInfo = CONSUMABLE_SPELL_IDS.get(consSpellId);
      if (consInfo) {
        if (this.currentSeg && this.currentSeg.consumablesUsed.length < 30) {
          this.currentSeg.consumablesUsed.push({
            ts,
            offsetMs: ts - this.currentSeg.startTs,
            playerName: this.guidToName.get(sourceGuid) || sourceName || null,
            class: this.guidToClass.get(sourceGuid) || "UNKNOWN",
            role: this.guidToRole.get(sourceGuid) || "unknown",
            spellId: consSpellId,
            spellName: consInfo.name,
            consumableType: consInfo.type,
          });
        }
      }
    }

    // ── Player-cast stun on enemy — drives Playbook "Crowd Control" pill ─
    // Mirrors Overwolf shared/combatLogRunBuilder.js. SPELL_CAST_SUCCESS only;
    // dest is informational (1s dedup keys on player+spellId, not target).
    if (isCast && isPlayerGuid(sourceGuid)) {
      const stunSpellId = parseInt(fields[9], 10) || 0;
      if (PLAYER_STUN_SPELLS.has(stunSpellId)) {
        if (this.currentSeg && this.currentSeg.stunEvents.length < 50) {
          const playerName = this.guidToName.get(sourceGuid) || "Unknown";
          const isDupe = this.currentSeg.stunEvents.some(s =>
            s.spellId === stunSpellId && s.playerName === playerName &&
            Math.abs(s.ts - ts) < 1000
          );
          if (!isDupe) {
            this.currentSeg.stunEvents.push({
              ts, offsetMs: ts - this.currentSeg.startTs,
              spellId: stunSpellId,
              spellName: (fields[10] || "").replace(/"/g, ""),
              playerName,
              class: this.guidToClass.get(sourceGuid) || "UNKNOWN",
              role: this.guidToRole.get(sourceGuid) || "unknown",
              targetName: (this.guidToName.get(destGuid) || destName) || null,
            });
          }
        }
      }
    }

    // ── Player cast/aura — check for defensive CDs (spec-aware) ─────────
    if ((isCast || isAuraApplied) && isPlayerGuid(sourceGuid)) {
      const spellId = parseInt(fields[9], 10) || 0;
      const spellName = (fields[10] || "").replace(/"/g, "");

      // ── Offensive cooldown tracking ───────────────────────────────────
      const offInfo = OFFENSIVE_COOLDOWNS.get(spellId);
      if (offInfo && isCast) {
        if (this.currentSeg && this.currentSeg.offensiveCDs.length < 60) {
          // Dedup: skip if same spell+player within 1s
          const isDupe = this.currentSeg.offensiveCDs.some(o =>
            o.spellId === spellId && o.name === (this.guidToName.get(sourceGuid) || "Unknown") &&
            Math.abs(o.ts - ts) < 1000
          );
          if (!isDupe) {
            this.currentSeg.offensiveCDs.push({
              ts, offsetMs: ts - this.currentSeg.startTs,
              spellName: offInfo.name, spellId,
              name: this.guidToName.get(sourceGuid) || "Unknown",
              class: this.guidToClass.get(sourceGuid) || "UNKNOWN",
              role: this.guidToRole.get(sourceGuid) || "unknown",
              cdType: offInfo.type,
              mapX: (this.guidToPosition.get(sourceGuid) || {}).x ?? null,
              mapY: (this.guidToPosition.get(sourceGuid) || {}).y ?? null,
              mapId: (this.guidToPosition.get(sourceGuid) || {}).mapId ?? null,
            });
          }
        }
      }

      // ── Aura/summon-only offensive CDs (OFFENSIVE_CD_05c) ────────────
      // Handles abilities that never emit SPELL_CAST_SUCCESS from the player.
      // Only fires on SPELL_AURA_APPLIED where sourceGuid is the player.
      // IDs here are a subset of OFFENSIVE_COOLDOWNS — offInfo lookup is safe.
      if (isAuraApplied && AURA_ONLY_OFFENSIVE_CDS.has(spellId)) {
        const auraOffInfo = OFFENSIVE_COOLDOWNS.get(spellId);
        if (auraOffInfo && this.currentSeg && this.currentSeg.offensiveCDs.length < 60) {
          const auraPlayerName = this.guidToName.get(sourceGuid) || "Unknown";
          const isAuraDupe = this.currentSeg.offensiveCDs.some(o =>
            o.spellId === spellId && o.name === auraPlayerName &&
            Math.abs(o.ts - ts) < 1000
          );
          if (!isAuraDupe) {
            this.currentSeg.offensiveCDs.push({
              ts, offsetMs: ts - this.currentSeg.startTs,
              spellName: auraOffInfo.name, spellId,
              name: auraPlayerName,
              class: this.guidToClass.get(sourceGuid) || "UNKNOWN",
              role: this.guidToRole.get(sourceGuid) || "unknown",
              cdType: auraOffInfo.type,
              mapX: (this.guidToPosition.get(sourceGuid) || {}).x ?? null,
              mapY: (this.guidToPosition.get(sourceGuid) || {}).y ?? null,
              mapId: (this.guidToPosition.get(sourceGuid) || {}).mapId ?? null,
            });
          }
        }
      }

      // ── Trinket tracking ──────────────────────────────────────────────
      const trinketInfo = TRACKED_TRINKETS.get(spellId);
      if (trinketInfo && isCast) {
        if (this.currentSeg) {
          if (trinketInfo.category === "trinket_defensive") {
            // Defensive trinkets go into defensives[] with trinket category
            this.currentSeg.defensives.push({
              ts, offsetMs: ts - this.currentSeg.startTs,
              spellName: trinketInfo.name, spellId,
              name: this.guidToName.get(sourceGuid) || "Unknown",
              class: this.guidToClass.get(sourceGuid) || "UNKNOWN",
              role: this.guidToRole.get(sourceGuid) || "unknown",
              category: "trinket_defensive",
              mapX: (this.guidToPosition.get(sourceGuid) || {}).x ?? null,
              mapY: (this.guidToPosition.get(sourceGuid) || {}).y ?? null,
            });
          } else if (trinketInfo.category === "trinket_offensive") {
            // Offensive trinkets go into offensiveCDs[]
            if (this.currentSeg.offensiveCDs && this.currentSeg.offensiveCDs.length < 60) {
              this.currentSeg.offensiveCDs.push({
                ts, offsetMs: ts - this.currentSeg.startTs,
                spellName: trinketInfo.name, spellId,
                name: this.guidToName.get(sourceGuid) || "Unknown",
                class: this.guidToClass.get(sourceGuid) || "UNKNOWN",
                role: this.guidToRole.get(sourceGuid) || "unknown",
                cdType: "trinket_offensive",
                mapX: (this.guidToPosition.get(sourceGuid) || {}).x ?? null,
                mapY: (this.guidToPosition.get(sourceGuid) || {}).y ?? null,
              });
            }
          }
        }
        // Don't return — let it continue to other checks in case it's also
        // in the defensive list (it shouldn't be, but safety first)
      }

      // Look up player's spec for spec-aware defensive tracking
      const playerSpecId = this.guidToSpecId.get(sourceGuid) || null;

      if (shouldTrackDefensive(spellId, playerSpecId)) {
        const playerName = this.guidToName.get(sourceGuid) || "Unknown";
        const playerClass = this.guidToClass.get(sourceGuid) || "UNKNOWN";
        const playerRole = this.guidToRole.get(sourceGuid) || "unknown";
        const defInfo = ALWAYS_TRACK_DEFENSIVES.get(spellId);
        const condInfo = SPEC_CONDITIONAL_DEFENSIVES[spellId];
        const category = defInfo ? defInfo.category : (condInfo ? condInfo.category : "defensive");

        if (!this.currentSeg) {
          // No active segment — buffer for next segment open
          console.warn(`[RunBuilder] DEFENSIVE DROPPED (no segment): ${playerName} cast ${spellName} (${spellId}) via ${event}`);
          this._defensiveBuffer.push({ ts, spellId, spellName, sourceGuid, name: playerName, cls: playerClass, role: playerRole, category, mapX: (this.guidToPosition.get(sourceGuid) || {}).x ?? null, mapY: (this.guidToPosition.get(sourceGuid) || {}).y ?? null, mapId: (this.guidToPosition.get(sourceGuid) || {}).mapId ?? null });
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
              category,
              mapX: (this.guidToPosition.get(sourceGuid) || {}).x ?? null,
              mapY: (this.guidToPosition.get(sourceGuid) || {}).y ?? null,
              mapId: (this.guidToPosition.get(sourceGuid) || {}).mapId ?? null,
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
        const spellSchool = parseInt(fields[11]) || 0; // WoW sends hex (0x1, 0x20) — no radix so parseInt auto-detects
        if (spellId > 0) {
          this.currentSeg.enemyCasts.push({
            ts, offsetMs: ts - this.currentSeg.startTs,
            npcName: sourceName || null, spellId, spellName, spellSchool,
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
        // Merge playerDamageDone totals
        prev.playerDamageDone = prev.playerDamageDone || {};
        for (const [guid, dmg] of Object.entries(seg.playerDamageDone || {})) {
          prev.playerDamageDone[guid] = (prev.playerDamageDone[guid] || 0) + dmg;
        }
        // Merge playerHealingDone totals
        prev.playerHealingDone = prev.playerHealingDone || {};
        for (const [guid, heal] of Object.entries(seg.playerHealingDone || {})) {
          prev.playerHealingDone[guid] = (prev.playerHealingDone[guid] || 0) + heal;
        }
        // Merge playerHealingReceived totals
        prev.playerHealingReceived = prev.playerHealingReceived || {};
        for (const [guid, heal] of Object.entries(seg.playerHealingReceived || {})) {
          prev.playerHealingReceived[guid] = (prev.playerHealingReceived[guid] || 0) + heal;
        }
        // Merge playerDamageTakenSeg totals
        prev.playerDamageTakenSeg = prev.playerDamageTakenSeg || {};
        for (const [guid, dmg] of Object.entries(seg.playerDamageTakenSeg || {})) {
          prev.playerDamageTakenSeg[guid] = (prev.playerDamageTakenSeg[guid] || 0) + dmg;
        }
        // Merge ccEvents, stunEvents, and offensiveCDs arrays
        prev.ccEvents = prev.ccEvents || [];
        prev.ccEvents.push(...(seg.ccEvents || []));
        prev.stunEvents = prev.stunEvents || [];
        prev.stunEvents.push(...(seg.stunEvents || []));
        prev.offensiveCDs = prev.offensiveCDs || [];
        prev.offensiveCDs.push(...(seg.offensiveCDs || []));
        // Merge Week 2 arrays
        prev.dispels = prev.dispels || [];
        prev.dispels.push(...(seg.dispels || []));
        prev.resurrections = prev.resurrections || [];
        prev.resurrections.push(...(seg.resurrections || []));
        prev.consumablesUsed = prev.consumablesUsed || [];
        prev.consumablesUsed.push(...(seg.consumablesUsed || []));
        prev.absorbs = prev.absorbs || [];
        prev.absorbs.push(...(seg.absorbs || []));
        prev.spikes = prev.spikes || [];
        prev.spikes.push(...(seg.spikes || []));
        // Merge damageTakenByAbility maps
        prev.damageTakenByAbility = prev.damageTakenByAbility || {};
        for (const [guid, abilities] of Object.entries(seg.damageTakenByAbility || {})) {
          if (!prev.damageTakenByAbility[guid]) prev.damageTakenByAbility[guid] = {};
          for (const [spell, info] of Object.entries(abilities)) {
            if (!prev.damageTakenByAbility[guid][spell]) {
              prev.damageTakenByAbility[guid][spell] = { ...info };
            } else {
              prev.damageTakenByAbility[guid][spell].total += info.total;
              prev.damageTakenByAbility[guid][spell].count += info.count;
              if (info.maxHit > prev.damageTakenByAbility[guid][spell].maxHit) {
                prev.damageTakenByAbility[guid][spell].maxHit = info.maxHit;
              }
            }
          }
        }
        // Merge playerOverhealing maps
        prev.playerOverhealing = prev.playerOverhealing || {};
        for (const [guid, oh] of Object.entries(seg.playerOverhealing || {})) {
          if (!prev.playerOverhealing[guid]) {
            prev.playerOverhealing[guid] = { ...oh };
          } else {
            prev.playerOverhealing[guid].healing += oh.healing;
            prev.playerOverhealing[guid].overhealing += oh.overhealing;
          }
        }
        // Merge damage/heal per second maps
        for (const [sec, dmg] of Object.entries(seg.dmgPerSec || {})) {
          const adjustedSec = parseInt(sec) + Math.floor((seg.startTs - prev.startTs) / 1000);
          prev.dmgPerSec[adjustedSec] = (prev.dmgPerSec[adjustedSec] || 0) + dmg;
        }
        for (const [sec, heal] of Object.entries(seg.healPerSec || {})) {
          const adjustedSec = parseInt(sec) + Math.floor((seg.startTs - prev.startTs) / 1000);
          prev.healPerSec[adjustedSec] = (prev.healPerSec[adjustedSec] || 0) + heal;
        }
        prev.overhealPerSec = prev.overhealPerSec || {};
        for (const [sec, oh] of Object.entries(seg.overhealPerSec || {})) {
          const adjustedSec = parseInt(sec) + Math.floor((seg.startTs - prev.startTs) / 1000);
          prev.overhealPerSec[adjustedSec] = (prev.overhealPerSec[adjustedSec] || 0) + oh;
        }
        prev.healEvents = prev.healEvents || [];
        prev.healEvents.push(...(seg.healEvents || []));
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
      // Convert dmgPerSec/healPerSec/overhealPerSec to compact bucket array
      const allSecs = new Set([
        ...Object.keys(seg.dmgPerSec || {}).map(Number),
        ...Object.keys(seg.healPerSec || {}).map(Number),
        ...Object.keys(seg.overhealPerSec || {}).map(Number),
      ]);
      const buckets = [...allSecs].sort((a, b) => a - b).map(sec => ({
        segmentId: seg.segmentId,
        bucketStartTs: seg.startTs + sec * 1000,
        bucketEndTs: seg.startTs + (sec + 1) * 1000,
        durationMs: 1000,
        partyDamageTaken: (seg.dmgPerSec || {})[sec] || 0,
        partyHealingReceived: (seg.healPerSec || {})[sec] || 0,
        partyOverhealing: (seg.overhealPerSec || {})[sec] || 0,
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
        playerDamageDone: Object.fromEntries(
          Object.entries(seg.playerDamageDone || {}).map(([guid, dmg]) => [
            this.guidToName.get(guid) || guid, dmg
          ])
        ),
        playerHealingDone: Object.fromEntries(
          Object.entries(seg.playerHealingDone || {}).map(([guid, heal]) => [
            this.guidToName.get(guid) || guid, heal
          ])
        ),
        playerHealingReceived: Object.fromEntries(
          Object.entries(seg.playerHealingReceived || {}).map(([guid, heal]) => [
            this.guidToName.get(guid) || guid, heal
          ])
        ),
        playerDamageTakenSeg: Object.fromEntries(
          Object.entries(seg.playerDamageTakenSeg || {}).map(([guid, dmg]) => [
            this.guidToName.get(guid) || guid, dmg
          ])
        ),
        ccEvents: seg.ccEvents || [],
        stunEvents: seg.stunEvents || [],
        offensiveCDs: seg.offensiveCDs || [],
        // ── Week 2 data streams ──
        dispels: seg.dispels || [],
        damageTakenByAbility: Object.fromEntries(
          Object.entries(seg.damageTakenByAbility || {}).map(([guid, abilities]) => [
            this.guidToName.get(guid) || guid,
            abilities
          ])
        ),
        playerOverhealing: Object.fromEntries(
          Object.entries(seg.playerOverhealing || {}).map(([guid, oh]) => [
            this.guidToName.get(guid) || guid, oh
          ])
        ),
        resurrections: seg.resurrections || [],
        consumablesUsed: seg.consumablesUsed || [],
        absorbs: seg.absorbs || [],
        spikes: seg.spikes || [],
        healEvents: ((seg.healEvents || [])
          .slice()
          .sort((a, b) => (b.effective || 0) - (a.effective || 0))
          .slice(0, 200)),
      };
    });

    // ── Between-pull downtime computation ─────────────────────────────
    if (finalSegments.length > 0) {
      finalSegments[0].downtimeBeforePullMs = 0;
      for (let i = 1; i < finalSegments.length; i++) {
        const prevEnd = finalSegments[i - 1].finishTs;
        const currStart = finalSegments[i].startTs;
        if (prevEnd && currStart) {
          finalSegments[i].downtimeBeforePullMs = currStart - prevEnd;
        } else {
          finalSegments[i].downtimeBeforePullMs = null;
        }
      }
    }
    const totalDowntimeMs = finalSegments.reduce((sum, seg) => sum + (seg.downtimeBeforePullMs || 0), 0);

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
      if (!this.confirmedPartyGuids.has(guid)) continue; // GUARD: must have COMBATANT_INFO
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
    let uploaderName = "Unknown";
    let identitySource = "unknown";
    let playerObj = null;        // null until identity resolves; never fabricate
    let otherMembers = [];

    // Priority 1: GUID match — check if any party member name matches an auth character.
    // Tiebreaker: when multiple auth characters are in the same run (e.g. Brian has
    // Dkroid AND Druidroid both authenticated, and both are in the party), prefer the
    // one that matches this.uploaderIdentity (SavedVariables from the active session).
    // Fall back to first match only if SV identity is absent or unmatched.
    if (this._authCharacters.length > 0) {
      // Collect all auth-character matches in the party
      const authMatches = [];
      for (let i = 0; i < partyMembers.length; i++) {
        const pm = partyMembers[i];
        const pmBase = stripRegionSuffix(pm.name);
        const matched = this._authCharacters.find(c => {
          const cFullBase = stripRegionSuffix(c.fullName);
          const cNameBase = stripRegionSuffix(c.characterName);
          return cFullBase === pmBase || cNameBase === pmBase;
        });
        if (matched) authMatches.push({ pm, matched, idx: i });
      }

      if (authMatches.length > 0) {
        // Prefer the match that aligns with SavedVariables uploaderIdentity
        let chosen = authMatches[0]; // default: first found
        if (authMatches.length > 1 && this.uploaderIdentity) {
          const svBase = stripRegionSuffix(this.uploaderIdentity);
          const svMatch = authMatches.find(m => stripRegionSuffix(m.pm.name) === svBase);
          if (svMatch) {
            chosen = svMatch;
            console.log(`[RunBuilder] GUID identity tiebreak: multiple auth chars in party, SV preferred ${chosen.pm.name}`);
          } else {
            console.warn(`[RunBuilder] GUID identity tiebreak: SV identity "${this.uploaderIdentity}" not in party — using first auth match ${chosen.pm.name}`);
          }
        }
        playerObj = chosen.pm;
        otherMembers = partyMembers.filter((_, idx) => idx !== chosen.idx);
        uploaderName = chosen.pm.name || chosen.matched.fullName;
        identitySource = "combat_log_guid_match";
        console.log(`[RunBuilder] GUID identity match: ${chosen.pm.name} → ${chosen.matched.fullName} (${chosen.matched.class})`);
      }
    }

    // Priority 2: SavedVariables identity
    if (identitySource === "unknown" && this.uploaderIdentity) {
      uploaderName = this.uploaderIdentity;
      identitySource = "saved_variables";
      const identityBase = stripRegionSuffix(this.uploaderIdentity);
      const uploaderIndex = partyMembers.findIndex(pm =>
        stripRegionSuffix(pm.name) === identityBase
      );
      if (uploaderIndex >= 0) {
        playerObj = partyMembers[uploaderIndex];
        otherMembers = partyMembers.filter((_, i) => i !== uploaderIndex);
        uploaderName = playerObj.name || uploaderName;
        console.log(`[RunBuilder] SV identity match: ${playerObj.name} (${playerObj.class} ${playerObj.spec} ${playerObj.role})`);
      } else {
        console.warn(`[RunBuilder] SV identity "${this.uploaderIdentity}" not found in party list — playerObj remains null`);
      }
    }

    if (!playerObj) {
      console.error(`[RunBuilder] IDENTITY UNRESOLVED: uploader "${uploaderName}" not found in party. partyMembers=[${partyMembers.map(p => p.name).join(", ")}]`);
      identitySource = "unresolved";
      // Use a sentinel that the backend can detect — not a fabricated party member
      playerObj = {
        name: uploaderName,
        class: null,
        spec: null,
        role: null,
        _unresolved: true,
      };
      otherMembers = partyMembers;  // ALL party members are "others" when uploader isn't found
    }

    // Attach Blizzard talent export string to the uploader's player object
    if (this.playerTalentString) {
      playerObj.talentString = this.playerTalentString;
    }

    return {
      addon: "VelaraIntel",
      v: COMPANION_VERSION,
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
        addonVersion: COMPANION_VERSION,
        exportVersion: COMPANION_VERSION,
        wowVersion: this._wowVersion || undefined,
        wowBuild:   this._wowBuild   || undefined,
        wowToc:     this._wowToc     || undefined,
        telemetryCapabilities: {
          hasCombatSegments: finalSegments.length > 0,
          hasEnemyRegistry: false,
          hasPartySnapshot: partyMembers.length > 0,
          hasDeathContext: totalDeaths > 0,
          hasDamageBuckets: totalBuckets > 0,
          hasEnemyCasts: totalECs > 0,
          hasInterrupts: totalInts > 0,
          hasEnemyHealthSnapshots: false,
          hasEnemyPositions: this._positionsCaptured > 0,
          hasDefensives: totalDefs > 0,
          hasPlayerDamageDone: finalSegments.some(s => Object.keys(s.playerDamageDone || {}).length > 0),
          hasPlayerHealingDone: finalSegments.some(s => Object.keys(s.playerHealingDone || {}).length > 0),
          hasPlayerHealingReceived: finalSegments.some(s => Object.keys(s.playerHealingReceived || {}).length > 0),
          hasCCEvents: finalSegments.some(s => (s.ccEvents || []).length > 0),
          hasStunEvents: finalSegments.some(s => (s.stunEvents || []).length > 0),
          hasOffensiveCDs: finalSegments.some(s => (s.offensiveCDs || []).length > 0),
          hasEncounterData: this.bossEncounters.length > 0,
          // Week 2 capabilities
          hasDispels: finalSegments.some(s => (s.dispels || []).length > 0),
          hasDamageTakenByAbility: finalSegments.some(s => Object.keys(s.damageTakenByAbility || {}).length > 0),
          hasDowntimeTracking: true,
          hasOverhealing: finalSegments.some(s => Object.keys(s.playerOverhealing || {}).length > 0),
          hasResurrections: finalSegments.some(s => (s.resurrections || []).length > 0),
          hasConsumableTracking: finalSegments.some(s => (s.consumablesUsed || []).length > 0),
          hasAbsorbs: finalSegments.some(s => (s.absorbs || []).length > 0),
          hasSpikes: finalSegments.some(s => (s.spikes || []).length > 0),
          hasHealEvents: finalSegments.some(s => (s.healEvents || []).length > 0),
        },
        player: playerObj,
        partyMembers: otherMembers,
        combatSegments: finalSegments,
        bossEncounters: this.bossEncounters,
        completionResult: { medal: success > 0 ? 1 : 0, timeMs, money: 0 },
        deathCountFinal: totalDeaths,
        totalDowntimeMs,
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
