// ApiUploader — sends run data to api.velaraintel.com
// V2 — no API key required. Ingest endpoint is public.
// clientId (UUID generated on first launch) sent for per-client rate tracking.
// Zero external dependencies — uses native Node.js https module.

const https = require("https");

class ApiUploader {
  constructor(clientId) {
    this.clientId = clientId || "";
    this.uploadedKeys = new Set();
  }

  setClientId(id) {
    this.clientId = id;
  }

  async upload(payload) {
    // Dedup check — runId is unique per run
    const run = payload.run;
    if (run && run.runId) {
      if (this.uploadedKeys.has(run.runId)) {
        return { ok: true, skipped: true, message: "Already uploaded" };
      }
      this.uploadedKeys.add(run.runId);
    }

    const body = JSON.stringify(payload);

    const headers = {
      "Content-Type"  : "application/json",
      "Content-Length": Buffer.byteLength(body),
    };

    // clientId is optional telemetry — helps with per-client rate tracking
    // It is a random UUID generated locally on first launch, not a user identifier
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
          timeout : 10000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              resolve({
                ok    : res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                body  : parsed,
              });
            } catch {
              resolve({
                ok    : res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                body  : data,
              });
            }
          });
        }
      );

      req.on("error",   (err) => resolve({ ok: false, error: err.message }));
      req.on("timeout", ()    => { req.destroy(); resolve({ ok: false, error: "Request timed out (10s)" }); });

      req.write(body);
      req.end();
    });
  }
}

module.exports = { ApiUploader };
