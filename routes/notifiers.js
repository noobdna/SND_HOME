// routes/notifiers.js
// 通知チャンネルのREST API(/api/notifiers/*)。PHASE5_PLAN.md「API」節参照。
//   GET  /            — 既知の通知プラグイン一覧 + 各々のライブな configured() 状態
//   POST /:name/test   — 指定した1チャンネルへテストメッセージを送信
//
// GET /api/notifiers の例示レスポンスは discord/slack/email/webhook の4つ全てを
// (configured: true/false を問わず)常に列挙する形になっている:
//   [{ name: "discord", configured: true }, { name: "slack", configured: false }, ...]
// しかし alerts/notifierRegistry.js の register() は、PHASE5_PLAN.md「Notification
// Plugins」節・「Configuration」節の両方が明記する通り、configured() が false の
// プラグインを一切保存しない(Stage 4 での実装判断、既にコミット済み・承認済み)。
// つまり notifierRegistry.list() だけでは「未設定のプラグイン」を報告できない —
// この既知のギャップは Stage 4 のコミット時点で「routes/notifiers.js(Stage 6)側の
// 関心事として残す」と明記していた。それが本ファイル。
// notifierRegistry を経由せず、notifiers/*.js を直接 require して configured() を
// その場で呼ぶことで、常に4つ全てをライブな状態で列挙する(collectorRegistry.js の
// 固定プラグインリストと同じ、既知の小規模プラグイン集合を列挙する既存パターン)。
//
// Task 6.8 で server.js に /api/notifiers としてマウント済み。
//
// ⚠️ SECURITY TODO — routes/alerts.js と同じ注記: POST /:name/test は外部サービスへ
// 実際にメッセージを送信する変更系エンドポイントだが、認証ミドルウェアはまだ
// このリポジトリに存在しない。routes/alerts.js のコミット時にユーザーと合意した
// 「今回は認証なしで実装し、明記して可視化する」方針をそのまま踏襲する。
const express = require("express");
const { STATES } = require("../alerts/ruleEvaluator");

const notifiers = [
  require("../notifiers/discordNotifier"),
  require("../notifiers/slackNotifier"),
  require("../notifiers/emailNotifier"),
  require("../notifiers/webhookNotifier"),
];

const router = express.Router();

// PHASE5_PLAN.md「API」節: "List registered notifiers and whether each is
// configured/enabled (never returns secret values)"。name と configured の
// 真偽値のみ返す — webhook URL・SMTP認証情報等は一切含めない
// (notifierRegistry.list() が既に確立している「機密情報を返さない」方針と同じ)。
router.get("/", (req, res) => {
  try {
    const data = notifiers.map((notifier) => ({
      name: notifier.name,
      configured: notifier.configured(),
    }));
    res.json({ status: "ok", data });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

// PHASE5_PLAN.md「API」節: "Send a test message through one specific channel"。
// notifierRegistry.dispatch() のような「登録済み全通知先へ」ではなく、
// 指定した1チャンネルの notify() だけを直接呼ぶ — 複数チャンネルへ一斉送信する
// POST /api/alerts/rules/:id/test(Task 6.5)とは異なり、こちらは1チャンネル単体の
// 疎通確認が目的のため、そのチャンネル自身の成功/失敗をそのままレスポンスに
// 反映できる(Promise.allSettled の背後に隠さない)。
router.post("/:name/test", async (req, res) => {
  const notifier = notifiers.find((n) => n.name === req.params.name);
  if (!notifier) {
    res.status(404).json({ status: "error", message: `Unknown notifier: ${req.params.name}` });
    return;
  }
  if (!notifier.configured()) {
    res.status(400).json({
      status: "error",
      message: `Notifier "${notifier.name}" is not configured`,
    });
    return;
  }

  const now = new Date().toISOString();
  const alert = {
    alertId: `test:${notifier.name}:${now}`,
    ruleId: "test",
    ruleName: "Test Notification",
    metric: "test.channel",
    value: null,
    operator: ">=",
    threshold: 0,
    severity: "info",
    state: STATES.FIRING,
    previousState: STATES.OK,
    message: `[TEST] This is a test notification from SND@HOME to verify the "${notifier.name}" channel is working.`,
    timestamp: now,
  };

  try {
    await notifier.notify(alert);
    res.json({ status: "ok", data: { name: notifier.name, alert } });
  } catch (error) {
    // 502: サーバー自身の処理は成功したが、下流の通知チャンネルへの送信が失敗した。
    res.status(502).json({
      status: "error",
      message: error.message || "Notifier failed to send",
    });
  }
});

module.exports = router;
