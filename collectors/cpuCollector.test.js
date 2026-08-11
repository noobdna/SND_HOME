// collectors/cpuCollector.test.js
// cpuCollector.js は os.cpus() を直接呼ぶだけで依存性注入の口が無い。
// lan/lanScanner.test.js が detectLocalSubnet() のために os.networkInterfaces()
// を monkey-patch しているのと同じ手法(os は plain な CommonJS モジュール
// オブジェクトなので、必要なメソッドだけ一時的に差し替えて finally で戻す)を
// os.cpus() に適用し、実CPU負荷に依存しない決定的なアサーションを行う。
//
// getCpuUsage() は2回 os.cpus() を100ms間隔でサンプリングする(内部の
// setTimeoutは差し替え不可のため、各テストは実時間で最低100msかかる)。
// collect() 自体はさらに3回目の os.cpus() を呼んで cores を求める。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");

const cpuCollector = require("./cpuCollector");

const originalCpus = os.cpus;

afterEach(() => {
  os.cpus = originalCpus;
});

function makeCore(times) {
  return { model: "fake", speed: 0, times };
}

describe("cpuCollector", () => {
  it("declares the expected {name, collect()} shape", () => {
    assert.equal(cpuCollector.name, "cpu");
    assert.equal(typeof cpuCollector.collect, "function");
  });

  it("computes usage from the idle/total diff between two samples, and cores from the third call", async () => {
    // sTotal = 100+0+50+850+0 = 1000, eTotal = 150+0+70+880+0 = 1100
    // idleDiff = 880-850 = 30, totalDiff = 1100-1000 = 100 -> usage = 100 - 30 = 70
    const startCpus = [makeCore({ user: 100, nice: 0, sys: 50, idle: 850, irq: 0 })];
    const endCpus = [makeCore({ user: 150, nice: 0, sys: 70, idle: 880, irq: 0 })];
    const coresCpus = new Array(8).fill(0).map(() => makeCore({ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }));
    const sequence = [startCpus, endCpus, coresCpus];
    let call = 0;
    os.cpus = () => sequence[call++];

    const result = await cpuCollector.collect();
    assert.equal(result.usage, 70);
    assert.equal(result.cores, 8);
  });

  it("returns usage 0 when totalDiff is 0 (idle guard against division by zero)", async () => {
    const sameCpus = [makeCore({ user: 10, nice: 0, sys: 10, idle: 80, irq: 0 })];
    const sequence = [sameCpus, sameCpus, sameCpus];
    let call = 0;
    os.cpus = () => sequence[call++];

    const result = await cpuCollector.collect();
    assert.equal(result.usage, 0);
  });

  it("rounds usage to 1 decimal place", async () => {
    // sTotal = 300, eTotal = 400, idleDiff = 33, totalDiff = 100 -> usage = 67 exactly (no rounding needed here)
    // use fractional diffs to force a rounding case: idleDiff=33.33.. isn't possible with integers,
    // so pick values that produce a repeating decimal instead: totalDiff=3, idleDiff=1 -> usage = 100 - 33.333... = 66.666...
    const startCpus = [makeCore({ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 })];
    const endCpus = [makeCore({ user: 1, nice: 0, sys: 1, idle: 1, irq: 0 })];
    const sequence = [startCpus, endCpus, endCpus];
    let call = 0;
    os.cpus = () => sequence[call++];

    const result = await cpuCollector.collect();
    // totalDiff = 3, idleDiff = 1 -> usage = 100 - (1/3)*100 = 66.666... -> rounds to 66.7
    assert.equal(result.usage, 66.7);
  });

  it("sums idle/total diffs across multiple cores", async () => {
    const startCpus = [
      makeCore({ user: 100, nice: 0, sys: 0, idle: 900, irq: 0 }),
      makeCore({ user: 200, nice: 0, sys: 0, idle: 800, irq: 0 }),
    ];
    const endCpus = [
      makeCore({ user: 150, nice: 0, sys: 0, idle: 950, irq: 0 }), // core 0: total +100, idle +50
      makeCore({ user: 250, nice: 0, sys: 0, idle: 850, irq: 0 }), // core 1: total +100, idle +50
    ];
    const sequence = [startCpus, endCpus, endCpus];
    let call = 0;
    os.cpus = () => sequence[call++];

    const result = await cpuCollector.collect();
    // totalDiff = 200, idleDiff = 100 -> usage = 100 - 50 = 50
    assert.equal(result.usage, 50);
    assert.equal(result.cores, 2);
  });

  it("against the real OS: resolves with a plausible usage/cores shape", async () => {
    const result = await cpuCollector.collect();
    assert.equal(typeof result.usage, "number");
    assert.ok(result.usage >= 0 && result.usage <= 100, `usage out of range: ${result.usage}`);
    assert.equal(result.cores, os.cpus().length);
    assert.ok(result.cores >= 1);
  });
});
