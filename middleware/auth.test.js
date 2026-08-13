// middleware/auth.test.js
// middleware/auth.js の requireAuth 単体テスト。実際のルーターへの配線
// (POST/PUT/DELETE のみ対象、GET は対象外)の検証は
// routes/alerts.test.js・routes/notifiers.test.js の "auth (opt-in)" ブロックが
// 別途担う — ここでは requireAuth 単体の判定ロジックのみを対象にする。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");

const { requireAuth } = require("./auth");
const eventLogStore = require("../monitor/eventLogStore");

const app = express();
app.get("/protected", requireAuth, (req, res) => res.json({ status: "ok" }));

/**
 * eventLogStore は共有シングルトンでリセットできない(alerts/alertHistoryStore.js
 * と同じ規約)。このファイル内のテストは順番に実行される(node:test はファイル内
 * デフォルトで直列)ため、"category: auth" に絞った履歴の**末尾**が「直前の
 * リクエストで記録されたはずのイベント」だと仮定できる。
 */
function lastAuthEvent() {
  const history = eventLogStore.getHistory({ category: ["auth"] });
  return history[history.length - 1];
}

afterEach(() => {
  delete process.env.API_KEY;
});

describe("requireAuth", () => {
  it("passes through when API_KEY is not set (opt-in default: unauthenticated)", async () => {
    delete process.env.API_KEY;
    const res = await request(app).get("/protected");
    assert.equal(res.status, 200);
  });

  it("401s when API_KEY is set and no Authorization header is sent", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/protected");
    assert.equal(res.status, 401);
    assert.equal(res.body.status, "error");
  });

  it("401s when API_KEY is set and the token doesn't match", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/protected").set("Authorization", "Bearer wrong-token");
    assert.equal(res.status, 401);
  });

  it("401s when the scheme isn't Bearer, even with the right token value", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/protected").set("Authorization", "Basic secret-token");
    assert.equal(res.status, 401);
  });

  it("passes through when API_KEY is set and the Bearer token matches exactly", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/protected").set("Authorization", "Bearer secret-token");
    assert.equal(res.status, 200);
  });

  it("401s (not a 500) when the Authorization header is 'Bearer' with no token at all (regression: timing-safe compare must not throw on a missing token)", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/protected").set("Authorization", "Bearer");
    assert.equal(res.status, 401);
  });

  it("401s (not a 500) when the Bearer token is a different length than API_KEY (regression: timingSafeEqual throws on length mismatch)", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/protected").set("Authorization", "Bearer short");
    assert.equal(res.status, 401);
  });
});

describe("requireAuth -- eventLogStore integration", () => {
  it("does not record any auth event when API_KEY is unset (pass-through, no check performed)", async () => {
    delete process.env.API_KEY;
    const before = eventLogStore.getHistory({ category: ["auth"] }).length;

    await request(app).get("/protected");

    assert.equal(eventLogStore.getHistory({ category: ["auth"] }).length, before);
  });

  it("records a warning event on auth failure", async () => {
    process.env.API_KEY = "secret-token";
    await request(app).get("/protected").set("Authorization", "Bearer wrong-token");

    const entry = lastAuthEvent();
    assert.equal(entry.category, "auth");
    assert.equal(entry.severity, "warning");
    assert.equal(entry.message, "Authentication failed");
    assert.equal(entry.meta.path, "/protected");
    assert.equal(entry.meta.method, "GET");
  });

  it("records an info event on auth success", async () => {
    process.env.API_KEY = "secret-token";
    await request(app).get("/protected").set("Authorization", "Bearer secret-token");

    const entry = lastAuthEvent();
    assert.equal(entry.category, "auth");
    assert.equal(entry.severity, "info");
    assert.equal(entry.message, "Authenticated request");
    assert.equal(entry.meta.path, "/protected");
    assert.equal(entry.meta.method, "GET");
  });

  it("CRITICAL: never records the raw token or API_KEY value, on either success or failure", async () => {
    process.env.API_KEY = "super-secret-value-12345";

    await request(app).get("/protected").set("Authorization", "Bearer super-secret-value-12345"); // success
    const successEntry = lastAuthEvent();
    assert.ok(!JSON.stringify(successEntry).includes("super-secret-value-12345"));

    await request(app).get("/protected").set("Authorization", "Bearer wrong-guess-98765"); // failure
    const failureEntry = lastAuthEvent();
    assert.ok(!JSON.stringify(failureEntry).includes("super-secret-value-12345"));
    assert.ok(!JSON.stringify(failureEntry).includes("wrong-guess-98765"));
  });
});
