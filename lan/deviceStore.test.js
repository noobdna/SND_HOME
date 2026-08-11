// lan/deviceStore.test.js
// lan/deviceStore.js のユニットテスト。alerts/ruleStore.test.js と同じ隔離規約:
// 常にテンポラリパスのみを使い、実際の既定パス(data/lanDevices.json)には
// 一切触れない。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  validateNickname,
  DeviceNotFoundError,
  recordScan,
  list,
  get,
  setNickname,
  clear,
  load,
  persist,
  getDevicesPath,
} = require("./deviceStore");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devicestore-test-"));
function tmpFile() {
  return path.join(tmpDir, `devices-${Math.random().toString(36).slice(2)}.json`);
}

beforeEach(() => {
  clear();
  process.env.LAN_DEVICES_PATH = tmpFile();
});

afterEach(() => {
  delete process.env.LAN_DEVICES_PATH;
});

function scanResult(devices, scannedAt = "2026-01-01T00:00:00.000Z") {
  return { scannedAt, devices };
}

describe("validateNickname", () => {
  it("accepts null (clears the nickname)", () => {
    assert.deepEqual(validateNickname(null), []);
  });

  it("accepts a non-empty string", () => {
    assert.deepEqual(validateNickname("Living Room TV"), []);
  });

  it("rejects an empty or whitespace-only string", () => {
    assert.ok(validateNickname("").length > 0);
    assert.ok(validateNickname("   ").length > 0);
  });

  it("rejects a non-string, non-null value", () => {
    assert.ok(validateNickname(42).length > 0);
    assert.ok(validateNickname(undefined).length > 0);
  });

  it("rejects a nickname over the max length", () => {
    assert.ok(validateNickname("x".repeat(101)).length > 0);
    assert.deepEqual(validateNickname("x".repeat(100)), []);
  });
});

describe("recordScan", () => {
  it("upserts a new device with mac, tracking first/last seen and the detection-method flags", () => {
    const result = recordScan(
      scanResult([
        { ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", vendor: "NETGEAR", respondedToPing: true, inArpTable: true, online: true },
      ]),
    );
    assert.deepEqual(result, { upserted: 1, skippedNoMac: 0, markedOffline: 0 });

    const device = get("aa:bb:cc:dd:ee:ff");
    assert.equal(device.ip, "192.168.1.1");
    assert.equal(device.vendor, "NETGEAR");
    assert.equal(device.online, true);
    assert.equal(device.respondedToPing, true);
    assert.equal(device.inArpTable, true);
    assert.equal(device.firstSeenAt, "2026-01-01T00:00:00.000Z");
    assert.equal(device.lastSeenAt, "2026-01-01T00:00:00.000Z");
    assert.equal(device.nickname, null);
  });

  it("CRITICAL: records a device that responded only via ARP (not ping) as online, with the flags reflecting exactly that", () => {
    recordScan(
      scanResult([
        { ip: "192.168.1.90", mac: "a4:f6:e8:80:39:51", vendor: null, respondedToPing: false, inArpTable: true, online: true },
      ]),
    );
    const device = get("a4:f6:e8:80:39:51");
    assert.equal(device.online, true);
    assert.equal(device.respondedToPing, false);
    assert.equal(device.inArpTable, true);
  });

  it("skips devices with no resolvable mac and counts them separately", () => {
    const result = recordScan(
      scanResult([{ ip: "192.168.1.50", mac: null, vendor: null, respondedToPing: true, inArpTable: false, online: true }]),
    );
    assert.deepEqual(result, { upserted: 0, skippedNoMac: 1, markedOffline: 0 });
    assert.deepEqual(list(), []);
  });

  it("a second scan updates ip/lastSeenAt but preserves firstSeenAt and any set nickname", () => {
    recordScan(scanResult([{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", vendor: "NETGEAR", online: true }], "2026-01-01T00:00:00.000Z"));
    setNickname("aa:bb:cc:dd:ee:ff", "Router");

    recordScan(scanResult([{ ip: "192.168.1.2", mac: "aa:bb:cc:dd:ee:ff", vendor: "NETGEAR", online: true }], "2026-01-01T00:05:00.000Z"));

    const device = get("aa:bb:cc:dd:ee:ff");
    assert.equal(device.ip, "192.168.1.2");
    assert.equal(device.firstSeenAt, "2026-01-01T00:00:00.000Z");
    assert.equal(device.lastSeenAt, "2026-01-01T00:05:00.000Z");
    assert.equal(device.nickname, "Router");
  });

  it("marks a previously-known device offline (both detection flags false) when it's absent from a later scan", () => {
    recordScan(scanResult([{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", vendor: null, respondedToPing: true, inArpTable: true, online: true }]));
    const result = recordScan(scanResult([]));

    assert.deepEqual(result, { upserted: 0, skippedNoMac: 0, markedOffline: 1 });
    const device = get("aa:bb:cc:dd:ee:ff");
    assert.equal(device.online, false);
    assert.equal(device.respondedToPing, false);
    assert.equal(device.inArpTable, false);
    // オフラインになっても台帳からは消えない -- 履歴として残る
    assert.equal(device.firstSeenAt, "2026-01-01T00:00:00.000Z");
  });

  it("a device that comes back online in a later scan is not double-counted as markedOffline", () => {
    recordScan(scanResult([{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", online: true }]));
    recordScan(scanResult([])); // now offline
    const result = recordScan(scanResult([{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", online: true }])); // back online
    assert.deepEqual(result, { upserted: 1, skippedNoMac: 0, markedOffline: 0 });
    assert.equal(get("aa:bb:cc:dd:ee:ff").online, true);
  });
});

describe("get / list", () => {
  it("throws DeviceNotFoundError for an unknown mac", () => {
    assert.throws(() => get("00:00:00:00:00:00"), DeviceNotFoundError);
  });

  it("list() returns clones, not live references", () => {
    recordScan(scanResult([{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", online: true }]));
    const devices = list();
    devices[0].nickname = "mutated locally";
    assert.equal(get("aa:bb:cc:dd:ee:ff").nickname, null);
  });
});

describe("setNickname", () => {
  it("sets and clears a nickname on a known device", () => {
    recordScan(scanResult([{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", online: true }]));
    setNickname("aa:bb:cc:dd:ee:ff", "Living Room TV");
    assert.equal(get("aa:bb:cc:dd:ee:ff").nickname, "Living Room TV");

    setNickname("aa:bb:cc:dd:ee:ff", null);
    assert.equal(get("aa:bb:cc:dd:ee:ff").nickname, null);
  });

  it("trims whitespace", () => {
    recordScan(scanResult([{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", online: true }]));
    setNickname("aa:bb:cc:dd:ee:ff", "  Router  ");
    assert.equal(get("aa:bb:cc:dd:ee:ff").nickname, "Router");
  });

  it("throws DeviceNotFoundError for an unknown mac", () => {
    assert.throws(() => setNickname("00:00:00:00:00:00", "x"), DeviceNotFoundError);
  });

  it("throws a validation error for an invalid nickname and leaves the device unchanged", () => {
    recordScan(scanResult([{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", online: true }]));
    assert.throws(() => setNickname("aa:bb:cc:dd:ee:ff", ""), /Invalid nickname/);
    assert.equal(get("aa:bb:cc:dd:ee:ff").nickname, null);
  });
});

describe("persistence (load/persist, temp paths only)", () => {
  it("getDevicesPath() honors LAN_DEVICES_PATH", () => {
    assert.equal(getDevicesPath(), process.env.LAN_DEVICES_PATH);
  });

  it("persists after recordScan and reloads identically via load()", () => {
    recordScan(
      scanResult([
        { ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", vendor: "NETGEAR", respondedToPing: true, inArpTable: true, online: true },
      ]),
    );
    setNickname("aa:bb:cc:dd:ee:ff", "Router");

    clear();
    assert.deepEqual(list(), []);

    const result = load();
    assert.deepEqual(result, { loaded: 1, skipped: 0 });

    const device = get("aa:bb:cc:dd:ee:ff");
    assert.equal(device.ip, "192.168.1.1");
    assert.equal(device.nickname, "Router");
    // 再読込直後は「まだ一度もスキャンしていない」状態として復元される
    assert.equal(device.online, false);
    assert.equal(device.respondedToPing, false);
    assert.equal(device.inArpTable, false);
  });

  it("load() on a nonexistent file is a no-op, not an error", () => {
    assert.deepEqual(load(tmpFile()), { loaded: 0, skipped: 0 });
  });

  it("load() skips a malformed entry (missing mac) without crashing", () => {
    fs.writeFileSync(getDevicesPath(), JSON.stringify([{ ip: "192.168.1.1" }, { mac: "aa:bb:cc:dd:ee:ff" }]));
    const result = load();
    assert.deepEqual(result, { loaded: 1, skipped: 1 });
  });

  it("load() treats non-array JSON as invalid and ignores it", () => {
    fs.writeFileSync(getDevicesPath(), JSON.stringify({ not: "an array" }));
    assert.deepEqual(load(), { loaded: 0, skipped: 0 });
  });

  it("load() tolerates malformed JSON without crashing", () => {
    fs.writeFileSync(getDevicesPath(), "{not valid json");
    assert.deepEqual(load(), { loaded: 0, skipped: 0 });
  });

  it("persist() creates the containing directory if needed", () => {
    const nestedPath = path.join(tmpDir, "nested", "dir", "devices.json");
    recordScan(scanResult([{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", online: true }]));
    persist(nestedPath);
    assert.ok(fs.existsSync(nestedPath));
  });
});
