// alerts/ruleEvaluator.test.js
// alerts/ruleEvaluator.js のユニットテスト。
// - happy-path フルサイクル(OK → FIRING → DOWN → RECOVERING → OK)(Task 2.8)
// - エッジケース: 境界値でのフラッピング・欠損メトリクス・duration=0・
//   rule.enabled の扱い(Task 2.9)
//
// 各ティックの遷移を個別の it() に分け、テスト間で同じ `state`/`t` を引き継いで
// 「実際に時間が進みながら1つのインシデントを追跡する」流れを1本の describe として
// 再現している(node:test は describe 内の it() を宣言順に逐次実行するため、この
// 依存関係は安全)。
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

const FIRED_AT = T0 + rule.duration * 1000;
const ALERT_ID = `${rule.id}:${new Date(FIRED_AT).toISOString()}`;

function downState(overrides = {}) {
  return {
    state: STATES.DOWN,
    breachSince: T0,
    clearSince: null,
    lastNotifiedAt: FIRED_AT,
    alertId: ALERT_ID,
    ...overrides,
  };
}

function firingState(overrides = {}) {
  return {
    state: STATES.FIRING,
    breachSince: T0,
    clearSince: null,
    lastNotifiedAt: FIRED_AT,
    alertId: ALERT_ID,
    ...overrides,
  };
}

function recoveringState(clearSince, overrides = {}) {
  return {
    state: STATES.RECOVERING,
    breachSince: T0,
    clearSince,
    lastNotifiedAt: FIRED_AT,
    alertId: ALERT_ID,
    ...overrides,
  };
}

describe("evaluate() — edge cases (Task 2.9)", () => {
  describe("flapping at the boundary", () => {
    it("OK: value exactly at an inclusive threshold (>=) counts as a breach", () => {
      const { nextState } = evaluate(rule, 90, createInitialState(), T0);
      assert.equal(nextState.breachSince, T0); // breach recognized, duration timer started
    });

    it("DOWN: flapping between breached and the threshold/clearThreshold dead zone does not reset or duplicate the incident", () => {
      let state = downState();
      let t = FIRED_AT;

      // still breached
      ({ nextState: state } = evaluate(rule, 95, state, t));
      assert.equal(state.state, STATES.DOWN);

      // dips into the dead zone (80 <= 84 < 90): not breached, not clear either
      t += 5000;
      ({ nextState: state } = evaluate(rule, 84, state, t));
      assert.equal(state.state, STATES.DOWN);
      assert.equal(state.clearSince, null);

      // breaches again
      t += 5000;
      ({ nextState: state } = evaluate(rule, 96, state, t));
      assert.equal(state.state, STATES.DOWN);

      // identity fields never moved through the flapping
      assert.equal(state.breachSince, T0);
      assert.equal(state.alertId, ALERT_ID);
    });

    it("DOWN: exactly at clearThreshold stays in the dead zone (strict-below semantics for >=)", () => {
      const { nextState } = evaluate(rule, 80, downState(), FIRED_AT + 5000);
      assert.equal(nextState.state, STATES.DOWN);
    });

    it("RECOVERING: dipping into the dead zone (not a re-breach) keeps the hysteresis timer running unmodified", () => {
      const clearSince = FIRED_AT + 10_000;
      const now = clearSince + 5000;
      const { nextState, notify } = evaluate(rule, 84, recoveringState(clearSince), now);
      assert.equal(nextState.state, STATES.RECOVERING);
      assert.equal(nextState.clearSince, clearSince); // untouched
      assert.equal(notify, false);
    });

    it("RECOVERING → DOWN → RECOVERING round trip mints a fresh clearSince but keeps the same alertId (same incident)", () => {
      const firstClearSince = FIRED_AT + 10_000;
      let state = recoveringState(firstClearSince);

      // re-breaches before hysteresis elapses -> back to DOWN
      let t = firstClearSince + 5000;
      ({ nextState: state } = evaluate(rule, 95, state, t));
      assert.equal(state.state, STATES.DOWN);
      assert.equal(state.clearSince, null);
      assert.equal(state.alertId, ALERT_ID);

      // clears again -> RECOVERING with a brand-new clearSince, same incident
      t += 5000;
      ({ nextState: state } = evaluate(rule, 75, state, t));
      assert.equal(state.state, STATES.RECOVERING);
      assert.equal(state.clearSince, t);
      assert.notEqual(state.clearSince, firstClearSince);
      assert.equal(state.alertId, ALERT_ID); // Duplicate Suppression: no new alertId minted
    });
  });

  describe("missing metric (value === undefined)", () => {
    it("OK: a missing metric is treated as a non-breach and does not start an incident", () => {
      const { nextState, notify } = evaluate(rule, undefined, createInitialState(), T0);
      assert.equal(nextState.state, STATES.OK);
      assert.equal(nextState.breachSince, null);
      assert.equal(notify, false);
    });

    it("FIRING: a missing metric is treated as fully clear and transitions directly to RECOVERING", () => {
      // Documented consequence of compare()'s null-safety (Task 2.3): for relational
      // operators, undefined never satisfies value >= clearThreshold, so the negation
      // used by resolveAfterBreachClears reads it as "clear". A real missing-data tick
      // should be skipped by the caller before ever reaching evaluate() (per
      // resolveMetric's contract) — this test pins down what happens if it isn't.
      const { nextState, notify } = evaluate(rule, undefined, firingState(), FIRED_AT + 5000);
      assert.equal(nextState.state, STATES.RECOVERING);
      assert.equal(notify, false);
    });

    it("DOWN: a missing metric is treated as fully clear and transitions to RECOVERING", () => {
      const { nextState, notify } = evaluate(rule, undefined, downState(), FIRED_AT + 5000);
      assert.equal(nextState.state, STATES.RECOVERING);
      assert.equal(notify, false);
    });

    it("RECOVERING: a missing metric does not count as a re-breach and can still resolve to OK once hysteresis elapses", () => {
      const clearSince = FIRED_AT + 10_000;
      const now = clearSince + rule.hysteresis * 1000;
      const { nextState, notify } = evaluate(rule, undefined, recoveringState(clearSince), now);
      assert.equal(nextState.state, STATES.OK);
      assert.equal(notify, true);
    });

    it("known gap: a '!=' operator rule treats a missing metric as a BREACH, not a non-breach", () => {
      // undefined !== threshold is always true in JS, so compare()'s null-safety
      // guarantee ("never causes an incorrect firing") does not hold for "!=" rules.
      // This is pre-existing behavior from Task 2.3, not introduced here — pinned
      // down as a known gap rather than silently treated as correct. Flagged to the
      // user; not fixed under this task's scope (tests only).
      const neqRule = { ...rule, operator: "!=" };
      const { nextState, notify } = evaluate(neqRule, undefined, createInitialState(), T0);
      assert.equal(nextState.state, STATES.OK);
      assert.equal(nextState.breachSince, T0); // treated as breaching, contrary to intent
      assert.equal(notify, false); // duration hasn't elapsed yet, but the timer did start
    });
  });

  describe("duration = 0", () => {
    it("OK → FIRING fires on the very first breaching tick when duration is 0", () => {
      const zeroDurationRule = { ...rule, duration: 0 };
      const { nextState, notify, alert } = evaluate(zeroDurationRule, 95, createInitialState(), T0);
      assert.equal(nextState.state, STATES.FIRING);
      assert.equal(notify, true);
      assert.ok(alert);
    });
  });

  describe("rule.enabled", () => {
    it("evaluate() ignores rule.enabled entirely — identical results whether true or false", () => {
      // Deciding whether to evaluate a disabled rule at all (and what to do with an
      // in-flight incident's runtime state when a rule is disabled mid-incident) is
      // the AlertEngine's job (Stage 3: "AE->RS: getEnabledRules()" filters before
      // calling evaluate()), not this pure state-machine function's. This test
      // documents that boundary: evaluate() does not special-case enabled/disabled.
      const enabledRule = { ...rule, enabled: true };
      const disabledRule = { ...rule, enabled: false };

      const a = evaluate(enabledRule, 95, downState(), FIRED_AT + 5000);
      const b = evaluate(disabledRule, 95, downState(), FIRED_AT + 5000);
      assert.deepEqual(a, b);
    });
  });
});
