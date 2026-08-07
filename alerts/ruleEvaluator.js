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
 * `state.state === STATES.OK` から始まる1ティック分の評価(Task 2.4)。
 *   - OK → OK(非ブリーチ、breachSince をリセット)
 *   - OK → OK(ブリーチ中だが `duration` 秒未満、breachSince を内部トラッキング)
 *   - OK → FIRING(`duration` 秒以上ブリーチが継続 — 通知あり)
 * @returns {{ nextState: object, notify: boolean, alert?: object }}
 */
function evaluateFromOk(rule, value, state, now) {
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

/**
 * `state.state === STATES.FIRING` から始まる1ティック分の評価(Task 2.5)。
 * Transition table 上のガードは「次の評価ティックで、まだブリーチが継続している場合」
 * のみを規定している(state diagram 上も FIRING から出る矢印は DOWN 行きの一本のみ)。
 * `FIRING` は「1ティックだけ存在するエッジ状態」であり、通知はすでに `OK → FIRING`
 * 遷移時に送出済みのため、`FIRING → DOWN` では notify しない。
 *
 * ブリーチが継続していない場合(このティックで既にクリアしている)の遷移先は
 * Transition table にも state diagram にも定義がなく、Stage 2 のタスク分割上も
 * 明示的な担当タスクが存在しない — `DOWN`/`RECOVERING` 側の閾値(`clearThreshold`)
 * を要する判断であり、Task 2.6〜2.7 の範囲。ここでは意図しない挙動(例えば無条件に
 * DOWN 扱いしてしまい "まだ落ちている" という誤ったランタイム状態を作る)を避けるため、
 * 未対応として明示的に例外を投げる。
 *
 * @returns {{ nextState: object, notify: boolean, alert?: object }}
 * @throws {Error} このティックで既にブリーチが解消している場合(Task 2.6〜2.7 で解禁予定)
 */
function evaluateFromFiring(rule, value, state, now) {
  const breached = compare(value, rule.operator, rule.threshold);

  if (!breached) {
    throw new Error(
      "evaluate() does not yet support the breach clearing before FIRING reaches DOWN (added in Task 2.6-2.7)"
    );
  }

  return {
    nextState: { ...state, state: STATES.DOWN, clearSince: null },
    notify: false,
  };
}

/**
 * ルール1件を1ティック分評価し、次のランタイム状態を返す(純粋関数、I/Oなし)。
 * PHASE5_PLAN.md の「State Machine」節・Transition table に準拠。
 *
 * 現時点(Task 2.4〜2.5)では `state.state` が `OK` または `FIRING` の場合の遷移のみを
 * 実装している。詳細は `evaluateFromOk` / `evaluateFromFiring` の JSDoc を参照。
 * `DOWN`/`RECOVERING` から始まる遷移は Task 2.6〜2.7 で追加される。
 *
 * `value` が `undefined`(resolveMetric が「データなし」を返した場合)を渡すかどうかは
 * 呼び出し元の責務 — 本来はそのティックの評価自体をスキップすべきだが、万一そのまま
 * 渡された場合も compare() の null-safety により「非ブリーチ」として扱われるため、
 * 誤って発報することはない。
 *
 * @param {object} rule - normalizeRule() 済みのルール定義
 * @param {number} value - resolveMetric() で解決済みのメトリクス値
 * @param {object} state - このルールの現在のランタイム状態
 * @param {number} now - 現在時刻(epoch ms。通常は `Date.now()`)
 * @returns {{ nextState: object, notify: boolean, alert?: object }}
 * @throws {Error} `state.state` が `DOWN`/`RECOVERING` の場合(Task 2.6〜2.7 で解禁予定)、
 *   または `FIRING` でこのティック中にブリーチが解消している場合(同上)
 */
function evaluate(rule, value, state, now) {
  if (state.state === STATES.OK) {
    return evaluateFromOk(rule, value, state, now);
  }

  if (state.state === STATES.FIRING) {
    return evaluateFromFiring(rule, value, state, now);
  }

  throw new Error(
    `evaluate() does not yet support transitions from state "${state.state}" (added in Task 2.6-2.7)`
  );
}

module.exports = {
  STATES,
  createInitialState,
  resolveMetric,
  compare,
  evaluate,
};
