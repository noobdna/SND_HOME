// collectors/connectionsCollector.test.js
// collectors/lanCollector.test.js と同じ技法: requestTracker.getSnapshot() /
// requestLogStore.getRequestsSince() を monkey-patch して、実タイマー/実HTTP
// リクエストなしで検証する。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const requestTracker = require("../middleware/requestTracker");
const requestLogStore = require("../monitor/requestLogStore");
const connectionsCollector = require("./connectionsCollector");

const originalGetSnapshot = requestTracker.getSnapshot;
const originalGetRequestsSince = requestLogStore.getRequestsSince;

afterEach(() => {
  requestTracker.getSnapshot = originalGetSnapshot;
  requestLogStore.getRequestsSince = originalGetRequestsSince;
});

describe("connectionsCollector", () => {
  it("declares the expected {name, collect()} shape", () => {
    assert.equal(connectionsCollector.name, "connections");
    assert.equal(typeof connectionsCollector.collect, "function");
  });

  it("gracefully degrades to all-zero when nothing has been tracked yet", async () => {
    requestTracker.getSnapshot = () => ({ activeCount: 0, totalRequests: 0, trackingSince: "2026-01-01T00:00:00.000Z" });
    requestLogStore.getRequestsSince = () => [];

    const result = await connectionsCollector.collect();
    assert.deepEqual(result, { current: 0, requestsLastMinute: 0, totalRequestsServed: 0 });
  });

  it("reports the tracker's current in-flight count and lifetime total", async () => {
    requestTracker.getSnapshot = () => ({ activeCount: 3, totalRequests: 500, trackingSince: "2026-01-01T00:00:00.000Z" });
    requestLogStore.getRequestsSince = () => [];

    const result = await connectionsCollector.collect();
    assert.equal(result.current, 3);
    assert.equal(result.totalRequestsServed, 500);
  });

  it("reports requestsLastMinute as the count of entries requestLogStore.getRequestsSince(60000) returns", async () => {
    requestTracker.getSnapshot = () => ({ activeCount: 0, totalRequests: 0, trackingSince: "2026-01-01T00:00:00.000Z" });
    let calledWithMs;
    requestLogStore.getRequestsSince = (ms) => {
      calledWithMs = ms;
      return [{}, {}, {}];
    };

    const result = await connectionsCollector.collect();
    assert.equal(result.requestsLastMinute, 3);
    assert.equal(calledWithMs, 60_000);
  });
});
