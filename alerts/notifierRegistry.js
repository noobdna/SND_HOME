// alerts/notifierRegistry.js
// 通知プラグインのレジストリ。discord/slack/email/webhook等の通知チャンネルを
// 1ファイル1プラグインとして register() で追加できるようにする
// (monitor/collectorRegistry.js と同じプラグインパターン — alertEngine 側の
// 変更は不要)。プラグインの実体(notifiers/*.js)は Stage 5 で追加した。
// collectorRegistry.js が register(cpuCollector) 等を自身のモジュール読み込み時に
// 固定で行っているのと同じ考え方で、本ファイルの末尾で4つの notifiers/*.js を
// require して register() する — 「notifier plugins」タスクの成果物が実際に
// 到達可能(register済み)であることまでを Stage 5 のスコープに含めた判断。
// PHASE5_PLAN.md のタスク一覧には Stage 4/6 のどこにも明示的な「wire notifiers
// into notifierRegistry」タスクが無いため、collectorRegistry.js の既存パターンに
// ならい、プラグインファイルを作るタスク(5.1〜5.4)自体にこの配線を含めた。
//
// プラグインは { name: string, configured: () => boolean, notify: (alert) => Promise<void> }
// の形を持つこと(PHASE5_PLAN.md「Notification Plugins」節)。
//
// register() は configured() が false を返すプラグインをスキップし、一行ログを出す
// (PHASE5_PLAN.md「Notification Plugins」節: 「notifierRegistry.register() skips
// ... any notifier whose configured() returns false」、および「Configuration」節:
// 「both must be true for it to register」— どちらも register() 自体が未設定の
// プラグインを保存しないと明記しているため、そのまま実装する)。
// 一方で「GET /api/notifiers」の例示レスポンスには configured: false の行も
// 含まれているが、それはまだ存在しない routes/notifiers.js(Stage 6)側の関心事
// (未登録のプラグインも含めて一覧表示する、等)であり、本レジストリの register()/
// list() の挙動をそちらに合わせて曲げる根拠にはならないと判断した — 本レジストリは
// 明記されている「未設定なら register しない」を素直に実装する。
//
// dispatch(alert) は登録済み(= 設定済み)の全通知先の notify(alert) を
// Promise.allSettled で並行実行し、各通知先を個別の try/catch で包んで失敗を
// その場でログする — 1つの通知先の障害・誤設定が他の通知を妨げない
// (PHASE5_PLAN.md「Isolation guarantee」節)。

const eventLogStore = require("../monitor/eventLogStore");

const notifiers = [];

/**
 * 通知プラグインを登録する。configured() が false を返す場合は登録をスキップし、
 * 一行ログを出す(env未設定などで無効化されているチャンネル)。
 * @param {{ name: string, configured: () => boolean, notify: (alert: object) => Promise<void> }} notifier
 * @throws {Error} プラグインの形が不正な場合(name/configured/notify が揃っていない)
 */
function register(notifier) {
  if (
    !notifier ||
    typeof notifier.name !== "string" ||
    typeof notifier.configured !== "function" ||
    typeof notifier.notify !== "function"
  ) {
    throw new Error(
      "Invalid notifier plugin: name(string), configured(function), and notify(function) are required"
    );
  }

  if (!notifier.configured()) {
    console.log(`[notifierRegistry] Skipping "${notifier.name}": not configured`);
    return;
  }

  notifiers.push(notifier);
}

/**
 * 登録済み(= 設定済み)の通知プラグイン一覧を返す。
 * credentialやURLなどの機密情報は一切含めない(name のみ)。
 * @returns {{ name: string, configured: true }[]}
 */
function list() {
  return notifiers.map((notifier) => ({ name: notifier.name, configured: true }));
}

/**
 * 登録済みの全通知プラグインへ alert を配信する。
 * Promise.allSettled + 個別 try/catch で1つの失敗が他をブロック・遅延させない
 * (PHASE5_PLAN.md「Isolation guarantee」節)。
 * @param {object} alert - PHASE5_PLAN.md「Notification Plugins」節の形の alert オブジェクト
 * @returns {Promise<void>}
 */
async function dispatch(alert) {
  await Promise.allSettled(
    notifiers.map(async (notifier) => {
      try {
        await notifier.notify(alert);
      } catch (error) {
        const message = `[notifierRegistry] "${notifier.name}" failed to notify: ${error.message || error}`;
        console.error(message);
        // severity: "warning" -- 1チャンネルの失敗は他の通知やアラート評価自体を
        // 止めない(Isolation guarantee)ため、"error" ではなく "warning" とする。
        eventLogStore.record({ category: "notifier", severity: "warning", message });
      }
    })
  );
}

const discordNotifier = require("../notifiers/discordNotifier");
const slackNotifier = require("../notifiers/slackNotifier");
const emailNotifier = require("../notifiers/emailNotifier");
const webhookNotifier = require("../notifiers/webhookNotifier");

register(discordNotifier);
register(slackNotifier);
register(emailNotifier);
register(webhookNotifier);

module.exports = { register, list, dispatch };
