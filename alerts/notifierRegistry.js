// alerts/notifierRegistry.js
// 通知プラグインのレジストリ。discord/slack/email/webhook等の通知チャンネルを
// 1ファイル1プラグインとして register() で追加できるようにする
// (monitor/collectorRegistry.js と同じプラグインパターン — alertEngine 側の
// 変更は不要)。プラグインの実体(notifiers/*.js)は Stage 5 で追加する。
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
        console.error(
          `[notifierRegistry] "${notifier.name}" failed to notify: ${error.message || error}`
        );
      }
    })
  );
}

module.exports = { register, list, dispatch };
