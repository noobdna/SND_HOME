// monitor/collectorRegistry.js
// Collectorプラグインのレジストリ。
// cpu/memory/disk/networkを標準搭載し、将来SNMP・AirPort・Cloudflare等の
// Collectorを register() で追加できるようにする(monitorEngine側の変更は不要)。
const os = require("os");
const cpuCollector = require("../collectors/cpuCollector");
const memoryCollector = require("../collectors/memoryCollector");
const diskCollector = require("../collectors/diskCollector");
const networkCollector = require("../collectors/networkCollector");

const collectors = [];

/**
 * Collectorプラグインを登録する。
 * プラグインは { name: string, collect: () => Promise<object> } の形を持つこと。
 */
function register(collector) {
  if (!collector || typeof collector.name !== "string" || typeof collector.collect !== "function") {
    throw new Error("Invalid collector plugin: name(string) and collect(function) are required");
  }
  collectors.push(collector);
}

/**
 * 登録済みの全Collectorを実行し、/api/system と同じ形状(status/hostname/
 * platform/<各Collector名>/load/uptime/timestamp)に集約して返す。
 * load・uptime・platform・hostnameは専用Collectorを作らず、os標準モジュールから直接取得する。
 */
async function collectAll() {
  const collected = {};
  for (const collector of collectors) {
    collected[collector.name] = await collector.collect();
  }

  return {
    status: "ok",
    hostname: os.hostname(),
    platform: os.platform(),
    ...collected,
    load: os.loadavg(),
    uptime: os.uptime(),
    timestamp: new Date().toISOString(),
  };
}

register(cpuCollector);
register(memoryCollector);
register(diskCollector);
register(networkCollector);

module.exports = { register, collectAll };
