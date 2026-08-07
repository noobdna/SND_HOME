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

module.exports = {
  STATES,
  createInitialState,
  resolveMetric,
  compare,
};
