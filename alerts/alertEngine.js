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
    const enabledRules = ruleStore.list().filter((rule) => rule.enabled);

    for (const rule of enabledRules) {
      const value = ruleEvaluator.resolveMetric(snapshot, rule.metric);
      if (value === undefined) {
        continue;
      }

      const currentState = this.runtimeStates.get(rule.id) ?? ruleEvaluator.createInitialState();
      const { nextState, notify, alert } = ruleEvaluator.evaluate(rule, value, currentState, now);
      this.runtimeStates.set(rule.id, nextState);

      if (notify) {
        this.emit("alert", alert);
      }
    }
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
  // 'alert' イベントの購読/解除。ペイロードは PHASE5_PLAN.md「Notification Plugins」節の
  // 形(alertId/ruleId/ruleName/metric/value/operator/threshold/severity/state/
  // previousState/message/timestamp)。alertHistoryStore と notifierRegistry は
  // 上ですでに購読済み。
  on: (eventName, listener) => engine.on(eventName, listener),
  off: (eventName, listener) => engine.off(eventName, listener),
};
