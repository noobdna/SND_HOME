// alerts/ruleEvaluator.js
// ルール評価の状態機械(state machine)ロジック。純粋関数のみで構成し、I/O を持たない
// (テストしやすさを優先 — PHASE5_PLAN.md の「File Structure」参照)。
// 状態遷移の詳細仕様は PHASE5_PLAN.md の「State Machine」セクションを参照。

const STATES = Object.freeze({
  OK: "OK",
  FIRING: "FIRING",
  DOWN: "DOWN",
  RECOVERING: "RECOVERING",
});

/**
 * ルール1件分の初期ランタイム状態を返す。
 * ランタイム状態はルール「定義」(RuleStore が持つ設定)とは別物で、AlertEngine が
 * ルールIDごとにメモリ上でのみ保持する(再起動で消えてよい — PHASE5_PLAN.md の
 * 「Duration」「Hysteresis」「Cooldown」「Duplicate Suppression」参照)。
 * @returns {{
 *   state: string,
 *   breachSince: number|null,
 *   clearSince: number|null,
 *   lastNotifiedAt: number|null,
 *   alertId: string|null,
 * }}
 */
function createInitialState() {
  return {
    state: STATES.OK,
    breachSince: null,
    clearSince: null,
    lastNotifiedAt: null,
    alertId: null,
  };
}

/**
 * ドットパス表記(例: "disk.percent")でスナップショットから値を取り出す。
 * 途中のプロパティが存在しない場合や snapshot / 中間値が null・undefined の場合も
 * 例外を投げず undefined を返す — 「データなし」として扱われ、その回の評価は
 * スキップされる(PHASE5_PLAN.md の Threshold Rules 「metric」欄を参照)。
 * @param {object} snapshot
 * @param {string} metricPath
 * @returns {*} 解決した値、または undefined(未検出/型不正)
 */
function resolveMetric(snapshot, metricPath) {
  if (typeof metricPath !== "string" || metricPath === "") {
    return undefined;
  }

  let current = snapshot;
  for (const key of metricPath.split(".")) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/**
 * value と threshold を operator で比較する。
 * "==" / "!=" は厳密等価(===/!==)で判定する — メトリクス値は数値である前提のため、
 * 型強制による意図しない一致(例: "90" == 90)を避ける。
 * value が undefined/NaN の場合(未検出メトリクス)の扱いは呼び出し元の責務
 * (「データなし」としてそのティックの評価自体をスキップする — resolveMetric の
 * JSDoc、および PHASE5_PLAN.md の Threshold Rules 「metric」欄を参照)。
 * @param {number} value
 * @param {">"|">="|"<"|"<="|"=="|"!="} operator
 * @param {number} threshold
 * @returns {boolean}
 * @throws {Error} operator が未知の場合(RuleStore の validateRule() が事前に
 *   ALLOWED_OPERATORS で弾いているため、通常到達しない)
 */
function compare(value, operator, threshold) {
  switch (operator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case "==":
      return value === threshold;
    case "!=":
      return value !== threshold;
    default:
      throw new Error(`Unknown operator: ${operator}`);
  }
}

/**
 * ルール1件を1ティック分評価し、次のランタイム状態を返す(純粋関数、I/Oなし)。
 * PHASE5_PLAN.md の「State Machine」節・Transition table に準拠。
 *
 * 現時点(Task 2.4)では `state.state === STATES.OK` から始まる遷移のみを実装している:
 *   - OK → OK(非ブリーチ、breachSince をリセット)
 *   - OK → OK(ブリーチ中だが `duration` 秒未満、breachSince を内部トラッキング)
 *   - OK → FIRING(`duration` 秒以上ブリーチが継続 — 通知あり)
 * FIRING/DOWN/RECOVERING から始まる遷移は Task 2.5〜2.7 で追加される。
 *
 * `value` が `undefined`(resolveMetric が「データなし」を返した場合)を渡すかどうかは
 * 呼び出し元の責務 — 本来はそのティックの評価自体をスキップすべきだが、万一そのまま
 * 渡された場合も compare() の null-safety により「非ブリーチ」として扱われるため、
 * 誤って発報することはない。
 *
 * @param {object} rule - normalizeRule() 済みのルール定義
 * @param {number} value - resolveMetric() で解決済みのメトリクス値
 * @param {object} state - このルールの現在のランタイム状態(`state.state === STATES.OK` であること)
 * @param {number} now - 現在時刻(epoch ms。通常は `Date.now()`)
 * @returns {{ nextState: object, notify: boolean, alert?: object }}
 * @throws {Error} `state.state` が `STATES.OK` 以外の場合(Task 2.5〜2.7 で解禁予定)
 */
function evaluate(rule, value, state, now) {
  if (state.state !== STATES.OK) {
    throw new Error(
      `evaluate() does not yet support transitions from state "${state.state}" (added in Task 2.5-2.7)`
    );
  }

  const breached = compare(value, rule.operator, rule.threshold);

  if (!breached) {
    return {
      nextState: { ...state, breachSince: null },
      notify: false,
    };
  }

  // 最初にブリーチを検知したティックで breachSince を刻む。以降のティックでは
  // 既存の breachSince を引き継ぎ、継続時間を計測する(PHASE5_PLAN.md「Duration」節)。
  const breachSince = state.breachSince ?? now;
  const durationMs = rule.duration * 1000;

  if (now - breachSince < durationMs) {
    return {
      nextState: { ...state, breachSince },
      notify: false,
    };
  }

  const incidentStartedAt = new Date(now).toISOString();
  const alertId = `${rule.id}:${incidentStartedAt}`;

  const nextState = {
    state: STATES.FIRING,
    breachSince,
    clearSince: null,
    lastNotifiedAt: now,
    alertId,
  };

  const alert = {
    alertId,
    ruleId: rule.id,
    ruleName: rule.name,
    metric: rule.metric,
    value,
    operator: rule.operator,
    threshold: rule.threshold,
    severity: rule.severity,
    state: STATES.FIRING,
    previousState: STATES.OK,
    message: `${rule.name} is FIRING: ${rule.metric} = ${value} (threshold ${rule.operator} ${rule.threshold})`,
    timestamp: incidentStartedAt,
  };

  return { nextState, notify: true, alert };
}

module.exports = {
  STATES,
  createInitialState,
  resolveMetric,
  compare,
  evaluate,
};
