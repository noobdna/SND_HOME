// lan/lanEngine.test.js
// monitor/monitorEngine.js には委託テストファイルが存在しない(このプロジェクトの
// 監視レイヤー全体 -- collectors/・monitor/ -- に元々コミット済みテストが無い、
// Phase 5で初めてnode:testの規律が導入された経緯があるため)。lan/lanEngine.js は
// その monitorEngine.js と同じ「タイマー駆動のエンジン」だが、ここでは
// notifiers/*.test.js の global.fetch monkey-patch と同じ技法を lanScanner.scan /
// deviceStore.recordScan に適用し、実ネットワークに一切触れずに実配線を検証する。
//
// 複数テストがタイマー状態を共有して干渉しないよう、共有シングルトン
// (startLanScanning等)ではなく、テストごとに独立した `new LanEngine()` を使う
// (エクスポートされたクラスを直接インスタンス化)。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const lanScanner = require("./lanScanner");
const deviceStore = require("./deviceStore");
const { LanEngine, startLanScanning, stopLanScanning, getLatestScan, getStatus } = require("./lanEngine");

const originalScan = lanScanner.scan;
const originalRecordScan = deviceStore.recordScan;

afterEach(() => {
  lanScanner.scan = originalScan;
  deviceStore.recordScan = originalRecordScan;
  stopLanScanning(); // 共有シングルトンを使うテストの後始末
});

function fakeScanResult(overrides = {}) {
  return {
    scannedAt: new Date().toISOString(),
    subnet: "10.0.0.0/24",
    totalScanned: 2,
    onlineCount: 1,
    devices: [{ ip: "10.0.0.1", mac: "aa:bb:cc:dd:ee:ff", vendor: null, respondedToPing: true, inArpTable: true, online: true }],
    ...overrides,
  };
}

function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LanEngine (fresh instance per test)", () => {
  it("start() runs an immediate first scan without waiting for the interval", async () => {
    const scanned = fakeScanResult();
    lanScanner.scan = async () => scanned;
    deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

    const engine = new LanEngine();
    engine.start(999_999); // 長い間隔 -- 初回tickがintervalを待たずに走ることを確認する
    await wait();

    assert.deepEqual(engine.getLatestScan(), scanned);
    engine.stop();
  });

  it("passes the scan result through to deviceStore.recordScan", async () => {
    const scanned = fakeScanResult();
    lanScanner.scan = async () => scanned;
    let received;
    deviceStore.recordScan = (result) => {
      received = result;
      return { upserted: 1, skippedNoMac: 0, markedOffline: 0 };
    };

    const engine = new LanEngine();
    engine.start(999_999);
    await wait();

    assert.deepEqual(received, scanned);
    engine.stop();
  });

  it("CRITICAL: getStatus().unresolvedMacCount reflects deviceStore.recordScan()'s skippedNoMac -- the diagnostic for onlineCount/knownDeviceCount diverging (a ping-only device has no stable MAC to key the ledger by, so it's excluded from it by design; this count is what makes that divergence visible instead of silently confusing)", async () => {
    lanScanner.scan = async () => fakeScanResult({ onlineCount: 5 });
    deviceStore.recordScan = () => ({ upserted: 3, skippedNoMac: 2, markedOffline: 0 });

    const engine = new LanEngine();
    engine.start(999_999);
    await wait();

    const status = engine.getStatus();
    assert.equal(status.onlineCount, 5);
    assert.equal(status.unresolvedMacCount, 2);
    engine.stop();
  });

  describe("LAN_SCAN_CIDR override", () => {
    const originalEnv = process.env.LAN_SCAN_CIDR;
    afterEach(() => {
      if (originalEnv === undefined) delete process.env.LAN_SCAN_CIDR;
      else process.env.LAN_SCAN_CIDR = originalEnv;
    });

    it("passes LAN_SCAN_CIDR through to lanScanner.scan() as the cidr option, when set", async () => {
      process.env.LAN_SCAN_CIDR = "10.0.0.0/28";
      let receivedOptions;
      lanScanner.scan = async (options) => {
        receivedOptions = options;
        return fakeScanResult();
      };
      deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

      const engine = new LanEngine();
      engine.start(999_999);
      await wait();

      assert.deepEqual(receivedOptions, { cidr: "10.0.0.0/28" });
      engine.stop();
    });

    it("calls lanScanner.scan() with no cidr option when LAN_SCAN_CIDR is unset (auto-detect, unchanged default behavior)", async () => {
      delete process.env.LAN_SCAN_CIDR;
      let receivedOptions;
      lanScanner.scan = async (options) => {
        receivedOptions = options;
        return fakeScanResult();
      };
      deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

      const engine = new LanEngine();
      engine.start(999_999);
      await wait();

      assert.deepEqual(receivedOptions, {});
      engine.stop();
    });
  });

  it("emits 'update' with the scan result on success", async () => {
    const scanned = fakeScanResult();
    lanScanner.scan = async () => scanned;
    deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

    const engine = new LanEngine();
    const updates = [];
    engine.on("update", (r) => updates.push(r));
    engine.start(999_999);
    await wait();

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], scanned);
    engine.stop();
  });

  it("CRITICAL: a scan failure emits 'error', does not throw, and preserves the previous cached scan", async () => {
    const scanned = fakeScanResult();
    lanScanner.scan = async () => scanned;
    deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

    const engine = new LanEngine();
    engine.start(999_999);
    await wait();
    assert.deepEqual(engine.getLatestScan(), scanned);

    // 2回目のtickでスキャンが失敗するよう差し替える
    lanScanner.scan = async () => {
      throw new Error("ping binary not found");
    };
    const errors = [];
    engine.on("error", (err) => errors.push(err));
    await engine.tick();

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /ping binary not found/);
    // 失敗しても直前のキャッシュはそのまま残る(古い値を握りつぶさない)
    assert.deepEqual(engine.getLatestScan(), scanned);
    engine.stop();
  });

  it("start() is idempotent -- calling it twice does not create a second timer", async () => {
    let scanCount = 0;
    lanScanner.scan = async () => {
      scanCount++;
      return fakeScanResult();
    };
    deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

    const engine = new LanEngine();
    engine.start(999_999);
    engine.start(999_999); // 2回目は無視されるはず
    await wait();

    assert.equal(scanCount, 1);
    engine.stop();
  });

  it("stop() clears the timer, and the engine can be restarted afterward", async () => {
    lanScanner.scan = async () => fakeScanResult();
    deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

    const engine = new LanEngine();
    engine.start(999_999);
    await wait();
    assert.equal(engine.getStatus().running, true);

    engine.stop();
    assert.equal(engine.getStatus().running, false);

    engine.start(999_999);
    assert.equal(engine.getStatus().running, true);
    engine.stop();
  });

  it("does not start a second overlapping tick while one is already in flight", async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    lanScanner.scan = async () => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await wait(30);
      concurrentCalls--;
      return fakeScanResult();
    };
    deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

    const engine = new LanEngine();
    // tick()を明示的に2回、待たずに呼ぶ -- 2回目は scanning ガードで即return するはず
    const first = engine.tick();
    const second = engine.tick();
    await Promise.all([first, second]);

    assert.equal(maxConcurrent, 1);
  });

  describe("getStatus()", () => {
    it("reports not-running, zeroed counters before start()", () => {
      const engine = new LanEngine();
      assert.deepEqual(engine.getStatus(), {
        running: false,
        interval: 120_000,
        lastUpdated: null,
        lastError: null,
        uptime: 0,
        knownDeviceCount: deviceStore.list().length,
        onlineCount: 0,
        unresolvedMacCount: 0,
      });
    });

    it("reflects running/interval/lastUpdated/onlineCount after a successful tick", async () => {
      const scanned = fakeScanResult({ onlineCount: 3 });
      lanScanner.scan = async () => scanned;
      deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

      const engine = new LanEngine();
      engine.start(45_000);
      await wait();

      const status = engine.getStatus();
      assert.equal(status.running, true);
      assert.equal(status.interval, 45_000);
      assert.equal(status.onlineCount, 3);
      assert.equal(status.lastError, null);
      assert.ok(typeof status.lastUpdated === "string");
      assert.ok(status.uptime >= 0);
      engine.stop();
    });

    it("reports lastError after a failed tick, without clearing lastUpdated from an earlier success", async () => {
      const scanned = fakeScanResult();
      lanScanner.scan = async () => scanned;
      deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

      const engine = new LanEngine();
      engine.start(999_999);
      await wait();
      const lastUpdatedAfterSuccess = engine.getStatus().lastUpdated;

      lanScanner.scan = async () => {
        throw new Error("boom");
      };
      await engine.tick();

      const status = engine.getStatus();
      assert.match(status.lastError, /boom/);
      assert.equal(status.lastUpdated, lastUpdatedAfterSuccess);
      engine.stop();
    });
  });
});

describe("module-level singleton wiring (startLanScanning/stopLanScanning/getLatestScan/getStatus)", () => {
  it("the exported singleton functions drive the same underlying engine", async () => {
    const scanned = fakeScanResult();
    lanScanner.scan = async () => scanned;
    deviceStore.recordScan = () => ({ upserted: 1, skippedNoMac: 0, markedOffline: 0 });

    startLanScanning(999_999);
    await wait();

    assert.deepEqual(getLatestScan(), scanned);
    assert.equal(getStatus().running, true);

    stopLanScanning();
    assert.equal(getStatus().running, false);
  });
});
