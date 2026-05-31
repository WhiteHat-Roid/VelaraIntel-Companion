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
  [51052,  { name: "Anti-Magic Zone",           category: "external"  }],
  [49039,  { name: "Lichborne",                 category: "defensive" }],
  // ── Demon Hunter ──
  [198589, { name: "Blur",                      category: "defensive" }],
  [196718, { name: "Darkness",                  category: "external"  }],
  [196555, { name: "Netherwalk",                category: "defensive" }],
  [187827, { name: "Metamorphosis (Veng)",      category: "defensive" }],
  [204021, { name: "Fiery Brand",               category: "defensive" }],
  // ── Druid ──
  [22812,  { name: "Barkskin",                  category: "defensive" }],
  [61336,  { name: "Survival Instincts",        category: "defensive" }],
  [102342, { name: "Ironbark",                  category: "external"  }],
  [22842,  { name: "Frenzied Regeneration",     category: "defensive" }],
  [102558, { name: "Incarnation: Guardian of Ursoc", category: "defensive" }],
  // [319454, { name: "Heart of the Wild",         category: "defensive" }],
  // RETIRED 2026-05-31 — old spellbook ID never fires in Midnight CLEU.
  // Real IDs 1261870 + 1261868 now tracked in OFFENSIVE_COOLDOWNS. Do not delete.
  // NOTE: this copy stores HotW in DEFENSIVE_CD_SPELLS (not SPEC_CONDITIONAL_DEFENSIVES like the other 2 copies) — flagged to PM.
  // ── Evoker ──
  [374348, { name: "Obsidian Scales",           category: "defensive" }],
  [374227, { name: "Zephyr",                    category: "external"  }],
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
  [15286,  { name: "Vampiric Embrace",          category: "external"  }],
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

  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // Mirrors combatLogRunBuilder.js ALWAYS_TRACK_DEFENSIVES additions for parity.
  [194679, { name: "Rune Tap",                  category: "defensive" }],
  [219809, { name: "Tombstone",                 category: "defensive" }],
  [263648, { name: "Soul Barrier",              category: "defensive" }],
  [200851, { name: "Rage of the Sleeper",       category: "defensive" }],
  [740,    { name: "Tranquility",               category: "external"  }],
  [363916, { name: "Obsidian Scales",           category: "defensive" }],
  [363534, { name: "Rewind",                    category: "external"  }],
  [370984, { name: "Time Spiral",               category: "external"  }],
  [264735, { name: "Survival of the Fittest",   category: "defensive" }],
  [5384,   { name: "Feign Death",               category: "defensive" }],
  [11426,  { name: "Ice Barrier",               category: "defensive" }],
  [235313, { name: "Blazing Barrier",           category: "defensive" }],
  [235450, { name: "Prismatic Barrier",         category: "defensive" }],
  [110959, { name: "Greater Invisibility",      category: "defensive" }],
  [243435, { name: "Fortifying Brew (WW/MW)",   category: "defensive" }],
  [115310, { name: "Revival",                   category: "external"  }],
  [184662, { name: "Shield of Vengeance",       category: "defensive" }],
  [205191, { name: "Eye for an Eye",            category: "defensive" }],
  [586,    { name: "Fade",                      category: "defensive" }],
  [1856,   { name: "Vanish",                    category: "defensive" }],
  [185311, { name: "Crimson Vial",              category: "defensive" }],
  [198103, { name: "Earth Elemental",           category: "defensive" }],
  [207399, { name: "Ancestral Protection Totem", category: "external" }],
  [325174, { name: "Spirit Link Totem",         category: "external"  }],
  [6229,   { name: "Twilight Ward",             category: "defensive" }],
  [23920,  { name: "Spell Reflection",          category: "defensive" }],
  // Monk extras already in runBuilder but missing from parser
  [132578, { name: "Invoke Niuzao, the Black Ox", category: "defensive" }],
  [322507, { name: "Celestial Brew",            category: "defensive" }],
  [1241059, { name: "Celestial Infusion",       category: "defensive" }],  // Talented CB variant — cast-path capture, mirrors 322507
  [115399, { name: "Black Ox Brew",             category: "defensive" }],

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

// Offensive CDs — copied verbatim from combatLogRunBuilder.js OFFENSIVE_COOLDOWNS (Overwolf parity).
// type: "group_offensive" = Bloodlust-class raid buff, "personal_offensive" = personal DPS CD.
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
  // NOTE: parser matches OFFENSIVE_COOLDOWNS on SPELL_CAST_SUCCESS only — the aura/summon-only
  // entries below (Bloodshed, Grimoire of Sacrifice, Feral Spirit, Fire/Storm Elemental,
  // Shadowfiend) are INERT until a parser aura/summon branch is added (flagged to PM).
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
  [1261870, { name: "Heart of the Wild", type: "personal_offensive", cd: 180 }],  // primary emitted ID (Balance/Feral/Resto confirmed SPELL_CAST_FAILED Druidroid 2026-05-31)
  [1261868, { name: "Heart of the Wild", type: "personal_offensive", cd: 180 }],  // alt emitted ID (spec variant — both register; first SPELL_CAST_SUCCESS wins dedup)
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

// Racial Abilities — copied verbatim from combatLogRunBuilder.js RACIAL_ABILITIES (Overwolf parity).
// type buckets: "offensive" | "damage" | "heal" | "cc" | "cleanse" | "cleanse_defensive" | "cleanse_offensive"
//               "combat_drop" | "mobility" | "emergency_heal" | "knockback" | "utility"
const RACIAL_ABILITIES = new Map([
  [20594,  { race: "Dwarf",                name: "Stoneform",                        type: "cleanse_defensive" }],
  [265221, { race: "Dark Iron Dwarf",      name: "Fireblood",                        type: "cleanse_offensive" }],
  // Combat-log-emitted ID — see combatLogRunBuilder.js for full note.
  [273104, { race: "Dark Iron Dwarf",      name: "Fireblood",                        type: "cleanse_offensive" }],
  [58984,  { race: "Night Elf",            name: "Shadowmeld",                       type: "combat_drop" }],
  [256948, { race: "Void Elf",             name: "Spatial Rift",                     type: "mobility" }],
  [259930, { race: "Kul Tiran",            name: "Haymaker",                         type: "cc" }],
  [312924, { race: "Mechagnome",           name: "Hyper Organic Light Originator",   type: "emergency_heal" }],
  [28880,  { race: "Draenei",              name: "Gift of the Naaru",                type: "heal" }],
  [255654, { race: "Lightforged Draenei",  name: "Light's Judgment",                 type: "damage" }],
  [69070,  { race: "Goblin",               name: "Rocket Jump",                      type: "mobility" }],
  [20572,  { race: "Orc",                  name: "Blood Fury",                       type: "offensive" }],
  [26297,  { race: "Troll",                name: "Berserking",                       type: "offensive" }],
  [33697,  { race: "Orc",                  name: "Blood Fury",                       type: "offensive" }],
  [33702,  { race: "Orc",                  name: "Blood Fury",                       type: "offensive" }],
  [7744,   { race: "Undead",               name: "Will of the Forsaken",             type: "cleanse" }],
  [59752,  { race: "Human",                name: "Every Man for Himself",            type: "cleanse" }],
  [20549,  { race: "Tauren",               name: "War Stomp",                        type: "cc" }],
  // 69179 was previously labeled "Goblin Rocket Barrage" — Wowhead 2026-05-07 verifies
  // 69179 is actually the Blood Elf Warrior variant of Arcane Torrent. Real Goblin
  // Rocket Barrage is 69041 (added below). Kept registered with corrected label.
  [69179,  { race: "Blood Elf",            name: "Arcane Torrent",                   type: "offensive" }],
  [255661, { race: "Highmountain Tauren",  name: "Bull Rush",                        type: "cc" }],
  [260364, { race: "Nightborne",           name: "Arcane Pulse",                     type: "damage" }],
  [274738, { race: "Mag'har Orc",          name: "Ancestral Call",                   type: "offensive" }],
  [291944, { race: "Zandalari Troll",      name: "Regeneratin'",                     type: "heal" }],
  [312411, { race: "Vulpera",              name: "Bag of Tricks",                    type: "damage" }],
  [107079, { race: "Pandaren",             name: "Quaking Palm",                     type: "cc" }],
  [368970, { race: "Dracthyr",             name: "Tail Swipe",                       type: "cc" }],
  [357214, { race: "Dracthyr",             name: "Wing Buffet",                      type: "knockback" }],
  [446280, { race: "Earthen",              name: "Azerite Surge",                    type: "damage" }],
  [448849, { race: "Earthen",              name: "Wide-Eyed Wonder",                 type: "utility" }],

  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // Blood Elf Arcane Torrent fires per-class spell IDs in CLEU. Register ALL of them.
  [28730,  { race: "Blood Elf",            name: "Arcane Torrent",                   type: "offensive" }],   // Mage/Warlock
  [155145, { race: "Blood Elf",            name: "Arcane Torrent",                   type: "offensive" }],   // Paladin
  [80483,  { race: "Blood Elf",            name: "Arcane Torrent",                   type: "offensive" }],   // Hunter
  [129597, { race: "Blood Elf",            name: "Arcane Torrent",                   type: "offensive" }],   // Monk
  [25046,  { race: "Blood Elf",            name: "Arcane Torrent",                   type: "offensive" }],   // Rogue
  [50613,  { race: "Blood Elf",            name: "Arcane Torrent",                   type: "offensive" }],   // Death Knight
  [202719, { race: "Blood Elf",            name: "Arcane Torrent",                   type: "offensive" }],   // Demon Hunter
  [232633, { race: "Blood Elf",            name: "Arcane Torrent",                   type: "offensive" }],   // Priest

  [68992,  { race: "Worgen",               name: "Darkflight",                       type: "mobility" }],
  [69041,  { race: "Goblin",               name: "Rocket Barrage",                   type: "damage" }],
  [287712, { race: "Kul Tiran",            name: "Haymaker",                         type: "cc" }],
  [358733, { race: "Dracthyr",             name: "Glide",                            type: "mobility" }],
]);

// Tracked consumables — copied verbatim from combatLogRunBuilder.js TRACKED_CONSUMABLES.
// TWW Season 1 IDs. type: "health" | "stat" | "flask".
const TRACKED_CONSUMABLES = new Map([
  // ── Health Potions ──
  [431416, { name: "Algari Healing Potion",         type: "health" }],
  [431418, { name: "Cavedweller's Delight",         type: "health" }],
  // ── Stat Potions ──
  [431932, { name: "Tempered Potion",               type: "stat" }],
  [431934, { name: "Potion of Unwavering Focus",    type: "stat" }],
  // ── Flasks ──
  [431940, { name: "Flask of Alchemical Chaos",     type: "flask" }],
  [431941, { name: "Flask of Tempered Mastery",     type: "flask" }],
  [431942, { name: "Flask of Tempered Versatility", type: "flask" }],
  [431943, { name: "Flask of Tempered Swiftness",   type: "flask" }],
  [431944, { name: "Flask of Tempered Aggression",  type: "flask" }],
  // ── Healthstone ──
  [6262,   { name: "Healthstone",                   type: "health" }],

  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // WARNING: All entries below are UNVERIFIED in CLEU. See runBuilder for context.
  [431972, { name: "Flask of Tempered Swiftness",   type: "flask" }],   // UNVERIFIED CLEU
  [431973, { name: "Flask of Tempered Versatility", type: "flask" }],   // UNVERIFIED CLEU
  [431974, { name: "Flask of Tempered Mastery",     type: "flask" }],   // UNVERIFIED CLEU
  [241325, { name: "Flask of the Blood Knights",    type: "flask" }],   // UNVERIFIED CLEU. Wowhead = "Fel Cannonball" — likely wrong ID.
  [243733, { name: "Thalassian Phoenix Oil",        type: "weapon" }],  // UNVERIFIED CLEU
  [241305, { name: "Silvermoon Health Potion",      type: "health" }],  // UNVERIFIED CLEU
  [242275, { name: "Royal Roast",                   type: "food" }],    // UNVERIFIED CLEU
  [255845, { name: "Silvermoon Parade",             type: "food" }],    // UNVERIFIED CLEU
  [1264426, { name: "Void-Touched Augment Rune",    type: "augment" }], // VERIFIED CLEU 2026-05-07 via Brian SpellID addon

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

// Player-cast stuns on enemies — copied verbatim from combatLogRunBuilder.js
// PLAYER_STUN_SPELLS. Narrower than the existing CC_SPELL_IDS (which also
// covers incapacitates and roots) — this drives the Playbook "Crowd Control"
// pill with stuns specifically.
const PLAYER_STUN_SPELLS = new Set([
  // Paladin
  853,      // Hammer of Justice
  255937,   // Wake of Ashes
  // Monk
  119381,   // Leg Sweep
  // Warrior
  46968,    // Shockwave
  132168,   // Shockwave variant (UNVERIFIED in Overwolf source)
  132169,   // Storm Bolt
  // DK
  91800,    // Gnaw (Ghoul stun)
  287254,   // Dead of Winter (UNVERIFIED — Shadowlands-era in Overwolf source)
  // Druid
  5211,     // Mighty Bash
  163505,   // Rake stun (UNVERIFIED — aura, not cast, per Overwolf source)
  202244,   // Overrun (UNVERIFIED)
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
  // Evoker
  357210,   // Deep Breath (UNVERIFIED — knockback, not true stun per Overwolf)
  // Racials
  20549,    // War Stomp (Tauren)
  255661,   // Bull Rush (Highmountain Tauren — matches RACIAL_ABILITIES)

  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // Mirrors combatLogRunBuilder.js PLAYER_STUN_SPELLS expansion. Now covers full
  // CC palette per directive Phase 2 (single-stream consolidation).
  107570, 221562, 108194, 408, 1833, 199804, 88625, 305483, 199530, 192058, 372245,
  20066, 115078, 6770, 1776, 217832, 118, 82691, 31661, 51514, 710, 6789, 5484,
  605, 8122, 64044, 2637, 99, 3355, 187650, 19386, 213691, 5246, 207167,
  132469, 102793, 116844, 157981, 51490,
  202137, 204490,
  28272, 28271, 61305, 61721, 61780, 161354, 277787, 277792, 391622,
  339, 102359, 122,
  6358, 9484,
]);

// Resurrection spells — minimal set per Directive 7 Work Item 5.
// Battle rezzes + one group rez (out-of-combat). Mass Resurrection included
// for clean runs where the group out-of-combats to rez everyone.
const RESURRECTION_SPELLS = new Map([
  [20484,  { name: "Rebirth" }],                    // Druid battle rez
  [61999,  { name: "Raise Ally" }],                 // Death Knight battle rez
  [159916, { name: "Ancestral Protection Totem" }], // Shaman battle rez via totem
  [265116, { name: "Soulstone" }],                  // Warlock pre-cast rez
  [342246, { name: "Mass Resurrection" }],          // Priest/Paladin/Shaman group rez (OOC)
  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  [20707,  { name: "Soulstone" }],                  // Warlock — master ID for in-combat Soulstone rez
  [391054, { name: "Intercession" }],               // Paladin Ret rez (Holy Power)
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
  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  19647,   // Spell Lock (Felhunter pet bar)
  132409,  // Spell Lock (Command Demon — player-cast)
  212619,  // Call Felhunter (Demonology PvP talent — also interrupts)
  89766,   // Axe Toss (Felguard) — also a stun
  97547,   // Solar Beam — interrupt event ID (cast 78675)
  93985,   // Skull Bash — interrupt event ID (cast 106839)
  220543,  // Silence — interrupt event ID (cast 15487)
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

  // ── Registry expansion 2026-05-07 — Playbook deep audit ──
  // Mirrors PLAYER_STUN_SPELLS expansion. CC_SPELL_IDS feeds the Timeline ccEvents
  // overlay (UnifiedRunTimeline.tsx:522); keep both sets in sync so Companion and
  // Overwolf produce identical CC coverage.
  107570,  // Storm Bolt (Warrior talent)
  199804,  // Between the Eyes (Outlaw)
  88625,   // Holy Word: Chastise (master ID)
  200200,  // Holy Word: Chastise (Censure ID)
  305483,  // Lightning Lasso (Shaman talent)
  115078,  // Paralysis (Monk)
  1776,    // Gouge (Rogue)
  217832,  // Imprison (DH)
  82691,   // Ring of Frost (Mage)
  31661,   // Dragon's Breath (Fire)
  51514,   // Hex (Shaman)
  6789,    // Mortal Coil (Warlock)
  5484,    // Howl of Terror (Warlock)
  605,     // Mind Control (Priest)
  8122,    // Psychic Scream (Priest)
  64044,   // Psychic Horror (Shadow)
  2637,    // Hibernate (Druid)
  99,      // Incapacitating Roar (Druid)
  19386,   // Wyvern Sting (Hunter talent)
  213691,  // Scatter Shot (Hunter)
  5246,    // Intimidating Shout (Warrior)
  207167,  // Blinding Sleet (DK talent)
  132469,  // Typhoon (Druid)
  102793,  // Ursol's Vortex (Druid)
  116844,  // Ring of Peace (Monk)
  157981,  // Blast Wave (Fire)
  51490,   // Thunderstorm (Elemental)
  202137,  // Sigil of Silence (DH)
  204490,  // Sigil of Silence (DH ground placement)
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
        racialCasts    : [],
        consumablesUsed: [],
        resurrections  : [],
        stunEvents     : [],
        dispels        : [],
        playerOverhealing: {},
        interrupts     : [],
        enemyCasts     : [],
        ccEvents       : [],
        spikes         : [],
        absorbs        : [],
        healEvents     : [],
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

      // WI 8 — per-player overhealing accumulation
      const sourceGuid = fields[1] || "";
      const sourceName = (fields[2] || "").replace(/"/g, "");
      const destName   = (fields[6] || "").replace(/"/g, "");
      if (isPlayerGuid(sourceGuid) && overhealing > 0) {
        segData.playerOverhealing[sourceGuid] =
          (segData.playerOverhealing[sourceGuid] || 0) + overhealing;
      }

      // Per-heal event capture (unbounded here; truncated to top-200-by-effective at payload build)
      segData.healEvents.push({
        ts          : normalizedTs,
        offsetMs    : normalizedTs - seg.startTs,
        playerName  : sourceName,
        sourceGuid,
        targetName  : destName,
        targetGuid  : destGuid,
        spellId,
        spellName,
        amount      : amount,
        overheal    : overhealing,
        effective,
      });
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
    if (offInfo && segData.offensiveCDs.length < 60) {
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

    // Racial ability cast — Overwolf parity. 1s per-(player,spellId) dedup
    // mirrors processRacialAura so a single use that emits both
    // SPELL_CAST_SUCCESS and SPELL_AURA_APPLIED only counts once.
    const racialInfo = RACIAL_ABILITIES.get(spellId);
    if (racialInfo) {
      const playerName = (fields[2] || "").replace(/"/g, "") || "Unknown";
      const isDupe = segData.racialCasts.some(r =>
        r.spellId === spellId && r.name === playerName &&
        Math.abs(r.ts - normalizedTs) < 1000
      );
      if (!isDupe) {
        segData.racialCasts.push({
          ts         : normalizedTs,
          offsetMs   : seg ? normalizedTs - seg.startTs : 0,
          spellId,
          spellName  : racialInfo.name,
          name       : playerName,
          class      : guidToClass.get(sourceGuid) || "UNKNOWN",
          role       : guidToRole.get(sourceGuid)  || "unknown",
          race       : racialInfo.race,
          racialType : racialInfo.type,
        });
      }
    }

    // Consumable use (health potions, stat potions, flasks, Healthstone) — Overwolf parity
    const consumableInfo = TRACKED_CONSUMABLES.get(spellId);
    if (consumableInfo && segData.consumablesUsed.length < 30) {
      segData.consumablesUsed.push({
        ts            : normalizedTs,
        offsetMs      : seg ? normalizedTs - seg.startTs : 0,
        spellId,
        spellName     : consumableInfo.name,
        playerName    : (fields[2] || "").replace(/"/g, "") || "Unknown",
        class         : guidToClass.get(sourceGuid) || "UNKNOWN",
        role          : guidToRole.get(sourceGuid)  || "unknown",
        consumableType: consumableInfo.type,
      });
    }

    // Resurrection cast (battle rez, Soulstone, Mass Rez) — Overwolf parity
    const rezInfo = RESURRECTION_SPELLS.get(spellId);
    if (rezInfo && segData.resurrections.length < 10) {
      segData.resurrections.push({
        ts         : normalizedTs,
        offsetMs   : seg ? normalizedTs - seg.startTs : 0,
        spellId,
        spellName  : rezInfo.name,
        playerName : (fields[2] || "").replace(/"/g, "") || "Unknown",
        class      : guidToClass.get(sourceGuid) || "UNKNOWN",
        role       : guidToRole.get(sourceGuid)  || "unknown",
        targetName : (fields[6] || "").replace(/"/g, "") || "Unknown",
      });
    }

    // Player-cast stun on enemy (SPELL_CAST_SUCCESS) — Overwolf parity.
    // Distinct from ccEvents[] (CC_SPELL_IDS, broader — incapacitates + roots).
    if (PLAYER_STUN_SPELLS.has(spellId) && segData.stunEvents.length < 50) {
      const playerName = (fields[2] || "").replace(/"/g, "") || "Unknown";
      const isDupe = segData.stunEvents.some(s =>
        s.spellId === spellId && s.playerName === playerName && Math.abs(s.ts - normalizedTs) < 1000
      );
      if (!isDupe) {
        segData.stunEvents.push({
          ts         : normalizedTs,
          offsetMs   : seg ? normalizedTs - seg.startTs : 0,
          spellId,
          spellName,
          playerName,
          class      : guidToClass.get(sourceGuid) || "UNKNOWN",
          role       : guidToRole.get(sourceGuid)  || "unknown",
          targetName : (fields[6] || "").replace(/"/g, "") || "Unknown",
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

  // ── SPELL_DISPEL — WI 7 — capture player dispel events ────────────────────
  function processSpellDispel(fields, normalizedTs, segmentId) {
    const sourceGuid = fields[1] || "";
    if (!isPlayerGuid(sourceGuid)) return;
    const seg     = getSegment(segmentId);
    const segData = getSegData(segmentId);
    if (!seg || !segData) return;
    if (!segData.dispels) segData.dispels = [];
    if (segData.dispels.length >= 50) return;

    const spellId   = parseInt(fields[9],  10) || 0;
    const spellName = (fields[10] || "").replace(/"/g, "");

    // SPELL_DISPEL suffix: after spell prefix (fields 9-11), check advanced info
    const dispelAdvStart = 12;
    const dispelHasAdv = hasAdvancedInfo(fields, dispelAdvStart);
    const dispelSuffixStart = dispelHasAdv ? dispelAdvStart + ADVANCED_INFO_FIELD_COUNT : dispelAdvStart;

    const dispelledSpellId   = parseInt(fields[dispelSuffixStart],     10) || 0;
    const dispelledSpellName = (fields[dispelSuffixStart + 1] || "").replace(/"/g, "");

    segData.dispels.push({
      ts              : normalizedTs,
      offsetMs        : normalizedTs - seg.startTs,
      spellId,
      spellName,
      playerName      : (fields[2] || "").replace(/"/g, "") || "Unknown",
      class           : guidToClass.get(sourceGuid) || "UNKNOWN",
      role            : guidToRole.get(sourceGuid)  || "unknown",
      targetName      : (fields[6] || "").replace(/"/g, "") || "Unknown",
      targetSpellId   : dispelledSpellId,
      targetSpellName : dispelledSpellName,
    });
  }

  // ── Racial aura tracking — for racials that emit only SPELL_AURA_APPLIED ───
  // Fireblood (273104) and similar racials never fire SPELL_CAST_SUCCESS in CLEU.
  // The cast-time racial branch in processPlayerCast handles racials that DO emit
  // SPELL_CAST_SUCCESS (Shadowmeld, etc.); this handles aura-only racials. The
  // 1s per-(player,spellId) dedup also catches the case where a single use fires
  // both events for the same racial.
  function processRacialAura(fields, normalizedTs, segmentId) {
    const sourceGuid = (fields[1] || "").replace(/"/g, "");
    if (!sourceGuid.startsWith("Player-")) return;

    const spellId = parseInt((fields[9] || "").replace(/"/g, ""), 10);
    if (!spellId) return;
    const racialInfo = RACIAL_ABILITIES.get(spellId);
    if (!racialInfo) return;

    const seg     = getSegment(segmentId);
    const segData = getSegData(segmentId);

    const playerName = (fields[2] || "").replace(/"/g, "") || "Unknown";

    const isDupe = segData.racialCasts.some(r =>
      r.spellId === spellId && r.name === playerName &&
      Math.abs(r.ts - normalizedTs) < 1000
    );
    if (isDupe) return;

    segData.racialCasts.push({
      ts         : normalizedTs,
      offsetMs   : seg ? normalizedTs - seg.startTs : 0,
      spellId,
      spellName  : racialInfo.name,
      name       : playerName,
      class      : guidToClass.get(sourceGuid) || "UNKNOWN",
      role       : guidToRole.get(sourceGuid)  || "unknown",
      race       : racialInfo.race,
      racialType : racialInfo.type,
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
      case "SPELL_DISPEL":
        processSpellDispel(fields, normalizedTs, segmentId);
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
        processRacialAura(fields, normalizedTs, segmentId);
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

    // 2026-05-05 (Companion 1.4.7) — fixed argument-index off-by-one and form detection.
    // Blizzard CLEU SPELL_ABSORBED has two forms:
    //   Form 1 (SWING absorbed): suffix starts with caster block at fields[9].
    //                            Total fields = 19.
    //   Form 2 (SPELL_* absorbed): suffix has source-spell prefix (3 fields) before caster block.
    //                              Total fields = 22.
    // Absorb block layout (last 6 fields of suffix in both forms):
    //   [absorbSpellId, absorbSpellName, absorbSpellSchool, absorbedAmount, totalAmount, critical]
    //
    // Detection: fields[9] is a caster GUID in form 1; numeric spell ID in form 2.
    //
    // Previous code assumed only 5 trailing absorb fields (no totalAmount) and read
    // [n-5..n-2] = [id, name, school, amount]. After Blizzard added totalAmount in 12.x,
    // every value shifted by 1: stored absorbedAmount was actually totalAmount,
    // school field held the real absorbedAmount, name field held the school hex
    // bitmask string ("0x1" etc.), and id field's parseInt of the shield's name
    // string returned 0. Forward-indexed read with form detection avoids the
    // shift entirely and is robust to future trailing-field additions.
    const SPELL_ABSORBED_BASE = 9;
    const fieldAtBase = fields[SPELL_ABSORBED_BASE] || "";
    const isFormTwo = /^\d+$/.test(fieldAtBase);
    const casterStart = isFormTwo ? SPELL_ABSORBED_BASE + 3 : SPELL_ABSORBED_BASE;
    const absorbBlockStart = casterStart + 4;
    const absorbSpellId = parseInt(fields[absorbBlockStart], 10) || 0;
    const absorbSpellName = (fields[absorbBlockStart + 1] || "").replace(/"/g, "");
    const absorbSpellSchool = parseInt(fields[absorbBlockStart + 2], 10) || 0;
    const absorbedAmount = parseInt(fields[absorbBlockStart + 3], 10) || 0;
    if (absorbedAmount <= 0) return;
    // fields[absorbBlockStart + 4] = totalAbsorbAmount (cumulative on this shield, not stored)
    // fields[absorbBlockStart + 5] = critical flag (not stored)

    let sourceHitSpellId = 0;
    let sourceHitSpellName = "";
    if (isFormTwo) {
      sourceHitSpellId = parseInt(fields[SPELL_ABSORBED_BASE], 10) || 0;
      sourceHitSpellName = (fields[SPELL_ABSORBED_BASE + 1] || "").replace(/"/g, "");
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
        racialCasts    : [],
        consumablesUsed: [],
        resurrections  : [],
        stunEvents     : [],
        dispels        : [],
        playerOverhealing: {},
        interrupts     : [],
        enemyCasts     : [],
        ccEvents       : [],
        spikes         : [],
        healEvents     : [],
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
      racialCasts    : data.racialCasts,
      consumablesUsed: data.consumablesUsed,
      resurrections  : data.resurrections,
      stunEvents     : data.stunEvents,
      dispels        : data.dispels || [],
      playerOverhealing: data.playerOverhealing || {},
      interrupts     : data.interrupts,
      enemyCasts     : data.enemyCasts,
      ccEvents       : data.ccEvents.filter(cc => isPlayerGuid(cc.sourceGuid)),
      spikes         : data.spikes,
      absorbs        : data.absorbs,
      healEvents     : (data.healEvents || [])
        .slice()
        .sort((a, b) => (b.effective || 0) - (a.effective || 0))
        .slice(0, 200),
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
