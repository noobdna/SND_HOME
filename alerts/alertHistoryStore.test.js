// alerts/alertHistoryStore.test.js
// monitor/historyStore.test.js と同じ規約: 実運用の共有シングルトン(500件・
// record/getHistory/getMaxEntries)ではなく、エクスポートされた AlertHistoryStore
// クラスを直接インスタンス化して小さい maxEntries で境界条件(リングバッファの
// 追い出し)を検証する。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { AlertHistoryStore, record, getHistory, getMaxEntries } = require("./alertHistoryStore");

function sampleAlert(overrides = {}) {
  return {
    alertId: "disk-root-critical:2026-01-01T00:00:00.000Z",
    ruleId: "disk-root-critical",
    ruleName: "Root disk usage critical",
    metric: "disk.percent",
    value: 95,
    operator: ">=",
    threshold: 90,
    severity: "critical",
    state: "FIRING",
    previousState: "OK",
    message: "Root disk usage critical is FIRING: disk.percent = 95 (threshold >= 90)",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AlertHistoryStore (fresh instance per test)", () => {
  describe("record()", () => {
    it("stores the alert object as-is, with no transformation", () => {
      const store = new AlertHistoryStore();
      const alert = sampleAlert();
      store.record(alert);
      assert.deepEqual(store.getHistory(), [alert]);
    });

    it("appends in call order", () => {
      const store = new AlertHistoryStore();
      store.record(sampleAlert({ alertId: "a1" }));
      store.record(sampleAlert({ alertId: "a2" }));
      store.record(sampleAlert({ alertId: "a3" }));

      assert.deepEqual(
        store.getHistory().map((e) => e.alertId),
        ["a1", "a2", "a3"]
      );
    });
  });

  describe("ring-buffer eviction (maxEntries)", () => {
    it("evicts the oldest entry once maxEntries is exceeded", () => {
      const store = new AlertHistoryStore(3);
      store.record(sampleAlert({ alertId: "a1" }));
      store.record(sampleAlert({ alertId: "a2" }));
      store.record(sampleAlert({ alertId: "a3" }));
      store.record(sampleAlert({ alertId: "a4" })); // a1 should be evicted

      assert.deepEqual(
        store.getHistory().map((e) => e.alertId),
        ["a2", "a3", "a4"]
      );
    });

    it("never holds more than maxEntries entries even after many more records", () => {
      const store = new AlertHistoryStore(3);
      for (let i = 0; i < 10; i++) {
        store.record(sampleAlert({ alertId: `a${i}` }));
      }

      assert.equal(store.getHistory().length, 3);
      assert.deepEqual(
        store.getHistory().map((e) => e.alertId),
        ["a7", "a8", "a9"]
      );
    });

    it("defaults to 500 entries when constructed with no argument", () => {
      const store = new AlertHistoryStore();
      assert.equal(store.maxEntries, 500);
    });
  });

  describe("getHistory({ limit })", () => {
    it("returns every entry when limit is omitted", () => {
      const store = new AlertHistoryStore();
      store.record(sampleAlert({ alertId: "a1" }));
      store.record(sampleAlert({ alertId: "a2" }));

      assert.equal(store.getHistory().length, 2);
    });

    it("returns every entry when limit is 0 (falsy -- treated the same as omitted)", () => {
      const store = new AlertHistoryStore();
      store.record(sampleAlert({ alertId: "a1" }));
      store.record(sampleAlert({ alertId: "a2" }));

      assert.equal(store.getHistory({ limit: 0 }).length, 2);
    });

    it("returns every entry when limit is >= the number of entries", () => {
      const store = new AlertHistoryStore();
      store.record(sampleAlert({ alertId: "a1" }));
      store.record(sampleAlert({ alertId: "a2" }));

      assert.equal(store.getHistory({ limit: 100 }).length, 2);
    });

    it("returns only the most recent `limit` entries, oldest-to-newest, when limit < entries.length", () => {
      const store = new AlertHistoryStore();
      for (let i = 0; i < 5; i++) {
        store.record(sampleAlert({ alertId: `a${i}` }));
      }

      assert.deepEqual(
        store.getHistory({ limit: 2 }).map((e) => e.alertId),
        ["a3", "a4"]
      );
    });

    it("returns an empty array when nothing has been recorded yet", () => {
      const store = new AlertHistoryStore();
      assert.deepEqual(store.getHistory(), []);
      assert.deepEqual(store.getHistory({ limit: 5 }), []);
    });
  });

  describe("encapsulation", () => {
    it("getHistory() returns a fresh array each call -- mutating the result does not affect internal state", () => {
      const store = new AlertHistoryStore();
      store.record(sampleAlert({ alertId: "a1" }));

      const result = store.getHistory();
      result.push(sampleAlert({ alertId: "should-not-appear" }));

      assert.equal(store.getHistory().length, 1);
    });

    it("two independent instances do not share entries", () => {
      const storeA = new AlertHistoryStore();
      const storeB = new AlertHistoryStore();
      storeA.record(sampleAlert({ alertId: "only-in-a" }));

      assert.equal(storeA.getHistory().length, 1);
      assert.equal(storeB.getHistory().length, 0);
    });
  });
});

describe("module-level singleton wiring (record/getHistory/getMaxEntries)", () => {
  it("the exported functions delegate to the same underlying shared store", () => {
    const before = getHistory().length;
    record(sampleAlert({ alertId: "singleton-check" }));
    const after = getHistory();

    assert.equal(after.length, before + 1);
    assert.equal(after[after.length - 1].alertId, "singleton-check");
  });

  it("getMaxEntries() reflects the shared store's default (500)", () => {
    assert.equal(getMaxEntries(), 500);
  });
});
