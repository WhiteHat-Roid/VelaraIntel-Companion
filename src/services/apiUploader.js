// ApiUploader — sends run data to api.velaraintel.com
// V2 — no API key required. Ingest endpoint is public.
// clientId (UUID generated on first launch) sent for per-client rate tracking.
// Zero external dependencies — uses native Node.js https module.

const https = require("https");
const vlog  = require("./velaraLog");

class ApiUploader {
  constructor(clientId) {
    this.clientId = clientId || "";
    this.authToken = null;
    this.uploadedKeys = new Set(); // Only stores SUCCESSFULLY uploaded runIds
  }

  setClientId(id) {
    this.clientId = id;
  }

  setAuthToken(token) {
    this.authToken = token || null;
  }

  // Generic authenticated JSON POST. D206's late subZone enrichment needs to
  // reach an owner-only endpoint, and it must carry the SAME Authorization and
  // X-Client-Id headers as upload() — reproducing that header block in a second
  // place is how the two drift apart.
  postJson(path, obj) {
    const body = JSON.stringify(obj);
    const headers = {
      "Content-Type"  : "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (this.clientId)  headers["X-Client-Id"]   = this.clientId;
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: "api.velaraintel.com",
          port    : 443,
          path,
          method  : "POST",
          headers,
          timeout : 15000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            try { resolve({ ok, status: res.statusCode, body: JSON.parse(data) }); }
            catch { resolve({ ok, status: res.statusCode, body: data }); }
          });
        }
      );
      req.on("error",   (err) => resolve({ ok: false, error: err.message }));
      req.on("timeout", ()    => { req.destroy(); resolve({ ok: false, error: "Request timed out (15s)" }); });
      req.write(body);
      req.end();
    });
  }

  // ⛔ mapBounds SAFETY NET. injectMapBounds() is called at exactly two sites in
  // main.js — the live auto-upload and the GO button. The log-rebuild paths
  // ("Upload A Log", combatLogScanner) reach upload() without passing either, so
  // they shipped with NO bounds: measured 0 of 66 rebuild-path runs carried
  // mapBounds, against 99 of 142 on the live path. Without bounds worldToNorm has
  // no basis and every positioned event is dropped by the web — the Temple +2 had
  // 300 usable events and rendered nothing.
  //
  // Injecting here, at the one choke point every path goes through, means a future
  // upload path cannot reintroduce the gap. FILL-ONLY: a payload that already
  // carries bounds is left untouched, so the two existing call sites keep their
  // exact current behaviour and this is strictly additive.
  setMapBoundsProvider(fn) {
    this.mapBoundsProvider = typeof fn === "function" ? fn : null;
  }

  _fillMapBounds(payload) {
    if (!payload || !payload.run || !this.mapBoundsProvider) return 0;
    const existing = payload.run.mapBounds;
    if (existing && Object.keys(existing).length > 0) return Object.keys(existing).length;
    let bounds = null;
    try { bounds = this.mapBoundsProvider(); } catch { bounds = null; }
    if (!bounds || Object.keys(bounds).length === 0) return 0;
    payload.run.mapBounds = bounds;
    return Object.keys(bounds).length;
  }

  async upload(payload) {
    const run = payload.run;
    const runId = run && run.runId;

    // Dedup check — only skip if previously SUCCEEDED
    if (runId && this.uploadedKeys.has(runId)) {
      return { ok: true, skipped: true, message: "Already uploaded" };
    }

    // Log payload shape for debugging
    const segments = run ? (run.combatSegments || []).length : 0;
    const pulls = run ? (run.pulls || []).length : 0;

    // ⛔ The identity fields AS SENT, plus the construction site that built this
    // run. This is the record that did not exist when a Temple +2 landed unowned:
    // uploadedBy said fullName "Unknown"/identitySource "unresolved" and nothing
    // on disk said which builder produced it or whether a Bearer was attached.
    // hasAuth is a BOOLEAN — the token itself never reaches the log.
    // Fill bounds BEFORE logging so mapBoundsKeys records what actually ships.
    const boundsBefore = run?.mapBounds ? Object.keys(run.mapBounds).length : 0;
    const boundsAfter  = this._fillMapBounds(payload);

    const ub = payload.uploadedBy || {};
    vlog.info("upload.attempt", {
      mapBoundsBefore: boundsBefore,
      mapBoundsFilledBySafetyNet: boundsBefore === 0 && boundsAfter > 0,
      runId,
      mapId: run?.mapId,
      keyLevel: run?.keyLevel,
      segments,
      pulls,
      builderSource: payload._builderSource || run?._builderSource || "unknown",
      identity: {
        fullName:       ub.fullName ?? null,
        characterName:  ub.characterName ?? null,
        identitySource: ub.identitySource ?? null,
        clientId:       ub.clientId ?? null,
      },
      uploaderClientId: this.clientId || null,
      hasAuth: !!this.authToken,
      mapBoundsKeys: run?.mapBounds ? Object.keys(run.mapBounds).length : 0,
    });

    const result = await this._doUpload(payload);

    // Every attempt is recorded with its HTTP status and FULL response body —
    // success and failure alike. A logger that only fires on one branch is the
    // same blind gate this was written to remove.
    vlog[result.ok ? "info" : "error"]("upload.result", {
      runId,
      ok: result.ok,
      status: result.status ?? null,
      error: result.error ?? null,
      body: result.body ?? null,
    });

    // Log full response for debugging
    if (!result.ok) {
      console.error(`[Uploader] FAILED (${result.status}):`, JSON.stringify(result.body || result.error));

      // 429 — rate limited. Read retryAfter from response body and surface to UI.
      // Do NOT cache the run as uploaded — allow future retry once window clears.
      // Do NOT retry immediately — caller should wait for retryAfter seconds.
      if (result.status === 429) {
        const retryAfter = result.body?.retryAfter || result.body?.retry_after || 60;
        const msg = `Rate limited — wait ${retryAfter}s before retrying`;
        console.warn(`[Uploader] 429 RATE LIMITED: ${msg}. runId=${runId}`);
        return {
          ok: false,
          status: 429,
          error: msg,
          retryAfter,
          body: result.body,
        };
      }

      // Retry once on 422 after 5 seconds
      if (result.status === 422) {
        console.log("[Uploader] Retrying in 5 seconds...");
        await new Promise(r => setTimeout(r, 5000));
        const retry = await this._doUpload(payload);
        vlog[retry.ok ? "info" : "error"]("upload.retry.result", {
          runId, ok: retry.ok, status: retry.status ?? null,
          error: retry.error ?? null, body: retry.body ?? null,
        });
        if (!retry.ok) {
          console.error(`[Uploader] Retry FAILED (${retry.status}):`, JSON.stringify(retry.body || retry.error));
          return retry; // Don't cache — allow future retries
        }
        // Retry succeeded
        if (runId) this.uploadedKeys.add(runId);
        return retry;
      }

      return result; // Don't cache failures — allow future retries
    }

    // SUCCESS — cache to prevent duplicate uploads
    if (runId) this.uploadedKeys.add(runId);
    return result;
  }

  async _doUpload(payload) {
    // `_builderSource` is a LOCAL diagnostic tag only. Strip it here so it can
    // never reach the wire — validate.py is strict about payload shape, and a
    // debug field must not be able to fail an upload.
    const { _builderSource, ...wire } = payload;
    const body = JSON.stringify(wire);

    const headers = {
      "Content-Type"  : "application/json",
      "Content-Length": Buffer.byteLength(body),
    };

    if (this.clientId) {
      headers["X-Client-Id"] = this.clientId;
    }

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: "api.velaraintel.com",
          port    : 443,
          path    : "/v1/ingest/run",
          method  : "POST",
          headers,
          timeout : 15000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            try {
              const parsed = JSON.parse(data);
              resolve({ ok, status: res.statusCode, body: parsed });
            } catch {
              resolve({ ok, status: res.statusCode, body: data });
            }
          });
        }
      );

      req.on("error",   (err) => resolve({ ok: false, error: err.message }));
      req.on("timeout", ()    => { req.destroy(); resolve({ ok: false, error: "Request timed out (15s)" }); });

      req.write(body);
      req.end();
    });
  }
}

module.exports = { ApiUploader };
