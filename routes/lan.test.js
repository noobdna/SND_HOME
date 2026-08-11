// routes/lan.test.js
// routes/lan.js の supertest 統合テスト(Stage 4)。/api/lan/* のHTTPレイヤー
// (ルーティング・ステータスコード・envelope形状・認証配線)を対象とする —
// lan/deviceStore.js・lan/lanEngine.js 自体の詳細な挙動は lan/deviceStore.test.js・
// lan/lanEngine.test.js が既に網羅しているため、ここでは再検証しない。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");

const deviceStore = require("../lan/deviceStore");
const lanEngine = require("../lan/lanEngine");
const lanRoutes = require("./lan");

const app = express();
app.use(express.json());
app.use("/api/lan", lanRoutes);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-lan-test-"));
function tmpFile() {
  return path.join(tmpDir, `devices-${Math.random().toString(36).slice(2)}.json`);
}

const originalGetStatus = lanEngine.getStatus;

beforeEach(() => {
  deviceStore.clear();
  process.env.LAN_DEVICES_PATH = tmpFile();
  delete process.env.API_KEY;
});

afterEach(() => {
  delete process.env.LAN_DEVICES_PATH;
  delete process.env.API_KEY;
  lanEngine.getStatus = originalGetStatus;
});

function seedDevice(mac = "aa:bb:cc:dd:ee:ff", overrides = {}) {
  deviceStore.recordScan({
    scannedAt: "2026-01-01T00:00:00.000Z",
    devices: [{ ip: "192.168.1.1", mac, vendor: "NETGEAR", respondedToPing: true, inArpTable: true, online: true, ...overrides }],
  });
}

describe("GET /api/lan/devices", () => {
  it("returns an empty list on a fresh store", async () => {
    const res = await request(app).get("/api/lan/devices");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok", data: [] });
  });

  it("returns every known device, including offline ones", async () => {
    seedDevice("aa:bb:cc:dd:ee:ff");
    deviceStore.recordScan({ scannedAt: "2026-01-01T00:05:00.000Z", devices: [] }); // now offline

    const res = await request(app).get("/api/lan/devices");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].mac, "aa:bb:cc:dd:ee:ff");
    assert.equal(res.body.data[0].online, false);
  });
});

describe("GET /api/lan/devices/:mac", () => {
  it("returns one device by mac", async () => {
    seedDevice("aa:bb:cc:dd:ee:ff");
    const res = await request(app).get("/api/lan/devices/aa:bb:cc:dd:ee:ff");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.mac, "aa:bb:cc:dd:ee:ff");
    assert.equal(res.body.data.vendor, "NETGEAR");
  });

  it("404s for an unknown mac", async () => {
    const res = await request(app).get("/api/lan/devices/00:00:00:00:00:00");
    assert.equal(res.status, 404);
    assert.equal(res.body.status, "error");
  });

  it("finds the device when the mac is requested in a different case (regression: case-sensitive lookup)", async () => {
    seedDevice("aa:bb:cc:dd:ee:ff");
    const res = await request(app).get("/api/lan/devices/AA:BB:CC:DD:EE:FF");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.mac, "aa:bb:cc:dd:ee:ff");
  });
});

describe("PATCH /api/lan/devices/:mac", () => {
  it("sets a nickname on a known device", async () => {
    seedDevice("aa:bb:cc:dd:ee:ff");
    const res = await request(app).patch("/api/lan/devices/aa:bb:cc:dd:ee:ff").send({ nickname: "Living Room TV" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.nickname, "Living Room TV");

    const getRes = await request(app).get("/api/lan/devices/aa:bb:cc:dd:ee:ff");
    assert.equal(getRes.body.data.nickname, "Living Room TV");
  });

  it("clears a nickname with null", async () => {
    seedDevice("aa:bb:cc:dd:ee:ff");
    await request(app).patch("/api/lan/devices/aa:bb:cc:dd:ee:ff").send({ nickname: "x" });
    const res = await request(app).patch("/api/lan/devices/aa:bb:cc:dd:ee:ff").send({ nickname: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.nickname, null);
  });

  it("400s when the nickname field is missing from the body", async () => {
    seedDevice("aa:bb:cc:dd:ee:ff");
    const res = await request(app).patch("/api/lan/devices/aa:bb:cc:dd:ee:ff").send({});
    assert.equal(res.status, 400);
  });

  it("400s for an invalid nickname (empty string), with the errors array included", async () => {
    seedDevice("aa:bb:cc:dd:ee:ff");
    const res = await request(app).patch("/api/lan/devices/aa:bb:cc:dd:ee:ff").send({ nickname: "" });
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
  });

  it("404s for an unknown mac", async () => {
    const res = await request(app).patch("/api/lan/devices/00:00:00:00:00:00").send({ nickname: "x" });
    assert.equal(res.status, 404);
  });

  it("sets a nickname when the mac is given in a different case (regression: case-sensitive lookup)", async () => {
    seedDevice("aa:bb:cc:dd:ee:ff");
    const res = await request(app).patch("/api/lan/devices/AA:BB:CC:DD:EE:FF").send({ nickname: "Living Room TV" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.mac, "aa:bb:cc:dd:ee:ff");
    assert.equal(res.body.data.nickname, "Living Room TV");
  });
});

describe("GET /api/lan/status", () => {
  it("returns lanEngine.getStatus() unwrapped (no envelope, matching /api/monitor/status)", async () => {
    lanEngine.getStatus = () => ({ running: false, interval: 120_000, lastUpdated: null, lastError: null, uptime: 0, knownDeviceCount: 0, onlineCount: 0 });
    const res = await request(app).get("/api/lan/status");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { running: false, interval: 120_000, lastUpdated: null, lastError: null, uptime: 0, knownDeviceCount: 0, onlineCount: 0 });
  });
});

// middleware/auth.js の requireAuth が router.use() でこのルーター全体
// (GETを含む)に適用されていることの検証 -- routes/alerts.js・
// routes/notifiers.js の「変更系エンドポイントだけ」とは異なる、
// このルーター特有の設計。requireAuth自体の単体テストは
// middleware/auth.test.js が既に担う。
describe("auth (whole router gated, unlike alerts/notifiers -- opt-in via API_KEY)", () => {
  it("without API_KEY configured, GET routes remain unauthenticated (unchanged default)", async () => {
    delete process.env.API_KEY;
    const res = await request(app).get("/api/lan/devices");
    assert.equal(res.status, 200);
  });

  it("with API_KEY configured, GET /devices 401s without a matching Bearer token", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/api/lan/devices");
    assert.equal(res.status, 401);
  });

  it("with API_KEY configured, GET /devices succeeds with the correct Bearer token", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/api/lan/devices").set("Authorization", "Bearer secret-token");
    assert.equal(res.status, 200);
  });

  it("with API_KEY configured, GET /status also 401s without a token (unlike /api/monitor/status, which has no auth)", async () => {
    process.env.API_KEY = "secret-token";
    const res = await request(app).get("/api/lan/status");
    assert.equal(res.status, 401);
  });

  it("with API_KEY configured, PATCH /devices/:mac 401s without a matching Bearer token", async () => {
    seedDevice("aa:bb:cc:dd:ee:ff");
    process.env.API_KEY = "secret-token";
    const res = await request(app).patch("/api/lan/devices/aa:bb:cc:dd:ee:ff").send({ nickname: "x" });
    assert.equal(res.status, 401);
  });

  it("with API_KEY configured, PATCH /devices/:mac succeeds with the correct Bearer token", async () => {
    seedDevice("aa:bb:cc:dd:ee:ff");
    process.env.API_KEY = "secret-token";
    const res = await request(app)
      .patch("/api/lan/devices/aa:bb:cc:dd:ee:ff")
      .set("Authorization", "Bearer secret-token")
      .send({ nickname: "x" });
    assert.equal(res.status, 200);
  });
});
