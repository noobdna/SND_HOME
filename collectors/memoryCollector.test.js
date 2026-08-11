// collectors/memoryCollector.test.js
// cpuCollector.test.js と同じ手法: os.totalmem()/os.freemem() を一時的に
// monkey-patch して決定的な値でアサーションする。こちらは非同期サンプリングが
// 無い純粋な同期計算のため、実時間コストは無い。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");

const memoryCollector = require("./memoryCollector");

const originalTotalmem = os.totalmem;
const originalFreemem = os.freemem;

afterEach(() => {
  os.totalmem = originalTotalmem;
  os.freemem = originalFreemem;
});

describe("memoryCollector", () => {
  it("declares the expected {name, collect()} shape", () => {
    assert.equal(memoryCollector.name, "memory");
    assert.equal(typeof memoryCollector.collect, "function");
  });

  it("computes used = total - free and percent rounded to 1 decimal", async () => {
    os.totalmem = () => 1000;
    os.freemem = () => 250;

    const result = await memoryCollector.collect();
    assert.deepEqual(result, { used: 750, total: 1000, percent: 75 });
  });

  it("rounds a repeating-decimal percent to 1 decimal place", async () => {
    os.totalmem = () => 3;
    os.freemem = () => 2; // used = 1, percent = (1/3)*100 = 33.333... -> 33.3

    const result = await memoryCollector.collect();
    assert.equal(result.percent, 33.3);
  });

  it("returns percent 0 when total is 0 (division-by-zero guard)", async () => {
    os.totalmem = () => 0;
    os.freemem = () => 0;

    const result = await memoryCollector.collect();
    assert.deepEqual(result, { used: 0, total: 0, percent: 0 });
  });

  it("returns percent 100 when free is 0 (fully used)", async () => {
    os.totalmem = () => 500;
    os.freemem = () => 0;

    const result = await memoryCollector.collect();
    assert.deepEqual(result, { used: 500, total: 500, percent: 100 });
  });

  it("against the real OS: resolves with a plausible used/total/percent shape", async () => {
    const result = await memoryCollector.collect();
    assert.equal(typeof result.used, "number");
    assert.equal(typeof result.total, "number");
    assert.equal(typeof result.percent, "number");
    assert.ok(result.total > 0);
    assert.ok(result.used >= 0 && result.used <= result.total);
    assert.ok(result.percent >= 0 && result.percent <= 100);
  });
});
