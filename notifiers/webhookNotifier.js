// notifiers/webhookNotifier.js
// 汎用Webhook通知プラグイン(PHASE5_PLAN.md「Generic Webhook」節)。
// WEBHOOK_ENABLED=true かつ WEBHOOK_URL が設定されている場合のみ configured() が
// true を返す。alertオブジェクトをそのままJSON POSTする — PagerDuty/Opsgenie/
// カスタムスクリプト等、未対応の連携先向けの統合ポイント。
//
// WEBHOOK_SECRET が設定されている場合は、送信するJSON本文(文字列化した後の
// バイト列)をHMAC-SHA256で署名し、16進エンコードした値を X-SND-Signature
// ヘッダとして送信する — 「day one から信頼できる設計であるべき」との明記に基づき、
// このプラグインが唯一 configured() に加えて任意の追加検証手段を持つ。
// アルゴリズムは常にSHA-256固定のため、ヘッダ値に "sha256=" 等のプレフィックスは
// 付けない(ヘッダ名自体がSND独自のものであり、複数アルゴリズムの negotiation は
// 想定していない)。受信側は同じ WEBHOOK_SECRET で
// `HMAC-SHA256(rawRequestBody)` を再計算し、16進文字列として比較すればよい。
const crypto = require("crypto");

function configured() {
  return process.env.WEBHOOK_ENABLED === "true" && Boolean(process.env.WEBHOOK_URL);
}

/**
 * @param {object} alert - PHASE5_PLAN.md「Notification Plugins」節の形のalertオブジェクト
 */
async function notify(alert) {
  const webhookUrl = process.env.WEBHOOK_URL;
  const secret = process.env.WEBHOOK_SECRET;
  const body = JSON.stringify(alert);

  const headers = { "Content-Type": "application/json" };
  if (secret) {
    headers["X-SND-Signature"] = crypto.createHmac("sha256", secret).update(body).digest("hex");
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`Webhook responded with ${response.status}`);
  }
}

module.exports = { name: "webhook", configured, notify };
