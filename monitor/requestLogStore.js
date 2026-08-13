// monitor/requestLogStore.js
// HTTPリクエストのアクセスログを一定件数だけメモリに保持するリングバッファ。
// monitor/historyStore.js・alerts/alertHistoryStore.js・monitor/eventLogStore.js
// と同じ設計(FIFO、上限超過分は古い順に破棄)。
//
// eventLogStore.js が「意味のある構造化イベント」(認証成功/失敗、エラー等)を
// 保持するのに対し、こちらは「完了した全HTTPリクエスト」を無条件に1件ずつ
// 記録する、質の異なるログ -- 「現在の接続数」「接続元IP一覧」はどちらも
// この生ログの集計から導出する(OBSERVABILITY_PLAN.md参照)。CPU/メモリ等の
// 5秒間隔メトリクスよりリクエスト頻度の方が高くなりうるため、上限は
// alertHistoryStore/eventLogStoreの500件より大きい2000件を既定とする。
//
// このファイル自体は Express を一切知らない(record() を実際に呼ぶのは
// middleware/requestTracker.js の役目) -- historyStore.js が
// monitorEngine.js を知らないのと同じ設計。
//
// 永続化: monitor/historyStore.js と同じ理由・同じ方式(定期スナップショット、
// monitor/ringBufferPersistence.js 共有ヘルパー使用)でJSON永続化する。
const path = require("path");
const { writeEntries, readEntries, createAutoFlush } = require("./ringBufferPersistence");

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

class RequestLogStore {
  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  /**
   * 1件の完了したリクエストを記録する。上限を超えた分は古い順に破棄する。
   * timestamp は呼び出し側が指定しなければ記録時刻を使う。
   * @param {{ method: string, path: string, ip: string, statusCode: number, durationMs: number, timestamp?: string }} entry
   */
  record(entry) {
    this.entries.push({
      timestamp: entry.timestamp || new Date().toISOString(),
      method: entry.method,
      path: entry.path,
      ip: entry.ip,
      statusCode: entry.statusCode,
      durationMs: entry.durationMs,
    });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * 履歴を取得する。limit指定時は直近limit件のみを返す
   * (monitor/eventLogStore.js の getHistory({limit}) と同じページング方針)。
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
   * 直近 windowMs ミリ秒以内に記録されたエントリだけを返す。
   * 「直近1分のリクエスト率」等、時間窓ベースの集計に使う
   * (件数ベースの getHistory({limit}) とは異なる切り口)。
   * @param {number} windowMs
   * @param {number} [now] テスト用に基準時刻を差し替え可能(省略時は Date.now())
   * @returns {object[]}
   */
  getRequestsSince(windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    return this.entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
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
    const entries = readEntries(filePath, "requestLogStore").filter((e) => e && typeof e === "object");
    this.entries = entries.slice(-this.maxEntries);
    return { loaded: this.entries.length };
  }
}

const store = new RequestLogStore();

const DEFAULT_REQUEST_LOG_PATH = path.join(__dirname, "..", "data", "requestLog.json");

/**
 * 永続化ファイルのパスを返す。REQUEST_LOG_PATH 環境変数があればそれを優先する。
 * @returns {string}
 */
function getRequestLogPath() {
  return process.env.REQUEST_LOG_PATH || DEFAULT_REQUEST_LOG_PATH;
}

const autoFlush = createAutoFlush(() => store.persist(getRequestLogPath()), DEFAULT_SNAPSHOT_INTERVAL_MS);

module.exports = {
  record: (entry) => store.record(entry),
  getHistory: (options) => store.getHistory(options),
  getRequestsSince: (windowMs, now) => store.getRequestsSince(windowMs, now),
  getMaxEntries: () => store.maxEntries,
  persist: (filePath = getRequestLogPath()) => store.persist(filePath),
  load: (filePath = getRequestLogPath()) => store.load(filePath),
  getRequestLogPath,
  startAutoFlush: autoFlush.start,
  stopAutoFlush: autoFlush.stop,
  // テスト用: 実運用の(2000件・共有シングルトンの)storeとは別に、小さい
  // maxEntries で独立したインスタンスを都度生成してリングバッファの境界条件を
  // 検証できるようにする -- monitor/historyStore.js の HistoryStore エクスポートと同じ理由。
  RequestLogStore,
};
