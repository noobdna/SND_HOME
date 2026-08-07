// alerts/alertEngine.js
// アラートエンジン: monitorEngine の 'update' イベントを購読し、有効な
// アラートルールを1件ずつ処理する。PHASE5_PLAN.md の「Architecture」
// 「Data Flow」節で言う AlertEngine — MonitorEngine 自体は変更せず、
// その 'update' イベントの購読者として動作する(historyStore.record() と
// 同じ立ち位置)。
//
// Task 3.1 で購読の開始/停止と、有効なルールをループする骨組みを作った。
// Task 3.2(このコミット)ではループの中身を実装: 各ルールについてスナップショットから
// 値を取り出し、ruleEvaluator.evaluate() を呼び、返ってきた次のランタイム状態を
// メモリ上に持続させる(PHASE5_PLAN.md「Duration」「Hysteresis」「Cooldown」節が言う
// 「ルールの定義とは別物の、AlertEngine がルールIDごとに保持するランタイム状態」)。
// 'alert' イベントの発行(notify/alert の活用)は Task 3.3 で追加する — 本タスクでは
// evaluate() が返す notify/alert はまだ使わない。monitorEngine.js が既に EventEmitter
// ベースの購読者パターンを確立しているため、AlertEngine 自身も将来 'alert' を
// 発行する EventEmitter として組み立てておく(File Structure 図の
// "AE -- emits 'alert' --> NR" に合わせた骨格)。
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
      const { nextState } = ruleEvaluator.evaluate(rule, value, currentState, now);
      this.runtimeStates.set(rule.id, nextState);
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
  // 将来の購読者(alertHistoryStore, notifierRegistry 等)向けのフック。
  // 現時点では何も emit() しない(Task 3.3 で 'alert' イベントを追加する)。
  on: (eventName, listener) => engine.on(eventName, listener),
  off: (eventName, listener) => engine.off(eventName, listener),
};
