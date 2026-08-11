// routes/monitor.test.js
// routes/monitor.js の supertest 統合テスト。routes/system.test.js と同じ手法:
// monitorEngine.getStatus を monkey-patch し、実タイマーには一切触れない。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");

const monitorEngine = require("../monitor/monitorEngine");
const monitorRoutes = require("./monitor");

const app = express();
app.use("/api/monitor", monitorRoutes);

const originalGetStatus = monitorEngine.getStatus;

afterEach(() => {
  monitorEngine.getStatus = originalGetStatus;
});

describe("GET /api/monitor/status", () => {
  it("returns monitorEngine.getStatus()'s value directly, without an envelope", async () => {
    const status = { running: true, interval: 5000, lastUpdated: "2026-01-01T00:00:00.000Z", uptime: 42 };
    monitorEngine.getStatus = () => status;

    const res = await request(app).get("/api/monitor/status");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, status);
  });

  it("returns a 500 error envelope when getStatus() throws", async () => {
    monitorEngine.getStatus = () => {
      throw new Error("engine unavailable");
    };

    const res = await request(app).get("/api/monitor/status");
    assert.equal(res.status, 500);
    assert.equal(res.body.status, "error");
    assert.match(res.body.message, /engine unavailable/);
  });

  it("404s on an unmounted sub-path", async () => {
    const res = await request(app).get("/api/monitor/nope");
    assert.equal(res.status, 404);
  });
});
