// monitor/eventLogStore.test.js
// monitor/historyStore.test.js と同じ規約: 実運用の共有シングルトン(500件)
// ではなく、エクスポートされた EventLogStore クラスを直接インスタンス化して
// 小さい maxEntries で境界条件(リングバッファの追い出し)を検証する。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { EventLogStore, record, getHistory, getMaxEntries } = require("./eventLogStore");

function event(overrides = {}) {
  return {
    category: "monitor",
    severity: "info",
    message: "test event",
    meta: {},
    ...overrides,
  };
}

describe("EventLogStore (fresh instance per test)", () => {
  describe("record()", () => {
    it("stores category/severity/message/meta as given", () => {
      const store = new EventLogStore();
      store.record(event({ category: "auth", severity: "warning", message: "Authentication failed", meta: { ip: "1.2.3.4" } }));

      const [entry] = store.getHistory();
      assert.equal(entry.category, "auth");
      assert.equal(entry.severity, "warning");
      assert.equal(entry.message, "Authentication failed");
      assert.deepEqual(entry.meta, { ip: "1.2.3.4" });
    });

    it("uses the given timestamp when provided", () => {
      const store = new EventLogStore();
      store.record(event({ timestamp: "2026-01-01T00:00:00.000Z" }));

      assert.equal(store.getHistory()[0].timestamp, "2026-01-01T00:00:00.000Z");
    });

    it("defaults timestamp to the current time when not provided", () => {
      const store = new EventLogStore();
      const before = new Date();
      store.record(event());
      const after = new Date();

      const recorded = new Date(store.getHistory()[0].timestamp);
      assert.ok(recorded >= before && recorded <= after);
    });

    it("defaults meta to an empty object when not provided", () => {
      const store = new EventLogStore();
      store.record({ category: "monitor", severity: "info", message: "no meta given" });

      assert.deepEqual(store.getHistory()[0].meta, {});
    });

    it("appends in call order", () => {
      const store = new EventLogStore();
      store.record(event({ message: "e1" }));
      store.record(event({ message: "e2" }));
      store.record(event({ message: "e3" }));

      assert.deepEqual(
        store.getHistory().map((e) => e.message),
        ["e1", "e2", "e3"],
      );
    });
  });

  describe("ring-buffer eviction (maxEntries)", () => {
    it("evicts the oldest entry once maxEntries is exceeded", () => {
      const store = new EventLogStore(3);
      store.record(event({ message: "e1" }));
      store.record(event({ message: "e2" }));
      store.record(event({ message: "e3" }));
      store.record(event({ message: "e4" })); // e1 should be evicted

      assert.deepEqual(
        store.getHistory().map((e) => e.message),
        ["e2", "e3", "e4"],
      );
    });

    it("never holds more than maxEntries entries even after many more records", () => {
      const store = new EventLogStore(3);
      for (let i = 0; i < 10; i++) {
        store.record(event({ message: `e${i}` }));
      }

      assert.equal(store.getHistory().length, 3);
      assert.deepEqual(
        store.getHistory().map((e) => e.message),
        ["e7", "e8", "e9"],
      );
    });

    it("defaults to 500 entries when constructed with no argument", () => {
      const store = new EventLogStore();
      assert.equal(store.maxEntries, 500);
    });
  });

  describe("getHistory({ limit })", () => {
    it("returns every entry when limit is omitted", () => {
      const store = new EventLogStore();
      store.record(event({ message: "e1" }));
      store.record(event({ message: "e2" }));

      assert.equal(store.getHistory().length, 2);
    });

    it("returns only the most recent `limit` entries, oldest-to-newest, when limit < entries.length", () => {
      const store = new EventLogStore();
      for (let i = 0; i < 5; i++) {
        store.record(event({ message: `e${i}` }));
      }

      assert.deepEqual(
        store.getHistory({ limit: 2 }).map((e) => e.message),
        ["e3", "e4"],
      );
    });

    it("returns an empty array when nothing has been recorded yet", () => {
      const store = new EventLogStore();
      assert.deepEqual(store.getHistory(), []);
    });
  });

  describe("getHistory({ severity, category }) filtering", () => {
    it("filters by severity", () => {
      const store = new EventLogStore();
      store.record(event({ message: "info-1", severity: "info" }));
      store.record(event({ message: "warn-1", severity: "warning" }));
      store.record(event({ message: "err-1", severity: "error" }));

      assert.deepEqual(
        store.getHistory({ severity: ["warning", "error"] }).map((e) => e.message),
        ["warn-1", "err-1"],
      );
    });

    it("filters by category", () => {
      const store = new EventLogStore();
      store.record(event({ message: "auth-1", category: "auth" }));
      store.record(event({ message: "lan-1", category: "lan" }));

      assert.deepEqual(
        store.getHistory({ category: ["auth"] }).map((e) => e.message),
        ["auth-1"],
      );
    });

    it("combines severity and category filters (AND, not OR)", () => {
      const store = new EventLogStore();
      store.record(event({ message: "match", category: "auth", severity: "warning" }));
      store.record(event({ message: "wrong-severity", category: "auth", severity: "info" }));
      store.record(event({ message: "wrong-category", category: "lan", severity: "warning" }));

      assert.deepEqual(
        store.getHistory({ category: ["auth"], severity: ["warning"] }).map((e) => e.message),
        ["match"],
      );
    });

    it("applies limit after filtering, not before", () => {
      const store = new EventLogStore();
      store.record(event({ message: "keep-1", severity: "error" }));
      store.record(event({ message: "drop", severity: "info" }));
      store.record(event({ message: "keep-2", severity: "error" }));
      store.record(event({ message: "keep-3", severity: "error" }));

      assert.deepEqual(
        store.getHistory({ severity: ["error"], limit: 2 }).map((e) => e.message),
        ["keep-2", "keep-3"],
      );
    });

    it("ignores empty filter arrays (treated the same as omitted)", () => {
      const store = new EventLogStore();
      store.record(event({ message: "e1" }));

      assert.equal(store.getHistory({ severity: [], category: [] }).length, 1);
    });
  });

  describe("encapsulation", () => {
    it("getHistory() returns a fresh array each call -- mutating the result does not affect internal state", () => {
      const store = new EventLogStore();
      store.record(event({ message: "e1" }));

      const result = store.getHistory();
      result.push(event({ message: "should-not-appear" }));

      assert.equal(store.getHistory().length, 1);
    });

    it("two independent instances do not share entries", () => {
      const storeA = new EventLogStore();
      const storeB = new EventLogStore();
      storeA.record(event({ message: "only-in-a" }));

      assert.equal(storeA.getHistory().length, 1);
      assert.equal(storeB.getHistory().length, 0);
    });
  });
});

describe("module-level singleton wiring (record/getHistory/getMaxEntries)", () => {
  it("the exported functions delegate to the same underlying shared store", () => {
    const before = getHistory().length;
    record(event({ message: "singleton-check" }));
    const after = getHistory();

    assert.equal(after.length, before + 1);
    assert.equal(after[after.length - 1].message, "singleton-check");
  });

  it("getMaxEntries() reflects the shared store's default (500)", () => {
    assert.equal(getMaxEntries(), 500);
  });
});
