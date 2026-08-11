// alerts/notifierRegistry.test.js
// alerts/notifierRegistry.js のユニットテスト。これまで routes/alerts.test.js から
// 間接的に(スパイ登録を通じて)しか触られておらず、専用のテストファイルが無かった。
//
// notifiers 配列はモジュール内のシングルトン(unregister は存在しない)ため、
// このファイル内のテストは register() で増える一方になる — 各テストは絶対数では
// なく「登録前後の差分」で検証する(list() の要素数を before/after で比較する等)。
// node:test はファイル単位でプロセスを分離するため、他のテストファイル
// (routes/alerts.test.js 等)が登録したフェイク通知先がここに漏れてくることはない。
//
// モジュール読み込み時に notifiers/{discord,slack,email,webhook}Notifier.js が
// register() 済み(notifierRegistry.js 末尾)だが、テスト環境では対応する環境変数が
// 未設定のため configured() が false を返し、実際には1つも登録されない前提
// (register()「skips ... whose configured() returns false」)。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const notifierRegistry = require("./notifierRegistry");

function fakeNotifier(name, overrides = {}) {
  return {
    name,
    configured: () => true,
    notify: async () => {},
    ...overrides,
  };
}

describe("register()", () => {
  it("throws for a null/undefined notifier", () => {
    assert.throws(() => notifierRegistry.register(null), /Invalid notifier plugin/);
    assert.throws(() => notifierRegistry.register(undefined), /Invalid notifier plugin/);
  });

  it("throws when name is missing or not a string", () => {
    assert.throws(
      () => notifierRegistry.register({ configured: () => true, notify: async () => {} }),
      /Invalid notifier plugin/
    );
    assert.throws(
      () => notifierRegistry.register({ name: 123, configured: () => true, notify: async () => {} }),
      /Invalid notifier plugin/
    );
  });

  it("throws when configured is not a function", () => {
    assert.throws(
      () => notifierRegistry.register({ name: "x", configured: true, notify: async () => {} }),
      /Invalid notifier plugin/
    );
  });

  it("throws when notify is not a function", () => {
    assert.throws(
      () => notifierRegistry.register({ name: "x", configured: () => true, notify: "nope" }),
      /Invalid notifier plugin/
    );
  });

  it("skips (does not register) a notifier whose configured() returns false", () => {
    const before = notifierRegistry.list().length;
    notifierRegistry.register(fakeNotifier("skip-me", { configured: () => false }));
    assert.equal(notifierRegistry.list().length, before);
  });

  it("registers a notifier whose configured() returns true", () => {
    const before = notifierRegistry.list().length;
    notifierRegistry.register(fakeNotifier("register-me"));
    const after = notifierRegistry.list();
    assert.equal(after.length, before + 1);
    assert.deepEqual(after[after.length - 1], { name: "register-me", configured: true });
  });
});

describe("list()", () => {
  it("never leaks notifier internals -- only { name, configured: true }", () => {
    notifierRegistry.register(
      fakeNotifier("secret-holder", { notify: async () => {}, apiKey: "should-not-leak" })
    );
    const entry = notifierRegistry.list().find((n) => n.name === "secret-holder");
    assert.deepEqual(Object.keys(entry).sort(), ["configured", "name"]);
    assert.deepEqual(entry, { name: "secret-holder", configured: true });
  });
});

describe("dispatch()", () => {
  it("calls notify(alert) on every registered notifier with the alert payload", async () => {
    const received = [];
    notifierRegistry.register(
      fakeNotifier("dispatch-spy-a", { notify: async (alert) => received.push(["a", alert]) })
    );
    notifierRegistry.register(
      fakeNotifier("dispatch-spy-b", { notify: async (alert) => received.push(["b", alert]) })
    );

    const alert = { alertId: "test:1", message: "hello" };
    await notifierRegistry.dispatch(alert);

    const names = received.map(([name]) => name);
    assert.ok(names.includes("a"));
    assert.ok(names.includes("b"));
    received.forEach(([, deliveredAlert]) => assert.deepEqual(deliveredAlert, alert));
  });

  it("isolates a failing notifier -- one rejecting notify() does not block or drop the others", async () => {
    const received = [];
    notifierRegistry.register(
      fakeNotifier("failing-notifier", {
        notify: async () => {
          throw new Error("boom");
        },
      })
    );
    notifierRegistry.register(
      fakeNotifier("healthy-notifier", { notify: async (alert) => received.push(alert) })
    );

    const originalConsoleError = console.error;
    const loggedErrors = [];
    console.error = (...args) => loggedErrors.push(args.join(" "));
    try {
      await notifierRegistry.dispatch({ alertId: "test:2" });
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(received.length, 1);
    assert.ok(loggedErrors.some((line) => /"failing-notifier" failed to notify: boom/.test(line)));
  });
});
