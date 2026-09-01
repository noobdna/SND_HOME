// routes/events.js
// アプリケーション横断のイベントログAPI(/api/events)。
// monitor/eventLogStore.js を薄くラップするだけで、ビジネスロジックはここに
// 書かない(routes/alerts.js・routes/lan.js と同じ「ルートは薄いアダプタ」方針)。
//
//   GET /  — 「履歴」(直近 eventLogStore.getRetentionDays() 日分。既定30日、
//            期限切れは自動でArchiveへ移動済みのためこのAPIには出てこない)を
//            取得(既定100件、最新順ではなく古い→新しい順、routes/alerts.js の
//            GET /history と同じページング方針)。
//            ?limit=N            件数上限
//            ?severity=a,b       カンマ区切り。指定した severity のみ
//                                 (info/warning/error) — 「エラー/警告」表示は
//                                 ?severity=warning,error で同じエンドポイントを
//                                 呼ぶだけで実現する(OBSERVABILITY_PLAN.md参照、
//                                 専用の /api/errors は用意しない)
//            ?category=a,b       カンマ区切り。指定した category のみ
//                                 (auth/monitor/lan/notifier)
//            ?from=ISO&to=ISO    timestampがその範囲内(両端含む)のものだけ
//            ?q=text             メッセージ本文の部分一致検索(大文字小文字無視)
//
//   GET /archive — 「過去ログ/Archive」(30日を超えて自動移動されたイベント。
//            削除はされず、こちらで参照・検索できる)を取得。クエリパラメータは
//            GET / と同一。
//
//   GET /summary — 履歴/Archiveの件数と保持日数を返す軽量な集計
//            (Dashboardが3階層のバッジ表示に使う。フル一覧を毎回取得せずに
//            件数だけ知りたい場合用)。
//
// このエンドポイントはあえて認証で保護しない — 現状のダッシュボードUIは
// Authorizationヘッダーを送信する仕組みを持たず、/api/system と同水準の
// 公開エンドポイントとして扱う(OBSERVABILITY_PLAN.mdでユーザーと確認済みの方針)。
//
// 「現在の状態」はこのファイルの対象外: eventLogStore は過去のイベントの
// 時系列ログであって「今アクティブな異常かどうか」を持たない(1件の履歴が
// 解決済みでも残り続ける設計 -- monitor/eventLogStore.js冒頭コメント参照)。
// 現在の状態は /api/monitor/status・/api/alerts/engine/status・/api/lan/status
// の lastError 等、各エンジンの一次情報を直接見る(public/app.js 参照)。
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

/**
 * req.query から getHistory()/getArchive() 共通のフィルタオブジェクトを組み立てる。
 * GET / と GET /archive の両方から使う(クエリパラメータの意味を一箇所にまとめる)。
 */
function parseFilterQuery(query) {
  const limitParam = parseInt(query.limit, 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100;
  const severity = parseCsvParam(query.severity, eventLogStore.VALID_SEVERITIES);
  const category = parseCsvParam(query.category, eventLogStore.VALID_CATEGORIES);
  const from = typeof query.from === "string" && query.from ? query.from : undefined;
  const to = typeof query.to === "string" && query.to ? query.to : undefined;
  const q = typeof query.q === "string" && query.q ? query.q : undefined;
  return { limit, severity, category, from, to, q };
}

router.get("/", (req, res) => {
  try {
    const data = eventLogStore.getHistory(parseFilterQuery(req.query));
    res.json({
      status: "ok",
      count: data.length,
      data,
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

router.get("/archive", (req, res) => {
  try {
    const data = eventLogStore.getArchive(parseFilterQuery(req.query));
    res.json({
      status: "ok",
      count: data.length,
      data,
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

router.get("/summary", (req, res) => {
  try {
    res.json({
      status: "ok",
      data: {
        historyCount: eventLogStore.getHistory().length,
        archiveCount: eventLogStore.getArchive().length,
        retentionDays: eventLogStore.getRetentionDays(),
      },
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

module.exports = router;
