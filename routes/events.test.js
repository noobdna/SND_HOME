// routes/events.test.js
// routes/events.js の supertest 統合テスト。/api/events の HTTPレイヤー
// (ルーティング・ステータスコード・envelope形状・クエリパラメータの解釈)を
// 対象とする — リングバッファの追い出し等の細部は monitor/eventLogStore.test.js
// が既に網羅しているため、ここでは再検証しない。
//
// eventLogStore は routes/alerts.test.js の alertHistoryStore と同じく、
// このファイル内の全テストで共有される、リセット不可能なシングルトンである
// (clear() を持たない設計、alerts/alertHistoryStore.js と同じ)。そのため
// 「バッファ全体の絶対件数」ではなく、各テストが自分で record() した
// 一意な message で絞り込んで検証する(routes/alerts.test.js の
// GET /api/alerts/history テストが確立した規約と同じ)。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");

const eventLogStore = require("../monitor/eventLogStore");
const eventsRouter = require("./events");

const app = express();
app.use("/api/events", eventsRouter);

function uniqueMessage(label) {
  return `${label}-${Math.random().toString(36).slice(2)}`;
}

describe("GET /api/events", () => {
  it("returns the envelope shape { status, count, data }", async () => {
    const res = await request(app).get("/api/events");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(typeof res.body.count, "number");
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.count, res.body.data.length);
  });

  it("reflects a real recorded event", async () => {
    const message = uniqueMessage("basic");
    eventLogStore.record({ category: "monitor", severity: "info", message });

    const res = await request(app).get("/api/events?limit=500");
    const mine = res.body.data.filter((e) => e.message === message);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].category, "monitor");
    assert.equal(mine[0].severity, "info");
  });

  it("defaults limit to 100 when not provided", async () => {
    for (let i = 0; i < 105; i++) {
      eventLogStore.record({ category: "monitor", severity: "info", message: uniqueMessage("bulk") });
    }

    const res = await request(app).get("/api/events");
    assert.equal(res.body.data.length, 100);
  });

  it("respects ?limit=", async () => {
    const res = await request(app).get("/api/events?limit=3");
    assert.equal(res.body.data.length, 3);
    assert.equal(res.body.count, 3);
  });

  it("falls back to the default limit when ?limit= is not a positive number", async () => {
    const res = await request(app).get("/api/events?limit=notanumber");
    assert.equal(res.body.data.length, 100);
  });

  it("filters by ?severity= (comma-separated) -- this is how the errors/warnings view works", async () => {
    const infoMsg = uniqueMessage("severity-info");
    const warnMsg = uniqueMessage("severity-warn");
    const errMsg = uniqueMessage("severity-err");
    eventLogStore.record({ category: "monitor", severity: "info", message: infoMsg });
    eventLogStore.record({ category: "monitor", severity: "warning", message: warnMsg });
    eventLogStore.record({ category: "monitor", severity: "error", message: errMsg });

    const res = await request(app).get("/api/events?severity=warning,error&limit=500");
    const messages = res.body.data.map((e) => e.message);
    assert.ok(messages.includes(warnMsg));
    assert.ok(messages.includes(errMsg));
    assert.ok(!messages.includes(infoMsg));
  });

  it("filters by ?category= (comma-separated)", async () => {
    const authMsg = uniqueMessage("category-auth");
    const lanMsg = uniqueMessage("category-lan");
    eventLogStore.record({ category: "auth", severity: "info", message: authMsg });
    eventLogStore.record({ category: "lan", severity: "info", message: lanMsg });

    const res = await request(app).get("/api/events?category=auth&limit=500");
    const messages = res.body.data.map((e) => e.message);
    assert.ok(messages.includes(authMsg));
    assert.ok(!messages.includes(lanMsg));
  });

  it("silently ignores unknown severity/category values rather than 500ing", async () => {
    const res = await request(app).get("/api/events?severity=not-a-real-severity&category=not-a-real-category");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });

  it("meta defaults to {} and round-trips through the API when provided", async () => {
    const message = uniqueMessage("meta");
    eventLogStore.record({ category: "auth", severity: "warning", message, meta: { ip: "203.0.113.5", path: "/api/lan/devices" } });

    const res = await request(app).get("/api/events?limit=500");
    const mine = res.body.data.find((e) => e.message === message);
    assert.deepEqual(mine.meta, { ip: "203.0.113.5", path: "/api/lan/devices" });
  });
});
