// collectors/lanCollector.test.js
// lan/lanEngine.js の getLatestScan() を monkey-patch して実ネットワーク/実タイマー
// なしで検証する(notifiers/*.test.js の global.fetch monkey-patchと同じ技法)。
// lan/deviceStore.js は実I/Oを伴わない(JSONファイルへの書き込みのみ)ため、
// 差し替えず本物を使い、テンポラリパスへ隔離する
// (alerts/ruleStore.test.js・lan/deviceStore.test.js と同じ隔離規約)。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const lanEngine = require("../lan/lanEngine");
const deviceStore = require("../lan/deviceStore");
const lanCollector = require("./lanCollector");

const originalGetLatestScan = lanEngine.getLatestScan;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lancollector-test-"));

beforeEach(() => {
  deviceStore.clear();
  process.env.LAN_DEVICES_PATH = path.join(tmpDir, `devices-${Math.random().toString(36).slice(2)}.json`);
});

afterEach(() => {
  lanEngine.getLatestScan = originalGetLatestScan;
  delete process.env.LAN_DEVICES_PATH;
});

describe("lanCollector", () => {
  it("declares the expected {name, collect()} shape", () => {
    assert.equal(lanCollector.name, "lan");
    assert.equal(typeof lanCollector.collect, "function");
  });

  it("gracefully degrades when no scan has ever completed (scanned: false, empty devices)", async () => {
    lanEngine.getLatestScan = () => null;
    const result = await lanCollector.collect();
    assert.deepEqual(result, {
      scanned: false,
      scannedAt: null,
      onlineCount: 0,
      totalScanned: 0,
      knownDeviceCount: 0,
      devices: {},
    });
  });

  it("reports scan summary fields from the latest cached scan", async () => {
    lanEngine.getLatestScan = () => ({
      scannedAt: "2026-01-01T00:00:00.000Z",
      subnet: "192.168.1.0/24",
      totalScanned: 254,
      onlineCount: 1,
      devices: [{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", vendor: "NETGEAR", respondedToPing: true, inArpTable: true, online: true }],
    });
    deviceStore.recordScan(lanEngine.getLatestScan());

    const result = await lanCollector.collect();
    assert.equal(result.scanned, true);
    assert.equal(result.scannedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(result.totalScanned, 254);
    assert.equal(result.onlineCount, 1);
  });

  it("publishes each known device under a dot-path-safe key (colons replaced with underscores)", async () => {
    const scanResult = {
      scannedAt: "2026-01-01T00:00:00.000Z",
      devices: [{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", vendor: "NETGEAR", respondedToPing: true, inArpTable: true, online: true }],
      totalScanned: 1,
      onlineCount: 1,
    };
    lanEngine.getLatestScan = () => scanResult;
    deviceStore.recordScan(scanResult);

    const result = await lanCollector.collect();
    assert.ok("aa_bb_cc_dd_ee_ff" in result.devices);
    assert.deepEqual(result.devices.aa_bb_cc_dd_ee_ff, {
      ip: "192.168.1.1",
      vendor: "NETGEAR",
      nickname: null,
      online: 1,
      respondedToPing: 1,
      inArpTable: 1,
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("CRITICAL: a device that goes offline still appears with online:0 (a real numeric value), not as a vanished key -- required for alerts/ruleEvaluator.js's dot-path resolution to detect the breach rather than skip evaluation", async () => {
    const firstScan = {
      scannedAt: "2026-01-01T00:00:00.000Z",
      devices: [{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", vendor: null, respondedToPing: true, inArpTable: true, online: true }],
      totalScanned: 1,
      onlineCount: 1,
    };
    deviceStore.recordScan(firstScan);

    // 2回目のスキャンではこのデバイスは応答しなかった -- devices配列から消える
    const secondScan = { scannedAt: "2026-01-01T00:05:00.000Z", devices: [], totalScanned: 1, onlineCount: 0 };
    deviceStore.recordScan(secondScan);
    lanEngine.getLatestScan = () => secondScan;

    const result = await lanCollector.collect();
    assert.ok("aa_bb_cc_dd_ee_ff" in result.devices, "the device's key must still be present after going offline");
    assert.equal(result.devices.aa_bb_cc_dd_ee_ff.online, 0);

    // ruleEvaluator.js自体は変更していないが、実際にその関数を使って
    // このスナップショットに対する評価が「データなしでスキップ」ではなく
    // 「閾値割れとして検知」になることを直接確認する。
    const { resolveMetric } = require("../alerts/ruleEvaluator");
    const snapshot = { lan: result };
    const value = resolveMetric(snapshot, "lan.devices.aa_bb_cc_dd_ee_ff.online");
    assert.equal(value, 0); // undefinedではない -- 実際の値として0が取れる
  });

  it("carries a user-assigned nickname through into the published snapshot", async () => {
    const scanResult = {
      scannedAt: "2026-01-01T00:00:00.000Z",
      devices: [{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", vendor: null, respondedToPing: true, inArpTable: true, online: true }],
      totalScanned: 1,
      onlineCount: 1,
    };
    deviceStore.recordScan(scanResult);
    deviceStore.setNickname("aa:bb:cc:dd:ee:ff", "Living Room TV");
    lanEngine.getLatestScan = () => scanResult;

    const result = await lanCollector.collect();
    assert.equal(result.devices.aa_bb_cc_dd_ee_ff.nickname, "Living Room TV");
  });

  it("does not throw when deviceStore is empty but a scan is cached (edge case: scan ran before any recordScan)", async () => {
    lanEngine.getLatestScan = () => ({ scannedAt: "2026-01-01T00:00:00.000Z", devices: [], totalScanned: 0, onlineCount: 0 });
    const result = await lanCollector.collect();
    assert.deepEqual(result.devices, {});
    assert.equal(result.knownDeviceCount, 0);
  });

  it("calls deviceStore.list() only once per collect() (regression: knownDeviceCount used to re-call list() instead of reusing the array used to build devices)", async () => {
    const scanResult = {
      scannedAt: "2026-01-01T00:00:00.000Z",
      devices: [{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", vendor: "NETGEAR", respondedToPing: true, inArpTable: true, online: true }],
      totalScanned: 1,
      onlineCount: 1,
    };
    deviceStore.recordScan(scanResult);
    lanEngine.getLatestScan = () => scanResult;

    const originalList = deviceStore.list;
    let callCount = 0;
    deviceStore.list = (...args) => {
      callCount++;
      return originalList.apply(deviceStore, args);
    };
    try {
      const result = await lanCollector.collect();
      assert.equal(result.knownDeviceCount, 1); // still correct, just computed without a second list() call
    } finally {
      deviceStore.list = originalList;
    }
    assert.equal(callCount, 1);
  });
});
