// ApiUploader — sends run data to api.velaraintel.com
// Zero external dependencies — uses native Node.js https module

const https = require("https");

class ApiUploader {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.uploadedKeys = new Set();
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  async upload(payload) {
    if (!this.apiKey) {
      return { ok: false, error: "No API key configured" };
    }

    // Dedup check — use V1.2 field names (runId is unique per run)
    const run = payload.run;
    if (run && run.runId) {
      if (this.uploadedKeys.has(run.runId)) {
        return { ok: true, skipped: true, message: "Already uploaded" };
      }
      this.uploadedKeys.add(run.runId);
    }

    const body = JSON.stringify(payload);

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: "api.velaraintel.com",
          port: 443,
          path: "/v1/ingest/run",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 10000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
            } catch {
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data });
            }
          });
        }
      );

      req.on("error", (err) => resolve({ ok: false, error: err.message }));
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Request timed out (10s)" }); });

      req.write(body);
      req.end();
    });
  }
}

module.exports = { ApiUploader };
