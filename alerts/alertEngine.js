// alerts/alertEngine.js
// アラートエンジン: monitorEngine の 'update' イベントを購読し、有効な
// アラートルールを1件ずつ処理する。PHASE5_PLAN.md の「Architecture」
// 「Data Flow」節で言う AlertEngine — MonitorEngine 自体は変更せず、
// その 'update' イベントの購読者として動作する(historyStore.record() と
// 同じ立ち位置)。
//
// 現時点(Task 3.1)はスケルトンのみ: 購読の開始/停止と、有効なルールを
// ループする骨組みだけを実装している。ループの中身(ruleEvaluator.evaluate()
// の呼び出し・ランタイム状態の更新)は Task 3.2、'alert' イベントの発行は
// Task 3.3 で追加する。monitorEngine.js が既に EventEmitter ベースの
// 購読者パターンを確立しているため、AlertEngine 自身も将来 'alert' を
// 発行する EventEmitter として組み立てておく(File Structure 図の
// "AE -- emits 'alert' --> NR" に合わせた骨格)。
const EventEmitter = require("events");
const monitorEngine = require("../monitor/monitorEngine");
const ruleStore = require("./ruleStore");

class AlertEngine extends EventEmitter {
  constructor() {
    super();
    this.listening = false;
    this.handleUpdate = this.handleUpdate.bind(this);
  }

  /**
   * monitorEngine から 'update' イベントを受け取るたびに呼ばれる。
   * 現時点では有効なルールをループするだけの no-op — 実際の評価は Task 3.2 で追加する。
   * @param {object} snapshot - collectorRegistry.collectAll() が返した最新のスナップショット
   */
  handleUpdate(snapshot) {
    const enabledRules = ruleStore.list().filter((rule) => rule.enabled);
    for (const rule of enabledRules) {
      // no-op — Task 3.2 でここに ruleEvaluator.evaluate() の呼び出しと
      // ランタイム状態の更新を追加する。
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
