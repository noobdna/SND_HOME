// alerts/ruleStore.js
// アラートルールのスキーマ定義・バリデーション・インメモリCRUD・JSON永続化。
// スキーマ・遷移ロジックの詳細は PHASE5_PLAN.md の「Alert Engine」セクションを参照。
const fs = require("fs");
const path = require("path");

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
  // PHASE5_PLAN.md「Stage 9 — Stretch」Task 9.1。null = 未サイレンス。設定時は
  // ISO 8601 タイムスタンプ文字列(API/alertオブジェクトの他のタイムスタンプ
  // フィールドと同じ表現に揃える)— この時刻を過ぎるまで、このルールの通知は
  // 抑制される(評価・記録は抑制されない。Task 9.2 参照)。
  silencedUntil: null,
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

  if (rule.silencedUntil !== undefined && rule.silencedUntil !== null) {
    if (typeof rule.silencedUntil !== "string" || Number.isNaN(Date.parse(rule.silencedUntil))) {
      errors.push("silencedUntil must be null or a valid ISO 8601 timestamp string when provided");
    }
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
    // 呼び出し元の配列をそのまま保持すると、後から呼び出し元がその配列を
    // 変更した際にストア内部の状態まで書き換わってしまう。常に複製する。
    channels: rule.channels ? [...rule.channels] : [...RULE_DEFAULTS.channels],
    enabled: rule.enabled ?? RULE_DEFAULTS.enabled,
    silencedUntil: rule.silencedUntil ?? RULE_DEFAULTS.silencedUntil,
  };
}

// ---------------------------------------------------------
// インメモリCRUD + JSON永続化
// ---------------------------------------------------------

class RuleValidationError extends Error {
  constructor(errors) {
    super(`Invalid rule: ${errors.join("; ")}`);
    this.name = "RuleValidationError";
    this.errors = errors;
  }
}

class RuleNotFoundError extends Error {
  constructor(id) {
    super(`Rule not found: ${id}`);
    this.name = "RuleNotFoundError";
    this.id = id;
  }
}

class RuleConflictError extends Error {
  constructor(id) {
    super(`Rule already exists: ${id}`);
    this.name = "RuleConflictError";
    this.id = id;
  }
}

// id -> normalized rule。内部状態を呼び出し元に直接渡さないよう、
// 出入りの際は必ず cloneRule() を通す。
const rules = new Map();

function cloneRule(rule) {
  return { ...rule, channels: [...rule.channels] };
}

/**
 * 新しいルールを作成する。
 * @param {object} rule
 * @returns {object} 作成されたルール(複製)
 * @throws {RuleValidationError} スキーマ違反の場合
 * @throws {RuleConflictError} 同じidのルールが既に存在する場合
 */
function create(rule) {
  const errors = validateRule(rule);
  if (errors.length > 0) {
    throw new RuleValidationError(errors);
  }
  if (rules.has(rule.id)) {
    throw new RuleConflictError(rule.id);
  }

  const normalized = normalizeRule(rule);
  rules.set(normalized.id, normalized);
  persist();
  return cloneRule(normalized);
}

/**
 * 全ルールを配列で返す(複製)。
 * @returns {object[]}
 */
function list() {
  return Array.from(rules.values()).map(cloneRule);
}

/**
 * idでルールを1件取得する(複製)。
 * @param {string} id
 * @returns {object}
 * @throws {RuleNotFoundError}
 */
function get(id) {
  const rule = rules.get(id);
  if (!rule) {
    throw new RuleNotFoundError(id);
  }
  return cloneRule(rule);
}

/**
 * 既存ルールに変更をマージして更新する(部分更新)。
 * id は不変 — changes.id が渡されても無視され、既存のidが維持される。
 * @param {string} id
 * @param {object} changes
 * @returns {object} 更新後のルール(複製)
 * @throws {RuleNotFoundError} 対象のルールが存在しない場合
 * @throws {RuleValidationError} マージ後のルールがスキーマ違反の場合
 */
function update(id, changes) {
  const existing = rules.get(id);
  if (!existing) {
    throw new RuleNotFoundError(id);
  }

  const merged = { ...existing, ...changes, id };
  const errors = validateRule(merged);
  if (errors.length > 0) {
    throw new RuleValidationError(errors);
  }

  const normalized = normalizeRule(merged);
  rules.set(id, normalized);
  persist();
  return cloneRule(normalized);
}

/**
 * idでルールを削除する。
 * @param {string} id
 * @throws {RuleNotFoundError}
 */
function remove(id) {
  if (!rules.has(id)) {
    throw new RuleNotFoundError(id);
  }
  rules.delete(id);
  persist();
}

/**
 * 全ルールを消去する(インメモリのみ・ディスクには書き込まない)。
 * テストでの状態リセット、および load() が再読込前に内部状態を
 * 空にするために使う内部的な操作であり、ユーザー操作の結果ではないため
 * persist() は呼ばない。
 */
function clear() {
  rules.clear();
}

// ---------------------------------------------------------
// JSON永続化
// ---------------------------------------------------------
// ルール定義はユーザーが設定する構成情報であり、メトリクス履歴と違って
// 再起動のたびに失われてよいものではない。本格的なDB導入(Milestone 2の
// SQLite化)より前に、軽量な書き込みスルー方式のJSONファイルで永続化する。

const DEFAULT_RULES_PATH = path.join(__dirname, "..", "data", "alertRules.json");

/**
 * 永続化ファイルのパスを返す。ALERTS_RULES_PATH 環境変数があればそれを優先する。
 * @returns {string}
 */
function getRulesPath() {
  return process.env.ALERTS_RULES_PATH || DEFAULT_RULES_PATH;
}

/**
 * 現在のインメモリ状態をJSONファイルへ書き込む(内部関数、CRUDから呼ばれる)。
 * 書き込みに失敗した場合は例外を投げ、呼び出し元のCRUD操作へ伝播する。
 * インメモリの状態はこの時点で既に更新済みであり、書き込み失敗時のロール
 * バックは行わない(ホームラボ規模の用途では、失敗時に呼び出し元が操作を
 * 再試行すれば十分と判断し、トランザクション的な複雑さは導入しない)。
 * @param {string} [filePath]
 */
function persist(filePath = getRulesPath()) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const data = Array.from(rules.values());
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/**
 * JSONファイルからルールを読み込み、インメモリ状態を置き換える。
 * ファイルが存在しない場合は何もしない(初回起動など)。
 * ファイルが壊れている・個々のルールがスキーマ違反の場合はそのルールだけを
 * スキップして警告をログに出し、アプリ全体はクラッシュさせない
 * (collectors/networkCollector.js 等、既存コードのグレースフルデグレード
 * の方針に合わせている)。
 * @param {string} [filePath]
 * @returns {{ loaded: number, skipped: number }}
 */
function load(filePath = getRulesPath()) {
  clear();

  if (!fs.existsSync(filePath)) {
    return { loaded: 0, skipped: 0 };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.warn(`[ruleStore] Failed to read ${filePath}: ${error.message}`);
    return { loaded: 0, skipped: 0 };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[ruleStore] Failed to parse ${filePath} as JSON: ${error.message}`);
    return { loaded: 0, skipped: 0 };
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[ruleStore] ${filePath} does not contain a JSON array; ignoring`);
    return { loaded: 0, skipped: 0 };
  }

  let loaded = 0;
  let skipped = 0;
  for (const rule of parsed) {
    const errors = validateRule(rule);
    if (errors.length > 0) {
      console.warn(
        `[ruleStore] Skipping invalid rule "${rule && rule.id}" from ${filePath}: ${errors.join("; ")}`
      );
      skipped++;
      continue;
    }
    if (rules.has(rule.id)) {
      console.warn(`[ruleStore] Skipping duplicate rule id "${rule.id}" from ${filePath}`);
      skipped++;
      continue;
    }
    rules.set(rule.id, normalizeRule(rule));
    loaded++;
  }

  return { loaded, skipped };
}

// PHASE5_PLAN.md「File Structure」節: `config/defaultAlertRules.json`
// 「seed rules loaded on first-ever run (empty rule store)」(Task 7.1/7.2)。
const DEFAULT_SEED_PATH = path.join(__dirname, "..", "config", "defaultAlertRules.json");

/**
 * サーバー起動時のエントリポイント。永続化ファイル(既定 alertRules.json)が
 * 既に存在する場合は通常通り load() する。存在しない場合(初回起動)は
 * config/defaultAlertRules.json のシードルールを読み込み、永続化ファイルへ
 * 書き込む — 以降の起動では「既存ファイルあり」経路に入るため、シードは
 * 一度だけ行われ、その後はユーザーが編集した実データとして扱われる
 * (シード後にユーザーが編集/削除しても、次回起動時に元のシードへ巻き戻る
 * ことはない)。
 *
 * 気付いた前提: server.js はこれまで起動時に load() を一切呼んでいなかった
 * (grep で確認済み)— つまり API 経由で作成したルールは JSON へ書き込みスルー
 * されてはいたが、プロセス再起動のたびに読み戻されず、インメモリの
 * ruleStore は常に空の状態から始まっていた。本関数はこの「起動時ロード」
 * 自体も初めて導入する — Task 7.2 の題名(「初回起動時のみシードする」)が
 * 成立するには、そもそも「起動時にロードする」という前提の仕組みが必要なため、
 * この導入は 7.2 のスコープの一部とみなした。
 * @param {string} [filePath] 実運用の永続化パス(既定 getRulesPath())
 * @param {string} [seedFilePath] シードデータのパス(既定 config/defaultAlertRules.json)
 * @returns {{ loaded: number, skipped: number, seeded: boolean }}
 */
function loadOrSeed(filePath = getRulesPath(), seedFilePath = DEFAULT_SEED_PATH) {
  if (fs.existsSync(filePath)) {
    const result = load(filePath);
    console.log(
      `[ruleStore] Loaded ${result.loaded} rule(s) from ${filePath}` +
        (result.skipped ? ` (${result.skipped} skipped)` : "")
    );
    return { ...result, seeded: false };
  }

  const result = load(seedFilePath);
  persist(filePath);
  console.log(
    `[ruleStore] No existing rules file found — seeded ${result.loaded} default rule(s) from ${seedFilePath}`
  );
  return { ...result, seeded: true };
}

module.exports = {
  ALLOWED_OPERATORS,
  ALLOWED_SEVERITIES,
  RULE_DEFAULTS,
  validateRule,
  normalizeRule,
  RuleValidationError,
  RuleNotFoundError,
  RuleConflictError,
  create,
  list,
  get,
  update,
  remove,
  clear,
  load,
  loadOrSeed,
  persist,
  getRulesPath,
};
