// alerts/alertEngine.test.js
// alerts/alertEngine.js のユニットテスト。AlertEngine クラス自体は export されて
// おらず(シングルトンの束縛関数のみ export)、routes/alerts.test.js が確立した
// 手法をそのまま流用する: monitorEngine.on() の戻り値(EventEmitter#on() は this を
// 返す)経由で、export されていない実シングルトンへのハンドルを得て、'update' を
// 直接 emit() することで monitorEngine の実ティックをシミュレートする。
//
// runtimeStates/lastValues の Map はモジュール内シングルトンでテスト間で共有される
// (alertEngine.js に「テスト用リセット」は無い)ため、各テストは専用の一意な
// ルールIDを使う(routes/alerts.test.js と同じ規約)。
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const monitorEngine = require("../monitor/monitorEngine");
const ruleStore = require("./ruleStore");
const alertEngine = require("./alertEngine");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alertEngine-test-"));
function tmpFile() {
  return path.join(tmpDir, `rules-${Math.random().toString(36).slice(2)}.json`);
}

const emitterRef = monitorEngine.on("__alertEngine_test_noop__", () => {});

beforeEach(() => {
  ruleStore.clear();
  process.env.ALERTS_RULES_PATH = tmpFile();
});

afterEach(() => {
  delete process.env.ALERTS_RULES_PATH;
  ruleStore.clear();
});

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

describe("handleUpdate(): missing metric", () => {
  it("skips a rule whose metric resolves to undefined this tick -- runtime/value stay untouched, other rules still evaluate", () => {
    const missingId = "missing-metric-rule";
    const normalId = "normal-rule-alongside-missing";
    ruleStore.create(sampleRule(missingId, { metric: "does.not.exist" }));
    ruleStore.create(sampleRule(normalId, { metric: "cpu.usage" }));

    alertEngine.start();
    emitterRef.emit("update", { cpu: { usage: 95 } }); // missingId's metric path resolves to undefined
    alertEngine.stop();

    const skippedRuntime = alertEngine.getRuntime(missingId);
    assert.equal(skippedRuntime.state, "OK");
    assert.equal(skippedRuntime.value, null); // lastValues was never set -- proves the tick was skipped, not just "non-breaching"

    // proves the loop didn't stop/break at the skipped rule -- the next rule in
    // the same tick was still evaluated normally.
    const normalRuntime = alertEngine.getRuntime(normalId);
    assert.equal(normalRuntime.state, "FIRING");
  });
});

describe("getRuntime(): RECOVERING state", () => {
  it("derives 'since' from clearSince (not breachSince) while RECOVERING", () => {
    const id = "recovering-since-rule";
    ruleStore.create(sampleRule(id, { duration: 0 }));

    alertEngine.start();
    emitterRef.emit("update", { cpu: { usage: 95 } }); // OK -> FIRING
    emitterRef.emit("update", { cpu: { usage: 95 } }); // FIRING -> DOWN
    emitterRef.emit("update", { cpu: { usage: 70 } }); // DOWN -> RECOVERING (drops below clearThreshold 80)
    alertEngine.stop();

    const runtime = alertEngine.getRuntime(id);
    assert.equal(runtime.state, "RECOVERING");
    assert.ok(runtime.since);
    assert.ok(!Number.isNaN(Date.parse(runtime.since)));
  });
});
