// routes/connections.js
// 接続数・接続元IPのREST API(/api/connections/*)。
// middleware/requestTracker.js・monitor/requestLogStore.js を薄くラップする
// だけで、追跡ロジック自体はここに書かない(routes/alerts.js・routes/lan.js と
// 同じ「ルートは薄いアダプタ」方針)。
//
//   GET /status   — 現在の接続数(in-flight)・直近1分のリクエスト数・
//                    累計リクエスト数(requestTracker.getSnapshot() 相当)。
//                    routes/monitor.js の GET /status 等と同じくenvelopeなし。
//   GET /sources  — 接続元IPの一覧(直近ログから集計、リクエスト数・
//                    最終アクセス時刻付き)。既定50件。
//   GET /log      — 生のリクエストログ(既定120件、/api/system/history の
//                    ?limit= と同じページング方針)。
//
// このルーターはあえて認証で保護しない(OBSERVABILITY_PLAN.mdで確認済みの
// 方針、routes/events.js・routes/auth.js と同じ理由 -- ダッシュボードUIは
// Authorizationヘッダーを送信する仕組みを持たない)。
const express = require("express");
const requestTracker = require("../middleware/requestTracker");
const requestLogStore = require("../monitor/requestLogStore");

const ONE_MINUTE_MS = 60_000;
const DEFAULT_SOURCES_LIMIT = 50;
const DEFAULT_LOG_LIMIT = 120;

const router = express.Router();

router.get("/status", (req, res) => {
  const { activeCount, totalRequests, trackingSince } = requestTracker.getSnapshot();
  res.json({
    current: activeCount,
    requestsLastMinute: requestLogStore.getRequestsSince(ONE_MINUTE_MS).length,
    totalRequestsServed: totalRequests,
    trackingSince,
  });
});

/**
 * リクエストログから接続元IPを集計する。
 * @param {object[]} entries
 * @returns {{ ip: string, requestCount: number, firstSeenAt: string, lastSeenAt: string }[]}
 */
function aggregateSources(entries) {
  const byIp = new Map();
  for (const entry of entries) {
    const existing = byIp.get(entry.ip);
    if (!existing) {
      byIp.set(entry.ip, { ip: entry.ip, requestCount: 1, firstSeenAt: entry.timestamp, lastSeenAt: entry.timestamp });
      continue;
    }
    existing.requestCount += 1;
    existing.lastSeenAt = entry.timestamp;
  }
  return Array.from(byIp.values()).sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
}

router.get("/sources", (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_SOURCES_LIMIT;
    const sources = aggregateSources(requestLogStore.getHistory()).slice(0, limit);
    res.json({ status: "ok", count: sources.length, data: sources });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

router.get("/log", (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LOG_LIMIT;
    const data = requestLogStore.getHistory({ limit });
    res.json({ status: "ok", count: data.length, data });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

module.exports = router;
