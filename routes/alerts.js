// routes/alerts.js
// アラート機能のREST API(/api/alerts/*)。PHASE5_PLAN.md「API」節参照。
// Task 6.1 で読み取り専用の2エンドポイントを実装した:
//   GET /rules      — 全ルール一覧 + 各ルールの現在のランタイム状態
//   GET /rules/:id  — ルール1件 + そのランタイム状態
// Task 6.2(このコミット)で最初の変更系(mutating)エンドポイントを追加する:
//   POST   /rules      — ルール新規作成
//   PUT    /rules/:id  — ルール更新
//   DELETE /rules/:id  — ルール削除(ランタイム状態も破棄)
// /active(6.3)、/history(6.4)、/rules/:id/test(6.5)、/engine/status(6.7)は未実装。
// server.js への実際のマウントも Task 6.8 で行う(Stage 6 のタスク分割どおり、
// 本ファイルの作成とマウントは別タスク)。
//
// レスポンス形は既存の routes/system.js・routes/monitor.js と同じ envelope
// (`{ status: "ok", data }` / `{ status: "error", message }`)に揃える。
//
// ⚠️ SECURITY TODO — 認証が未実装: PHASE5_PLAN.md の「API」節は「これらは本プロジェクト
// 最初の変更系(POST/PUT/DELETE)エンドポイントであり、読み取り専用の /api/system/* が
// まだ未認証でも、ここでの認証は必須(not optional)」と明記している。しかし
// Milestone 2 の認証ミドルウェアはこのリポジトリにまだ存在しない(grep 済み、
// middleware/ ディレクトリも無い)。ユーザーとの合意の上、今回は認証を追加せず
// 実装し、この事実をコード・PHASE5_PLAN.md 双方に明記して可視化する方針とした
// (ホームラボ規模・単一ユーザー運用を前提とした一時的な判断 — 本番公開前に
// 必ず認証ミドルウェアを追加すること)。
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

// PHASE5_PLAN.md「API」節: "Create a new rule (body validated against the schema above)"。
// バリデーションは ruleStore.create() → validateRule() が担う。RuleValidationError の
// .errors 配列をそのままレスポンスに含め、どのフィールドが不正かAPI利用者が判別できるようにする。
router.post("/rules", (req, res) => {
  try {
    const rule = ruleStore.create(req.body);
    res.status(201).json({ status: "ok", data: withRuntime(rule) });
  } catch (error) {
    if (error instanceof ruleStore.RuleValidationError) {
      res.status(400).json({ status: "error", message: error.message, errors: error.errors });
      return;
    }
    if (error instanceof ruleStore.RuleConflictError) {
      res.status(409).json({ status: "error", message: error.message });
      return;
    }
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

// PHASE5_PLAN.md「API」節: "Update an existing rule"。ruleStore.update() は部分更新
// (既存フィールドとのマージ)であり、id の変更は無視される(ruleStore.js 側の既存仕様)。
router.put("/rules/:id", (req, res) => {
  try {
    const rule = ruleStore.update(req.params.id, req.body);
    res.json({ status: "ok", data: withRuntime(rule) });
  } catch (error) {
    if (error instanceof ruleStore.RuleValidationError) {
      res.status(400).json({ status: "error", message: error.message, errors: error.errors });
      return;
    }
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

// PHASE5_PLAN.md「API」節: "Delete a rule (its runtime state is discarded too)"。
// ruleStore.remove() が失敗(未存在)した場合は alertEngine.clearRuntime() を呼ばない
// (削除が実際に成功した場合にのみランタイム状態を破棄する)。
router.delete("/rules/:id", (req, res) => {
  try {
    ruleStore.remove(req.params.id);
    alertEngine.clearRuntime(req.params.id);
    res.json({ status: "ok" });
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
