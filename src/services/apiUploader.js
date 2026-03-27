// ApiUploader — sends run data to api.velaraintel.com
// V2 — no API key required. Ingest endpoint is public.
// clientId (UUID generated on first launch) sent for per-client rate tracking.
// Zero external dependencies — uses native Node.js https module.

const https = require("https");

class ApiUploader {
  constructor(clientId) {
    this.clientId = clientId || "";
    this.uploadedKeys = new Set(); // Only stores SUCCESSFULLY uploaded runIds
  }

  setClientId(id) {
    this.clientId = id;
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
    console.log(`[Uploader] Uploading runId=${runId} mapId=${run?.mapId} key=+${run?.keyLevel} segments=${segments} pulls=${pulls}`);

    const result = await this._doUpload(payload);

    // Log full response for debugging
    if (!result.ok) {
      console.error(`[Uploader] FAILED (${result.status}):`, JSON.stringify(result.body || result.error));

      // Retry once on 422 after 5 seconds
      if (result.status === 422) {
        console.log("[Uploader] Retrying in 5 seconds...");
        await new Promise(r => setTimeout(r, 5000));
        const retry = await this._doUpload(payload);
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
    const body = JSON.stringify(payload);

    const headers = {
      "Content-Type"  : "application/json",
      "Content-Length": Buffer.byteLength(body),
    };

    if (this.clientId) {
      headers["X-Client-Id"] = this.clientId;
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
