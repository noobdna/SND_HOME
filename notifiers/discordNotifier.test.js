// notifiers/discordNotifier.test.js
// notifiers/discordNotifier.js のユニットテスト: configured()/未設定パス、
// notify() の成功時ペイロード形、失敗パス(非OKレスポンス・fetch自体の失敗)を
// mockした global.fetch で検証する(実際のネットワークには一切触れない)。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const ENV_KEYS = ["DISCORD_ENABLED", "DISCORD_WEBHOOK_URL"];
let savedEnv;
let originalFetch;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  originalFetch = global.fetch;
  delete require.cache[require.resolve("./discordNotifier")];
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
  it("is false when DISCORD_ENABLED is unset", () => {
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/x/y";
    const discordNotifier = require("./discordNotifier");
    assert.equal(discordNotifier.configured(), false);
  });

  it("is false when DISCORD_ENABLED=true but DISCORD_WEBHOOK_URL is unset", () => {
    process.env.DISCORD_ENABLED = "true";
    const discordNotifier = require("./discordNotifier");
    assert.equal(discordNotifier.configured(), false);
  });

  it("is false when DISCORD_ENABLED is not exactly the string 'true'", () => {
    process.env.DISCORD_ENABLED = "1";
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/x/y";
    const discordNotifier = require("./discordNotifier");
    assert.equal(discordNotifier.configured(), false);
  });

  it("is true when both DISCORD_ENABLED=true and DISCORD_WEBHOOK_URL are set", () => {
    process.env.DISCORD_ENABLED = "true";
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/x/y";
    const discordNotifier = require("./discordNotifier");
    assert.equal(discordNotifier.configured(), true);
  });
});

describe("notify() — success path", () => {
  beforeEach(() => {
    process.env.DISCORD_ENABLED = "true";
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/x/y";
  });

  it("POSTs an embed with the correct URL, headers, and content", async () => {
    let captured;
    global.fetch = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 204 };
    };

    const discordNotifier = require("./discordNotifier");
    await discordNotifier.notify(sampleAlert);

    assert.equal(captured.url, "https://discord.com/api/webhooks/x/y");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["Content-Type"], "application/json");

    const body = JSON.parse(captured.init.body);
    const embed = body.embeds[0];
    assert.match(embed.title, /Root disk usage critical/);
    assert.match(embed.title, /FIRING/);
    assert.equal(embed.description, sampleAlert.message);
    assert.equal(embed.timestamp, sampleAlert.timestamp);
    const fieldMap = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.equal(fieldMap.Metric, "disk.percent");
    assert.equal(fieldMap.Value, "91.4");
    assert.equal(fieldMap.Severity, "critical");
  });

  it("colors FIRING/DOWN red and OK green", async () => {
    const bodies = [];
    global.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 204 };
    };
    const discordNotifier = require("./discordNotifier");

    await discordNotifier.notify({ ...sampleAlert, state: "FIRING" });
    await discordNotifier.notify({ ...sampleAlert, state: "DOWN" });
    await discordNotifier.notify({ ...sampleAlert, state: "OK" });

    const [firing, down, ok] = bodies.map((b) => b.embeds[0].color);
    assert.equal(firing, 0xed4245);
    assert.equal(down, 0xed4245);
    assert.equal(ok, 0x57f287);
  });
});

describe("notify() — failure paths", () => {
  beforeEach(() => {
    process.env.DISCORD_ENABLED = "true";
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/x/y";
  });

  it("throws when the webhook responds with a non-ok status", async () => {
    global.fetch = async () => ({ ok: false, status: 500 });
    const discordNotifier = require("./discordNotifier");
    await assert.rejects(() => discordNotifier.notify(sampleAlert), /responded with 500/);
  });

  it("propagates a network-level fetch failure", async () => {
    global.fetch = async () => {
      throw new Error("network unreachable");
    };
    const discordNotifier = require("./discordNotifier");
    await assert.rejects(() => discordNotifier.notify(sampleAlert), /network unreachable/);
  });
});
