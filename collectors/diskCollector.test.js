// collectors/diskCollector.test.js
// lan/lanScanner.test.js の pingHost/readArpTable テストと同じ依存性注入手法
// (execFileImpl を差し替えて実コマンドに一切触れない)で runDf() を検証し、
// parseDfOutput() は純粋関数として直接、macOS/Linux双方のdf出力形式・
// 異常系を検証する。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const diskCollector = require("./diskCollector");
const { parseDfOutput, runDf } = diskCollector;

describe("parseDfOutput", () => {
  it("parses macOS-style df -k / output (with iused/ifree/%iused columns)", () => {
    const stdout = [
      "Filesystem     1024-blocks    Used Available Capacity iused     ifree %iused  Mounted on",
      "/dev/disk1s4s1   488347692 9435772  14488572    40%  357149 144885720    0%   /",
    ].join("\n");

    const result = parseDfOutput(stdout);
    assert.deepEqual(result, {
      used: 9435772 * 1024,
      total: 488347692 * 1024,
      percent: Math.round((9435772 / 488347692) * 1000) / 10,
    });
  });

  it("parses Linux-style df -k / output (no iused/ifree/%iused columns)", () => {
    const stdout = ["Filesystem     1024-blocks    Used Available Capacity Mounted on", "/dev/sda1         41152832 4520000  34515000    12% /"].join(
      "\n",
    );

    const result = parseDfOutput(stdout);
    assert.deepEqual(result, {
      used: 4520000 * 1024,
      total: 41152832 * 1024,
      percent: Math.round((4520000 / 41152832) * 1000) / 10,
    });
  });

  it("throws when there is no data line (header only)", () => {
    assert.throws(() => parseDfOutput("Filesystem     1024-blocks    Used Available Capacity Mounted on"), /解析できませんでした/);
  });

  it("throws when there is no data at all (empty output)", () => {
    assert.throws(() => parseDfOutput(""), /解析できませんでした/);
  });

  it("throws when the data line has no Capacity-style (%) column", () => {
    const stdout = ["Filesystem 1024-blocks Used Available Mounted-on", "/dev/sda1 100 50 50 /"].join("\n");
    assert.throws(() => parseDfOutput(stdout), /形式が想定と異なります/);
  });

  it("throws when the % column appears too early to have 3 preceding columns", () => {
    const stdout = ["a b c", "foo 50% bar"].join("\n");
    assert.throws(() => parseDfOutput(stdout), /形式が想定と異なります/);
  });

  it("returns percent 0 when total is 0 (division-by-zero guard)", () => {
    const stdout = ["Filesystem 1024-blocks Used Available Capacity Mounted-on", "/dev/sda1 0 0 0 50% /"].join("\n");
    const result = parseDfOutput(stdout);
    assert.deepEqual(result, { used: 0, total: 0, percent: 0 });
  });
});

describe("runDf (execFile injected, no real command)", () => {
  it("resolves with stdout when the command succeeds", async () => {
    const fakeExecFile = (cmd, args, cb) => cb(null, "fake df output");
    const stdout = await runDf({ execFileImpl: fakeExecFile });
    assert.equal(stdout, "fake df output");
  });

  it("rejects when the command errors", async () => {
    const fakeExecFile = (cmd, args, cb) => cb(new Error("df: command not found"));
    await assert.rejects(() => runDf({ execFileImpl: fakeExecFile }), /command not found/);
  });

  it("invokes df with the expected arguments", async () => {
    let captured;
    const fakeExecFile = (cmd, args, cb) => {
      captured = { cmd, args };
      cb(null, "");
    };
    await runDf({ execFileImpl: fakeExecFile });
    assert.equal(captured.cmd, "df");
    assert.deepEqual(captured.args, ["-k", "/"]);
  });
});

describe("diskCollector.collect()", () => {
  it("declares the expected {name, collect()} shape", () => {
    assert.equal(diskCollector.name, "disk");
    assert.equal(typeof diskCollector.collect, "function");
  });

  it("against the real OS: resolves with a plausible used/total/percent shape", async () => {
    const result = await diskCollector.collect();
    assert.equal(typeof result.used, "number");
    assert.equal(typeof result.total, "number");
    assert.equal(typeof result.percent, "number");
    assert.ok(result.total > 0);
    assert.ok(result.used >= 0);
    assert.ok(result.percent >= 0 && result.percent <= 100);
  });
});
