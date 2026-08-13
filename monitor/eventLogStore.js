// monitor/eventLogStore.js
// アプリケーション全体の構造化イベント(認証成功/失敗、監視/LANスキャンの
// エラー、通知チャネル失敗等)を一定件数だけメモリに保持するリングバッファ。
// monitor/historyStore.js・alerts/alertHistoryStore.js と同じ設計
// (FIFO、上限超過分は古い順に破棄)。
//
// 「エラー/警告」表示と「イベントログ」表示は、このストアを持つ1本の
// タイムラインに対する severity フィルタの有無の違いでしかない — 別ストアを
// 2つ持つと「何がエラーか」の判定をストア間で二重に管理する必要が生まれるため、
// あえて1本にまとめている(OBSERVABILITY_PLAN.md 参照)。
//
// このファイル自体は各エンジン/ミドルウェアを一切知らない(record() を実際に
// 呼ぶ側の配線は各呼び出し元に任せる) -- historyStore.js が monitorEngine.js
// を知らないのと同じ設計。
//
// 永続化: monitor/historyStore.js と同じ理由・同じ方式(定期スナップショット、
// monitor/ringBufferPersistence.js 共有ヘルパー使用)でJSON永続化する。
const path = require("path");
const { writeEntries, readEntries, createAutoFlush } = require("./ringBufferPersistence");

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

const VALID_SEVERITIES = new Set(["info", "warning", "error"]);
const VALID_CATEGORIES = new Set(["auth", "monitor", "lan", "notifier"]);

class EventLogStore {
  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  /**
   * 1件のイベントを記録する。上限を超えた分は古い順に破棄する。
   * timestamp は呼び出し側が指定しなければ記録時刻を使う。
   * @param {{ category: string, severity: string, message: string, meta?: object, timestamp?: string }} event
   */
  record(event) {
    this.entries.push({
      timestamp: event.timestamp || new Date().toISOString(),
      category: event.category,
      severity: event.severity,
      message: event.message,
      meta: event.meta || {},
    });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * 履歴を取得する。limit指定時は直近limit件のみを返す
   * (alerts/alertHistoryStore.js の getHistory({limit}) と同じページング方針)。
   * severity/category を指定すると、それぞれ配列に含まれるものだけに絞り込む
   * (絞り込みを先に行い、その結果に対して limit を適用する — 「直近N件の
   * 絞り込み後の結果」を返す、routes/alerts.js の ?limit= と同じ「最新から
   * 数える」考え方)。
   * @param {{ limit?: number, severity?: string[], category?: string[] }} [options]
   * @returns {object[]}
   */
  getHistory({ limit, severity, category } = {}) {
    let filtered = this.entries;
    if (Array.isArray(severity) && severity.length > 0) {
      filtered = filtered.filter((e) => severity.includes(e.severity));
    }
    if (Array.isArray(category) && category.length > 0) {
      filtered = filtered.filter((e) => category.includes(e.category));
    }

    if (!limit || limit >= filtered.length) {
      return filtered.slice();
    }
    return filtered.slice(filtered.length - limit);
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
    const entries = readEntries(filePath, "eventLogStore").filter((e) => e && typeof e === "object");
    this.entries = entries.slice(-this.maxEntries);
    return { loaded: this.entries.length };
  }
}

const store = new EventLogStore();

const DEFAULT_EVENT_LOG_PATH = path.join(__dirname, "..", "data", "eventLog.json");

/**
 * 永続化ファイルのパスを返す。EVENT_LOG_PATH 環境変数があればそれを優先する。
 * @returns {string}
 */
function getEventLogPath() {
  return process.env.EVENT_LOG_PATH || DEFAULT_EVENT_LOG_PATH;
}

const autoFlush = createAutoFlush(() => store.persist(getEventLogPath()), DEFAULT_SNAPSHOT_INTERVAL_MS);

module.exports = {
  record: (event) => store.record(event),
  getHistory: (options) => store.getHistory(options),
  getMaxEntries: () => store.maxEntries,
  persist: (filePath = getEventLogPath()) => store.persist(filePath),
  load: (filePath = getEventLogPath()) => store.load(filePath),
  getEventLogPath,
  startAutoFlush: autoFlush.start,
  stopAutoFlush: autoFlush.stop,
  VALID_SEVERITIES,
  VALID_CATEGORIES,
  // テスト用: 実運用の(500件・共有シングルトンの)storeとは別に、小さい
  // maxEntries で独立したインスタンスを都度生成してリングバッファの境界条件を
  // 検証できるようにする -- monitor/historyStore.js の HistoryStore エクスポートと同じ理由。
  EventLogStore,
};
