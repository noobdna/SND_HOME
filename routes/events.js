// routes/events.js
// アプリケーション横断のイベントログAPI(/api/events)。
// monitor/eventLogStore.js を薄くラップするだけで、ビジネスロジックはここに
// 書かない(routes/alerts.js・routes/lan.js と同じ「ルートは薄いアダプタ」方針)。
//
//   GET /  — 記録済みイベントを取得(既定100件、最新順ではなく古い→新しい順、
//            routes/alerts.js の GET /history と同じページング方針)。
//            ?limit=N            件数上限
//            ?severity=a,b       カンマ区切り。指定した severity のみ
//                                 (info/warning/error) — 「エラー/警告」表示は
//                                 ?severity=warning,error で同じエンドポイントを
//                                 呼ぶだけで実現する(OBSERVABILITY_PLAN.md参照、
//                                 専用の /api/errors は用意しない)
//            ?category=a,b       カンマ区切り。指定した category のみ
//                                 (auth/monitor/lan/notifier)
//
// このエンドポイントはあえて認証で保護しない — 現状のダッシュボードUIは
// Authorizationヘッダーを送信する仕組みを持たず、/api/system と同水準の
// 公開エンドポイントとして扱う(OBSERVABILITY_PLAN.mdでユーザーと確認済みの方針)。
const express = require("express");
const eventLogStore = require("../monitor/eventLogStore");

const router = express.Router();

/**
 * カンマ区切りのクエリパラメータを配列にパースする。
 * 未指定時は undefined を返す(eventLogStore.getHistory() 側でフィルタなし扱いになる)。
 * 既知の値(VALID_SEVERITIES/VALID_CATEGORIES)以外は黙って無視する
 * (不正な値を渡されても500にはせず、単に該当なしのフィルタとして扱う)。
 */
function parseCsvParam(raw, validValues) {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const values = raw.split(",").map((v) => v.trim()).filter((v) => validValues.has(v));
  return values.length > 0 ? values : undefined;
}

router.get("/", (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100;
    const severity = parseCsvParam(req.query.severity, eventLogStore.VALID_SEVERITIES);
    const category = parseCsvParam(req.query.category, eventLogStore.VALID_CATEGORIES);

    const data = eventLogStore.getHistory({ limit, severity, category });
    res.json({
      status: "ok",
      count: data.length,
      data,
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

module.exports = router;
