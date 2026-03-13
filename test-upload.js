// test-upload.js — fires a real upload without needing a dungeon run
// Usage: node test-upload.js YOUR_API_KEY
// Example: node test-upload.js abc123xyz

const { ApiUploader } = require("./src/services/apiUploader");

const apiKey = process.argv[2];
if (!apiKey) {
  console.error("Usage: node test-upload.js YOUR_API_KEY");
  process.exit(1);
}

// Minimal valid V1.2 payload — Windrunner Spire, mapId 2769
const now = Date.now();
const payload = {
  addon    : "VelaraIntel",
  v        : "0.5.3",
  uploadTs : now,
  clockOffsetMs       : null,
  clockSyncConfidence : "unknown",
  run: {
    runId         : `test-${now}`,
    mapId         : 2769,
    dungeonName   : "Windrunner Spire",
    keyLevel      : 2,
    affixes       : [],
    startTs       : now - 1800000,
    finishTs      : now - 600000,
    durationMs    : 1200000,
    runType       : "private",
    addonVersion  : "0.5.3",
    exportVersion : "1.0.0",
    telemetryCapabilities: {
      hasCombatSegments      : false,
      hasEnemyRegistry       : false,
      hasPartySnapshot       : false,
      hasDeathContext        : false,
      hasDamageBuckets       : false,
      hasEnemyCasts          : false,
      hasInterrupts          : false,
      hasEnemyHealthSnapshots: false,
      hasEnemyPositions      : false,
    },
    player        : { class: "DRUID", role: "tank" },
    partyMembers  : [],
    pulls         : [],
    wipes         : [],
    damageBuckets : [],
    enemyRegistry : [],
    combatSegments: [],
  },
};

console.log(`[TEST] Uploading test run to api.velaraintel.com...`);
console.log(`[TEST] runId: ${payload.run.runId}`);

const uploader = new ApiUploader(apiKey);
uploader.upload(payload).then((result) => {
  console.log("[TEST] Result:", JSON.stringify(result, null, 2));
  if (result.ok) {
    console.log("\n✅ UPLOAD PIPELINE WORKS — end to end verified");
  } else {
    console.log("\n❌ UPLOAD FAILED — see result above");
  }
});
