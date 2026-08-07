// notifiers/emailNotifier.js
// メール通知プラグイン(PHASE5_PLAN.md「Email」節)。Node組み込みにSMTPクライアントは
// 無いため、新規依存として nodemailer を追加した(package.json参照)。
//
// EMAIL_ENABLED=true かつ EMAIL_SMTP_HOST・EMAIL_TO が設定されている場合のみ
// configured() が true を返す。EMAIL_SMTP_USER/PASS は任意 — 認証不要な
// ローカル/内部SMTPリレーもありうるため、両方が揃っている場合のみ auth を設定する。
// EMAIL_FROM は既定値(alerts@sndhome.local)を持つため必須チェックの対象にしない。
// EMAIL_SMTP_PORT は既定 587(サンプル設定と同じ)。
//
// トランスポートは notify() 呼び出しのたびに新規作成する(接続プールは行わない —
// ホームラボ規模の低頻度送信では単純さを優先。「Recommend developing against
// Ethereal ... or Mailtrap」の通り、実運用ではサンドボックスSMTPでの検証を想定)。
const nodemailer = require("nodemailer");

function configured() {
  return (
    process.env.EMAIL_ENABLED === "true" &&
    Boolean(process.env.EMAIL_SMTP_HOST) &&
    Boolean(process.env.EMAIL_TO)
  );
}

function buildTransport() {
  const hasAuth = process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS;
  return nodemailer.createTransport({
    host: process.env.EMAIL_SMTP_HOST,
    port: Number(process.env.EMAIL_SMTP_PORT) || 587,
    secure: process.env.EMAIL_SMTP_SECURE === "true",
    auth: hasAuth
      ? { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASS }
      : undefined,
  });
}

/**
 * @param {object} alert - PHASE5_PLAN.md「Notification Plugins」節の形のalertオブジェクト
 */
async function notify(alert) {
  const transport = buildTransport();
  await transport.sendMail({
    from: process.env.EMAIL_FROM || "alerts@sndhome.local",
    to: process.env.EMAIL_TO,
    subject: `[${alert.severity.toUpperCase()}] ${alert.ruleName} — ${alert.state}`,
    text: alert.message,
  });
}

module.exports = { name: "email", configured, notify };
