// monitor/monitorEngine.test.js
// monitorEngine.js は元々このプロジェクトの監視レイヤー(collectors/・monitor/)
// 全体と同じく、node:test 導入前(Phase 5より前)に書かれたためテストが無かった。
// lan/lanEngine.js が同じ「タイマー駆動のエンジン」構造に対して既に確立している
// 手法(依存モジュールをオブジェクトごと require し、テスト側で該当メソッドを
// monkey-patch する — collectorRegistry.collectAll をここで差し替える)を
// そのまま適用する。historyStore.record も同じ流儀で monkey-patch し、
// 複数テストファイルから共有される historyStore シングルトンの実データを
// 汚染しない。
//
// 複数テストがタイマー状態を共有して干渉しないよう、共有シングルトン
// (startMonitoring等)ではなく、テストごとに独立した `new MonitorEngine()` を
// 使う(エクスポートされたクラスを直接インスタンス化 -- lan/lanEngine.test.js
// と同じ規約)。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const collectorRegistry = require("./collectorRegistry");
const historyStore = require("./historyStore");
const eventLogStore = require("./eventLogStore");
const { MonitorEngine, startMonitoring, stopMonitoring, getLatestSystemInfo, getStatus } = require("./monitorEngine");

const originalCollectAll = collectorRegistry.collectAll;
const originalRecord = historyStore.record;

afterEach(() => {
  collectorRegistry.collectAll = originalCollectAll;
  historyStore.record = originalRecord;
  stopMonitoring(); // 共有シングルトンを使うテストの後始末
});

function fakeSnapshot(overrides = {}) {
  return {
    status: "ok",
    hostname: "test-host",
    platform: "darwin",
    cpu: { usage: 12.3, cores: 8 },
    memory: { used: 100, total: 200, percent: 50 },
    disk: { used: 10, total: 20, percent: 50 },
    network: { interfaces: [], localIp: null, rxBytes: null, txBytes: null },
    load: [1, 1, 1],
    uptime: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MonitorEngine (fresh instance per test)", () => {
  it("start() runs an immediate first tick without waiting for the interval", async () => {
    const snapshot = fakeSnapshot();
    collectorRegistry.collectAll = async () => snapshot;
    historyStore.record = () => {};

    const engine = new MonitorEngine();
    engine.start(999_999); // 長い間隔 -- 初回tickがintervalを待たずに走ることを確認する
    await wait();

    assert.deepEqual(engine.getLatestSystemInfo(), snapshot);
    engine.stop();
  });

  it("passes the collected snapshot through to historyStore.record", async () => {
    const snapshot = fakeSnapshot();
    collectorRegistry.collectAll = async () => snapshot;
    let received;
    historyStore.record = (data) => {
      received = data;
    };

    const engine = new MonitorEngine();
    engine.start(999_999);
    await wait();

    assert.deepEqual(received, snapshot);
    engine.stop();
  });

  it("emits 'update' with the snapshot on success", async () => {
    const snapshot = fakeSnapshot();
    collectorRegistry.collectAll = async () => snapshot;
    historyStore.record = () => {};

    const engine = new MonitorEngine();
    const updates = [];
    engine.on("update", (data) => updates.push(data));
    engine.start(999_999);
    await wait();

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], snapshot);
    engine.stop();
  });

  it("CRITICAL: a collection failure emits 'error', does not throw, and preserves the previous cached snapshot", async () => {
    const snapshot = fakeSnapshot();
    collectorRegistry.collectAll = async () => snapshot;
    historyStore.record = () => {};

    const engine = new MonitorEngine();
    engine.start(999_999);
    await wait();
    assert.deepEqual(engine.getLatestSystemInfo(), snapshot);

    // 2回目のtickで収集が失敗するよう差し替える(このテスト固有のエラー文言 --
    // eventLogStore は共有シングルトンでリセットできないため、message で絞り込む)
    collectorRegistry.collectAll = async () => {
      throw new Error("df binary not found (monitorEngine test)");
    };
    const errors = [];
    engine.on("error", (err) => errors.push(err));
    await engine.tick();

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /df binary not found \(monitorEngine test\)/);
    // 失敗しても直前のキャッシュはそのまま残る(古い値を握りつぶさない)
    assert.deepEqual(engine.getLatestSystemInfo(), snapshot);

    const logged = eventLogStore.getHistory({ category: ["monitor"], severity: ["error"] });
    const mine = logged.filter((e) => e.message.includes("df binary not found (monitorEngine test)"));
    assert.equal(mine.length, 1);

    engine.stop();
  });

  it("does not record history or emit 'update' on a failed tick", async () => {
    collectorRegistry.collectAll = async () => {
      throw new Error("boom");
    };
    let recordCalls = 0;
    historyStore.record = () => {
      recordCalls++;
    };

    const engine = new MonitorEngine();
    const updates = [];
    engine.on("update", (data) => updates.push(data));
    engine.on("error", () => {});
    await engine.tick();

    assert.equal(recordCalls, 0);
    assert.equal(updates.length, 0);
  });

  it("start() is idempotent -- calling it twice does not create a second timer", async () => {
    let tickCount = 0;
    collectorRegistry.collectAll = async () => {
      tickCount++;
      return fakeSnapshot();
    };
    historyStore.record = () => {};

    const engine = new MonitorEngine();
    engine.start(999_999);
    engine.start(999_999); // 2回目は無視されるはず
    await wait();

    assert.equal(tickCount, 1);
    engine.stop();
  });

  it("stop() clears the timer, and the engine can be restarted afterward", async () => {
    collectorRegistry.collectAll = async () => fakeSnapshot();
    historyStore.record = () => {};

    const engine = new MonitorEngine();
    engine.start(999_999);
    await wait();
    assert.equal(engine.getStatus().running, true);

    engine.stop();
    assert.equal(engine.getStatus().running, false);

    engine.start(999_999);
    assert.equal(engine.getStatus().running, true);
    engine.stop();
  });

  it("stop() before start() is a no-op (does not throw)", () => {
    const engine = new MonitorEngine();
    assert.doesNotThrow(() => engine.stop());
    assert.equal(engine.getStatus().running, false);
  });

  it("the interval timer re-runs tick() repeatedly", async () => {
    let tickCount = 0;
    collectorRegistry.collectAll = async () => {
      tickCount++;
      return fakeSnapshot();
    };
    historyStore.record = () => {};

    const engine = new MonitorEngine();
    engine.start(15); // 短い間隔で複数回発火することを確認する
    await wait(80);
    engine.stop();

    assert.ok(tickCount >= 3, `expected at least 3 ticks, got ${tickCount}`);
  });

  describe("getLatestSystemInfo()", () => {
    it("returns null before any successful tick", () => {
      const engine = new MonitorEngine();
      assert.equal(engine.getLatestSystemInfo(), null);
    });
  });

  describe("getStatus()", () => {
    it("reports not-running, default interval, null lastUpdated before start()", () => {
      const engine = new MonitorEngine();
      assert.deepEqual(engine.getStatus(), {
        running: false,
        interval: 5000,
        lastUpdated: null,
        uptime: 0,
      });
    });

    it("reflects running/interval/lastUpdated after a successful tick", async () => {
      collectorRegistry.collectAll = async () => fakeSnapshot();
      historyStore.record = () => {};

      const engine = new MonitorEngine();
      engine.start(45_000);
      await wait();

      const status = engine.getStatus();
      assert.equal(status.running, true);
      assert.equal(status.interval, 45_000);
      assert.ok(typeof status.lastUpdated === "string");
      assert.ok(status.uptime >= 0);
      engine.stop();
    });

    it("uptime resets to 0 after stop()", async () => {
      collectorRegistry.collectAll = async () => fakeSnapshot();
      historyStore.record = () => {};

      const engine = new MonitorEngine();
      engine.start(999_999);
      await wait();
      engine.stop();

      assert.equal(engine.getStatus().uptime, 0);
    });

    it("preserves lastUpdated from an earlier success after a later failed tick", async () => {
      collectorRegistry.collectAll = async () => fakeSnapshot();
      historyStore.record = () => {};

      const engine = new MonitorEngine();
      engine.start(999_999);
      await wait();
      const lastUpdatedAfterSuccess = engine.getStatus().lastUpdated;

      collectorRegistry.collectAll = async () => {
        throw new Error("boom");
      };
      engine.on("error", () => {});
      await engine.tick();

      assert.equal(engine.getStatus().lastUpdated, lastUpdatedAfterSuccess);
      engine.stop();
    });
  });

  describe("on()/off()", () => {
    it("off() stops delivering further events to a removed listener", async () => {
      collectorRegistry.collectAll = async () => fakeSnapshot();
      historyStore.record = () => {};

      const engine = new MonitorEngine();
      const updates = [];
      const listener = (data) => updates.push(data);
      engine.on("update", listener);
      await engine.tick();
      engine.off("update", listener);
      await engine.tick();

      assert.equal(updates.length, 1);
    });
  });
});

describe("module-level singleton wiring (startMonitoring/stopMonitoring/getLatestSystemInfo/getStatus)", () => {
  it("the exported singleton functions drive the same underlying engine", async () => {
    const snapshot = fakeSnapshot();
    collectorRegistry.collectAll = async () => snapshot;
    historyStore.record = () => {};

    startMonitoring(999_999);
    await wait();

    assert.deepEqual(getLatestSystemInfo(), snapshot);
    assert.equal(getStatus().running, true);

    stopMonitoring();
    assert.equal(getStatus().running, false);
  });
});
