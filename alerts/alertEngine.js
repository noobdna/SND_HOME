// alerts/alertEngine.js
// アラートエンジン: monitorEngine の 'update' イベントを購読し、有効な
// アラートルールを1件ずつ処理する。PHASE5_PLAN.md の「Architecture」
// 「Data Flow」節で言う AlertEngine — MonitorEngine 自体は変更せず、
// その 'update' イベントの購読者として動作する(historyStore.record() と
// 同じ立ち位置)。
//
// Task 3.1 で購読の開始/停止と、有効なルールをループする骨組みを作った。
// Task 3.2 でループの中身(値の取り出し・ruleEvaluator.evaluate() の呼び出し・
// 次のランタイム状態のメモリ上への持続)を実装した(PHASE5_PLAN.md「Duration」
// 「Hysteresis」「Cooldown」節が言う「ルールの定義とは別物の、AlertEngine が
// ルールIDごとに保持するランタイム状態」)。
// Task 3.3 では evaluate() が返す notify/alert を活かし、notify === true の
// ティックで 'alert' イベントを発行するようにした。Task 3.4 で alertHistoryStore
// (状態遷移イベントの ring buffer)を独立したモジュールとして作った — この時点では
// alertEngine.js を一切知らない、単体で完結したストアだった。
// Task 3.5(このコミット)では、その alertHistoryStore を AlertEngine 自身の 'alert'
// イベントの購読者として配線する: `engine.on("alert", alertHistoryStore.record)`。
// これにより alertHistoryStore は「発行されたすべての 'alert' イベントを記録する」
// 最初の購読者になった(File Structure 図の "AE -- records every transition --> AHS"
// に対応)。
// Stage 4(このコミット)では notifierRegistry.dispatch を同じ 'alert' イベントの
// 2人目の購読者として並行登録する — このファイルの他の部分は変更不要
// (File Structure 図の "AE -- emits 'alert' --> NR" に対応)。Stage 4 時点では
// notifiers/*.js(Stage 5)がまだ無いため notifierRegistry には何も登録されておらず、
// dispatch() は実質 no-op(登録済み通知先ゼロの Promise.allSettled)。
const EventEmitter = require("events");
const monitorEngine = require("../monitor/monitorEngine");
const ruleStore = require("./ruleStore");
const ruleEvaluator = require("./ruleEvaluator");
const alertHistoryStore = require("./alertHistoryStore");
const notifierRegistry = require("./notifierRegistry");

class AlertEngine extends EventEmitter {
  constructor() {
    super();
    this.listening = false;
    this.handleUpdate = this.handleUpdate.bind(this);
    // ルールIDごとのランタイム状態(state/breachSince/clearSince/lastNotifiedAt/alertId)。
    // ルール「定義」(ruleStore)とは別物 — プロセス再起動で消えてよい
    // (PHASE5_PLAN.md の「Duration」節、createInitialState() の JSDoc参照)。
    this.runtimeStates = new Map();
    // ルールIDごとに直近解決できたメトリクス値。ruleEvaluator の状態機械には
    // 含まれない(evaluate() への入力パラメータであり、保持するランタイム状態の
    // 一部ではない — ruleEvaluator.js のドキュメント通りの状態形をあえて汚さない)。
    // GET /api/alerts/rules の runtime.value(Stage 6)専用の、表示用の副次情報。
    this.lastValues = new Map();
    // monitorEngine の 'update' を最後に処理した時刻(ISO文字列)。
    // GET /api/alerts/engine/status の lastEvaluatedAt(Task 6.7)専用 —
    // monitorEngine.js の lastUpdated と同じ設計(ティックのたびに更新、
    // 対象ルールの有無に関わらず「最後に処理を試みた時刻」を表す)。
    this.lastEvaluatedAt = null;
  }

  /**
   * monitorEngine から 'update' イベントを受け取るたびに呼ばれる。
   * 有効な各ルールについて: スナップショットから値を取り出し(データなしならその
   * ルールのこのティックの評価をスキップ — resolveMetric() の契約通り)、既存の
   * ランタイム状態(初見のルールなら createInitialState())を使って評価し、
   * 返ってきた nextState をランタイム状態に反映する。全ルールが同じ `now` を
   * 共有する(このティック内で評価がぶれないように、ループの外で一度だけ取得)。
   *
   * `notify === true` の場合(OK→FIRING・DOWN の cooldown 再通知・RECOVERING→OK)、
   * `evaluate()` が返す `alert`(PHASE5_PLAN.md「Notification Plugins」節の
   * ドキュメント通りの形)をそのまま 'alert' イベントとして発行する。ランタイム状態の
   * 更新は notify の有無に関わらず常に行う — 通知は「発火するかどうか」の話であり、
   * 状態遷移そのものとは独立している(例: DOWN→DOWN のクールダウン抑制中でも
   * ランタイム状態は毎ティック持続させる必要がある)。
   * @param {object} snapshot - collectorRegistry.collectAll() が返した最新のスナップショット
   */
  handleUpdate(snapshot) {
    const now = Date.now();
    this.lastEvaluatedAt = new Date(now).toISOString();
    const enabledRules = ruleStore.list().filter((rule) => rule.enabled);

    for (const rule of enabledRules) {
      const value = ruleEvaluator.resolveMetric(snapshot, rule.metric);
      if (value === undefined) {
        continue;
      }
      this.lastValues.set(rule.id, value);

      const currentState = this.runtimeStates.get(rule.id) ?? ruleEvaluator.createInitialState();
      const { nextState, notify, alert } = ruleEvaluator.evaluate(rule, value, currentState, now);
      this.runtimeStates.set(rule.id, nextState);

      if (notify) {
        this.emit("alert", alert);
      }
    }
  }

  /**
   * ルール1件の表示用ランタイム情報を返す(PHASE5_PLAN.md `GET /api/alerts/rules`
   * の例示レスポンスにある `runtime` オブジェクトと同じ形: `{ state, value, since,
   * lastNotifiedAt }`)。まだ一度も評価されていないルール(作成直後で monitorEngine
   * のティックがまだ来ていない等)には `createInitialState()`相当のOK状態を返す —
   * 「未評価」という3つ目の概念を新設せず、状態機械が元々持つ意味のある初期値に
   * フォールバックすることで、API利用者は常に整形済みの runtime オブジェクトを
   * 受け取れる(null分岐が不要)。
   *
   * `since` は state に応じて意味が変わる:
   *   - `FIRING`/`DOWN` → `breachSince`(このインシデントが始まった時刻)
   *   - `RECOVERING` → `clearSince`(クリアし始めた時刻)
   *   - `OK` → 常に `null`(`breachSince` が内部的に進行中でも外部には見せない —
   *     Transition table の「OK→OK(内部 `breachSince` 計測中)」は
   *     "intentionally invisible externally" と明記されている)
   *
   * @param {string} ruleId
   * @returns {{ state: string, value: number|null, since: string|null, lastNotifiedAt: string|null }}
   */
  getRuntime(ruleId) {
    const state = this.runtimeStates.get(ruleId) ?? ruleEvaluator.createInitialState();
    const value = this.lastValues.get(ruleId) ?? null;

    let sinceMs = null;
    if (state.state === ruleEvaluator.STATES.FIRING || state.state === ruleEvaluator.STATES.DOWN) {
      sinceMs = state.breachSince;
    } else if (state.state === ruleEvaluator.STATES.RECOVERING) {
      sinceMs = state.clearSince;
    }

    return {
      state: state.state,
      value,
      since: sinceMs !== null ? new Date(sinceMs).toISOString() : null,
      lastNotifiedAt: state.lastNotifiedAt !== null ? new Date(state.lastNotifiedAt).toISOString() : null,
    };
  }

  /**
   * ルール1件分のランタイム状態(state/breachSince/... と直近メトリクス値)を破棄する。
   * `DELETE /api/alerts/rules/:id`(Task 6.2)専用 — PHASE5_PLAN.md の DELETE
   * エンドポイントの説明に明記されている「its runtime state is discarded too」を
   * 実装する。ルールIDが存在しない/一度も評価されていない場合も安全な no-op
   * (Map#delete() は該当キーが無くても例外を投げない)。
   * @param {string} ruleId
   */
  clearRuntime(ruleId) {
    this.runtimeStates.delete(ruleId);
    this.lastValues.delete(ruleId);
  }

  /**
   * アラートエンジン自体の稼働状態を返す(PHASE5_PLAN.md `GET /api/alerts/engine/status`
   * — "mirrors /api/monitor/status" と明記されている通り、monitorEngine.getStatus() と
   * 同じ「自己完結した getStatus()」設計に揃える。ルート層(routes/alerts.js)は
   * 何も計算せず、この戻り値をそのまま返すだけでよい)。
   *
   * `activeAlertsCount` は `GET /api/alerts/active`(Task 6.3)と同じ定義
   * (`runtime.state !== STATES.OK`)を使う — `this.runtimeStates` を直接数えるより
   * 遅いが、`getRuntime()` を経由することで両エンドポイントの「アクティブ」の定義が
   * 決してズレない(未評価ルールの createInitialState() フォールバックも含めて一致する)。
   * @returns {{ running: boolean, rulesCount: number, activeAlertsCount: number, lastEvaluatedAt: string|null }}
   */
  getStatus() {
    const rules = ruleStore.list();
    const activeAlertsCount = rules.filter(
      (rule) => this.getRuntime(rule.id).state !== ruleEvaluator.STATES.OK
    ).length;

    return {
      running: this.listening,
      rulesCount: rules.length,
      activeAlertsCount,
      lastEvaluatedAt: this.lastEvaluatedAt,
    };
  }

  /**
   * monitorEngine の 'update' イベント購読を開始する。
   * 既に購読中の場合は何もしない(二重登録防止 — monitorEngine.start() と同じ方針)。
   * monitorEngine.start() が起動時に "Background polling started" をログ出力するのと
   * 同じ運用可視性のため、購読開始時にログを1行出す(停止時は monitorEngine.stop() に
   * ならいログを出さない)。
   */
  start() {
    if (this.listening) return;
    monitorEngine.on("update", this.handleUpdate);
    this.listening = true;
    console.log("Alert engine started");
  }

  /**
   * 購読を解除する。購読していない場合は何もしない。
   */
  stop() {
    if (!this.listening) return;
    monitorEngine.off("update", this.handleUpdate);
    this.listening = false;
  }
}

const engine = new AlertEngine();

// alertHistoryStore を最初の 'alert' 購読者として配線する。monitorEngine.js が
// collectorRegistry の register() 呼び出しをモジュール読み込み時に固定で行っている
// のと同じ考え方 — この購読は start()/stop() の対象ではなく、プロセスの寿命全体で
// 常に有効(handleUpdate() 自体が monitorEngine の 'update' 購読中にしか呼ばれない
// ため、実質的には start() 中にしか 'alert' は発行されないが、購読自体は無条件)。
engine.on("alert", alertHistoryStore.record);
engine.on("alert", notifierRegistry.dispatch);

module.exports = {
  start: () => engine.start(),
  stop: () => engine.stop(),
  // ルール1件の表示用ランタイム情報(Stage 6 の routes/alerts.js が使う読み取り専用API)。
  getRuntime: (ruleId) => engine.getRuntime(ruleId),
  // ルール削除時(DELETE /api/alerts/rules/:id、Task 6.2)にランタイム状態も破棄する。
  clearRuntime: (ruleId) => engine.clearRuntime(ruleId),
  // アラートエンジン自体の稼働状態(GET /api/alerts/engine/status、Task 6.7)。
  getStatus: () => engine.getStatus(),
  // 'alert' イベントの購読/解除。ペイロードは PHASE5_PLAN.md「Notification Plugins」節の
  // 形(alertId/ruleId/ruleName/metric/value/operator/threshold/severity/state/
  // previousState/message/timestamp)。alertHistoryStore と notifierRegistry は
  // 上ですでに購読済み。
  on: (eventName, listener) => engine.on(eventName, listener),
  off: (eventName, listener) => engine.off(eventName, listener),
};
