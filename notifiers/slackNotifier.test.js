// notifiers/slackNotifier.test.js
// notifiers/slackNotifier.js のユニットテスト: configured()/未設定パス、
// notify() の成功時ペイロード形、失敗パス(非OKレスポンス・fetch自体の失敗)を
// mockした global.fetch で検証する(実際のネットワークには一切触れない)。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const ENV_KEYS = ["SLACK_ENABLED", "SLACK_WEBHOOK_URL"];
let savedEnv;
let originalFetch;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  originalFetch = global.fetch;
  delete require.cache[require.resolve("./slackNotifier")];
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
  it("is false when SLACK_ENABLED is unset", () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/x/y/z";
    const slackNotifier = require("./slackNotifier");
    assert.equal(slackNotifier.configured(), false);
  });

  it("is false when SLACK_ENABLED=true but SLACK_WEBHOOK_URL is unset", () => {
    process.env.SLACK_ENABLED = "true";
    const slackNotifier = require("./slackNotifier");
    assert.equal(slackNotifier.configured(), false);
  });

  it("is true when both SLACK_ENABLED=true and SLACK_WEBHOOK_URL are set", () => {
    process.env.SLACK_ENABLED = "true";
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/x/y/z";
    const slackNotifier = require("./slackNotifier");
    assert.equal(slackNotifier.configured(), true);
  });
});

describe("notify() — success path", () => {
  beforeEach(() => {
    process.env.SLACK_ENABLED = "true";
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/x/y/z";
  });

  it("POSTs a simple { text } payload to the correct URL", async () => {
    let captured;
    global.fetch = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200 };
    };

    const slackNotifier = require("./slackNotifier");
    await slackNotifier.notify(sampleAlert);

    assert.equal(captured.url, "https://hooks.slack.com/services/x/y/z");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["Content-Type"], "application/json");

    const body = JSON.parse(captured.init.body);
    assert.ok(typeof body.text === "string");
    assert.match(body.text, /Root disk usage critical/);
    assert.match(body.text, /FIRING/);
    assert.match(body.text, /disk\.percent = 91\.4/);
  });
});

describe("notify() — failure paths", () => {
  beforeEach(() => {
    process.env.SLACK_ENABLED = "true";
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/x/y/z";
  });

  it("throws when the webhook responds with a non-ok status", async () => {
    global.fetch = async () => ({ ok: false, status: 403 });
    const slackNotifier = require("./slackNotifier");
    await assert.rejects(() => slackNotifier.notify(sampleAlert), /responded with 403/);
  });

  it("propagates a network-level fetch failure", async () => {
    global.fetch = async () => {
      throw new Error("network unreachable");
    };
    const slackNotifier = require("./slackNotifier");
    await assert.rejects(() => slackNotifier.notify(sampleAlert), /network unreachable/);
  });
});
