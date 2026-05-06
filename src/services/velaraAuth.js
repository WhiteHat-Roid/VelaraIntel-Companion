// VelaraAuth — Companion ↔ Velara Intelligence link state
//
// Persists the link token + user/characters in electron-store under "auth".
// Talks to api.velaraintel.com:
//   POST /v1/companion/token       body {code}   → {token, userId, displayName, characters[]}
//   GET  /v1/companion/characters  Bearer token  → {userId, characters[]}
//
// Zero external deps — uses Node's built-in https module (matches ApiUploader).

const https = require("https");

const API_HOST = "api.velaraintel.com";
const API_PORT = 443;

class VelaraAuth {
  constructor(store) {
    this.store = store;
    const saved = (store && store.get("auth")) || {};
    this._token       = saved.token       || null;
    this._userId      = saved.userId      || null;
    this._displayName = saved.displayName || null;
    this._characters  = Array.isArray(saved.characters) ? saved.characters : [];
  }

  get isLinked()    { return !!this._token; }
  get userId()      { return this._userId; }
  get displayName() { return this._displayName; }
  get characters()  { return this._characters || []; }

  getAuthToken() {
    return this._token;
  }

  async initialize() {
    if (!this._token) return;
    try {
      const data = await this._request("GET", "/v1/companion/characters", null, this._token);
      if (data && Array.isArray(data.characters)) {
        this._characters = data.characters;
        if (data.userId) this._userId = data.userId;
        this._persist();
      }
    } catch (err) {
      // Network error or 401 — leave cached state as-is so we can still tag uploads.
      // A 401 will surface to the user when they next try to upload.
      console.warn(`[VelaraAuth] initialize() failed: ${err.message}`);
    }
  }

  async linkWithCode(code) {
    const cleaned = String(code || "").trim().toUpperCase();
    if (!cleaned) throw new Error("Link code is empty");

    const data = await this._request("POST", "/v1/companion/token", { code: cleaned }, null);
    if (!data || !data.token) {
      throw new Error("Server did not return a token");
    }
    this._token       = data.token;
    this._userId      = data.userId      || null;
    this._displayName = data.displayName || null;
    this._characters  = Array.isArray(data.characters) ? data.characters : [];
    this._persist();
    return {
      displayName: this._displayName,
      characters : this._characters,
    };
  }

  unlink() {
    this._token       = null;
    this._userId      = null;
    this._displayName = null;
    this._characters  = [];
    this._persist();
  }

  _persist() {
    if (!this.store) return;
    this.store.set("auth", {
      token       : this._token,
      userId      : this._userId,
      displayName : this._displayName,
      characters  : this._characters,
    });
  }

  _request(method, path, body, bearer) {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers["Content-Type"]   = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;

    return new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: API_HOST, port: API_PORT, path, method, headers, timeout: 15000 },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            let parsed = data;
            try { parsed = JSON.parse(data); } catch { /* leave as string */ }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const detail = (parsed && typeof parsed === "object" && parsed.detail) || `HTTP ${res.statusCode}`;
              reject(new Error(detail));
            }
          });
        }
      );
      req.on("error",   (err) => reject(err));
      req.on("timeout", ()    => { req.destroy(); reject(new Error("Request timed out (15s)")); });
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = { VelaraAuth };
