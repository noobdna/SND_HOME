// monitor/monitorEngine.js
// 常時監視エンジン: collectorRegistry を一定間隔で実行し、
// 最新値のみをメモリにキャッシュする。内部はEventEmitterによる
// イベント駆動(update/error)で動作し、将来の購読者(通知・ロギング等)を
// このファイルを変更せずに追加できる。
const EventEmitter = require("events");
const { collectAll } = require("./collectorRegistry");

const DEFAULT_INTERVAL_MS = 5000;

class MonitorEngine extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.latestSystemInfo = null;
    this.lastUpdated = null;
    this.startedAt = null;
  }

  /**
   * collectAll() を1回実行する。
   * 成功時は update イベントで通知してキャッシュを更新し、
   * 失敗時は error イベントを発行して直前のキャッシュ値を保持する。
   */
  async tick() {
    try {
      const data = await collectAll();
      this.latestSystemInfo = data;
      this.lastUpdated = new Date().toISOString();
      console.log("System cache updated");
      this.emit("update", data);
    } catch (error) {
      // Collectorが失敗してもプロセスは落とさず、直前のキャッシュを保持したまま次回ポーリングを継続する
      console.error("Polling error:", error.message || error);
      this.emit("error", error);
    }
  }

  /**
   * 監視を開始する。既に稼働中の場合は何もしない(二重起動防止)。
   * @param {number} [ms] ポーリング間隔(ms)。省略時は DEFAULT_INTERVAL_MS(5000ms)。
   */
  start(ms = DEFAULT_INTERVAL_MS) {
    if (this.timer) return;

    this.intervalMs = ms;
    this.startedAt = Date.now();
    console.log("Background polling started");
    this.tick(); // 初回値をすぐに取得する
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /**
   * 監視を停止する。タイマーが無い場合は何もしない。
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.startedAt = null;
  }

  getLatestSystemInfo() {
    return this.latestSystemInfo;
  }

  getStatus() {
    return {
      running: this.timer !== null,
      interval: this.intervalMs,
      lastUpdated: this.lastUpdated,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
    };
  }
}

const engine = new MonitorEngine();

module.exports = {
  startMonitoring: (ms) => engine.start(ms),
  stopMonitoring: () => engine.stop(),
  getLatestSystemInfo: () => engine.getLatestSystemInfo(),
  getStatus: () => engine.getStatus(),
  // 将来の購読者(EventCollector, WebSocket通知層等)向けのフック
  on: (eventName, listener) => engine.on(eventName, listener),
  off: (eventName, listener) => engine.off(eventName, listener),
};
