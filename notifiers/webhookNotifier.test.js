// notifiers/webhookNotifier.test.js
// notifiers/webhookNotifier.js のユニットテスト: configured()/未設定パス、
// notify() の成功時ペイロード形(alertのそのままJSON化)・HMAC署名ヘッダの有無と
// 正しさ、失敗パス(非OKレスポンス・fetch自体の失敗)を mockした global.fetch で
// 検証する(実際のネットワークには一切触れない)。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const ENV_KEYS = ["WEBHOOK_ENABLED", "WEBHOOK_URL", "WEBHOOK_SECRET"];
let savedEnv;
let originalFetch;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  originalFetch = global.fetch;
  delete require.cache[require.resolve("./webhookNotifier")];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  global.fetch = originalFetch;
});

const sampleAlert = {
  alertId: "disk-root-critical:2026-08-07T10:00:00.000Z",
  ruleId: "disk-root-critical",
  ruleName: "Root disk usage critical",
  metric: "disk.percent",
  value: 91.4,
  operator: ">=",
  threshold: 90,
  severity: "critical",
  state: "FIRING",
  previousState: "OK",
  message: "Root disk usage critical is FIRING: disk.percent = 91.4 (threshold >= 90)",
  timestamp: "2026-08-07T10:00:00.000Z",
};

describe("configured()", () => {
  it("is false when WEBHOOK_ENABLED is unset", () => {
    process.env.WEBHOOK_URL = "https://example.com/hook";
    const webhookNotifier = require("./webhookNotifier");
    assert.equal(webhookNotifier.configured(), false);
  });

  it("is false when WEBHOOK_ENABLED=true but WEBHOOK_URL is unset", () => {
    process.env.WEBHOOK_ENABLED = "true";
    const webhookNotifier = require("./webhookNotifier");
    assert.equal(webhookNotifier.configured(), false);
  });

  it("is true when both WEBHOOK_ENABLED=true and WEBHOOK_URL are set (WEBHOOK_SECRET is optional)", () => {
    process.env.WEBHOOK_ENABLED = "true";
    process.env.WEBHOOK_URL = "https://example.com/hook";
    const webhookNotifier = require("./webhookNotifier");
    assert.equal(webhookNotifier.configured(), true);
  });
});

describe("notify() — success path", () => {
  beforeEach(() => {
    process.env.WEBHOOK_ENABLED = "true";
    process.env.WEBHOOK_URL = "https://example.com/hook";
  });

  it("POSTs the raw alert JSON verbatim, with no signature header when WEBHOOK_SECRET is unset", async () => {
    let captured;
    global.fetch = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200 };
    };

    const webhookNotifier = require("./webhookNotifier");
    await webhookNotifier.notify(sampleAlert);

    assert.equal(captured.url, "https://example.com/hook");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(captured.init.body), sampleAlert);
    assert.equal(captured.init.headers["X-SND-Signature"], undefined);
  });

  it("adds a correct X-SND-Signature (hex HMAC-SHA256 of the exact body) when WEBHOOK_SECRET is set", async () => {
    process.env.WEBHOOK_SECRET = "top-secret";
    let captured;
    global.fetch = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200 };
    };

    const webhookNotifier = require("./webhookNotifier");
    await webhookNotifier.notify(sampleAlert);

    const expectedSignature = crypto
      .createHmac("sha256", "top-secret")
      .update(captured.init.body)
      .digest("hex");
    assert.equal(captured.init.headers["X-SND-Signature"], expectedSignature);
    // sanity: signature is a bare hex string, no algorithm prefix
    assert.match(captured.init.headers["X-SND-Signature"], /^[0-9a-f]{64}$/);
  });

  it("produces a different signature for a different WEBHOOK_SECRET (proves the secret is actually used)", async () => {
    const signatures = [];
    global.fetch = async (url, init) => {
      signatures.push(init.headers["X-SND-Signature"]);
      return { ok: true, status: 200 };
    };

    process.env.WEBHOOK_SECRET = "secret-a";
    delete require.cache[require.resolve("./webhookNotifier")];
    await require("./webhookNotifier").notify(sampleAlert);

    process.env.WEBHOOK_SECRET = "secret-b";
    delete require.cache[require.resolve("./webhookNotifier")];
    await require("./webhookNotifier").notify(sampleAlert);

    assert.notEqual(signatures[0], signatures[1]);
  });
});

describe("notify() — failure paths", () => {
  beforeEach(() => {
    process.env.WEBHOOK_ENABLED = "true";
    process.env.WEBHOOK_URL = "https://example.com/hook";
  });

  it("throws when the endpoint responds with a non-ok status", async () => {
    global.fetch = async () => ({ ok: false, status: 502 });
    const webhookNotifier = require("./webhookNotifier");
    await assert.rejects(() => webhookNotifier.notify(sampleAlert), /responded with 502/);
  });

  it("propagates a network-level fetch failure", async () => {
    global.fetch = async () => {
      throw new Error("network unreachable");
    };
    const webhookNotifier = require("./webhookNotifier");
    await assert.rejects(() => webhookNotifier.notify(sampleAlert), /network unreachable/);
  });
});
