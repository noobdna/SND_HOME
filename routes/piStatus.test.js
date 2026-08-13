// routes/piStatus.test.js
// routes/piStatus.js の supertest 統合テスト。/api/pi-status の HTTPレイヤーを
// 対象とする -- lan/deviceStore.js 自体の詳細な挙動は lan/deviceStore.test.js が
// 既に網羅しているため、ここでは再検証しない。routes/lan.test.js と同じ
// deviceStore隔離規約(テンポラリパス + clear())を使う。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");

const deviceStore = require("../lan/deviceStore");
const piStatusRoutes = require("./piStatus");

const app = express();
app.use("/api/pi-status", piStatusRoutes);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-pistatus-test-"));
function tmpFile() {
  return path.join(tmpDir, `devices-${Math.random().toString(36).slice(2)}.json`);
}

beforeEach(() => {
  deviceStore.clear();
  process.env.LAN_DEVICES_PATH = tmpFile();
  delete process.env.PI_MONITOR_MAC;
});

afterEach(() => {
  delete process.env.LAN_DEVICES_PATH;
  delete process.env.PI_MONITOR_MAC;
});

describe("GET /api/pi-status", () => {
  it("returns { configured: false } when PI_MONITOR_MAC is unset", async () => {
    const res = await request(app).get("/api/pi-status");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { configured: false });
  });

  it("returns { configured: true, found: false } when the configured MAC has never been seen by any scan", async () => {
    process.env.PI_MONITOR_MAC = "b8:27:eb:d3:f4:52";
    const res = await request(app).get("/api/pi-status");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { configured: true, found: false });
  });

  it("returns online/ip/lastSeenAt for a known, currently-online device", async () => {
    process.env.PI_MONITOR_MAC = "b8:27:eb:d3:f4:52";
    deviceStore.recordScan({
      scannedAt: "2026-01-01T00:00:00.000Z",
      devices: [
        { ip: "192.168.1.150", mac: "b8:27:eb:d3:f4:52", vendor: "Raspberry Pi Foundation", respondedToPing: true, inArpTable: true, online: true },
      ],
      totalScanned: 1,
      onlineCount: 1,
    });

    const res = await request(app).get("/api/pi-status");
    assert.deepEqual(res.body, {
      configured: true,
      found: true,
      online: true,
      ip: "192.168.1.150",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("reflects online:false once the device stops responding (still found -- device stays in the ledger)", async () => {
    process.env.PI_MONITOR_MAC = "b8:27:eb:d3:f4:52";
    deviceStore.recordScan({
      scannedAt: "2026-01-01T00:00:00.000Z",
      devices: [{ ip: "192.168.1.150", mac: "b8:27:eb:d3:f4:52", vendor: null, respondedToPing: true, inArpTable: true, online: true }],
      totalScanned: 1,
      onlineCount: 1,
    });
    // 次のスキャンで応答しなかった -- devices配列から消えるが台帳には残る
    // (lan/deviceStore.js の設計、collectors/lanCollector.test.js の
    // 同種のテストと同じ前提)
    deviceStore.recordScan({ scannedAt: "2026-01-01T00:05:00.000Z", devices: [], totalScanned: 1, onlineCount: 0 });

    const res = await request(app).get("/api/pi-status");
    assert.equal(res.body.found, true);
    assert.equal(res.body.online, false);
  });

  it("normalizes the configured MAC's case/padding before looking it up (matches lan/lanScanner.js's normalizeMac)", async () => {
    process.env.PI_MONITOR_MAC = "B8:27:EB:D3:F4:52"; // uppercase, same as the LAN scan's own normalization concern
    deviceStore.recordScan({
      scannedAt: "2026-01-01T00:00:00.000Z",
      devices: [{ ip: "192.168.1.150", mac: "b8:27:eb:d3:f4:52", vendor: null, respondedToPing: true, inArpTable: true, online: true }],
      totalScanned: 1,
      onlineCount: 1,
    });

    const res = await request(app).get("/api/pi-status");
    assert.equal(res.body.found, true);
  });

  it("never exposes vendor/nickname or any other ledger field beyond configured/found/online/ip/lastSeenAt", async () => {
    process.env.PI_MONITOR_MAC = "b8:27:eb:d3:f4:52";
    deviceStore.recordScan({
      scannedAt: "2026-01-01T00:00:00.000Z",
      devices: [{ ip: "192.168.1.150", mac: "b8:27:eb:d3:f4:52", vendor: "Raspberry Pi Foundation", respondedToPing: true, inArpTable: true, online: true }],
      totalScanned: 1,
      onlineCount: 1,
    });
    deviceStore.setNickname("b8:27:eb:d3:f4:52", "Home Pi Agent");

    const res = await request(app).get("/api/pi-status");
    assert.deepEqual(Object.keys(res.body).sort(), ["configured", "found", "ip", "lastSeenAt", "online"]);
  });
});
