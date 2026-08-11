// monitor/collectorRegistry.test.js
// collectorRegistry.js は元々このプロジェクトの監視レイヤー全体と同じく、
// node:test 導入前(Phase 5より前)に書かれたためテストが無かった。
// 実運用の共有シングルトン(cpu/memory/disk/network/lanの5つが登録済み --
// 実コマンドを叩く/最大2秒かかりうる)ではなく、エクスポートされた
// createRegistry() で空のレジストリを都度生成し、フェイクのCollectorだけを
// 登録して register()/collectAll() 自体のロジックを検証する --
// lan/lanEngine.js の LanEngine エクスポートと同じ理由・同じ規約。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");

const collectorRegistry = require("./collectorRegistry");
const { createRegistry } = collectorRegistry;

const originalHostname = os.hostname;
const originalPlatform = os.platform;
const originalLoadavg = os.loadavg;
const originalUptime = os.uptime;

afterEach(() => {
  os.hostname = originalHostname;
  os.platform = originalPlatform;
  os.loadavg = originalLoadavg;
  os.uptime = originalUptime;
});

function fakeCollector(name, result) {
  return { name, collect: async () => result };
}

describe("register()", () => {
  it("accepts a valid {name, collect()} plugin", () => {
    const { register } = createRegistry();
    assert.doesNotThrow(() => register(fakeCollector("test", {})));
  });

  it("throws when collector is null/undefined", () => {
    const { register } = createRegistry();
    assert.throws(() => register(null), /Invalid collector plugin/);
    assert.throws(() => register(undefined), /Invalid collector plugin/);
  });

  it("throws when name is missing or not a string", () => {
    const { register } = createRegistry();
    assert.throws(() => register({ collect: async () => ({}) }), /Invalid collector plugin/);
    assert.throws(() => register({ name: 123, collect: async () => ({}) }), /Invalid collector plugin/);
  });

  it("throws when collect is missing or not a function", () => {
    const { register } = createRegistry();
    assert.throws(() => register({ name: "test" }), /Invalid collector plugin/);
    assert.throws(() => register({ name: "test", collect: "not a function" }), /Invalid collector plugin/);
  });
});

describe("collectAll()", () => {
  it("returns the base shape (status/hostname/platform/load/uptime/timestamp) with no collectors registered", async () => {
    os.hostname = () => "fake-host";
    os.platform = () => "fake-platform";
    os.loadavg = () => [1, 2, 3];
    os.uptime = () => 999;

    const { collectAll } = createRegistry();
    const result = await collectAll();

    assert.equal(result.status, "ok");
    assert.equal(result.hostname, "fake-host");
    assert.equal(result.platform, "fake-platform");
    assert.deepEqual(result.load, [1, 2, 3]);
    assert.equal(result.uptime, 999);
    assert.equal(typeof result.timestamp, "string");
  });

  it("merges each registered collector's result under its own name key", async () => {
    const { register, collectAll } = createRegistry();
    register(fakeCollector("cpu", { usage: 12 }));
    register(fakeCollector("memory", { percent: 50 }));

    const result = await collectAll();
    assert.deepEqual(result.cpu, { usage: 12 });
    assert.deepEqual(result.memory, { percent: 50 });
  });

  it("runs collectors sequentially in registration order, not in parallel", async () => {
    const order = [];
    const { register, collectAll } = createRegistry();
    register({
      name: "slow",
      collect: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("slow");
        return {};
      },
    });
    register({
      name: "fast",
      collect: async () => {
        order.push("fast");
        return {};
      },
    });

    await collectAll();
    // "slow" is registered first and awaited to completion before "fast" ever runs,
    // even though "fast" itself resolves immediately -- proves this isn't Promise.all().
    assert.deepEqual(order, ["slow", "fast"]);
  });

  it("propagates a collector's rejection without catching it (error handling is the caller's responsibility)", async () => {
    const { register, collectAll } = createRegistry();
    register(fakeCollector("ok-one", {}));
    register({
      name: "broken",
      collect: async () => {
        throw new Error("collector exploded");
      },
    });

    await assert.rejects(() => collectAll(), /collector exploded/);
  });

  it("does not run collectors registered after a rejecting one", async () => {
    const order = [];
    const { register, collectAll } = createRegistry();
    register({
      name: "broken",
      collect: async () => {
        order.push("broken");
        throw new Error("boom");
      },
    });
    register({
      name: "never-runs",
      collect: async () => {
        order.push("never-runs");
        return {};
      },
    });

    await assert.rejects(() => collectAll());
    assert.deepEqual(order, ["broken"]);
  });
});

describe("createRegistry() encapsulation", () => {
  it("two independent registries do not share registered collectors", async () => {
    const registryA = createRegistry();
    const registryB = createRegistry();
    registryA.register(fakeCollector("only-in-a", { present: true }));

    const resultA = await registryA.collectAll();
    const resultB = await registryB.collectAll();
    assert.ok("only-in-a" in resultA);
    assert.ok(!("only-in-a" in resultB));
  });
});

describe("module-level singleton wiring (the real cpu/memory/disk/network/lan registry)", () => {
  it("the default export has all 5 production collectors registered", async () => {
    const result = await collectorRegistry.collectAll();
    assert.equal(result.status, "ok");
    for (const name of ["cpu", "memory", "disk", "network", "lan"]) {
      assert.ok(name in result, `expected "${name}" in collectAll() result`);
    }
  });
});
