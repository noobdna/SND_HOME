// collectors/networkCollector.test.js
// 2つの依存性注入手法を組み合わせる:
//  - os.networkInterfaces() は lan/lanScanner.test.js の detectLocalSubnet()
//    テストと同じ手法(os を直接 monkey-patch)で差し替える。
//  - netstat の実行は lan/lanScanner.js の pingHost/readArpTable と同じ
//    execFileImpl 注入パターンで差し替える(このファイルで新規追加)。
// parseThroughput() は純粋関数として直接、様々な netstat -ib 出力形式・
// 異常系を検証する。
//
// Link行のAddress列には実機では通常MACアドレスが入る(例:
// "en0 1500 <Link#5> 68:5b:35:bd:c6:ee ...")。loopback(lo0)のようにMACを
// 持たないインターフェースだけがこの列が空になり、ヘッダーとのカラム数が
// ずれる -- が、collect() は internal:false のインターフェースしか
// primaryInterfaceName に選ばないため、実際にparseThroughput()へ渡される
// 行は常にMACアドレス入りで、ヘッダーと同じカラム数になる。テストの
// フィクスチャもこの実際の並びに合わせる(このテスト作成中に実機の
// `netstat -ib` 出力と突き合わせて確認済み)。
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");

const networkCollector = require("./networkCollector");
const { parseThroughput, runNetstat } = networkCollector;

const originalNetworkInterfaces = os.networkInterfaces;

afterEach(() => {
  os.networkInterfaces = originalNetworkInterfaces;
});

const HEADER = "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll";

function linkRow(name, { mac = "aa:bb:cc:dd:ee:ff", rxBytes = "5000000", txBytes = "3000000" } = {}) {
  return `${name}        1500  <Link#7>    ${mac} 100000     0    ${rxBytes}   90000     0    ${txBytes}     0`;
}

describe("parseThroughput", () => {
  it("returns rxBytes/txBytes from the <Link#N> row matching the interface name", () => {
    const stdout = [
      HEADER,
      linkRow("en0"),
      "en0        1500  192.168     192.168.1.42          100000     -    5000000   90000     -    3000000     -",
    ].join("\n");

    const result = parseThroughput(stdout, "en0");
    assert.deepEqual(result, { rxBytes: 5000000, txBytes: 3000000 });
  });

  it("returns null when there are fewer than 2 lines", () => {
    assert.equal(parseThroughput(HEADER, "en0"), null);
    assert.equal(parseThroughput("", "en0"), null);
  });

  it("returns null when the header has no Ibytes/Obytes columns", () => {
    const badHeader = "Name Mtu Network Address Ipkts Ierrs Xbytes Opkts Oerrs Ybytes Coll";
    const stdout = [badHeader, linkRow("en0")].join("\n");
    assert.equal(parseThroughput(stdout, "en0"), null);
  });

  it("returns null when the interface name is not present", () => {
    const stdout = [HEADER, linkRow("lo0")].join("\n");
    assert.equal(parseThroughput(stdout, "en0"), null);
  });

  it("returns null when the interface has only non-Link rows (protocol rows are skipped)", () => {
    const stdout = [
      HEADER,
      "en0        1500  192.168     192.168.1.42          100000     -    5000000   90000     -    3000000     -",
    ].join("\n");
    assert.equal(parseThroughput(stdout, "en0"), null);
  });

  it("returns null when the matching Link row has too few columns", () => {
    const stdout = [HEADER, "en0 1500 <Link#7> 1 0"].join("\n");
    assert.equal(parseThroughput(stdout, "en0"), null);
  });

  it("returns null when the byte columns are not numeric", () => {
    const stdout = [HEADER, linkRow("en0", { rxBytes: "notanumber" })].join("\n");
    assert.equal(parseThroughput(stdout, "en0"), null);
  });
});

describe("runNetstat (execFile injected, no real command)", () => {
  it("resolves with stdout when the command succeeds", async () => {
    const fakeExecFile = (cmd, args, opts, cb) => cb(null, "fake netstat output");
    const stdout = await runNetstat({ execFileImpl: fakeExecFile });
    assert.equal(stdout, "fake netstat output");
  });

  it("rejects when the command errors", async () => {
    const fakeExecFile = (cmd, args, opts, cb) => cb(new Error("netstat: command not found"));
    await assert.rejects(() => runNetstat({ execFileImpl: fakeExecFile }), /command not found/);
  });

  it("invokes netstat with the expected arguments, plus a timeout option (regression: unbounded hang)", async () => {
    let captured;
    const fakeExecFile = (cmd, args, opts, cb) => {
      captured = { cmd, args, opts };
      cb(null, "");
    };
    await runNetstat({ timeoutMs: 500, execFileImpl: fakeExecFile });
    assert.equal(captured.cmd, "netstat");
    assert.deepEqual(captured.args, ["-ib"]);
    assert.equal(captured.opts.timeout, 500);
  });
});

describe("networkCollector.collect()", () => {
  it("declares the expected {name, collect()} shape", () => {
    assert.equal(networkCollector.name, "network");
    assert.equal(typeof networkCollector.collect, "function");
  });

  it("picks the first non-internal IPv4 address as localIp, ignoring internal/IPv6 entries", async () => {
    os.networkInterfaces = () => ({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "fe80::1", family: "IPv6", internal: false },
        { address: "192.168.1.42", family: "IPv4", internal: false },
      ],
      en1: [{ address: "192.168.1.99", family: "IPv4", internal: false }],
    });

    const netstatStdout = [HEADER, linkRow("en0")].join("\n");
    const fakeExecFile = (cmd, args, opts, cb) => cb(null, netstatStdout);

    const result = await networkCollector.collect({ execFileImpl: fakeExecFile });
    assert.equal(result.localIp, "192.168.1.42"); // en0's IPv4, not en1's (first wins), not the IPv6 or internal entries
    assert.equal(result.rxBytes, 5000000);
    assert.equal(result.txBytes, 3000000);
    assert.equal(result.interfaces.length, 4); // all addresses across all interfaces are still listed
  });

  it("CRITICAL: gracefully degrades when netstat fails -- interfaces/localIp still returned, rxBytes/txBytes null, no throw", async () => {
    os.networkInterfaces = () => ({
      en0: [{ address: "192.168.1.42", family: "IPv4", internal: false }],
    });
    const fakeExecFile = (cmd, args, opts, cb) => cb(new Error("netstat: command not found"));

    const result = await networkCollector.collect({ execFileImpl: fakeExecFile });
    assert.equal(result.localIp, "192.168.1.42");
    assert.equal(result.rxBytes, null);
    assert.equal(result.txBytes, null);
    assert.equal(result.interfaces.length, 1);
  });

  it("does not call netstat at all when there is no non-internal IPv4 interface", async () => {
    os.networkInterfaces = () => ({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    });
    const fakeExecFile = () => {
      throw new Error("should not be called");
    };

    const result = await networkCollector.collect({ execFileImpl: fakeExecFile });
    assert.equal(result.localIp, null);
    assert.equal(result.rxBytes, null);
    assert.equal(result.txBytes, null);
  });

  it("against the real OS: resolves without throwing and returns the expected shape", async () => {
    const result = await networkCollector.collect();
    assert.ok(Array.isArray(result.interfaces));
    assert.ok("localIp" in result);
    assert.ok("rxBytes" in result);
    assert.ok("txBytes" in result);
  });
});
