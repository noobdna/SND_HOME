// monitor/historyStore.js
// メトリクス履歴を一定件数だけメモリに保持するリングバッファ。
// interfaces一覧など時系列として意味を持たない静的データは保持せず、
// チャート表示・将来のアラート評価に必要な数値メトリクスのみを間引いて記録する。
//
// 将来のアラート評価(閾値超過・トレンド検知等)は、getHistory() で
// この履歴を読み取るだけで実現できる設計にしてあり、本ファイルや
// monitorEngine.js の変更は不要(read-onlyな購読モデル)。
const DEFAULT_MAX_POINTS = 720; // 5秒間隔 x 720 = 1時間分

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
}

const store = new HistoryStore();

module.exports = {
  record: (snapshot) => store.record(snapshot),
  getHistory: (options) => store.getHistory(options),
  getMaxPoints: () => store.maxPoints,
};
