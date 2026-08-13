// monitor/requestLogStore.test.js
// monitor/eventLogStore.test.js と同じ規約: 実運用の共有シングルトン(2000件)
// ではなく、エクスポートされた RequestLogStore クラスを直接インスタンス化して
// 小さい maxEntries で境界条件(リングバッファの追い出し)を検証する。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { RequestLogStore, record, getHistory, getRequestsSince, getMaxEntries } = require("./requestLogStore");

function entry(overrides = {}) {
  return {
    method: "GET",
    path: "/api/system",
    ip: "127.0.0.1",
    statusCode: 200,
    durationMs: 5,
    ...overrides,
  };
}

describe("RequestLogStore (fresh instance per test)", () => {
  describe("record()", () => {
    it("stores method/path/ip/statusCode/durationMs as given", () => {
      const store = new RequestLogStore();
      store.record(entry({ method: "POST", path: "/api/alerts/rules", ip: "10.0.0.5", statusCode: 201, durationMs: 12.5 }));

      const [logged] = store.getHistory();
      assert.equal(logged.method, "POST");
      assert.equal(logged.path, "/api/alerts/rules");
      assert.equal(logged.ip, "10.0.0.5");
      assert.equal(logged.statusCode, 201);
      assert.equal(logged.durationMs, 12.5);
    });

    it("defaults timestamp to the current time when not provided", () => {
      const store = new RequestLogStore();
      const before = new Date();
      store.record(entry());
      const after = new Date();

      const recorded = new Date(store.getHistory()[0].timestamp);
      assert.ok(recorded >= before && recorded <= after);
    });

    it("appends in call order", () => {
      const store = new RequestLogStore();
      store.record(entry({ path: "/1" }));
      store.record(entry({ path: "/2" }));
      store.record(entry({ path: "/3" }));

      assert.deepEqual(
        store.getHistory().map((e) => e.path),
        ["/1", "/2", "/3"],
      );
    });
  });

  describe("ring-buffer eviction (maxEntries)", () => {
    it("evicts the oldest entry once maxEntries is exceeded", () => {
      const store = new RequestLogStore(3);
      store.record(entry({ path: "/1" }));
      store.record(entry({ path: "/2" }));
      store.record(entry({ path: "/3" }));
      store.record(entry({ path: "/4" })); // /1 should be evicted

      assert.deepEqual(
        store.getHistory().map((e) => e.path),
        ["/2", "/3", "/4"],
      );
    });

    it("defaults to 2000 entries when constructed with no argument", () => {
      const store = new RequestLogStore();
      assert.equal(store.maxEntries, 2000);
    });
  });

  describe("getHistory({ limit })", () => {
    it("returns only the most recent `limit` entries, oldest-to-newest, when limit < entries.length", () => {
      const store = new RequestLogStore();
      for (let i = 0; i < 5; i++) {
        store.record(entry({ path: `/${i}` }));
      }

      assert.deepEqual(
        store.getHistory({ limit: 2 }).map((e) => e.path),
        ["/3", "/4"],
      );
    });

    it("returns an empty array when nothing has been recorded yet", () => {
      const store = new RequestLogStore();
      assert.deepEqual(store.getHistory(), []);
    });
  });

  describe("getRequestsSince(windowMs, now)", () => {
    it("includes only entries within the trailing window", () => {
      const store = new RequestLogStore();
      const now = new Date("2026-01-01T00:01:00.000Z").getTime();

      store.record(entry({ path: "/too-old", timestamp: "2026-01-01T00:00:00.000Z" })); // 60s before now -- exactly at the boundary
      store.record(entry({ path: "/inside", timestamp: "2026-01-01T00:00:30.000Z" })); // 30s before now
      store.record(entry({ path: "/right-now", timestamp: "2026-01-01T00:01:00.000Z" })); // exactly now

      const recent = store.getRequestsSince(30_000, now); // 30s window
      assert.deepEqual(
        recent.map((e) => e.path),
        ["/inside", "/right-now"],
      );
    });

    it("returns an empty array when nothing falls within the window", () => {
      const store = new RequestLogStore();
      const now = new Date("2026-01-01T00:10:00.000Z").getTime();
      store.record(entry({ timestamp: "2026-01-01T00:00:00.000Z" }));

      assert.deepEqual(store.getRequestsSince(60_000, now), []);
    });

    it("defaults `now` to the real current time when not provided", () => {
      const store = new RequestLogStore();
      store.record(entry());

      assert.equal(store.getRequestsSince(60_000).length, 1);
    });
  });

  describe("encapsulation", () => {
    it("getHistory() returns a fresh array each call -- mutating the result does not affect internal state", () => {
      const store = new RequestLogStore();
      store.record(entry());

      const result = store.getHistory();
      result.push(entry({ path: "/should-not-appear" }));

      assert.equal(store.getHistory().length, 1);
    });

    it("two independent instances do not share entries", () => {
      const storeA = new RequestLogStore();
      const storeB = new RequestLogStore();
      storeA.record(entry({ path: "/only-in-a" }));

      assert.equal(storeA.getHistory().length, 1);
      assert.equal(storeB.getHistory().length, 0);
    });
  });
});

describe("module-level singleton wiring (record/getHistory/getRequestsSince/getMaxEntries)", () => {
  it("the exported functions delegate to the same underlying shared store", () => {
    const before = getHistory().length;
    record(entry({ path: "/singleton-check" }));
    const after = getHistory();

    assert.equal(after.length, before + 1);
    assert.equal(after[after.length - 1].path, "/singleton-check");
  });

  it("getMaxEntries() reflects the shared store's default (2000)", () => {
    assert.equal(getMaxEntries(), 2000);
  });
});
