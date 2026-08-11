// routes/system.test.js
// routes/system.js の supertest 統合テスト。routes/lan.test.js・routes/alerts.test.js
// と同じ手法: monitorEngine/collectorRegistry の各メソッドを monkey-patch し、
// 実Collector(実コマンド・実タイマー)には一切触れない。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");

const monitorEngine = require("../monitor/monitorEngine");
const collectorRegistry = require("../monitor/collectorRegistry");
const systemRoutes = require("./system");

const app = express();
app.use("/api", systemRoutes);

const original = {
  getLatestSystemInfo: monitorEngine.getLatestSystemInfo,
  getStatus: monitorEngine.getStatus,
  getHistory: monitorEngine.getHistory,
  collectAll: collectorRegistry.collectAll,
};

afterEach(() => {
  monitorEngine.getLatestSystemInfo = original.getLatestSystemInfo;
  monitorEngine.getStatus = original.getStatus;
  monitorEngine.getHistory = original.getHistory;
  collectorRegistry.collectAll = original.collectAll;
});

function fakeSnapshot(overrides = {}) {
  return { status: "ok", hostname: "test-host", cpu: { usage: 10 }, ...overrides };
}

describe("GET /api/system", () => {
  it("returns the monitorEngine cache when one exists, without calling collectAll()", async () => {
    const cached = fakeSnapshot({ hostname: "cached-host" });
    monitorEngine.getLatestSystemInfo = () => cached;
    collectorRegistry.collectAll = () => {
      throw new Error("collectAll should not be called when a cache exists");
    };

    const res = await request(app).get("/api/system");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, cached);
  });

  it("falls back to a fresh collectAll() when the cache is empty (e.g. right after startup)", async () => {
    monitorEngine.getLatestSystemInfo = () => null;
    const fresh = fakeSnapshot({ hostname: "fresh-host" });
    collectorRegistry.collectAll = async () => fresh;

    const res = await request(app).get("/api/system");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, fresh);
  });

  it("returns a 500 error envelope when collection fails", async () => {
    monitorEngine.getLatestSystemInfo = () => null;
    collectorRegistry.collectAll = async () => {
      throw new Error("df not found");
    };

    const res = await request(app).get("/api/system");
    assert.equal(res.status, 500);
    assert.equal(res.body.status, "error");
    assert.match(res.body.message, /df not found/);
  });
});

describe("GET /api/health", () => {
  it("always returns 200 { status: ok }", async () => {
    const res = await request(app).get("/api/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });
});

describe("GET /api/system/latest", () => {
  it("returns the cache directly without ever calling collectAll()", async () => {
    const cached = fakeSnapshot();
    monitorEngine.getLatestSystemInfo = () => cached;
    collectorRegistry.collectAll = () => {
      throw new Error("should never be called by /system/latest");
    };

    const res = await request(app).get("/api/system/latest");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, cached);
  });

  it("returns 503 when nothing has been collected yet", async () => {
    monitorEngine.getLatestSystemInfo = () => null;

    const res = await request(app).get("/api/system/latest");
    assert.equal(res.status, 503);
    assert.equal(res.body.status, "error");
  });

  it("returns a 500 error envelope if getLatestSystemInfo() itself throws", async () => {
    monitorEngine.getLatestSystemInfo = () => {
      throw new Error("boom");
    };

    const res = await request(app).get("/api/system/latest");
    assert.equal(res.status, 500);
    assert.equal(res.body.status, "error");
    assert.match(res.body.message, /boom/);
  });
});

describe("GET /api/system/history", () => {
  function fakeHistory(limitReceived) {
    monitorEngine.getHistory = ({ limit } = {}) => {
      limitReceived.value = limit;
      return [{ timestamp: "t1" }, { timestamp: "t2" }];
    };
    monitorEngine.getStatus = () => ({ interval: 5000 });
  }

  it("defaults to limit=120 when ?limit is omitted", async () => {
    const limitReceived = {};
    fakeHistory(limitReceived);

    const res = await request(app).get("/api/system/history");
    assert.equal(res.status, 200);
    assert.equal(limitReceived.value, 120);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.count, 2);
    assert.equal(res.body.interval, 5000);
    assert.deepEqual(res.body.data, [{ timestamp: "t1" }, { timestamp: "t2" }]);
  });

  it("passes a valid positive ?limit through as a number", async () => {
    const limitReceived = {};
    fakeHistory(limitReceived);

    await request(app).get("/api/system/history?limit=50");
    assert.equal(limitReceived.value, 50);
  });

  it("falls back to 120 when ?limit is 0 (not a positive number)", async () => {
    const limitReceived = {};
    fakeHistory(limitReceived);

    await request(app).get("/api/system/history?limit=0");
    assert.equal(limitReceived.value, 120);
  });

  it("falls back to 120 when ?limit is negative", async () => {
    const limitReceived = {};
    fakeHistory(limitReceived);

    await request(app).get("/api/system/history?limit=-5");
    assert.equal(limitReceived.value, 120);
  });

  it("falls back to 120 when ?limit is not a number", async () => {
    const limitReceived = {};
    fakeHistory(limitReceived);

    await request(app).get("/api/system/history?limit=abc");
    assert.equal(limitReceived.value, 120);
  });

  it("returns a 500 error envelope when getHistory() throws", async () => {
    monitorEngine.getHistory = () => {
      throw new Error("history unavailable");
    };

    const res = await request(app).get("/api/system/history");
    assert.equal(res.status, 500);
    assert.equal(res.body.status, "error");
    assert.match(res.body.message, /history unavailable/);
  });
});
