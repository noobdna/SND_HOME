// alerts/alertHistoryStore.js
// アラート状態遷移イベントの履歴を一定件数だけメモリに保持するリングバッファ。
// monitor/historyStore.js と同じ設計(FIFO、上限超過分は古い順に破棄)だが、
// スナップショットの間引き変換(historyStore.js の extractMetrics() 相当)は
// 不要 — alertEngine が 'alert' イベントで渡す alert オブジェクトは、そのつど
// 新規に組み立てられる(呼び出し元が使い回したり後から変更したりしない)ため、
// そのまま記録すれば十分。形は PHASE5_PLAN.md「Notification Plugins」節が
// 定義する alert オブジェクト(alertId/ruleId/ruleName/metric/value/operator/
// threshold/severity/state/previousState/message/timestamp)。
//
// PHASE5_PLAN.md「File Structure」節: 「alertHistoryStore.js # ring buffer of
// alert state-transition events」。alertEngine の 'alert' イベントへの配線
// (record() を実際に呼ぶところ)は Task 3.5 で行う — 本ファイルは単体の
// ring buffer として完結しており、alertEngine.js を一切知らない
// (historyStore.js が monitorEngine.js を知らないのと同じ設計)。
const DEFAULT_MAX_ENTRIES = 500;

class AlertHistoryStore {
  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  /**
   * 1件のアラートイベントを履歴に追加する。上限を超えた分は古い順に破棄する。
   * @param {object} alert - PHASE5_PLAN.md「Notification Plugins」節の形の alert オブジェクト
   */
  record(alert) {
    this.entries.push(alert);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * 履歴を取得する。limit指定時は直近limit件のみを返す
   * (PHASE5_PLAN.md の `GET /api/alerts/history?limit=N` と同じページング方針)。
   * @param {{ limit?: number }} [options]
   * @returns {object[]}
   */
  getHistory({ limit } = {}) {
    if (!limit || limit >= this.entries.length) {
      return this.entries.slice();
    }
    return this.entries.slice(this.entries.length - limit);
  }
}

const store = new AlertHistoryStore();

module.exports = {
  record: (alert) => store.record(alert),
  getHistory: (options) => store.getHistory(options),
  getMaxEntries: () => store.maxEntries,
  // テスト用: 実運用の(500件・共有シングルトンの)storeとは別に、小さい
  // maxEntries で独立したインスタンスを都度生成してリングバッファの境界条件を
  // 検証できるようにする -- monitor/historyStore.js の HistoryStore エクスポートと同じ理由。
  AlertHistoryStore,
};
