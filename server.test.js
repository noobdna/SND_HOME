// server.test.js
// server.js の2層のテスト:
//
// 1. 「app」レイヤー(ルート合成・静的配信・JSONボディパース) -- server.js は
//    app の組み立て(ルート定義まで)と実際の起動(start(): listen + 各エンジンの
//    start)を分離してエクスポートしている。ここでは require("../server").app を
//    supertest に渡すだけで、実ポートを一切開かず・実バックグラウンドエンジン
//    (monitorEngine/alertEngine/lanEngine)も一切起動せずに検証できる。
//    ALERTS_RULES_PATH/LAN_DEVICES_PATH は念のためテンポラリパスに向けておく
//    (ruleStore/deviceStoreへの誤った書き込みを避ける -- routes/alerts.test.js
//    と同じ規約)。
//
// 2. 「実プロセス」レイヤー(start()・起動シーケンス・SIGTERM/SIGINTでの
//    グレースフルシャットダウン・API_KEY警告ログ) -- これらはエクスポートされた
//    関数として存在しない(start()自体は呼べるが、実ポート・実エンジンを
//    伴わずに「listenコールバック内の起動シーケンス」や「シグナルハンドラ」
//    だけを検証する方法が無い)ため、`node server.js` を実子プロセスとして
//    spawn し、実際のHTTPリクエストとシグナル送信で検証する
//    (このファイル内で一度だけ行う、比較的重いテスト)。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
function tmpFile(name) {
  return path.join(tmpDir, `${name}-${Math.random().toString(36).slice(2)}.json`);
}

process.env.ALERTS_RULES_PATH = tmpFile("rules");
process.env.LAN_DEVICES_PATH = tmpFile("devices");

const { app } = require("./server");

describe("app composition (in-process, no listen/engines started)", () => {
  it("GET / returns the plain-text landing route", async () => {
    const res = await request(app).get("/");
    assert.equal(res.status, 200);
    assert.match(res.text, /SND@HOME/);
  });

  it("serves the static dashboard from public/", async () => {
    const res = await request(app).get("/index.html");
    assert.equal(res.status, 200);
    assert.match(res.text, /<html/i);
  });

  it("404s on an unknown path", async () => {
    const res = await request(app).get("/this-route-does-not-exist");
    assert.equal(res.status, 404);
  });

  it("mounts routes/system.js at /api", async () => {
    const res = await request(app).get("/api/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });

  it("mounts routes/monitor.js at /api/monitor", async () => {
    const res = await request(app).get("/api/monitor/status");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.running, "boolean");
  });

  it("mounts routes/alerts.js at /api/alerts", async () => {
    const res = await request(app).get("/api/alerts/rules");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });

  it("mounts routes/notifiers.js at /api/notifiers", async () => {
    const res = await request(app).get("/api/notifiers");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });

  it("mounts routes/lan.js at /api/lan", async () => {
    const res = await request(app).get("/api/lan/status");
    assert.equal(res.status, 200);
  });

  it("parses JSON request bodies (proven via a 400 validation error that reflects the sent body, never touching the real rule store)", async () => {
    const res = await request(app).post("/api/alerts/rules").send({ name: "missing required fields on purpose" });
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
    assert.ok(res.body.errors.some((e) => /id/i.test(e)));
  });
});

describe("real process (spawned `node server.js`)", () => {
  function spawnServer(extraEnv) {
    return spawn("node", ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, ...extraEnv },
    });
  }

  function captureStdout(child) {
    const state = { text: "" };
    child.stdout.on("data", (chunk) => {
      state.text += chunk.toString();
    });
    return state;
  }

  function waitFor(state, pattern, timeoutMs = 5000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (pattern.test(state.text)) {
          resolve(state.text);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for ${pattern} in stdout. Got:\n${state.text}`));
          return;
        }
        setTimeout(check, 20);
      };
      check();
    });
  }

  function waitForExit(child, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for process exit")), timeoutMs);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("boots for real, serves a request, logs the API_KEY warning when unset, and exits cleanly (code 0) on SIGTERM", async () => {
    const port = 34571;
    const env = {
      PORT: String(port),
      ALERTS_RULES_PATH: tmpFile("spawn-rules"),
      LAN_DEVICES_PATH: tmpFile("spawn-devices"),
    };
    delete env.API_KEY;
    const child = spawnServer(env);
    const stdout = captureStdout(child);

    try {
      await waitFor(stdout, /SND@HOME server listening on port/);
      await wait(150); // give the synchronous log lines right after "listening" time to flush
      assert.match(stdout.text, /\[auth\] API_KEY not set/);

      const res = await fetch(`http://localhost:${port}/api/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: "ok" });

      child.kill("SIGTERM");
      const code = await waitForExit(child);
      assert.equal(code, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("does not log the API_KEY warning when set, and enforces auth on a mutating endpoint", async () => {
    const port = 34572;
    const child = spawnServer({
      PORT: String(port),
      API_KEY: "test-secret",
      ALERTS_RULES_PATH: tmpFile("spawn-rules"),
      LAN_DEVICES_PATH: tmpFile("spawn-devices"),
    });
    const stdout = captureStdout(child);

    try {
      await waitFor(stdout, /SND@HOME server listening on port/);
      await wait(150);
      assert.doesNotMatch(stdout.text, /API_KEY not set/);

      const unauthed = await fetch(`http://localhost:${port}/api/alerts/rules`, { method: "POST" });
      assert.equal(unauthed.status, 401);

      const authed = await fetch(`http://localhost:${port}/api/alerts/rules`, {
        method: "POST",
        headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(authed.status, 400); // auth passes; body fails schema validation -- proves it got past requireAuth

      child.kill("SIGTERM");
      await waitForExit(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
