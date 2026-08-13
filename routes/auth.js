// routes/auth.js
// 認証設定自体の状態を返すルート(/api/auth/status)。
// routes/monitor.js・routes/alerts.js の GET /engine/status・routes/lan.js の
// GET /status と同じ流儀で、envelopeで包まず生のオブジェクトを返す
// ("エンジン/サブシステム自身の稼働状態"を返す既存エンドポイント群と揃える)。
//
// middleware/auth.js の requireAuth は API_KEY 未設定時はチェック自体を
// 行わない(無条件で next())。そのため「認証成功/失敗イベント」のログには
// API_KEY 未設定時の通過を一切記録しない(OBSERVABILITY_PLAN.md で確認済みの
// 方針) -- 代わりに、認証が現在有効かどうかをこの静的フィールドで見せる。
const express = require("express");

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({ enforced: Boolean(process.env.API_KEY) });
});

module.exports = router;
