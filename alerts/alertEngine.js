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
// Task 3.3(このコミット)では evaluate() が返す notify/alert を活かし、
// notify === true のティックで 'alert' イベントを発行する。monitorEngine.js が
// 既に EventEmitter ベースの購読者パターンを確立しているため、AlertEngine 自身も
// この 'alert' イベントの購読者(Task 3.4 の alertHistoryStore、Stage 4 の
// notifierRegistry)を、このファイルを変更せずに追加できる
// (File Structure 図の "AE -- emits 'alert' --> NR" に対応)。
const EventEmitter = require("events");
const monitorEngine = require("../monitor/monitorEngine");
const ruleStore = require("./ruleStore");
const ruleEvaluator = require("./ruleEvaluator");

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
   */
  start() {
    if (this.listening) return;
    monitorEngine.on("update", this.handleUpdate);
    this.listening = true;
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

module.exports = {
  start: () => engine.start(),
  stop: () => engine.stop(),
  // 'alert' イベントの購読/解除。ペイロードは PHASE5_PLAN.md「Notification Plugins」節の
  // 形(alertId/ruleId/ruleName/metric/value/operator/threshold/severity/state/
  // previousState/message/timestamp)。将来の購読者は alertHistoryStore(Task 3.4/3.5)、
  // notifierRegistry(Stage 4)。
  on: (eventName, listener) => engine.on(eventName, listener),
  off: (eventName, listener) => engine.off(eventName, listener),
};
