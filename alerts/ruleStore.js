// alerts/ruleStore.js
// アラートルールのスキーマ定義とバリデーション(副作用なしの純粋関数)。
// CRUD・JSON永続化は後続タスク(1.2, 1.3)で本ファイルに追加する。
// スキーマ・遷移ロジックの詳細は PHASE5_PLAN.md の「Alert Engine」セクションを参照。

const ALLOWED_OPERATORS = [">", ">=", "<", "<=", "==", "!="];

// PHASE5_PLAN.md の例(severity: "warning" | "critical")に、下位の "info" を加えた3段階。
const ALLOWED_SEVERITIES = ["info", "warning", "critical"];

// ルールIDはログ・ファイル永続化・API URLに使われる安定した識別子のため、
// 小文字英数字とハイフンのみ("disk-root-critical"のような形式)に制限する。
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const RULE_DEFAULTS = Object.freeze({
  duration: 0,
  hysteresis: 0,
  cooldown: 0,
  severity: "warning",
  channels: [],
  enabled: true,
});

/**
 * ルール定義を検証する。入力を変更せず、エラーメッセージの配列を返す(空配列 = 有効)。
 * @param {object} rule
 * @returns {string[]}
 */
function validateRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return ["Rule must be an object"];
  }

  const errors = [];

  if (typeof rule.id !== "string" || !ID_PATTERN.test(rule.id)) {
    errors.push('id must be a lowercase, hyphen-separated string (e.g. "disk-root-critical")');
  }

  if (typeof rule.name !== "string" || rule.name.trim() === "") {
    errors.push("name must be a non-empty string");
  }

  if (typeof rule.metric !== "string" || rule.metric.trim() === "") {
    errors.push('metric must be a non-empty string (dot-path, e.g. "disk.percent")');
  }

  if (!ALLOWED_OPERATORS.includes(rule.operator)) {
    errors.push(`operator must be one of ${ALLOWED_OPERATORS.join(", ")}`);
  }

  if (typeof rule.threshold !== "number" || Number.isNaN(rule.threshold)) {
    errors.push("threshold must be a number");
  }

  if (rule.clearThreshold !== undefined && rule.clearThreshold !== null) {
    if (typeof rule.clearThreshold !== "number" || Number.isNaN(rule.clearThreshold)) {
      errors.push("clearThreshold must be a number when provided");
    }
  }

  for (const field of ["duration", "hysteresis", "cooldown"]) {
    if (rule[field] !== undefined) {
      if (typeof rule[field] !== "number" || Number.isNaN(rule[field]) || rule[field] < 0) {
        errors.push(`${field} must be a non-negative number of seconds`);
      }
    }
  }

  if (rule.severity !== undefined && !ALLOWED_SEVERITIES.includes(rule.severity)) {
    errors.push(`severity must be one of ${ALLOWED_SEVERITIES.join(", ")}`);
  }

  if (rule.channels !== undefined) {
    const isValidChannelList =
      Array.isArray(rule.channels) &&
      rule.channels.every((c) => typeof c === "string" && c.trim() !== "");
    if (!isValidChannelList) {
      errors.push("channels must be an array of non-empty strings when provided");
    }
  }

  if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
    errors.push("enabled must be a boolean when provided");
  }

  return errors;
}

/**
 * 未指定フィールドに既定値を適用した新しいオブジェクトを返す(入力は変更しない)。
 * validateRule() を通過済みの rule に対して呼び出すことを想定する。
 * @param {object} rule
 * @returns {object}
 */
function normalizeRule(rule) {
  return {
    id: rule.id,
    name: rule.name,
    metric: rule.metric,
    operator: rule.operator,
    threshold: rule.threshold,
    clearThreshold: rule.clearThreshold ?? rule.threshold,
    duration: rule.duration ?? RULE_DEFAULTS.duration,
    hysteresis: rule.hysteresis ?? RULE_DEFAULTS.hysteresis,
    cooldown: rule.cooldown ?? RULE_DEFAULTS.cooldown,
    severity: rule.severity ?? RULE_DEFAULTS.severity,
    channels: rule.channels ?? [...RULE_DEFAULTS.channels],
    enabled: rule.enabled ?? RULE_DEFAULTS.enabled,
  };
}

module.exports = {
  ALLOWED_OPERATORS,
  ALLOWED_SEVERITIES,
  RULE_DEFAULTS,
  validateRule,
  normalizeRule,
};
