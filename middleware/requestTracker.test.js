// middleware/requestTracker.test.js
// createTracker() で実運用の共有シングルトンとは独立したインスタンスを
// 生成して検証する(monitor/collectorRegistry.js の createRegistry() テストと
// 同じ理由)。req/res は実HTTPを起こさず、EventEmitter ベースの最小限の
// フェイクで代用する -- res.on("finish"/"close") さえ発火できれば十分
// (このミドルウェア自体はExpress固有のAPIを他に使っていない)。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const requestLogStore = require("../monitor/requestLogStore");
const { createTracker, trackRequests, getSnapshot } = require("./requestTracker");

const originalRecord = requestLogStore.record;

afterEach(() => {
  requestLogStore.record = originalRecord;
});

function fakeReq(overrides = {}) {
  // requestTracker.js は req.path ではなく req.originalUrl を読む(ネストした
  // ルーターへのディスパッチでマウントパス分だけ剥がされる req.path/req.url とは
  // 異なり、リクエストの生存期間中ずっと書き換えられないため -- 実機起動での
  // 確認で発覚した回帰、middleware/requestTracker.js 冒頭コメント参照)。
  return { method: "GET", originalUrl: "/api/system", ip: "127.0.0.1", ...overrides };
}

function fakeRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}

describe("createTracker() (fresh instance per test)", () => {
  it("increments activeCount when a request starts", () => {
    const tracker = createTracker();
    tracker.middleware(fakeReq(), fakeRes(), () => {});

    assert.equal(tracker.getSnapshot().activeCount, 1);
  });

  it("decrements activeCount when the response finishes", () => {
    const tracker = createTracker();
    const res = fakeRes();
    tracker.middleware(fakeReq(), res, () => {});
    assert.equal(tracker.getSnapshot().activeCount, 1);

    res.emit("finish");
    assert.equal(tracker.getSnapshot().activeCount, 0);
  });

  it("decrements activeCount when the connection closes (no finish, e.g. client disconnect)", () => {
    const tracker = createTracker();
    const res = fakeRes();
    tracker.middleware(fakeReq(), res, () => {});

    res.emit("close");
    assert.equal(tracker.getSnapshot().activeCount, 0);
  });

  it("CRITICAL: does not double-decrement when both 'finish' and 'close' fire for the same request", () => {
    const tracker = createTracker();
    const res = fakeRes();
    tracker.middleware(fakeReq(), res, () => {});

    res.emit("finish");
    res.emit("close"); // some HTTP clients/servers emit both -- must not go negative
    assert.equal(tracker.getSnapshot().activeCount, 0);
  });

  it("tracks multiple concurrent in-flight requests independently", () => {
    const tracker = createTracker();
    const resA = fakeRes();
    const resB = fakeRes();
    tracker.middleware(fakeReq(), resA, () => {});
    tracker.middleware(fakeReq(), resB, () => {});
    assert.equal(tracker.getSnapshot().activeCount, 2);

    resA.emit("finish");
    assert.equal(tracker.getSnapshot().activeCount, 1);
    resB.emit("finish");
    assert.equal(tracker.getSnapshot().activeCount, 0);
  });

  it("increments totalRequests only once the response completes, not when it starts", () => {
    const tracker = createTracker();
    const res = fakeRes();
    tracker.middleware(fakeReq(), res, () => {});
    assert.equal(tracker.getSnapshot().totalRequests, 0);

    res.emit("finish");
    assert.equal(tracker.getSnapshot().totalRequests, 1);
  });

  it("calls next() synchronously so the request pipeline is never blocked", () => {
    const tracker = createTracker();
    let nextCalled = false;
    tracker.middleware(fakeReq(), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  it("records method/path/ip/statusCode/durationMs into requestLogStore on completion", () => {
    const tracker = createTracker();
    let recorded;
    requestLogStore.record = (entry) => {
      recorded = entry;
    };

    const res = fakeRes(201);
    tracker.middleware(fakeReq({ method: "POST", originalUrl: "/api/alerts/rules", ip: "10.0.0.9" }), res, () => {});
    res.emit("finish");

    assert.equal(recorded.method, "POST");
    assert.equal(recorded.path, "/api/alerts/rules");
    assert.equal(recorded.ip, "10.0.0.9");
    assert.equal(recorded.statusCode, 201);
    assert.equal(typeof recorded.durationMs, "number");
    assert.ok(recorded.durationMs >= 0);
  });

  it("does not record anything until the response actually completes", () => {
    const tracker = createTracker();
    let recordCalls = 0;
    requestLogStore.record = () => {
      recordCalls++;
    };

    tracker.middleware(fakeReq(), fakeRes(), () => {});
    assert.equal(recordCalls, 0);
  });

  it("getSnapshot() exposes a stable trackingSince timestamp", () => {
    const tracker = createTracker();
    const first = tracker.getSnapshot().trackingSince;
    const second = tracker.getSnapshot().trackingSince;
    assert.equal(first, second);
  });

  it("two independent trackers do not share state", () => {
    const trackerA = createTracker();
    const trackerB = createTracker();
    trackerA.middleware(fakeReq(), fakeRes(), () => {});

    assert.equal(trackerA.getSnapshot().activeCount, 1);
    assert.equal(trackerB.getSnapshot().activeCount, 0);
  });
});

describe("module-level singleton wiring (trackRequests/getSnapshot)", () => {
  it("trackRequests is the default tracker's middleware, wired to the same getSnapshot()", () => {
    const before = getSnapshot().activeCount;
    const res = fakeRes();
    trackRequests(fakeReq(), res, () => {});
    assert.equal(getSnapshot().activeCount, before + 1);

    res.emit("finish");
    assert.equal(getSnapshot().activeCount, before);
  });
});
