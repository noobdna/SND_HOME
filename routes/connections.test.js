// routes/connections.test.js
// routes/connections.js の supertest 統合テスト。/api/connections/* の
// HTTPレイヤー(ルーティング・ステータスコード・envelope形状・クエリ
// パラメータの解釈)を対象とする -- リングバッファの追い出し等の細部は
// monitor/requestLogStore.test.js が既に網羅しているため、ここでは
// 再検証しない。
//
// requestLogStore は routes/events.test.js の eventLogStore と同じく、
// このファイル内の全テストで共有される、リセット不可能なシングルトンである。
// そのため「バッファ全体の絶対件数」ではなく、各テストが自分で record() した
// 一意な ip/path で絞り込んで検証する。GET /status のみ requestTracker
// (別モジュール、collectors/lanCollector.test.js と同じ monkey-patch 技法)を
// 差し替えて、既存の(実際のこのテストプロセス自体のin-flightリクエストに
// 影響されうる)activeCount に依存せず決定的に検証する。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");

const requestLogStore = require("../monitor/requestLogStore");
const requestTracker = require("../middleware/requestTracker");
const connectionsRouter = require("./connections");

const originalGetSnapshot = requestTracker.getSnapshot;

const app = express();
app.use("/api/connections", connectionsRouter);

afterEach(() => {
  requestTracker.getSnapshot = originalGetSnapshot;
});

function uniqueIp() {
  return `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
}

describe("GET /api/connections/status", () => {
  it("returns the bare status object (no envelope), reflecting requestTracker.getSnapshot()", async () => {
    requestTracker.getSnapshot = () => ({ activeCount: 2, totalRequests: 42, trackingSince: "2026-01-01T00:00:00.000Z" });

    const res = await request(app).get("/api/connections/status");
    assert.equal(res.status, 200);
    assert.equal(res.body.current, 2);
    assert.equal(res.body.totalRequestsServed, 42);
    assert.equal(res.body.trackingSince, "2026-01-01T00:00:00.000Z");
    assert.equal(typeof res.body.requestsLastMinute, "number");
  });
});

describe("GET /api/connections/sources", () => {
  it("returns the envelope shape { status, count, data }", async () => {
    const res = await request(app).get("/api/connections/sources");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.ok(Array.isArray(res.body.data));
  });

  it("aggregates requestCount/firstSeenAt/lastSeenAt per distinct IP", async () => {
    const ip = uniqueIp();
    requestLogStore.record({ method: "GET", path: "/api/system", ip, statusCode: 200, durationMs: 1, timestamp: "2026-01-01T00:00:00.000Z" });
    requestLogStore.record({ method: "GET", path: "/api/system", ip, statusCode: 200, durationMs: 1, timestamp: "2026-01-01T00:00:05.000Z" });

    const res = await request(app).get("/api/connections/sources?limit=500");
    const mine = res.body.data.find((s) => s.ip === ip);
    assert.equal(mine.requestCount, 2);
    assert.equal(mine.firstSeenAt, "2026-01-01T00:00:00.000Z");
    assert.equal(mine.lastSeenAt, "2026-01-01T00:00:05.000Z");
  });

  it("respects ?limit=", async () => {
    const res = await request(app).get("/api/connections/sources?limit=1");
    assert.ok(res.body.data.length <= 1);
  });
});

describe("GET /api/connections/log", () => {
  it("returns the envelope shape { status, count, data } and reflects a recorded entry", async () => {
    const path = `/api/unique-check-${Math.random().toString(36).slice(2)}`;
    requestLogStore.record({ method: "GET", path, ip: "127.0.0.1", statusCode: 200, durationMs: 3 });

    const res = await request(app).get("/api/connections/log?limit=500");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    const mine = res.body.data.find((e) => e.path === path);
    assert.ok(mine);
    assert.equal(mine.statusCode, 200);
  });

  it("defaults limit to 120 when not provided", async () => {
    for (let i = 0; i < 125; i++) {
      requestLogStore.record({ method: "GET", path: "/api/bulk", ip: "127.0.0.1", statusCode: 200, durationMs: 1 });
    }

    const res = await request(app).get("/api/connections/log");
    assert.equal(res.body.data.length, 120);
  });
});
