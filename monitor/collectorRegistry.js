// monitor/collectorRegistry.js
// Collectorプラグインのレジストリ。
// cpu/memory/disk/networkを標準搭載し、将来SNMP・AirPort・Cloudflare等の
// Collectorを register() で追加できるようにする(monitorEngine側の変更は不要)。
const os = require("os");
const cpuCollector = require("../collectors/cpuCollector");
const memoryCollector = require("../collectors/memoryCollector");
const diskCollector = require("../collectors/diskCollector");
const networkCollector = require("../collectors/networkCollector");
const lanCollector = require("../collectors/lanCollector");
const connectionsCollector = require("../collectors/connectionsCollector");

/**
 * register()/collectAll() のペアを、それぞれ独立した Collector 配列を持つ
 * 状態で新規生成する。
 * このモジュール自体は実運用の5つのCollectorが登録済みの共有シングルトンを
 * 直接エクスポートする(下記)が、テストは空のレジストリからCollectorを
 * 都度差し替えて検証したい -- lan/lanEngine.js の LanEngine エクスポート・
 * monitor/monitorEngine.js の MonitorEngine エクスポートと同じ理由。
 * こちらはタイマー等の状態を持たないため、class ではなく素直なファクトリ関数にしてある。
 * @returns {{ register: Function, collectAll: Function }}
 */
function createRegistry() {
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
   * Collectorは登録順に直列(for...of + await)で実行する -- 1つが失敗した
   * 場合はその場で例外を伝播し(catchしない)、呼び出し元(monitorEngine.tick()等)
   * の責務とする。
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

  return { register, collectAll };
}

const defaultRegistry = createRegistry();

defaultRegistry.register(cpuCollector);
defaultRegistry.register(memoryCollector);
defaultRegistry.register(diskCollector);
defaultRegistry.register(networkCollector);
// lan/lanEngine.js の独立タイマー(既定2分間隔)がまだ起動されていない限り、
// scanned:false のまま返る -- server.js側でlanEngine.startLanScanning()を
// 呼ぶ配線(Stage 4の対象、今回はまだ未着手)が入るまでは常にこの状態。
// 追加のみのフィールドのため、既存の /api/system レスポンス形状との互換性は
// 保たれる(collectors/networkCollector.js が rxBytes/txBytes を追加した際の
// 既存方針と同じ)。
defaultRegistry.register(lanCollector);
// middleware/requestTracker.js が /api にマウントされていない限り(server.js
// 側の配線待ちの場合)、activeCount/totalRequestsServed は常に0のまま返る --
// lanCollector 冒頭コメントと同じグレースフルデグレード。
defaultRegistry.register(connectionsCollector);

module.exports = {
  register: defaultRegistry.register,
  collectAll: defaultRegistry.collectAll,
  createRegistry,
};
