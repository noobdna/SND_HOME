// collectors/connectionsCollector.js
// monitor/collectorRegistry.js の既存Collectorプラグイン規約({name, collect()})
// に沿った軽量アダプタ。collectors/lanCollector.js と同じ考え方 --
// 実際の追跡は middleware/requestTracker.js が既に(Expressのミドルウェアとして)
// 行っており、ここではその最新スナップショットを読むだけの、ミリ秒未満で
// 完了する軽い呼び出し。
//
// 「直近1分のリクエスト数」を requestsLastMinute として付け加えているのは、
// activeCount(瞬間値)だけだと大半のリクエストが数ミリ秒で完了するため
// 3秒間隔のダッシュボード表示ではほぼ常に0に見えてしまい、単体では
// あまり有用な情報にならないため(OBSERVABILITY_PLAN.md参照)。
const requestTracker = require("../middleware/requestTracker");
const requestLogStore = require("../monitor/requestLogStore");

const ONE_MINUTE_MS = 60_000;

module.exports = {
  name: "connections",
  async collect() {
    const { activeCount, totalRequests } = requestTracker.getSnapshot();
    return {
      current: activeCount,
      requestsLastMinute: requestLogStore.getRequestsSince(ONE_MINUTE_MS).length,
      totalRequestsServed: totalRequests,
    };
  },
};
