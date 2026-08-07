// notifiers/slackNotifier.js
// Slack Incoming Webhook 通知プラグイン(PHASE5_PLAN.md「Slack」節)。
// SLACK_ENABLED=true かつ SLACK_WEBHOOK_URL が設定されている場合のみ
// configured() が true を返す。シンプルな { text } ペイロードでPOSTする —
// Block Kitは「nice-to-have, not required for v1」と明記されているため対応しない。

function configured() {
  return process.env.SLACK_ENABLED === "true" && Boolean(process.env.SLACK_WEBHOOK_URL);
}

/**
 * @param {object} alert - PHASE5_PLAN.md「Notification Plugins」節の形のalertオブジェクト
 */
async function notify(alert) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `*${alert.ruleName}* [${alert.state}]\n${alert.message}` }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook responded with ${response.status}`);
  }
}

module.exports = { name: "slack", configured, notify };
