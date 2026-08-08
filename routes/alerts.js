// routes/alerts.js
// アラート機能のREST API(/api/alerts/*)。PHASE5_PLAN.md「API」節参照。
// Task 6.1(このコミット)では読み取り専用の2エンドポイントのみ実装する:
//   GET /rules      — 全ルール一覧 + 各ルールの現在のランタイム状態
//   GET /rules/:id  — ルール1件 + そのランタイム状態
// POST/PUT/DELETE(Task 6.2)、/active(6.3)、/history(6.4)、/rules/:id/test(6.5)、
// /engine/status(6.7)は未実装。server.js への実際のマウントも Task 6.8 で行う
// (Stage 6 のタスク分割どおり、本ファイルの作成とマウントは別タスク)。
//
// レスポンス形は既存の routes/system.js・routes/monitor.js と同じ envelope
// (`{ status: "ok", data }` / `{ status: "error", message }`)に揃える。
const express = require("express");
const ruleStore = require("../alerts/ruleStore");
const alertEngine = require("../alerts/alertEngine");

const router = express.Router();

/**
 * ルール定義(ruleStore)とランタイム情報(alertEngine.getRuntime())を1つの
 * オブジェクトにまとめる — PHASE5_PLAN.md の GET /api/alerts/rules 例示レスポンスの
 * 各要素の形(ルールの全フィールド + `runtime` サブオブジェクト)。
 */
function withRuntime(rule) {
  return { ...rule, runtime: alertEngine.getRuntime(rule.id) };
}

router.get("/rules", (req, res) => {
  try {
    const data = ruleStore.list().map(withRuntime);
    res.json({ status: "ok", data });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

router.get("/rules/:id", (req, res) => {
  try {
    const rule = ruleStore.get(req.params.id);
    res.json({ status: "ok", data: withRuntime(rule) });
  } catch (error) {
    if (error instanceof ruleStore.RuleNotFoundError) {
      res.status(404).json({ status: "error", message: error.message });
      return;
    }
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

module.exports = router;
