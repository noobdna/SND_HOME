// monitor/historyStore.test.js
// historyStore.js は元々このプロジェクトの監視レイヤー全体と同じく、node:test
// 導入前(Phase 5より前)に書かれたためテストが無かった。
// 実運用の共有シングルトン(720件・record/getHistory/getMaxPoints)ではなく、
// エクスポートされた HistoryStore クラスを直接インスタンス化して小さい
// maxPoints で境界条件(リングバッファの追い出し)を検証する --
// lan/lanEngine.js の LanEngine エクスポートと同じ理由・同じ規約。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { HistoryStore, record, getHistory, getMaxPoints } = require("./historyStore");

function fullSnapshot(overrides = {}) {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    cpu: { usage: 10 },
    memory: { percent: 20 },
    disk: { percent: 30 },
    network: { rxBytes: 100, txBytes: 200 },
    ...overrides,
  };
}

describe("HistoryStore (fresh instance per test)", () => {
  describe("record() / extractMetrics()", () => {
    it("extracts only the tracked numeric metrics, dropping everything else (e.g. interfaces list)", () => {
      const store = new HistoryStore();
      store.record({
        timestamp: "2026-01-01T00:00:00.000Z",
        status: "ok",
        hostname: "test-host",
        cpu: { usage: 12.3, cores: 8 },
        memory: { used: 1, total: 2, percent: 50 },
        disk: { used: 1, total: 2, percent: 25 },
        network: { interfaces: [{ name: "en0" }], localIp: "1.2.3.4", rxBytes: 111, txBytes: 222 },
        load: [1, 1, 1],
      });

      assert.deepEqual(store.getHistory(), [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          cpu: { usage: 12.3 },
          memory: { percent: 50 },
          disk: { percent: 25 },
          network: { rxBytes: 111, txBytes: 222 },
        },
      ]);
    });

    it("substitutes null for cpu/memory/disk/network when the sub-object is missing (graceful degradation)", () => {
      const store = new HistoryStore();
      store.record({ timestamp: "2026-01-01T00:00:00.000Z" });

      assert.deepEqual(store.getHistory(), [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          cpu: { usage: null },
          memory: { percent: null },
          disk: { percent: null },
          network: { rxBytes: null, txBytes: null },
        },
      ]);
    });

    it("appends in call order", () => {
      const store = new HistoryStore();
      store.record(fullSnapshot({ timestamp: "t1" }));
      store.record(fullSnapshot({ timestamp: "t2" }));
      store.record(fullSnapshot({ timestamp: "t3" }));

      assert.deepEqual(
        store.getHistory().map((e) => e.timestamp),
        ["t1", "t2", "t3"],
      );
    });
  });

  describe("ring-buffer eviction (maxPoints)", () => {
    it("evicts the oldest entry once maxPoints is exceeded", () => {
      const store = new HistoryStore(3);
      store.record(fullSnapshot({ timestamp: "t1" }));
      store.record(fullSnapshot({ timestamp: "t2" }));
      store.record(fullSnapshot({ timestamp: "t3" }));
      store.record(fullSnapshot({ timestamp: "t4" })); // t1 should be evicted

      assert.deepEqual(
        store.getHistory().map((e) => e.timestamp),
        ["t2", "t3", "t4"],
      );
    });

    it("never holds more than maxPoints entries even after many more records", () => {
      const store = new HistoryStore(3);
      for (let i = 0; i < 10; i++) {
        store.record(fullSnapshot({ timestamp: `t${i}` }));
      }

      assert.equal(store.getHistory().length, 3);
      assert.deepEqual(
        store.getHistory().map((e) => e.timestamp),
        ["t7", "t8", "t9"],
      );
    });

    it("defaults to 720 points when constructed with no argument", () => {
      const store = new HistoryStore();
      assert.equal(store.maxPoints, 720);
    });
  });

  describe("getHistory({ limit })", () => {
    it("returns every entry when limit is omitted", () => {
      const store = new HistoryStore();
      store.record(fullSnapshot({ timestamp: "t1" }));
      store.record(fullSnapshot({ timestamp: "t2" }));

      assert.equal(store.getHistory().length, 2);
    });

    it("returns every entry when limit is 0 (falsy -- treated the same as omitted)", () => {
      const store = new HistoryStore();
      store.record(fullSnapshot({ timestamp: "t1" }));
      store.record(fullSnapshot({ timestamp: "t2" }));

      assert.equal(store.getHistory({ limit: 0 }).length, 2);
    });

    it("returns every entry when limit is >= the number of entries", () => {
      const store = new HistoryStore();
      store.record(fullSnapshot({ timestamp: "t1" }));
      store.record(fullSnapshot({ timestamp: "t2" }));

      assert.equal(store.getHistory({ limit: 100 }).length, 2);
    });

    it("returns only the most recent `limit` entries, oldest-to-newest, when limit < entries.length", () => {
      const store = new HistoryStore();
      for (let i = 0; i < 5; i++) {
        store.record(fullSnapshot({ timestamp: `t${i}` }));
      }

      assert.deepEqual(
        store.getHistory({ limit: 2 }).map((e) => e.timestamp),
        ["t3", "t4"],
      );
    });

    it("returns an empty array when nothing has been recorded yet", () => {
      const store = new HistoryStore();
      assert.deepEqual(store.getHistory(), []);
      assert.deepEqual(store.getHistory({ limit: 5 }), []);
    });
  });

  describe("encapsulation", () => {
    it("getHistory() returns a fresh array each call -- mutating the result does not affect internal state", () => {
      const store = new HistoryStore();
      store.record(fullSnapshot({ timestamp: "t1" }));

      const result = store.getHistory();
      result.push(fullSnapshot({ timestamp: "should-not-appear" }));

      assert.equal(store.getHistory().length, 1);
    });

    it("two independent instances do not share entries", () => {
      const storeA = new HistoryStore();
      const storeB = new HistoryStore();
      storeA.record(fullSnapshot({ timestamp: "only-in-a" }));

      assert.equal(storeA.getHistory().length, 1);
      assert.equal(storeB.getHistory().length, 0);
    });
  });
});

describe("module-level singleton wiring (record/getHistory/getMaxPoints)", () => {
  it("the exported functions delegate to the same underlying shared store", () => {
    const before = getHistory().length;
    record(fullSnapshot({ timestamp: "singleton-check" }));
    const after = getHistory();

    assert.equal(after.length, before + 1);
    assert.equal(after[after.length - 1].timestamp, "singleton-check");
  });

  it("getMaxPoints() reflects the shared store's default (720)", () => {
    assert.equal(getMaxPoints(), 720);
  });
});
