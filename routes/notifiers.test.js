// routes/notifiers.test.js
// routes/notifiers.js の supertest 統合テスト(Task 8.3)。/api/notifiers/* の
// HTTPレイヤーを対象とする — 各通知プラグイン自体の configured()/notify() の
// 詳細な挙動は notifiers/*.test.js が既に網羅しているため、ここでは再検証しない。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");

const notifiersRouter = require("./notifiers");

const app = express();
app.use(express.json());
app.use("/api/notifiers", notifiersRouter);

const ENV_KEYS = [
  "DISCORD_ENABLED", "DISCORD_WEBHOOK_URL",
  "SLACK_ENABLED", "SLACK_WEBHOOK_URL",
  "EMAIL_ENABLED", "EMAIL_SMTP_HOST", "EMAIL_TO",
  "WEBHOOK_ENABLED", "WEBHOOK_URL",
];
let savedEnv;
let originalFetch;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  originalFetch = global.fetch;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  global.fetch = originalFetch;
});

describe("GET /api/notifiers", () => {
  it("lists all four known notifiers with no leaked secrets", async () => {
    const res = await request(app).get("/api/notifiers");
    assert.equal(res.status, 200);
    const names = res.body.data.map((n) => n.name).sort();
    assert.deepEqual(names, ["discord", "email", "slack", "webhook"]);
    for (const entry of res.body.data) {
      assert.deepEqual(Object.keys(entry).sort(), ["configured", "name"]);
    }
  });

  it("reflects live env var state, not a load-time snapshot", async () => {
    const before = await request(app).get("/api/notifiers");
    assert.equal(before.body.data.find((n) => n.name === "discord").configured, false);

    process.env.DISCORD_ENABLED = "true";
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/x/y";

    const after = await request(app).get("/api/notifiers");
    assert.equal(after.body.data.find((n) => n.name === "discord").configured, true);
  });
});

describe("POST /api/notifiers/:name/test", () => {
  it("404s for an unknown notifier name", async () => {
    const res = await request(app).post("/api/notifiers/bogus/test");
    assert.equal(res.status, 404);
    assert.equal(res.body.status, "error");
  });

  it("400s for a known but unconfigured notifier", async () => {
    const res = await request(app).post("/api/notifiers/slack/test");
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not configured/);
  });

  it("sends a real test notification and returns 200 for a configured notifier", async () => {
    process.env.DISCORD_ENABLED = "true";
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/x/y";

    let captured;
    global.fetch = async (url, init) => {
      if (url === process.env.DISCORD_WEBHOOK_URL) {
        captured = { url, init };
        return { ok: true, status: 204 };
      }
      return originalFetch(url, init); // pass through: supertest's own request to the app
    };

    const res = await request(app).post("/api/notifiers/discord/test");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, "discord");
    assert.match(res.body.data.alert.message, /^\[TEST\]/);
    assert.ok(captured);
    assert.equal(captured.url, "https://discord.com/api/webhooks/x/y");
  });

  it("surfaces a downstream notifier failure as 502", async () => {
    process.env.DISCORD_ENABLED = "true";
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/x/y";

    global.fetch = async (url, init) => {
      if (url === process.env.DISCORD_WEBHOOK_URL) {
        return { ok: false, status: 500 };
      }
      return originalFetch(url, init);
    };

    const res = await request(app).post("/api/notifiers/discord/test");
    assert.equal(res.status, 502);
    assert.match(res.body.message, /responded with 500/);
  });
});
