// monitor/historyStore.js
// メトリクス履歴を一定件数だけメモリに保持するリングバッファ。
// interfaces一覧など時系列として意味を持たない静的データは保持せず、
// チャート表示・将来のアラート評価に必要な数値メトリクスのみを間引いて記録する。
//
// 将来のアラート評価(閾値超過・トレンド検知等)は、getHistory() で
// この履歴を読み取るだけで実現できる設計にしてあり、本ファイルや
// monitorEngine.js の変更は不要(read-onlyな購読モデル)。
//
// 永続化: プロセス再起動をまたいでトレンドチャートの履歴が失われないよう、
// alerts/ruleStore.js と同じJSON書き込みスルー方式で永続化する
// (共通部分は monitor/ringBufferPersistence.js に切り出し済み)。
// record()毎ではなく定期スナップショット方式 — 理由は
// ringBufferPersistence.js 冒頭コメント参照。
const path = require("path");
const { writeEntries, readEntries, createAutoFlush } = require("./ringBufferPersistence");

const DEFAULT_MAX_POINTS = 720; // 5秒間隔 x 720 = 1時間分
const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

function extractMetrics(snapshot) {
  return {
    timestamp: snapshot.timestamp,
    cpu: { usage: snapshot.cpu ? snapshot.cpu.usage : null },
    memory: { percent: snapshot.memory ? snapshot.memory.percent : null },
    disk: { percent: snapshot.disk ? snapshot.disk.percent : null },
    network: {
      rxBytes: snapshot.network ? snapshot.network.rxBytes : null,
      txBytes: snapshot.network ? snapshot.network.txBytes : null,
    },
    connections: {
      current: snapshot.connections ? snapshot.connections.current : null,
      requestsLastMinute: snapshot.connections ? snapshot.connections.requestsLastMinute : null,
    },
  };
}

class HistoryStore {
  constructor(maxPoints = DEFAULT_MAX_POINTS) {
    this.maxPoints = maxPoints;
    this.entries = [];
  }

  /**
   * 1件のスナップショットを履歴に追加する。上限を超えた分は古い順に破棄する。
   */
  record(snapshot) {
    this.entries.push(extractMetrics(snapshot));
    if (this.entries.length > this.maxPoints) {
      this.entries.shift();
    }
  }

  /**
   * 履歴を取得する。limit指定時は直近limit件のみを返す。
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
   * ファイルが無い/壊れている場合は空のまま(グレースフルデグレード、
   * alerts/ruleStore.js の load() と同じ方針)。上限件数(maxPoints)を
   * 超えて保存されていた場合は直近maxPoints件だけを採用する。
   * @param {string} filePath
   * @returns {{ loaded: number }}
   */
  load(filePath) {
    const entries = readEntries(filePath, "historyStore").filter((e) => e && typeof e === "object");
    this.entries = entries.slice(-this.maxPoints);
    return { loaded: this.entries.length };
  }
}

const store = new HistoryStore();

const DEFAULT_HISTORY_PATH = path.join(__dirname, "..", "data", "metricsHistory.json");

/**
 * 永続化ファイルのパスを返す。HISTORY_STORE_PATH 環境変数があればそれを優先する
 * (LAN_DEVICES_PATH/ALERTS_RULES_PATH と同じ規約)。
 * @returns {string}
 */
function getHistoryPath() {
  return process.env.HISTORY_STORE_PATH || DEFAULT_HISTORY_PATH;
}

const autoFlush = createAutoFlush(() => store.persist(getHistoryPath()), DEFAULT_SNAPSHOT_INTERVAL_MS);

module.exports = {
  record: (snapshot) => store.record(snapshot),
  getHistory: (options) => store.getHistory(options),
  getMaxPoints: () => store.maxPoints,
  persist: (filePath = getHistoryPath()) => store.persist(filePath),
  load: (filePath = getHistoryPath()) => store.load(filePath),
  getHistoryPath,
  // server.js が起動時に1回呼ぶ(定期スナップショットの開始)/シャットダウン時に
  // 呼ぶ(タイマー停止)想定。テストからは通常呼ばない。
  startAutoFlush: autoFlush.start,
  stopAutoFlush: autoFlush.stop,
  // テスト用: 実運用の(720件・共有シングルトンの)storeとは別に、小さい
  // maxPoints で独立したインスタンスを都度生成してリングバッファの境界条件を
  // 検証できるようにする -- lan/lanEngine.js の LanEngine エクスポートと同じ理由。
  HistoryStore,
};
