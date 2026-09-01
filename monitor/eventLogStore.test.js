// monitor/eventLogStore.test.js
// monitor/historyStore.test.js と同じ規約: 実運用の共有シングルトン(500件)
// ではなく、エクスポートされた EventLogStore クラスを直接インスタンス化して
// 小さい maxEntries で境界条件(リングバッファの追い出し)を検証する。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  EventLogStore,
  record,
  getHistory,
  getMaxEntries,
  getEventLogPath,
  getArchive,
  getArchiveMaxEntries,
  getRetentionDays,
  archiveExpiredEntries,
  getEventLogArchivePath,
  persist,
  load,
} = require("./eventLogStore");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventlogstore-test-"));
function tmpFile() {
  return path.join(tmpDir, `eventlog-${Math.random().toString(36).slice(2)}.json`);
}

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

  describe("onEvict hook (3階層ログ設計: 上限超過分をArchiveへ退避するための配線点)", () => {
    it("invokes onEvict with the evicted entry once maxEntries is exceeded", () => {
      const evicted = [];
      const store = new EventLogStore(2, { onEvict: (entry) => evicted.push(entry) });
      store.record(event({ message: "e1" }));
      store.record(event({ message: "e2" }));
      store.record(event({ message: "e3" })); // e1 should be evicted

      assert.equal(evicted.length, 1);
      assert.equal(evicted[0].message, "e1");
      assert.deepEqual(store.getHistory().map((e) => e.message), ["e2", "e3"]);
    });

    it("does not call onEvict while under the limit", () => {
      const evicted = [];
      const store = new EventLogStore(3, { onEvict: (entry) => evicted.push(entry) });
      store.record(event({ message: "e1" }));
      store.record(event({ message: "e2" }));

      assert.equal(evicted.length, 0);
    });

    it("defaults to no onEvict (existing behavior: silently drops on overflow)", () => {
      const store = new EventLogStore(1);
      assert.doesNotThrow(() => {
        store.record(event({ message: "e1" }));
        store.record(event({ message: "e2" }));
      });
      assert.deepEqual(store.getHistory().map((e) => e.message), ["e2"]);
    });

    it("CRITICAL: no data is lost across overflow when an archive is wired via onEvict -- total count is conserved", () => {
      const archive = new EventLogStore(100);
      const history = new EventLogStore(3, { onEvict: (entry) => archive.record(entry) });

      for (let i = 0; i < 10; i++) {
        history.record(event({ message: `e${i}` }));
      }

      assert.equal(history.getHistory().length, 3);
      assert.equal(archive.getHistory().length, 7);
      assert.equal(history.getHistory().length + archive.getHistory().length, 10);
      assert.deepEqual(
        archive.getHistory().map((e) => e.message),
        ["e0", "e1", "e2", "e3", "e4", "e5", "e6"],
      );
    });
  });

  describe("extractOlderThan(cutoffIso)", () => {
    it("removes entries older than the cutoff and returns them, oldest first", () => {
      const store = new EventLogStore();
      store.record(event({ message: "old-1", timestamp: "2026-01-01T00:00:00.000Z" }));
      store.record(event({ message: "old-2", timestamp: "2026-01-02T00:00:00.000Z" }));
      store.record(event({ message: "recent", timestamp: "2026-06-01T00:00:00.000Z" }));

      const removed = store.extractOlderThan("2026-03-01T00:00:00.000Z");

      assert.deepEqual(removed.map((e) => e.message), ["old-1", "old-2"]);
      assert.deepEqual(store.getHistory().map((e) => e.message), ["recent"]);
    });

    it("keeps entries exactly at the cutoff (only strictly-older entries are removed)", () => {
      const store = new EventLogStore();
      store.record(event({ message: "at-cutoff", timestamp: "2026-03-01T00:00:00.000Z" }));

      const removed = store.extractOlderThan("2026-03-01T00:00:00.000Z");

      assert.deepEqual(removed, []);
      assert.equal(store.getHistory().length, 1);
    });

    it("returns an empty array and leaves entries untouched when nothing is older than the cutoff", () => {
      const store = new EventLogStore();
      store.record(event({ message: "e1", timestamp: "2026-06-01T00:00:00.000Z" }));

      const removed = store.extractOlderThan("2026-01-01T00:00:00.000Z");

      assert.deepEqual(removed, []);
      assert.equal(store.getHistory().length, 1);
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

  describe("getHistory({ from, to, q }) filtering (Archiveの「参照・検索できる構造」要件用)", () => {
    it("filters by from/to (inclusive) on timestamp", () => {
      const store = new EventLogStore();
      store.record(event({ message: "e1", timestamp: "2026-01-01T00:00:00.000Z" }));
      store.record(event({ message: "e2", timestamp: "2026-01-15T00:00:00.000Z" }));
      store.record(event({ message: "e3", timestamp: "2026-02-01T00:00:00.000Z" }));

      assert.deepEqual(
        store.getHistory({ from: "2026-01-10T00:00:00.000Z", to: "2026-01-31T00:00:00.000Z" }).map((e) => e.message),
        ["e2"],
      );
    });

    it("from/to bounds are inclusive", () => {
      const store = new EventLogStore();
      store.record(event({ message: "boundary", timestamp: "2026-01-15T00:00:00.000Z" }));

      assert.deepEqual(
        store.getHistory({ from: "2026-01-15T00:00:00.000Z", to: "2026-01-15T00:00:00.000Z" }).map((e) => e.message),
        ["boundary"],
      );
    });

    it("filters by q (case-insensitive substring match on message)", () => {
      const store = new EventLogStore();
      store.record(event({ message: "Ping timeout on 192.168.1.50" }));
      store.record(event({ message: "Discord webhook failed" }));

      assert.deepEqual(
        store.getHistory({ q: "ping" }).map((e) => e.message),
        ["Ping timeout on 192.168.1.50"],
      );
    });

    it("combines from/to/q with severity/category (all AND)", () => {
      const store = new EventLogStore();
      store.record(event({ message: "match", category: "lan", severity: "error", timestamp: "2026-01-05T00:00:00.000Z" }));
      store.record(event({ message: "wrong-text", category: "lan", severity: "error", timestamp: "2026-01-05T00:00:00.000Z" }));

      assert.deepEqual(
        store.getHistory({ category: ["lan"], severity: ["error"], q: "match" }).map((e) => e.message),
        ["match"],
      );
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

describe("persist() / load() (temp paths only)", () => {
  it("persists entries and reloads them identically into a fresh instance", () => {
    const store = new EventLogStore();
    store.record(event({ message: "e1", timestamp: "2026-01-01T00:00:00.000Z" }));
    store.record(event({ message: "e2", timestamp: "2026-01-01T00:00:05.000Z" }));

    const file = tmpFile();
    store.persist(file);

    const reloaded = new EventLogStore();
    const result = reloaded.load(file);

    assert.deepEqual(result, { loaded: 2 });
    assert.deepEqual(reloaded.getHistory(), store.getHistory());
  });

  it("load() on a nonexistent file leaves entries empty, not an error", () => {
    const store = new EventLogStore();
    const result = store.load(tmpFile());
    assert.deepEqual(result, { loaded: 0 });
    assert.deepEqual(store.getHistory(), []);
  });

  it("load() truncates to the most recent maxEntries entries if the file has more", () => {
    const file = tmpFile();
    const many = Array.from({ length: 5 }, (_, i) => event({ message: `e${i}` }));
    fs.writeFileSync(file, JSON.stringify(many));

    const store = new EventLogStore(3);
    const result = store.load(file);

    assert.deepEqual(result, { loaded: 3 });
    assert.deepEqual(
      store.getHistory().map((e) => e.message),
      ["e2", "e3", "e4"],
    );
  });

  it("getEventLogPath() honors EVENT_LOG_PATH", () => {
    const original = process.env.EVENT_LOG_PATH;
    process.env.EVENT_LOG_PATH = "/tmp/custom-event-log.json";
    try {
      assert.equal(getEventLogPath(), "/tmp/custom-event-log.json");
    } finally {
      if (original === undefined) delete process.env.EVENT_LOG_PATH;
      else process.env.EVENT_LOG_PATH = original;
    }
  });

  it("getEventLogArchivePath() honors EVENT_LOG_ARCHIVE_PATH", () => {
    const original = process.env.EVENT_LOG_ARCHIVE_PATH;
    process.env.EVENT_LOG_ARCHIVE_PATH = "/tmp/custom-event-log-archive.json";
    try {
      assert.equal(getEventLogArchivePath(), "/tmp/custom-event-log-archive.json");
    } finally {
      if (original === undefined) delete process.env.EVENT_LOG_ARCHIVE_PATH;
      else process.env.EVENT_LOG_ARCHIVE_PATH = original;
    }
  });
});

// --- 3階層ログ設計: 履歴(30日)/ Archive(30日超) ---
// ここから下は module-level のシングルトン(record/getHistory/getArchive/
// archiveExpiredEntries/persist/load)を対象にする。他のテストファイル
// (routes/events.test.js等)と同じ共有シングルトンのため、絶対件数ではなく
// 各テストが自分で record() した一意なメッセージで絞り込んで検証する
// (このファイル冒頭の「module-level singleton wiring」セクションと同じ規約)。
describe("module-level archive wiring (getArchive/archiveExpiredEntries/getRetentionDays/getArchiveMaxEntries)", () => {
  it("getRetentionDays() reports 30 (履歴として保持する既定日数)", () => {
    assert.equal(getRetentionDays(), 30);
  });

  it("getArchiveMaxEntries() is much larger than history's getMaxEntries() (Archiveは「削除しない」受け皿のため)", () => {
    assert.ok(getArchiveMaxEntries() > getMaxEntries());
  });

  it("archiveExpiredEntries() moves entries older than maxAgeDays from history into the archive, without losing them", () => {
    const message = `archive-me-${Math.random().toString(36).slice(2)}`;
    record(event({ message, timestamp: "2020-01-01T00:00:00.000Z" }));
    const archiveCountBefore = getArchive().length;

    const result = archiveExpiredEntries({ now: new Date("2026-09-02T00:00:00.000Z"), maxAgeDays: 30 });

    assert.ok(result.archivedCount >= 1);
    assert.equal(getHistory().some((e) => e.message === message), false);
    assert.equal(getArchive().some((e) => e.message === message), true);
    assert.equal(getArchive().length, archiveCountBefore + result.archivedCount);
  });

  it("does not archive entries within the retention window", () => {
    const message = `keep-me-recent-${Math.random().toString(36).slice(2)}`;
    record(event({ message, timestamp: new Date().toISOString() }));

    archiveExpiredEntries({ now: new Date(), maxAgeDays: 30 });

    assert.equal(getHistory().some((e) => e.message === message), true);
    assert.equal(getArchive().some((e) => e.message === message), false);
  });

  it("getArchive() supports the same filters as getHistory() (severity/category/from/to/q)", () => {
    const message = `archived-searchable-${Math.random().toString(36).slice(2)}`;
    record(event({ message, category: "lan", severity: "error", timestamp: "2020-06-15T00:00:00.000Z" }));
    archiveExpiredEntries({ now: new Date("2026-09-02T00:00:00.000Z"), maxAgeDays: 30 });

    const found = getArchive({ category: ["lan"], severity: ["error"], q: message.slice(0, 12) });
    assert.ok(found.some((e) => e.message === message));
  });
});

describe("module-level persist()/load() cover both the history file and the archive file", () => {
  it("persist() writes both files; load() reads both back (restart-safe, no data lost)", () => {
    const historyFile = tmpFile();
    const archiveFile = tmpFile();
    const originalHistoryEnv = process.env.EVENT_LOG_PATH;
    const originalArchiveEnv = process.env.EVENT_LOG_ARCHIVE_PATH;
    process.env.EVENT_LOG_PATH = historyFile;
    process.env.EVENT_LOG_ARCHIVE_PATH = archiveFile;

    try {
      const historyMessage = `restart-safe-history-${Math.random().toString(36).slice(2)}`;
      const archivedMessage = `restart-safe-archived-${Math.random().toString(36).slice(2)}`;
      record(event({ message: historyMessage, timestamp: new Date().toISOString() }));
      record(event({ message: archivedMessage, timestamp: "2020-01-01T00:00:00.000Z" }));
      archiveExpiredEntries({ now: new Date() });

      persist();

      const historyOnDisk = JSON.parse(fs.readFileSync(historyFile, "utf8"));
      const archiveOnDisk = JSON.parse(fs.readFileSync(archiveFile, "utf8"));
      assert.ok(historyOnDisk.some((e) => e.message === historyMessage));
      assert.ok(archiveOnDisk.some((e) => e.message === archivedMessage));

      // 別プロセス(再起動)を模して、両ファイルを読み直せることを確認する。
      const result = load();
      assert.ok(result.loaded > 0);
      assert.ok(result.archiveLoaded > 0);
      assert.ok(getHistory().some((e) => e.message === historyMessage));
      assert.ok(getArchive().some((e) => e.message === archivedMessage));
    } finally {
      if (originalHistoryEnv === undefined) delete process.env.EVENT_LOG_PATH;
      else process.env.EVENT_LOG_PATH = originalHistoryEnv;
      if (originalArchiveEnv === undefined) delete process.env.EVENT_LOG_ARCHIVE_PATH;
      else process.env.EVENT_LOG_ARCHIVE_PATH = originalArchiveEnv;
      // このテストで書き換えたシングルトンの永続化先を元(実運用パス)へ戻す --
      // 後続テスト/次回起動の data/eventLog*.json を汚さないため、テスト用の
      // 空エントリではなく、実ファイルを一切書かずに終える(load()を呼ばない)。
    }
  });

  it("load() immediately sweeps already-expired entries into the archive (does not wait for the next periodic tick)", () => {
    const historyFile = tmpFile();
    const archiveFile = tmpFile();
    const oldMessage = `already-expired-on-disk-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(
      historyFile,
      JSON.stringify([
        { timestamp: "2020-01-01T00:00:00.000Z", category: "monitor", severity: "error", message: oldMessage, meta: {} },
      ]),
    );

    const originalHistoryEnv = process.env.EVENT_LOG_PATH;
    const originalArchiveEnv = process.env.EVENT_LOG_ARCHIVE_PATH;
    process.env.EVENT_LOG_PATH = historyFile;
    process.env.EVENT_LOG_ARCHIVE_PATH = archiveFile;

    try {
      load();

      assert.equal(getHistory().some((e) => e.message === oldMessage), false);
      assert.equal(getArchive().some((e) => e.message === oldMessage), true);
    } finally {
      if (originalHistoryEnv === undefined) delete process.env.EVENT_LOG_PATH;
      else process.env.EVENT_LOG_PATH = originalHistoryEnv;
      if (originalArchiveEnv === undefined) delete process.env.EVENT_LOG_ARCHIVE_PATH;
      else process.env.EVENT_LOG_ARCHIVE_PATH = originalArchiveEnv;
    }
  });
});
