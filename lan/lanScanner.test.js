// lan/lanScanner.test.js
// 純粋関数(IPアドレス計算・CIDR計算・arp/ip neigh出力パース)は
// 直接ユニットテストする。ping/arp のような実I/Oを伴う部分は、
// execFileImpl を差し替え可能にした依存性注入によって、実ネットワークに
// 一切触れずに(そしてCI環境でも決定的に)テストする — alerts/*.test.js が
// global.fetch を monkey-patch するのと同じ「実配線を検証するが実I/Oはしない」
// という考え方を、execFile向けに関数注入という形で踏襲したもの。
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_HOSTS,
  ipToInt,
  intToIp,
  netmaskToPrefixLength,
  cidrToRange,
  enumerateHosts,
  detectLocalSubnet,
  parseArpTable,
  parseIpNeighTable,
  pingHost,
  readArpTable,
  mapWithConcurrency,
  scan,
} = require("./lanScanner");

describe("ipToInt / intToIp", () => {
  it("round-trips a normal address", () => {
    assert.equal(ipToInt("192.168.1.10"), 3232235786);
    assert.equal(intToIp(3232235786), "192.168.1.10");
  });

  it("handles the extremes", () => {
    assert.equal(ipToInt("0.0.0.0"), 0);
    assert.equal(intToIp(0), "0.0.0.0");
    assert.equal(ipToInt("255.255.255.255"), 4294967295);
    assert.equal(intToIp(4294967295), "255.255.255.255");
  });

  it("throws for malformed input", () => {
    assert.throws(() => ipToInt("192.168.1"), /Invalid IPv4/);
    assert.throws(() => ipToInt("192.168.1.256"), /Invalid IPv4/);
    assert.throws(() => ipToInt("192.168.1.abc"), /Invalid IPv4/);
    assert.throws(() => ipToInt("not-an-ip"), /Invalid IPv4/);
  });
});

describe("netmaskToPrefixLength", () => {
  it("resolves common netmasks", () => {
    assert.equal(netmaskToPrefixLength("255.255.255.0"), 24);
    assert.equal(netmaskToPrefixLength("255.255.0.0"), 16);
    assert.equal(netmaskToPrefixLength("255.255.255.252"), 30);
    assert.equal(netmaskToPrefixLength("255.255.255.255"), 32);
    assert.equal(netmaskToPrefixLength("0.0.0.0"), 0);
  });

  it("returns null for a malformed netmask", () => {
    assert.equal(netmaskToPrefixLength("not-a-netmask"), null);
  });
});

describe("cidrToRange", () => {
  it("computes a /24 range", () => {
    const range = cidrToRange("192.168.1.10/24");
    assert.equal(intToIp(range.networkInt), "192.168.1.0");
    assert.equal(intToIp(range.broadcastInt), "192.168.1.255");
    assert.equal(range.prefixLength, 24);
    assert.equal(range.size, 256);
  });

  it("computes a /30 range", () => {
    const range = cidrToRange("10.0.0.5/30");
    assert.equal(intToIp(range.networkInt), "10.0.0.4");
    assert.equal(intToIp(range.broadcastInt), "10.0.0.7");
    assert.equal(range.size, 4);
  });

  it("throws for malformed CIDR", () => {
    assert.throws(() => cidrToRange("192.168.1.0"), /Invalid CIDR/);
    assert.throws(() => cidrToRange("192.168.1.0/33"), /Invalid CIDR/);
    assert.throws(() => cidrToRange("bogus/24"), /Invalid CIDR/);
  });
});

describe("enumerateHosts", () => {
  it("excludes network and broadcast addresses for a /30", () => {
    const hosts = enumerateHosts("10.0.0.4/30");
    assert.deepEqual(hosts, ["10.0.0.5", "10.0.0.6"]);
  });

  it("returns the full 254-host range for a /24, excluding .0 and .255", () => {
    const hosts = enumerateHosts("192.168.1.0/24");
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], "192.168.1.1");
    assert.equal(hosts[hosts.length - 1], "192.168.1.254");
    assert.ok(!hosts.includes("192.168.1.0"));
    assert.ok(!hosts.includes("192.168.1.255"));
  });

  it("does not exclude any address for a /31 (RFC 3021 point-to-point)", () => {
    const hosts = enumerateHosts("10.0.0.0/31");
    assert.deepEqual(hosts, ["10.0.0.0", "10.0.0.1"]);
  });

  it("returns a single host for a /32", () => {
    assert.deepEqual(enumerateHosts("10.0.0.5/32"), ["10.0.0.5"]);
  });

  it("refuses to enumerate a range larger than the safety cap", () => {
    assert.throws(() => enumerateHosts("10.0.0.0/8"), /safety cap/);
  });

  it("respects a custom, smaller maxHosts override", () => {
    assert.throws(() => enumerateHosts("192.168.1.0/24", { maxHosts: 10 }), /safety cap/);
  });

  it("the default MAX_HOSTS comfortably covers a /24", () => {
    assert.ok(MAX_HOSTS >= 254);
  });
});

describe("detectLocalSubnet", () => {
  it("picks the first non-internal IPv4 interface with a netmask", () => {
    const fakeInterfaces = {
      lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
      en0: [
        { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false },
        { address: "192.168.1.42", netmask: "255.255.255.0", family: "IPv4", internal: false },
      ],
    };
    const result = detectLocalSubnet(fakeInterfaces);
    assert.deepEqual(result, {
      interfaceName: "en0",
      localIp: "192.168.1.42",
      netmask: "255.255.255.0",
      cidr: "192.168.1.0/24",
    });
  });

  it("returns null when nothing qualifies (loopback-only)", () => {
    const fakeInterfaces = {
      lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
    };
    assert.equal(detectLocalSubnet(fakeInterfaces), null);
  });

  it("skips an interface entry with a null address list", () => {
    const fakeInterfaces = { tun0: null, en0: [{ address: "10.0.0.5", netmask: "255.255.255.0", family: "IPv4", internal: false }] };
    assert.equal(detectLocalSubnet(fakeInterfaces).localIp, "10.0.0.5");
  });
});

describe("parseArpTable", () => {
  it("parses macOS/BSD-style arp -a output, including single-digit octets", () => {
    const stdout = [
      "? (192.168.1.1) at 0:1b:63:aa:bb:cc on en0 ifscope [ethernet]",
      "printer.local (192.168.1.20) at ac:de:48:11:22:33 on en0 ifscope [ethernet]",
      "? (192.168.1.99) at (incomplete) on en0 ifscope [ethernet]",
    ].join("\n");
    const table = parseArpTable(stdout);
    assert.equal(table.get("192.168.1.1"), "00:1b:63:aa:bb:cc");
    assert.equal(table.get("192.168.1.20"), "ac:de:48:11:22:33");
    assert.equal(table.has("192.168.1.99"), false);
  });

  it("parses Linux net-tools-style arp -a output", () => {
    const stdout = "router (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] on eth0";
    const table = parseArpTable(stdout);
    assert.equal(table.get("192.168.1.1"), "aa:bb:cc:dd:ee:ff");
  });

  it("returns an empty map for empty/garbage input", () => {
    assert.equal(parseArpTable("").size, 0);
    assert.equal(parseArpTable("nothing useful here").size, 0);
  });
});

describe("parseIpNeighTable", () => {
  it("parses `ip neigh show` output, skipping entries without lladdr", () => {
    const stdout = [
      "192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff STALE",
      "192.168.1.50 dev eth0 lladdr 11:22:33:44:55:66 REACHABLE",
      "192.168.1.77 dev eth0 FAILED",
    ].join("\n");
    const table = parseIpNeighTable(stdout);
    assert.equal(table.get("192.168.1.1"), "aa:bb:cc:dd:ee:ff");
    assert.equal(table.get("192.168.1.50"), "11:22:33:44:55:66");
    assert.equal(table.has("192.168.1.77"), false);
  });
});

describe("pingHost (execFile injected, no real network)", () => {
  it("resolves true when the command exits successfully", async () => {
    const fakeExecFile = (cmd, args, opts, cb) => cb(null, "1 packets transmitted, 1 received");
    assert.equal(await pingHost("192.168.1.1", { execFileImpl: fakeExecFile }), true);
  });

  it("resolves false when the command errors (unreachable/timeout)", async () => {
    const fakeExecFile = (cmd, args, opts, cb) => cb(new Error("no reply"));
    assert.equal(await pingHost("192.168.1.1", { execFileImpl: fakeExecFile }), false);
  });

  it("invokes ping with -c 1 and the given ip, plus a timeout option", async () => {
    let captured;
    const fakeExecFile = (cmd, args, opts, cb) => {
      captured = { cmd, args, opts };
      cb(null, "");
    };
    await pingHost("10.0.0.5", { timeoutMs: 250, execFileImpl: fakeExecFile });
    assert.equal(captured.cmd, "ping");
    assert.deepEqual(captured.args, ["-c", "1", "10.0.0.5"]);
    assert.equal(captured.opts.timeout, 250);
  });
});

describe("readArpTable (execFile injected, no real network)", () => {
  it("uses arp -a's output when arp succeeds", async () => {
    const fakeExecFile = (cmd, args, opts, cb) => {
      if (cmd === "arp") {
        cb(null, "? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]");
        return;
      }
      throw new Error("should not reach ip neigh when arp succeeds");
    };
    const table = await readArpTable({ execFileImpl: fakeExecFile });
    assert.equal(table.get("192.168.1.1"), "aa:bb:cc:dd:ee:ff");
  });

  it("falls back to `ip neigh show` when arp fails (e.g. command not found)", async () => {
    const fakeExecFile = (cmd, args, opts, cb) => {
      if (cmd === "arp") {
        cb(new Error("command not found"));
        return;
      }
      if (cmd === "ip") {
        cb(null, "192.168.1.5 dev eth0 lladdr 11:22:33:44:55:66 REACHABLE");
        return;
      }
      throw new Error(`unexpected command: ${cmd}`);
    };
    const table = await readArpTable({ execFileImpl: fakeExecFile });
    assert.equal(table.get("192.168.1.5"), "11:22:33:44:55:66");
  });

  it("resolves to an empty map when both arp and ip neigh fail", async () => {
    const fakeExecFile = (cmd, args, opts, cb) => cb(new Error("nope"));
    const table = await readArpTable({ execFileImpl: fakeExecFile });
    assert.equal(table.size, 0);
  });

  it("passes a timeout option on both the arp call and the ip neigh fallback (regression: unbounded hang)", async () => {
    const captured = [];
    const fakeExecFile = (cmd, args, opts, cb) => {
      captured.push({ cmd, opts });
      if (cmd === "arp") {
        cb(new Error("command not found"));
        return;
      }
      cb(null, "192.168.1.5 dev eth0 lladdr 11:22:33:44:55:66 REACHABLE");
    };
    await readArpTable({ timeoutMs: 500, execFileImpl: fakeExecFile });
    assert.equal(captured.length, 2);
    assert.equal(captured[0].cmd, "arp");
    assert.equal(captured[0].opts.timeout, 500);
    assert.equal(captured[1].cmd, "ip");
    assert.equal(captured[1].opts.timeout, 500);
  });
});

describe("mapWithConcurrency", () => {
  it("applies fn to every item and preserves order regardless of completion timing", async () => {
    const items = [30, 10, 20, 5];
    const results = await mapWithConcurrency(items, 2, (n) => new Promise((r) => setTimeout(() => r(n * 2), n)));
    assert.deepEqual(results, [60, 20, 40, 10]);
  });

  it("never runs more than `limit` concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    assert.ok(maxActive <= 3, `expected maxActive <= 3, got ${maxActive}`);
  });

  it("handles an empty item list", async () => {
    assert.deepEqual(await mapWithConcurrency([], 5, () => Promise.resolve(1)), []);
  });
});

describe("scan (fully injected, no real network)", () => {
  function fakePingAllAlive() {
    return async () => true;
  }

  it("returns only the hosts that responded to ping, enriched with mac/vendor from the arp table", async () => {
    const result = await scan({
      cidr: "10.0.0.0/30",
      pingHostImpl: async (ip) => ip === "10.0.0.1",
      readArpTableImpl: async () => new Map([["10.0.0.1", "dc:a6:32:11:22:33"]]),
    });

    assert.equal(result.subnet, "10.0.0.0/30");
    assert.equal(result.totalScanned, 2); // 10.0.0.1, 10.0.0.2
    assert.equal(result.onlineCount, 1);
    assert.deepEqual(result.devices, [
      {
        ip: "10.0.0.1",
        mac: "dc:a6:32:11:22:33",
        vendor: "Raspberry Pi Foundation",
        respondedToPing: true,
        inArpTable: true,
        online: true,
      },
    ]);
    assert.ok(typeof result.scannedAt === "string");
    assert.equal(new Date(result.scannedAt).toISOString(), result.scannedAt);
  });

  it("a responding host with no arp entry still appears, with null mac/vendor", async () => {
    const result = await scan({
      cidr: "10.0.0.0/30",
      pingHostImpl: fakePingAllAlive(),
      readArpTableImpl: async () => new Map(),
    });
    assert.equal(result.devices.length, 2);
    for (const device of result.devices) {
      assert.equal(device.mac, null);
      assert.equal(device.vendor, null);
      assert.equal(device.respondedToPing, true);
      assert.equal(device.inArpTable, false);
    }
  });

  it("CRITICAL: a host that does NOT respond to ping but IS in the arp table is still reported online (real-world regression: some devices block ICMP but resolve ARP)", async () => {
    const result = await scan({
      cidr: "10.0.0.0/30",
      pingHostImpl: async () => false, // nothing responds to ping
      readArpTableImpl: async () => new Map([["10.0.0.1", "aa:bb:cc:dd:ee:ff"]]),
    });

    assert.equal(result.onlineCount, 1);
    assert.deepEqual(result.devices, [
      {
        ip: "10.0.0.1",
        mac: "aa:bb:cc:dd:ee:ff",
        vendor: null,
        respondedToPing: false,
        inArpTable: true,
        online: true,
      },
    ]);
  });

  it("ignores arp entries outside the scanned host range", async () => {
    const result = await scan({
      cidr: "10.0.0.0/30", // hosts: 10.0.0.1, 10.0.0.2
      pingHostImpl: async () => false,
      readArpTableImpl: async () => new Map([["192.168.99.99", "aa:bb:cc:dd:ee:ff"]]),
    });
    assert.equal(result.onlineCount, 0);
    assert.deepEqual(result.devices, []);
  });

  it("returns an empty device list when nothing responds", async () => {
    const result = await scan({
      cidr: "10.0.0.0/30",
      pingHostImpl: async () => false,
      readArpTableImpl: async () => new Map(),
    });
    assert.equal(result.onlineCount, 0);
    assert.deepEqual(result.devices, []);
  });

  it("rejects an invalid explicit cidr", async () => {
    await assert.rejects(
      () => scan({ cidr: "not-a-cidr", pingHostImpl: fakePingAllAlive(), readArpTableImpl: async () => new Map() }),
      /Invalid CIDR/,
    );
  });

  it("auto-detects the subnet from os.networkInterfaces() when cidr is omitted", async () => {
    // os は plain な CommonJS モジュールオブジェクトなので、notifiers/*.test.js が
    // global.fetch を monkey-patch するのと同じ手法で networkInterfaces を
    // 一時的に差し替える。scan() 自体は detectLocalSubnet() を直接呼ぶため、
    // execFileImpl 系の依存性注入とは別に、この一箇所だけ os を直接差し替える。
    const os = require("os");
    const original = os.networkInterfaces;
    os.networkInterfaces = () => ({
      en0: [{ address: "10.0.0.5", netmask: "255.255.255.252", family: "IPv4", internal: false }],
    });
    try {
      const result = await scan({ pingHostImpl: fakePingAllAlive(), readArpTableImpl: async () => new Map() });
      assert.equal(result.subnet, "10.0.0.4/30");
    } finally {
      os.networkInterfaces = original;
    }
  });

  it("rejects when cidr is omitted and no subnet can be auto-detected", async () => {
    const os = require("os");
    const original = os.networkInterfaces;
    os.networkInterfaces = () => ({});
    try {
      await assert.rejects(
        () => scan({ pingHostImpl: fakePingAllAlive(), readArpTableImpl: async () => new Map() }),
        /Could not auto-detect/,
      );
    } finally {
      os.networkInterfaces = original;
    }
  });
});
