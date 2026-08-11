// routes/alerts.js
// アラート機能のREST API(/api/alerts/*)。PHASE5_PLAN.md「API」節参照。
// Task 6.1 で読み取り専用の2エンドポイントを実装した:
//   GET /rules      — 全ルール一覧 + 各ルールの現在のランタイム状態
//   GET /rules/:id  — ルール1件 + そのランタイム状態
// Task 6.2 で最初の変更系(mutating)エンドポイントを追加した:
//   POST   /rules      — ルール新規作成
//   PUT    /rules/:id  — ルール更新
//   DELETE /rules/:id  — ルール削除(ランタイム状態も破棄)
// Task 6.3 で /active を追加した:
//   GET /active — FIRING/DOWN/RECOVERING のルールのみ一覧
// Task 6.4 で /history を追加した:
//   GET /history?limit=N — 最近のアラート状態遷移イベント(既定100件)
// Task 6.5 で /rules/:id/test を追加した:
//   POST /rules/:id/test — 合成アラートを実際に通知先へ送信(実ブリーチ不要)
// Task 6.7 で /engine/status を追加した:
//   GET /engine/status — アラートエンジン自体の稼働状態
// Task 6.8 で server.js に /api/alerts としてマウント済み。
// Task 9.2(Stage 9 — Stretch)で /rules/:id/silence を追加した:
//   POST /rules/:id/silence — 指定期間、このルールの通知だけを抑制する
//   (評価・履歴記録は継続。解除は PUT /rules/:id で silencedUntil: null)
//
// レスポンス形は既存の routes/system.js・routes/monitor.js と同じ envelope
// (`{ status: "ok", data }` / `{ status: "error", message }`)に揃えるが、
// GET /engine/status だけは例外 — PHASE5_PLAN.md が明示的に
// "mirrors /api/monitor/status" と書いており、routes/monitor.js の
// GET /status は envelope で包まず生のオブジェクトをそのまま返す設計のため、
// それに合わせる(本ファイル内で唯一 envelope を使わないエンドポイント)。
//
// SECURITY: 変更系(POST/PUT/DELETE)エンドポイントは middleware/auth.js の
// requireAuth をそれぞれ個別に通す(オプトイン — API_KEY 未設定なら従来通り
// 無認証、設定時のみ Bearer トークンを要求。経緯は middleware/auth.js 冒頭の
// コメント参照)。GET エンドポイントは対象外(routes/system.js 同様、引き続き
// 無認証のまま)。
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ruleStore = require("../alerts/ruleStore");
const alertEngine = require("../alerts/alertEngine");
const alertHistoryStore = require("../alerts/alertHistoryStore");
const notifierRegistry = require("../alerts/notifierRegistry");
const { STATES } = require("../alerts/ruleEvaluator");

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

// PHASE5_PLAN.md「API」節: "List only rules currently in FIRING, DOWN, or RECOVERING —
// the 'what's broken right now' view"。GET /rules と同じ rule+runtime の形を返し、
// runtime.state が OK のものだけを除外する(4値のうち3つ = FIRING/DOWN/RECOVERING)。
// enabled: false のルールでも、無効化される前から続く runtime.state がまだ
// FIRING/DOWN/RECOVERING のままなら含める — 無効化はそれ以降の評価を止めるだけで、
// 進行中のインシデントを遡って解消したことにはならない(alertEngine.js のループが
// 無効化ルールを評価対象から外すだけで、既存のランタイム状態はそのまま残る設計と一貫)。
router.get("/active", (req, res) => {
  try {
    const data = ruleStore
      .list()
      .map(withRuntime)
      .filter((entry) => entry.runtime.state !== STATES.OK);
    res.json({ status: "ok", data });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

// PHASE5_PLAN.md「API」節: "Recent alert state-transition events (default 100),
// mirrors /api/system/history's shape/pagination"。routes/system.js の
// GET /system/history と同じ ?limit= の解釈(数値でなければ既定値、0以下も既定値)。
// system/history の `interval`(monitorEngineのポーリング間隔)に相当するフィールドは
// 持たない — アラート履歴は固定間隔のティックではなく状態遷移イベントそのものなので、
// 「間隔」という概念自体が存在しない。
router.get("/history", (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100;
    const data = alertHistoryStore.getHistory({ limit });
    res.json({
      status: "ok",
      count: data.length,
      data,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

// PHASE5_PLAN.md「API」節: "Create a new rule (body validated against the schema above)"。
// バリデーションは ruleStore.create() → validateRule() が担う。RuleValidationError の
// .errors 配列をそのままレスポンスに含め、どのフィールドが不正かAPI利用者が判別できるようにする。
router.post("/rules", requireAuth, (req, res) => {
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
router.put("/rules/:id", requireAuth, (req, res) => {
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

// PHASE5_PLAN.md「Stage 9 — Stretch」Task 9.2: "POST /api/alerts/rules/:id/silence
// + suppress dispatch (but keep evaluating/recording) while silenced"。
// リクエストボディは `{ durationSeconds }` か `{ until }` のどちらかを受け付ける
// (両方省略時は 400 — 「いつまでサイレンスするか」を必ず明示させる。無期限
// サイレンスをデフォルトにしないための意図的な設計)。両方指定された場合は
// `until`(明示的な終了時刻)を優先する。
// 実際の抑制ロジックは alertEngine.handleUpdate() 側(rule.silencedUntil を見て
// notifierRegistry への配線だけを迂回する)にあり、このルートは `silencedUntil`
// フィールドを設定するだけ — 通常の ruleStore.update() を経由するため、
// バリデーション・書き込みスルー永続化も自動的に効く。
// サイレンス解除は専用エンドポイントを設けず、既存の PUT /rules/:id で
// `{ "silencedUntil": null }` を送ることで行える(silencedUntil は Task 9.1 で
// 追加した通常のスキーマフィールドであり、PUT からも直接設定できるため)。
//
// POST /api/alerts/rules/:id/test(Task 6.5)はこのサイレンスの影響を受けない —
// あちらは「通知設定を手動で疎通確認する」ための明示的な操作であり、無関係な
// サイレンス状態によって黙って抑制されると「なぜテストメッセージが届かないのか」
// と混乱を招くため、意図的に別経路(notifierRegistry.dispatch() を直接呼ぶ)
// のままにしてある。
router.post("/rules/:id/silence", requireAuth, (req, res) => {
  try {
    const { durationSeconds, until } = req.body || {};

    let silencedUntil;
    if (typeof until === "string" && !Number.isNaN(Date.parse(until))) {
      silencedUntil = new Date(until).toISOString();
    } else if (typeof durationSeconds === "number" && durationSeconds > 0) {
      silencedUntil = new Date(Date.now() + durationSeconds * 1000).toISOString();
    } else {
      res.status(400).json({
        status: "error",
        message: "Provide either a positive numeric durationSeconds or a valid ISO 'until' timestamp",
      });
      return;
    }

    const rule = ruleStore.update(req.params.id, { silencedUntil });
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
router.delete("/rules/:id", requireAuth, (req, res) => {
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

// PHASE5_PLAN.md「API」節: "Fire a synthetic alert for this rule through its
// configured channels, without needing a real breach — for verifying
// notification setup"。notifierRegistry.dispatch() を直接呼ぶ(alertEngine.emit
// 経由ではない)— alertHistoryStore は alertEngine 自身の 'alert' イベントの購読者
// (Task 3.5)であり、テスト通知は実インシデントではないため履歴を汚さない。
// alertEngine のランタイム状態(state/breachSince等)も一切変更しない — 「今
// 登録されている通知先へ実際に送ってみる」だけの、副作用が閉じた操作。
//
// ⚠️ 既知のギャップ(このタスクでは修正しない、フラグのみ): PHASE5_PLAN.md の
// Threshold Rules 表は rule.channels で通知先を絞り込める設計を明記しているが、
// notifierRegistry.dispatch() にも alertEngine.js の実配線(Task 3.3/4.3)にも
// rule.channels によるフィルタリングは実装されていない — 現状は常に「登録済みの
// 全通知先」に送られる(grep で確認済み: channels は ruleStore.js のスキーマ
// 検証にしか登場しない)。本エンドポイントはこの既存の(未完成な)実配線と
// あえて同じ挙動にしている — テストエンドポイントだけを実際より "正しく"
// 見せかけると、テスト結果が実際の通知挙動を予測しなくなってしまうため。
// channels フィルタリングの実装は別タスクとして今後フラグする。
router.post("/rules/:id/test", requireAuth, async (req, res) => {
  try {
    const rule = ruleStore.get(req.params.id);
    const now = new Date().toISOString();

    const alert = {
      alertId: `${rule.id}:test:${now}`,
      ruleId: rule.id,
      ruleName: rule.name,
      metric: rule.metric,
      value: rule.threshold,
      operator: rule.operator,
      threshold: rule.threshold,
      severity: rule.severity,
      state: STATES.FIRING,
      previousState: STATES.OK,
      message: `[TEST] ${rule.name}: synthetic test notification (not a real alert) — ${rule.metric} ${rule.operator} ${rule.threshold}`,
      timestamp: now,
    };

    await notifierRegistry.dispatch(alert);

    res.json({
      status: "ok",
      data: {
        alert,
        notifiers: notifierRegistry.list().map((notifier) => notifier.name),
      },
    });
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

// PHASE5_PLAN.md「API」節: "{ running, rulesCount, activeAlertsCount,
// lastEvaluatedAt } — mirrors /api/monitor/status"。routes/monitor.js の
// GET /status と同じく、alertEngine.getStatus() の戻り値をそのまま返す
// (envelope で包まない — このファイル唯一の例外、上部コメント参照)。
router.get("/engine/status", (req, res) => {
  try {
    res.json(alertEngine.getStatus());
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

module.exports = router;
