// middleware/requestTracker.js
// Express経由の HTTP リクエストを追跡する軽量ミドルウェア。
// 「現在の接続数」の定義(OBSERVABILITY_PLAN.md で確認済み): WebSocketも
// SNDエージェントプロトコルもこのコードベースには存在しないため、実質的に
// 数えられるのは Express 経由の in-flight HTTPリクエスト数だけ -- ここでは
// それ(activeCount)と、直近の集計に使う生ログ(monitor/requestLogStore.js)を
// 記録する。server.js 側で `/api` にのみマウントし、静的ファイル配信
// (express.static("public"))は対象外とする(ダッシュボード自体のポーリングを
// 「意味のある接続」として過大に数えないようにする趣旨)。
//
// res の "finish"(正常完了)・"close"(クライアント切断等)の両方で
// activeCount を減算する必要があるが、同一リクエストで両方発火しうるため
// 二重デクリメントを防ぐガード(finished フラグ)を持つ。
//
// method/path/ip はミドルウェア実行時点(next()を呼ぶ前)で変数へ確定させ、
// "finish" イベント発火時にその値を使う -- req.path/req.url はネストした
// ルーター(例: app.use("/api/connections", ...))へディスパッチされる過程で
// マウントパス分だけ書き換えられるため、非同期の "finish" コールバック内で
// 遅延評価すると、実際より深く剥がされた断片的なパス(例: "/api/connections/status"
// が "/status" になる)を記録してしまう回帰があった(実機起動での確認で発覚)。
// req.originalUrl はリクエストの生存期間中ずっと書き換えられない値だが、
// 念のため method/ip も含めて開始時点でまとめて確定させる方が確実。
const requestLogStore = require("./../monitor/requestLogStore");

/**
 * register()/collectAll() 同様、実運用の共有シングルトンとは別に、
 * テストが独立したインスタンスを都度生成できるようにするファクトリ関数
 * (monitor/collectorRegistry.js の createRegistry() と同じ理由)。
 * @returns {{ middleware: Function, getSnapshot: Function }}
 */
function createTracker() {
  let activeCount = 0;
  let totalRequests = 0;
  const trackingSince = new Date().toISOString();

  function middleware(req, res, next) {
    activeCount++;
    const startedAt = process.hrtime.bigint();
    const method = req.method;
    const path = req.originalUrl;
    const ip = req.ip;
    let finished = false;

    function onFinish() {
      if (finished) return;
      finished = true;
      activeCount--;
      totalRequests++;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      requestLogStore.record({
        method,
        path,
        ip,
        statusCode: res.statusCode,
        durationMs,
      });
    }

    res.on("finish", onFinish);
    res.on("close", onFinish);

    next();
  }

  /**
   * @returns {{ activeCount: number, totalRequests: number, trackingSince: string }}
   */
  function getSnapshot() {
    return { activeCount, totalRequests, trackingSince };
  }

  return { middleware, getSnapshot };
}

const defaultTracker = createTracker();

module.exports = {
  trackRequests: defaultTracker.middleware,
  getSnapshot: defaultTracker.getSnapshot,
  createTracker,
};
