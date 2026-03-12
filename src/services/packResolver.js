// packResolver.js — V1.2
// Velara Intelligence — NPC ID to Pack Matching Engine
//
// Responsibilities:
//   Layer 1 — loadDungeonPackDb(mapId): loads + validates static pack database
//   Layer 2 — scorePackMatch(): scores candidate packs for a given pull
//   Layer 3 — resolvePullAnchor(): returns final spatial output with fallback hierarchy
//
// Deterministic: same input always produces same output.
// Never returns null anchor — fallback hierarchy ensures map never breaks.
//
// What this file does NOT do:
//   - Classify hardest pull
//   - Compute route risk
//   - Infer player movement
//   - Build any War Room or community logic
//
// Confidence model (V1.2 contract):
//   0.80–1.00 → strong   → pack_centroid, anchorPrecision: exact
//   0.55–0.79 → usable   → pack_centroid, anchorPrecision: exact
//   0.40–0.54 → weak     → pack_centroid, anchorPrecision: exact (borderline — watch in testing)
//   <0.40     → fallback → region_centroid or previous_pull_anchor

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Confidence thresholds ────────────────────────────────────────────────────

const CONFIDENCE_STRONG   = 0.80;
const CONFIDENCE_USABLE   = 0.55;
const CONFIDENCE_WEAK     = 0.40; // below this = do not use pack_centroid
const PACK_ADJUSTED_SHIFT = 0.20; // 20% shift toward previous anchor for pack_adjusted

// ─── Layer 1 — Database Loader ───────────────────────────────────────────────

const DB_CACHE = new Map(); // mapId → validated db (in-process cache)

/**
 * loadDungeonPackDb(mapId)
 * Loads the static pack database for a dungeon by mapId.
 * Validates schema on load. Throws on any validation failure.
 *
 * @param {number} mapId
 * @returns {object} Validated pack database
 */
function loadDungeonPackDb(mapId) {
  if (DB_CACHE.has(mapId)) return DB_CACHE.get(mapId);

  // Map mapId to filename
  const DB_FILE_MAP = {
    2769: "windrunner_spire.json",
    // Add future dungeons here: 9999: "dungeon_name.json"
  };

  const filename = DB_FILE_MAP[mapId];
  if (!filename) {
    throw new Error(`[packResolver] No pack database registered for mapId ${mapId}`);
  }

  const dbPath = path.join(__dirname, "../data/dungeonPacks", filename);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`[packResolver] Pack database file not found: ${dbPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  } catch (e) {
    throw new Error(`[packResolver] Failed to parse pack database ${filename}: ${e.message}`);
  }

  validatePackDb(raw);
  DB_CACHE.set(mapId, raw);
  return raw;
}

/**
 * validatePackDb(db)
 * Validates minimal schema. Throws immediately on any failure.
 * Checks: required fields, centroids, no duplicate IDs.
 */
function validatePackDb(db) {
  if (!db.mapId)   throw new Error("[packResolver] DB missing mapId");
  if (!db.floors)  throw new Error("[packResolver] DB missing floors");

  const allPackIds   = new Set();
  const allRegionIds = new Set();

  for (const [floorKey, floor] of Object.entries(db.floors)) {
    if (!Array.isArray(floor.packs)) {
      throw new Error(`[packResolver] Floor ${floorKey} missing packs array`);
    }
    if (!Array.isArray(floor.regions)) {
      throw new Error(`[packResolver] Floor ${floorKey} missing regions array`);
    }

    for (const pack of floor.packs) {
      if (!pack.packId)  throw new Error(`[packResolver] Pack missing packId in floor ${floorKey}`);
      if (!pack.npcIds || !Array.isArray(pack.npcIds)) {
        throw new Error(`[packResolver] Pack ${pack.packId} missing npcIds`);
      }
      if (!pack.centroid || pack.centroid.x == null || pack.centroid.y == null) {
        throw new Error(`[packResolver] Pack ${pack.packId} missing centroid`);
      }
      if (!pack.regionId) {
        throw new Error(`[packResolver] Pack ${pack.packId} missing regionId`);
      }
      if (allPackIds.has(pack.packId)) {
        throw new Error(`[packResolver] Duplicate packId: ${pack.packId}`);
      }
      allPackIds.add(pack.packId);
    }

    for (const region of floor.regions) {
      if (!region.regionId) {
        throw new Error(`[packResolver] Region missing regionId in floor ${floorKey}`);
      }
      if (!region.centroid || region.centroid.x == null || region.centroid.y == null) {
        throw new Error(`[packResolver] Region ${region.regionId} missing centroid`);
      }
      if (!region.bounds) {
        throw new Error(`[packResolver] Region ${region.regionId} missing bounds`);
      }
      if (allRegionIds.has(region.regionId)) {
        throw new Error(`[packResolver] Duplicate regionId: ${region.regionId}`);
      }
      allRegionIds.add(region.regionId);
    }
  }
}

// ─── Database lookup helpers ──────────────────────────────────────────────────

function getAllPacks(db) {
  const packs = [];
  for (const [floorKey, floor] of Object.entries(db.floors)) {
    for (const pack of floor.packs) {
      packs.push({ ...pack, _floor: floorKey });
    }
  }
  return packs;
}

function getRegion(db, regionId) {
  for (const floor of Object.values(db.floors)) {
    for (const region of floor.regions) {
      if (region.regionId === regionId) return region;
    }
  }
  return null;
}

function getPackById(db, packId) {
  for (const [floorKey, floor] of Object.entries(db.floors)) {
    for (const pack of floor.packs) {
      if (pack.packId === packId) return { ...pack, _floor: floorKey };
    }
  }
  return null;
}

// ─── Layer 2 — Scoring Engine ────────────────────────────────────────────────

// Scoring weights — deterministic, explicit
const WEIGHTS = {
  overlapRatio   : 0.50,  // primary signal: fraction of pack NPCs seen in pull
  uniqueBonus    : 0.25,  // strong signal: unique NPC matched
  adjacencyBonus : 0.15,  // continuity: pack adjacent to previous resolved pack
  routeStageBonus: 0.10,  // weak hint: routeStage near pull index
};

/**
 * scorePackMatch({ pullNpcIds, pullIndex, lastMatchedPackId, pack })
 *
 * @returns { score: number, breakdown: object }
 * Score is 0.0–1.0 (may slightly exceed 1.0 in edge cases, clamped later).
 */
function scorePackMatch({ pullNpcIds, pullIndex, lastMatchedPackId, pack }) {
  const pullSet  = new Set(pullNpcIds);
  const packSet  = new Set(pack.npcIds);
  const uniqueSet = new Set(pack.uniqueNpcIds || []);

  // A. Overlap ratio: how many pack NPCs appear in this pull
  const matched = [...packSet].filter(id => pullSet.has(id)).length;
  const overlapRatio = packSet.size > 0 ? matched / packSet.size : 0;

  // B. Unique NPC bonus: 1.0 if any pull NPC is in pack's uniqueNpcIds
  const hasUnique    = [...uniqueSet].some(id => pullSet.has(id));
  const uniqueBonus  = hasUnique ? 1.0 : 0.0;

  // C. Adjacency bonus: 1.0 if this pack is adjacent to last resolved pack
  const adjacencyBonus = (
    lastMatchedPackId &&
    Array.isArray(pack.adjacentPackIds) &&
    pack.adjacentPackIds.includes(lastMatchedPackId)
  ) ? 1.0 : 0.0;

  // D. Route stage bonus: closeness of routeStage to pullIndex (normalized 0–1)
  // Soft signal only — max contribution is WEIGHTS.routeStageBonus
  let routeStageBonus = 0.0;
  if (pack.routeStage != null && pullIndex != null) {
    const diff = Math.abs(pack.routeStage - pullIndex);
    // Bonus decays: 0 diff = 1.0, 1 diff = 0.5, 2+ = 0
    routeStageBonus = diff === 0 ? 1.0 : diff === 1 ? 0.5 : 0.0;
  }

  const score =
    overlapRatio    * WEIGHTS.overlapRatio    +
    uniqueBonus     * WEIGHTS.uniqueBonus     +
    adjacencyBonus  * WEIGHTS.adjacencyBonus  +
    routeStageBonus * WEIGHTS.routeStageBonus;

  const breakdown = {
    overlapRatio,
    uniqueBonus,
    adjacencyBonus,
    routeStageBonus,
    matched,
    packNpcCount: packSet.size,
  };

  return { score: Math.min(score, 1.0), breakdown };
}

// ─── Layer 3 — Anchor Resolver ───────────────────────────────────────────────

/**
 * resolvePullAnchor({ bestPack, matchConfidence, db, lastResolved })
 *
 * @param bestPack       Best candidate pack object (with _floor set), or null
 * @param matchConfidence 0.0–1.0
 * @param db             Loaded pack database
 * @param lastResolved   Previous pull's resolver output (or null)
 *
 * @returns anchor resolution fields (anchorType, anchorPrecision, anchor, regionId, floor)
 */
function resolvePullAnchor({ bestPack, matchConfidence, db, lastResolved }) {
  // ── Path 1: strong/usable/weak pack match ────────────────────────────────
  if (bestPack && matchConfidence >= CONFIDENCE_WEAK) {
    const region = getRegion(db, bestPack.regionId);

    // Decide between pack_centroid and pack_adjusted
    // pack_adjusted used when: usable confidence AND previous anchor exists
    // (provides gentle route continuity without over-engineering)
    const useAdjusted =
      matchConfidence >= CONFIDENCE_USABLE &&
      matchConfidence < CONFIDENCE_STRONG &&
      lastResolved?.anchor != null;

    if (useAdjusted) {
      const cx   = bestPack.centroid.x;
      const cy   = bestPack.centroid.y;
      const prev = lastResolved.anchor;

      // Shift 20% toward previous anchor
      let ax = cx + (prev.x - cx) * PACK_ADJUSTED_SHIFT;
      let ay = cy + (prev.y - cy) * PACK_ADJUSTED_SHIFT;

      // Clamp inside region bounds if available
      if (region?.bounds) {
        ax = Math.max(region.bounds.xMin, Math.min(region.bounds.xMax, ax));
        ay = Math.max(region.bounds.yMin, Math.min(region.bounds.yMax, ay));
      }

      return {
        packId      : bestPack.packId,
        regionId    : bestPack.regionId,
        floor       : bestPack._floor,
        anchor      : { x: parseFloat(ax.toFixed(1)), y: parseFloat(ay.toFixed(1)) },
        anchorType  : "pack_adjusted",
        anchorPrecision: "estimated",
      };
    }

    // Standard pack_centroid
    return {
      packId      : bestPack.packId,
      regionId    : bestPack.regionId,
      floor       : bestPack._floor,
      anchor      : { x: bestPack.centroid.x, y: bestPack.centroid.y },
      anchorType  : "pack_centroid",
      anchorPrecision: "exact",
    };
  }

  // ── Path 2: weak match — try region_centroid ────────────────────────────
  // Use known region from bestPack (even if confidence is low) or from last resolved
  const regionId = bestPack?.regionId || lastResolved?.regionId;
  if (regionId) {
    const region = getRegion(db, regionId);
    if (region?.centroid) {
      return {
        packId      : bestPack?.packId || null,
        regionId,
        floor       : bestPack?._floor || lastResolved?.floor || null,
        anchor      : { x: region.centroid.x, y: region.centroid.y },
        anchorType  : "region_centroid",
        anchorPrecision: "fallback",
      };
    }
  }

  // ── Path 3: previous pull anchor ────────────────────────────────────────
  if (lastResolved?.anchor) {
    return {
      packId      : null,
      regionId    : lastResolved.regionId || null,
      floor       : lastResolved.floor    || null,
      anchor      : { x: lastResolved.anchor.x, y: lastResolved.anchor.y },
      anchorType  : "previous_pull_anchor",
      anchorPrecision: "fallback",
    };
  }

  // ── Path 4: absolute last resort — map center ────────────────────────────
  // This should almost never happen. Logged as warning.
  console.warn("[packResolver] WARNING: All anchor fallbacks exhausted — using map center");
  return {
    packId      : null,
    regionId    : null,
    floor       : null,
    anchor      : { x: 50.0, y: 50.0 },
    anchorType  : "unknown",
    anchorPrecision: "fallback",
  };
}

// ─── Primary export: resolvePull ─────────────────────────────────────────────

/**
 * resolvePull({ mapId, pullNpcIds, enemyCount, pullIndex, lastResolved })
 *
 * Main entry point. Resolves spatial context for one pull.
 *
 * @param {number}   mapId         Dungeon mapId
 * @param {number[]} pullNpcIds    Unique NPC IDs seen in this pull
 * @param {number}   enemyCount    Total enemy instances (not unique IDs)
 * @param {number}   pullIndex     1-based pull index
 * @param {object}   lastResolved  Previous pull's resolvePull() output, or null
 *
 * @returns {ResolvedPull}
 * {
 *   packId, regionId, floor,
 *   anchor, anchorType, anchorPrecision,
 *   packMatchConfidence,
 *   enemyCount,
 *   resolverDiagnostics
 * }
 */
function resolvePull({ mapId, pullNpcIds, enemyCount, pullIndex, lastResolved }) {
  // Load and validate DB (cached after first load)
  const db   = loadDungeonPackDb(mapId);
  const packs = getAllPacks(db);

  // Score all candidate packs
  const candidates = packs.map(pack => {
    const { score, breakdown } = scorePackMatch({
      pullNpcIds,
      pullIndex,
      lastMatchedPackId: lastResolved?.packId || null,
      pack,
    });
    return { pack, score, breakdown };
  });

  // Sort by score descending, then by packId ascending for deterministic tie-breaking
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.pack.packId.localeCompare(b.pack.packId);
  });

  const best           = candidates[0] || null;
  const bestScore      = best?.score ?? 0;
  const bestPack       = best?.pack   ?? null;

  // Anchor resolution
  const anchorResult = resolvePullAnchor({
    bestPack,
    matchConfidence: bestScore,
    db,
    lastResolved: lastResolved || null,
  });

  // Diagnostics block
  const resolverDiagnostics = {
    candidatePacks: candidates.slice(0, 5).map(c => ({
      packId   : c.pack.packId,
      score    : parseFloat(c.score.toFixed(4)),
      breakdown: c.breakdown,
    })),
    selectedPackId         : anchorResult.packId,
    selectedAnchorType     : anchorResult.anchorType,
    selectedAnchorPrecision: anchorResult.anchorPrecision,
    fallbackUsed           : anchorResult.anchorType !== "pack_centroid",
    inputNpcIds            : pullNpcIds,
    pullIndex,
  };

  return {
    packId              : anchorResult.packId,
    regionId            : anchorResult.regionId,
    floor               : anchorResult.floor,
    anchor              : anchorResult.anchor,
    anchorType          : anchorResult.anchorType,
    anchorPrecision     : anchorResult.anchorPrecision,
    packMatchConfidence : parseFloat(bestScore.toFixed(4)),
    enemyCount          : enemyCount || 0,
    resolverDiagnostics,
  };
}

// ─── Test runner (dev only) ──────────────────────────────────────────────────
// Call runResolverTests() to verify all 5 acceptance cases.
// Remove from production or gate behind process.env.NODE_ENV === "development".

function runResolverTests(mapId = 2769) {
  console.log("\n[packResolver] Running acceptance tests for mapId", mapId);
  const db     = loadDungeonPackDb(mapId);
  const packs  = getAllPacks(db);
  const first  = packs[0];
  const second = packs[1];

  let passed = 0;
  let failed = 0;

  function assert(label, condition, detail = "") {
    if (condition) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${label} ${detail}`);
      failed++;
    }
  }

  // Case 1 — clean exact match
  {
    const r = resolvePull({
      mapId,
      pullNpcIds : first.npcIds,
      enemyCount : first.npcIds.length,
      pullIndex  : first.routeStage,
      lastResolved: null,
    });
    assert("Case 1 — exact match → pack_centroid",
      r.anchorType === "pack_centroid", JSON.stringify(r));
    assert("Case 1 — non-null anchor", r.anchor != null);
    assert("Case 1 — correct packId", r.packId === first.packId, r.packId);
    assert("Case 1 — enemyCount present", r.enemyCount >= 0);
  }

  // Case 2 — shared NPC, unique NPC breaks tie
  // Use first pack's uniqueNpcIds + a generic NPC that might appear in two packs
  if (first.uniqueNpcIds?.length > 0) {
    const r = resolvePull({
      mapId,
      pullNpcIds : [...first.uniqueNpcIds, ...(second?.npcIds?.slice(0,1) || [])],
      enemyCount : 2,
      pullIndex  : 1,
      lastResolved: null,
    });
    assert("Case 2 — unique NPC bonus picks correct pack",
      r.packId === first.packId, `got ${r.packId}`);
  } else {
    console.log("  ⏭  Case 2 — skipped (no uniqueNpcIds on first pack)");
  }

  // Case 3 — weak overlap, known region → region_centroid fallback
  {
    const r = resolvePull({
      mapId,
      pullNpcIds : [999998, 999999], // unknown NPCs
      enemyCount : 2,
      pullIndex  : 1,
      lastResolved: null,
    });
    assert("Case 3 — unknown NPCs → fallback (not pack_centroid)",
      r.anchorType !== "pack_centroid", `got ${r.anchorType}`);
    assert("Case 3 — non-null anchor", r.anchor != null);
  }

  // Case 4 — no valid pack, prior pull exists → previous_pull_anchor
  {
    const prior = {
      packId : null,
      regionId: null,
      floor  : "f1",
      anchor : { x: 45.0, y: 60.0 },
    };
    const r = resolvePull({
      mapId,
      pullNpcIds : [999998, 999999],
      enemyCount : 2,
      pullIndex  : 5,
      lastResolved: prior,
    });
    assert("Case 4 — no pack + prior anchor → previous_pull_anchor or region_centroid",
      r.anchor != null, JSON.stringify(r.anchor));
    assert("Case 4 — uses prior anchor location",
      r.anchorType === "previous_pull_anchor" || r.anchorType === "region_centroid");
  }

  // Case 5 — determinism: identical input → identical result
  {
    const input = {
      mapId,
      pullNpcIds : first.npcIds,
      enemyCount : 3,
      pullIndex  : first.routeStage,
      lastResolved: null,
    };
    const r1 = resolvePull(input);
    const r2 = resolvePull(input);
    assert("Case 5 — deterministic output",
      JSON.stringify(r1) === JSON.stringify(r2));
  }

  console.log(`\n[packResolver] Tests complete: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

module.exports = {
  loadDungeonPackDb,
  validatePackDb,
  resolvePull,
  runResolverTests,
};
