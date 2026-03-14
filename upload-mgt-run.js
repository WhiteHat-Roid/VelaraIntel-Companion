// One-time manual upload for Magisters' Terrace run 0-1773428593-7451-f59d
// This run was captured before the mapId polling fix — mapId was 0.
// We know it's Magisters' Terrace (mapId 2811) so we override it here.
//
// Run with: node upload-mgt-run.js YOUR_API_KEY

const API_KEY = process.argv[2];
if (!API_KEY) { console.error("Usage: node upload-mgt-run.js YOUR_API_KEY"); process.exit(1); }

const run = {
  runId         : "0-1773428593-7451-f59d",
  mapId         : 2811,   // Magisters' Terrace — overridden from 0
  dungeonName   : "Magisters' Terrace",
  keyLevel      : 0,
  affixes       : [],
  startSec      : 1773428593,
  finishSec     : 1773429013,
  runType       : "private",
  addonVersion  : "0.5.3",
  exportVersion : "1.0.0",
  telemetryCapabilities: {
    hasCombatSegments      : true,
    hasEnemyRegistry       : true,
    hasPartySnapshot       : true,
    hasDeathContext        : false,
    hasDamageBuckets       : false,
    hasEnemyCasts          : false,
    hasInterrupts          : false,
    hasEnemyHealthSnapshots: false,
    hasEnemyPositions      : false,
  },
  player: {
    class: "Druid",
    spec : "Guardian",
    role : "tank",
  },
  partyMembers: [
    { class: "Druid",   spec: "", role: "dps",    specConfidence: "unknown" },
    { class: "Priest",  spec: "", role: "healer",  specConfidence: "unknown" },
    { class: "Druid",   spec: "", role: "dps",    specConfidence: "unknown" },
    { class: "Warrior", spec: "", role: "dps",    specConfidence: "unknown" },
  ],
  combatSegments: [
    {
      segmentId   : "0-1773428593-7451-f59d-s1",
      index       : 1,
      startSec    : 1773428774,
      finishSec   : 1773428987,
      segmentType : "regen",
      rawOutcome  : "regen_restored",
      enemyGuids  : [],
      npcIds      : [],
    },
  ],
  enemyRegistry: [],
};

const startTs  = run.startSec  * 1000;
const finishTs = run.finishSec * 1000;

const payload = {
  addon    : "VelaraIntel",
  v        : run.addonVersion,
  uploadTs : Date.now(),
  clockOffsetMs       : null,
  clockSyncConfidence : "unknown",
  run: {
    runId         : run.runId,
    mapId         : run.mapId,
    dungeonName   : run.dungeonName,
    keyLevel      : run.keyLevel,
    affixes       : run.affixes,
    startTs       : startTs,
    finishTs      : finishTs,
    durationMs    : finishTs - startTs,
    runType       : run.runType,
    addonVersion  : run.addonVersion,
    exportVersion : run.exportVersion,
    telemetryCapabilities: run.telemetryCapabilities,
    player        : run.player,
    partyMembers  : run.partyMembers,
    pulls         : [],
    wipes         : [],
    damageBuckets : [],
    enemyRegistry : run.enemyRegistry,
    combatSegments: run.combatSegments,
  },
};

async function upload() {
  const url = "https://api.velaraintel.com/v1/ingest/run";
  console.log(`Uploading run ${run.runId} as mapId ${run.mapId} (Magisters' Terrace)...`);

  const res  = await fetch(url, {
    method  : "POST",
    headers : { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body    : JSON.stringify(payload),
  });
  const body = await res.json();
  console.log("Result:", JSON.stringify(body, null, 2));
}

upload().catch(console.error);
