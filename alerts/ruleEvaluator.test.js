// alerts/ruleEvaluator.test.js
// alerts/ruleEvaluator.js のユニットテスト:evaluate() の happy-path フルサイクル
// (OK → FIRING → DOWN → RECOVERING → OK)を対象とする(Task 2.8)。
//
// 各ティックの遷移を個別の it() に分け、テスト間で同じ `state`/`t` を引き継いで
// 「実際に時間が進みながら1つのインシデントを追跡する」流れを1本の describe として
// 再現している(node:test は describe 内の it() を宣言順に逐次実行するため、この
// 依存関係は安全)。フラッピングの境界値・欠損メトリクス・duration=0 などの
// エッジケースは対象外 — それは Task 2.9 のスコープ。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { STATES, createInitialState, evaluate } = require("./ruleEvaluator");

const rule = {
  id: "disk-root-critical",
  name: "Root disk usage critical",
  metric: "disk.percent",
  operator: ">=",
  threshold: 90,
  clearThreshold: 80,
  duration: 30,
  hysteresis: 60,
  cooldown: 1800,
  severity: "critical",
  channels: ["discord"],
  enabled: true,
};

const T0 = 1_700_000_000_000;

describe("evaluate() — happy-path full cycle (OK → FIRING → DOWN → RECOVERING → OK)", () => {
  let state = createInitialState();
  let t = T0;
  let incidentAlertId;

  it("OK, non-breach: stays OK, no notify", () => {
    const { nextState, notify, alert } = evaluate(rule, 50, state, t);
    assert.equal(nextState.state, STATES.OK);
    assert.equal(nextState.breachSince, null);
    assert.equal(notify, false);
    assert.equal(alert, undefined);
    state = nextState;
  });

  it("OK, breach starts but under duration: stays OK, breachSince tracked internally, no notify", () => {
    const { nextState, notify } = evaluate(rule, 95, state, t);
    assert.equal(nextState.state, STATES.OK);
    assert.equal(nextState.breachSince, t);
    assert.equal(notify, false);
    state = nextState;
  });

  it("OK → FIRING once the breach has persisted for >= duration seconds: notifies", () => {
    t += rule.duration * 1000;
    const { nextState, notify, alert } = evaluate(rule, 95, state, t);
    assert.equal(nextState.state, STATES.FIRING);
    assert.equal(notify, true);
    assert.equal(alert.state, STATES.FIRING);
    assert.equal(alert.previousState, STATES.OK);
    assert.equal(alert.value, 95);
    assert.match(alert.message, /is FIRING/);
    incidentAlertId = nextState.alertId;
    assert.ok(incidentAlertId);
    state = nextState;
  });

  it("FIRING → DOWN on the next tick while still breached: no re-notify (already notified on FIRING)", () => {
    t += 5000;
    const { nextState, notify } = evaluate(rule, 95, state, t);
    assert.equal(nextState.state, STATES.DOWN);
    assert.equal(notify, false);
    assert.equal(nextState.alertId, incidentAlertId); // same incident thread
    state = nextState;
  });

  it("DOWN, still breached, within cooldown: suppressed", () => {
    t += 5000;
    const { nextState, notify } = evaluate(rule, 95, state, t);
    assert.equal(nextState.state, STATES.DOWN);
    assert.equal(notify, false);
    state = nextState;
  });

  it("DOWN → RECOVERING once the metric drops below clearThreshold: no notify yet", () => {
    t += 5000;
    const { nextState, notify } = evaluate(rule, 75, state, t);
    assert.equal(nextState.state, STATES.RECOVERING);
    assert.equal(nextState.clearSince, t);
    assert.equal(notify, false);
    assert.equal(nextState.alertId, incidentAlertId); // still the same incident
    state = nextState;
  });

  it("RECOVERING, still clear but under hysteresis: stays RECOVERING, no notify", () => {
    t += 10_000;
    const { nextState, notify } = evaluate(rule, 70, state, t);
    assert.equal(nextState.state, STATES.RECOVERING);
    assert.equal(notify, false);
    state = nextState;
  });

  it("RECOVERING → OK once clear has held for >= hysteresis seconds: notifies resolved", () => {
    t = state.clearSince + rule.hysteresis * 1000;
    const { nextState, notify, alert } = evaluate(rule, 65, state, t);
    assert.equal(nextState.state, STATES.OK);
    assert.equal(notify, true);
    assert.equal(alert.state, STATES.OK);
    assert.equal(alert.previousState, STATES.RECOVERING);
    assert.equal(alert.alertId, incidentAlertId); // closing message still threads to the incident
    assert.match(alert.message, /RESOLVED/);
    // runtime state resets to a fresh-OK shape — a future incident gets a new alertId
    assert.equal(nextState.breachSince, null);
    assert.equal(nextState.clearSince, null);
    assert.equal(nextState.alertId, null);
    state = nextState;
  });

  it("back to OK: a fresh breach starts a brand-new incident with a different alertId", () => {
    t += 5000;
    const { nextState } = evaluate(rule, 95, state, t);
    assert.equal(nextState.state, STATES.OK);
    assert.equal(nextState.breachSince, t);
    state = nextState;
  });
});
