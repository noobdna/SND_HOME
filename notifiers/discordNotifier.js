// notifiers/discordNotifier.js
// Discord Webhook 通知プラグイン(PHASE5_PLAN.md「Discord」節)。
// DISCORD_ENABLED=true かつ DISCORD_WEBHOOK_URL が設定されている場合のみ
// configured() が true を返す(「Configuration」節: 両方が true でないと register されない)。
// Node組み込みの fetch(Node >=18)でPOSTする — 新規依存は追加しない。
//
// state/severityで色分けしたDiscord embedを1件送る。仕様が明記しているのは
// 「red for FIRING/DOWN, green for OK」のみ — RECOVERING(確定前の遷移状態)の色は
// 未規定のため、amber(琥珀色)を割り当てた。既知の state 以外は中立のグレーにする
// (将来 STATES が増えても notify() 自体は落ちない)。

const COLOR_BY_STATE = {
  FIRING: 0xed4245, // Discord standard red
  DOWN: 0xed4245,
  RECOVERING: 0xfaa61a, // amber — 未規定、確定前の遷移状態として選択
  OK: 0x57f287, // Discord standard green
};
const DEFAULT_COLOR = 0x99aaab; // 未知の state 用の中立グレー

function configured() {
  return process.env.DISCORD_ENABLED === "true" && Boolean(process.env.DISCORD_WEBHOOK_URL);
}

/**
 * @param {object} alert - PHASE5_PLAN.md「Notification Plugins」節の形のalertオブジェクト
 */
async function notify(alert) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  const body = {
    embeds: [
      {
        title: `${alert.ruleName} — ${alert.state}`,
        description: alert.message,
        color: COLOR_BY_STATE[alert.state] ?? DEFAULT_COLOR,
        fields: [
          { name: "Metric", value: alert.metric, inline: true },
          { name: "Value", value: String(alert.value), inline: true },
          { name: "Severity", value: alert.severity, inline: true },
        ],
        timestamp: alert.timestamp,
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook responded with ${response.status}`);
  }
}

module.exports = { name: "discord", configured, notify };
