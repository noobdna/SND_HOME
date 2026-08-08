// routes/alerts.test.js
// routes/alerts.js の supertest 統合テスト(Task 8.3)。/api/alerts/* の
// HTTPレイヤー(ルーティング・ステータスコード・envelope形状・エンドツーエンドの
// 配線)を対象とする — ruleEvaluator の状態機械の細部(境界値・欠損メトリクス等)は
// alerts/ruleEvaluator.test.js が、ruleStore の永続化/バリデーションの細部は
// alerts/ruleStore.test.js が既に網羅しているため、ここでは再検証しない。
//
// alertEngine の実ティックは monitorEngine の 'update' イベントを直接 emit()
// することでシミュレートする(Stage 3〜6 の一連のスクリプト検証で確立した手法 —
// EventEmitter#on() が this を返すことを利用して、monitorEngine を実際には
// export していない内部シングルトンへのハンドルを得る)。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");

const monitorEngine = require("../monitor/monitorEngine");
const ruleStore = require("./../alerts/ruleStore");
const alertEngine = require("../alerts/alertEngine");
const alertHistoryStore = require("../alerts/alertHistoryStore");
const alertsRouter = require("./alerts");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-alerts-test-"));
function tmpFile() {
  return path.join(tmpDir, `rules-${Math.random().toString(36).slice(2)}.json`);
}

const app = express();
app.use(express.json());
app.use("/api/alerts", alertsRouter);

// monitorEngine.on() の戻り値(EventEmitter#on() は this を返す)経由で、
// export されていない実シングルトンへの参照を得る。
const emitterRef = monitorEngine.on("__routes_alerts_test_noop__", () => {});

function sampleRule(id, overrides = {}) {
  return {
    id,
    name: id,
    metric: "cpu.usage",
    operator: ">=",
    threshold: 90,
    clearThreshold: 80,
    duration: 0,
    hysteresis: 0,
    cooldown: 0,
    severity: "warning",
    channels: [],
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  ruleStore.clear();
  process.env.ALERTS_RULES_PATH = tmpFile();
});

afterEach(() => {
  delete process.env.ALERTS_RULES_PATH;
  ruleStore.clear();
});

describe("GET /api/alerts/rules", () => {
  it("returns an empty list on a fresh store", async () => {
    const res = await request(app).get("/api/alerts/rules");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok", data: [] });
  });

  it("returns every rule with its runtime info attached", async () => {
    ruleStore.create(sampleRule("rule-a"));
    ruleStore.create(sampleRule("rule-b"));

    const res = await request(app).get("/api/alerts/rules");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 2);
    const ids = res.body.data.map((r) => r.id).sort();
    assert.deepEqual(ids, ["rule-a", "rule-b"]);
    assert.deepEqual(res.body.data[0].runtime, {
      state: "OK",
      value: null,
      since: null,
      lastNotifiedAt: null,
    });
  });
});

describe("GET /api/alerts/rules/:id", () => {
  it("returns a single rule with runtime info", async () => {
    ruleStore.create(sampleRule("rule-a"));
    const res = await request(app).get("/api/alerts/rules/rule-a");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.id, "rule-a");
    assert.ok(res.body.data.runtime);
  });

  it("404s for an unknown id", async () => {
    const res = await request(app).get("/api/alerts/rules/does-not-exist");
    assert.equal(res.status, 404);
    assert.equal(res.body.status, "error");
  });
});

describe("POST /api/alerts/rules", () => {
  it("creates a valid rule and returns 201", async () => {
    const res = await request(app).post("/api/alerts/rules").send(sampleRule("new-rule"));
    assert.equal(res.status, 201);
    assert.equal(res.body.data.id, "new-rule");
    assert.equal(res.body.data.clearThreshold, 80);
  });

  it("rejects an invalid rule with 400 and a structured errors array", async () => {
    const res = await request(app).post("/api/alerts/rules").send({ id: "bad id with spaces" });
    assert.equal(res.status, 400);
    assert.equal(res.body.status, "error");
    assert.ok(Array.isArray(res.body.errors) && res.body.errors.length > 0);
  });

  it("rejects a duplicate id with 409", async () => {
    ruleStore.create(sampleRule("dup"));
    const res = await request(app).post("/api/alerts/rules").send(sampleRule("dup"));
    assert.equal(res.status, 409);
  });
});

describe("PUT /api/alerts/rules/:id", () => {
  it("merges a partial update and preserves untouched fields", async () => {
    ruleStore.create(sampleRule("rule-a"));
    const res = await request(app)
      .put("/api/alerts/rules/rule-a")
      .send({ threshold: 95, severity: "critical" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.threshold, 95);
    assert.equal(res.body.data.severity, "critical");
    assert.equal(res.body.data.metric, "cpu.usage");
  });

  it("rejects an invalid update with 400 and leaves the stored rule unchanged", async () => {
    ruleStore.create(sampleRule("rule-a"));
    const res = await request(app).put("/api/alerts/rules/rule-a").send({ operator: "=>" });
    assert.equal(res.status, 400);
    assert.equal(ruleStore.get("rule-a").operator, ">=");
  });

  it("404s for an unknown id", async () => {
    const res = await request(app).put("/api/alerts/rules/does-not-exist").send({ threshold: 1 });
    assert.equal(res.status, 404);
  });
});

describe("DELETE /api/alerts/rules/:id", () => {
  it("removes the rule, clears runtime state, and returns a bare ok envelope", async () => {
    // alertEngine's runtime Maps are a module-level singleton not reset between
    // tests (unlike ruleStore, which is explicitly cleared in beforeEach), so
    // every test that drives a real tick uses its own unique rule id to avoid
    // leaking state into other tests.
    const id = "delete-test-rule";
    ruleStore.create(sampleRule(id, { duration: 0 }));

    alertEngine.start();
    emitterRef.emit("update", { cpu: { usage: 95 } }); // fires
    alertEngine.stop();
    assert.notEqual(alertEngine.getRuntime(id).state, "OK");

    const res = await request(app).delete(`/api/alerts/rules/${id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });

    await request(app).get(`/api/alerts/rules/${id}`).expect(404);

    // recreating the same id should start fresh, proving runtime was cleared
    ruleStore.create(sampleRule(id));
    assert.deepEqual(alertEngine.getRuntime(id), {
      state: "OK",
      value: null,
      since: null,
      lastNotifiedAt: null,
    });
  });

  it("404s for an unknown id", async () => {
    const res = await request(app).delete("/api/alerts/rules/does-not-exist");
    assert.equal(res.status, 404);
  });
});

describe("GET /api/alerts/active", () => {
  it("only returns rules currently in FIRING/DOWN/RECOVERING", async () => {
    ruleStore.create(sampleRule("ok-rule", { metric: "cpu.usage" }));
    ruleStore.create(sampleRule("firing-rule", { metric: "memory.percent" }));

    alertEngine.start();
    emitterRef.emit("update", { cpu: { usage: 10 }, memory: { percent: 95 } });
    alertEngine.stop();

    const res = await request(app).get("/api/alerts/active");
    assert.equal(res.status, 200);
    const ids = res.body.data.map((r) => r.id);
    assert.deepEqual(ids, ["firing-rule"]);
  });
});

describe("GET /api/alerts/history", () => {
  it("reflects real recorded transitions and respects ?limit=", async () => {
    // alertHistoryStore is also a shared, un-reset singleton across tests in
    // this file, so assert on this rule's own entries (filtered by ruleId)
    // rather than an absolute count of the whole shared buffer.
    const id = "history-test-rule";
    ruleStore.create(sampleRule(id, { duration: 0 }));

    alertEngine.start();
    emitterRef.emit("update", { cpu: { usage: 95 } }); // OK -> FIRING (notifies)
    emitterRef.emit("update", { cpu: { usage: 95 } }); // FIRING -> DOWN (no notify)
    alertEngine.stop();

    const res = await request(app).get("/api/alerts/history");
    assert.equal(res.status, 200);
    const mine = res.body.data.filter((e) => e.ruleId === id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].previousState, "OK");
    assert.equal(mine[0].state, "FIRING");

    // this rule's alert is the most recent entry in the shared buffer at this
    // point in the suite, so ?limit=1 should return exactly it.
    const limited = await request(app).get("/api/alerts/history?limit=1");
    assert.equal(limited.body.count, 1);
    assert.equal(limited.body.data[0].ruleId, id);
  });
});

describe("POST /api/alerts/rules/:id/test", () => {
  it("404s for an unknown rule id", async () => {
    const res = await request(app).post("/api/alerts/rules/does-not-exist/test");
    assert.equal(res.status, 404);
  });

  it("dispatches a synthetic [TEST] alert to registered notifiers without touching history or runtime state", async () => {
    const id = "test-endpoint-rule"; // own unique id, independent of other tests' cleanup
    ruleStore.create(sampleRule(id));
    const notifierRegistry = require("../alerts/notifierRegistry");
    const received = [];
    notifierRegistry.register({
      name: "spy",
      configured: () => true,
      notify: async (alert) => received.push(alert),
    });

    const historyBefore = alertHistoryStore.getHistory().length;
    const res = await request(app).post(`/api/alerts/rules/${id}/test`);
    assert.equal(res.status, 200);
    assert.match(res.body.data.alert.message, /^\[TEST\]/);
    assert.equal(res.body.data.notifiers.includes("spy"), true);
    assert.equal(received.length, 1);
    assert.equal(alertHistoryStore.getHistory().length, historyBefore); // untouched
    assert.equal(alertEngine.getRuntime(id).state, "OK"); // untouched
  });
});

describe("GET /api/alerts/engine/status", () => {
  it("returns the bare status object (no envelope), reflecting real engine state", async () => {
    ruleStore.create(sampleRule("rule-a"));

    const before = await request(app).get("/api/alerts/engine/status");
    assert.equal(before.status, 200);
    assert.deepEqual(Object.keys(before.body).sort(), [
      "activeAlertsCount",
      "lastEvaluatedAt",
      "rulesCount",
      "running",
    ]);
    assert.equal(before.body.running, false);
    assert.equal(before.body.rulesCount, 1);

    alertEngine.start();
    emitterRef.emit("update", { cpu: { usage: 10 } });
    alertEngine.stop();

    const after = await request(app).get("/api/alerts/engine/status");
    assert.equal(after.body.running, false); // stopped again
    assert.ok(after.body.lastEvaluatedAt); // but the last tick is still recorded
  });
});

describe("POST /api/alerts/rules/:id/silence (Stage 9 stretch)", () => {
  it("sets a future silencedUntil from durationSeconds", async () => {
    ruleStore.create(sampleRule("silence-a"));
    const before = Date.now();
    const res = await request(app)
      .post("/api/alerts/rules/silence-a/silence")
      .send({ durationSeconds: 3600 });
    assert.equal(res.status, 200);
    const silencedUntilMs = Date.parse(res.body.data.silencedUntil);
    assert.ok(silencedUntilMs >= before + 3600 * 1000 - 1000);
  });

  it("sets an explicit silencedUntil verbatim when 'until' is given", async () => {
    ruleStore.create(sampleRule("silence-b"));
    const until = new Date(Date.now() + 7200 * 1000).toISOString();
    const res = await request(app).post("/api/alerts/rules/silence-b/silence").send({ until });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.silencedUntil, until);
  });

  it("400s when neither durationSeconds nor until is provided", async () => {
    ruleStore.create(sampleRule("silence-c"));
    const res = await request(app).post("/api/alerts/rules/silence-c/silence").send({});
    assert.equal(res.status, 400);
  });

  it("404s for an unknown rule id", async () => {
    const res = await request(app)
      .post("/api/alerts/rules/does-not-exist/silence")
      .send({ durationSeconds: 60 });
    assert.equal(res.status, 404);
  });

  it("PUT with silencedUntil: null unsilences a rule", async () => {
    ruleStore.create(sampleRule("silence-d"));
    await request(app).post("/api/alerts/rules/silence-d/silence").send({ durationSeconds: 3600 });
    const res = await request(app).put("/api/alerts/rules/silence-d").send({ silencedUntil: null });
    assert.equal(res.body.data.silencedUntil, null);
  });

  it("while silenced: notify still records history but does not reach notifierRegistry", async () => {
    const id = "silence-behavior-notify";
    ruleStore.create(sampleRule(id, { duration: 0 }));
    await request(app).post(`/api/alerts/rules/${id}/silence`).send({ durationSeconds: 3600 });

    const notifierRegistry = require("../alerts/notifierRegistry");
    const received = [];
    notifierRegistry.register({
      name: `spy-${id}`,
      configured: () => true,
      notify: async (alert) => received.push(alert),
    });

    const historyBefore = alertHistoryStore.getHistory().length;
    alertEngine.start();
    emitterRef.emit("update", { cpu: { usage: 95 } }); // OK -> FIRING, notify=true
    alertEngine.stop();

    assert.equal(received.length, 0);
    assert.equal(alertHistoryStore.getHistory().length, historyBefore + 1);
    assert.equal(alertEngine.getRuntime(id).state, "FIRING"); // runtime still updates normally
  });

  it("the manual /rules/:id/test endpoint still dispatches even while silenced", async () => {
    const id = "silence-behavior-test-endpoint";
    ruleStore.create(sampleRule(id));
    await request(app).post(`/api/alerts/rules/${id}/silence`).send({ durationSeconds: 3600 });

    const notifierRegistry = require("../alerts/notifierRegistry");
    const received = [];
    notifierRegistry.register({
      name: `spy-test-${id}`,
      configured: () => true,
      notify: async (alert) => received.push(alert),
    });

    const res = await request(app).post(`/api/alerts/rules/${id}/test`);
    assert.equal(res.status, 200);
    assert.equal(received.length, 1);
  });
});
