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
//
// 永続化: monitor/historyStore.js と同じ理由・同じ方式(定期スナップショット、
// monitor/ringBufferPersistence.js 共有ヘルパー使用)でJSON永続化する。
const path = require("path");
const { writeEntries, readEntries, createAutoFlush } = require("../monitor/ringBufferPersistence");

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

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

  /**
   * 現在のentries配列をJSONファイルへ書き込む。
   * @param {string} filePath
   */
  persist(filePath) {
    writeEntries(filePath, this.entries);
  }

  /**
   * JSONファイルからentries配列を読み込み、内部状態を置き換える。
   * ファイルが無い/壊れている場合は空のまま(グレースフルデグレード)。
   * 上限件数(maxEntries)を超えて保存されていた場合は直近maxEntries件だけを
   * 採用する。
   * @param {string} filePath
   * @returns {{ loaded: number }}
   */
  load(filePath) {
    const entries = readEntries(filePath, "alertHistoryStore").filter((e) => e && typeof e === "object");
    this.entries = entries.slice(-this.maxEntries);
    return { loaded: this.entries.length };
  }
}

const store = new AlertHistoryStore();

const DEFAULT_ALERT_HISTORY_PATH = path.join(__dirname, "..", "data", "alertHistory.json");

/**
 * 永続化ファイルのパスを返す。ALERT_HISTORY_PATH 環境変数があればそれを優先する。
 * @returns {string}
 */
function getAlertHistoryPath() {
  return process.env.ALERT_HISTORY_PATH || DEFAULT_ALERT_HISTORY_PATH;
}

const autoFlush = createAutoFlush(() => store.persist(getAlertHistoryPath()), DEFAULT_SNAPSHOT_INTERVAL_MS);

module.exports = {
  record: (alert) => store.record(alert),
  getHistory: (options) => store.getHistory(options),
  getMaxEntries: () => store.maxEntries,
  persist: (filePath = getAlertHistoryPath()) => store.persist(filePath),
  load: (filePath = getAlertHistoryPath()) => store.load(filePath),
  getAlertHistoryPath,
  startAutoFlush: autoFlush.start,
  stopAutoFlush: autoFlush.stop,
  // テスト用: 実運用の(500件・共有シングルトンの)storeとは別に、小さい
  // maxEntries で独立したインスタンスを都度生成してリングバッファの境界条件を
  // 検証できるようにする -- monitor/historyStore.js の HistoryStore エクスポートと同じ理由。
  AlertHistoryStore,
};
