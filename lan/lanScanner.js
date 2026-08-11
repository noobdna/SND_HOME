// lan/lanScanner.js
// LAN上の生きている機器を検出する: サブネット自動検出 → 並行pingスイープ →
// arp -a(または ip neigh show)によるMAC突き合わせ → 静的OUIテーブルでベンダー名解決。
//
// スコープ(明示): 「観測・記録・通知」のみ。自動遮断・ルーター設定変更・
// 機器への侵入や操作は一切行わない。ポートスキャンも行わない(観測の範囲を
// 超えると判断し、別機能として切り出す前提でここには含めていない)。
//
// 権限: OSの `ping`/`arp` バイナリを child_process 経由で呼ぶだけで、
// Node プロセス自体はroot権限を必要としない(既存の collectors/networkCollector.js
// が `netstat`/`df` を同じ方法で呼んでいるのと同じパターン)。ただし一部の
// 最小構成Linux環境(特に将来のDocker化 — README Roadmap Phase 6 —
// では顕著になりうる)では `ping` バイナリ自体に CAP_NET_RAW 等が
// 付与されておらず失敗することがある。その場合は当該ホストへの応答が
// 単に「オフライン」として扱われるのみで、スキャン全体はクラッシュしない
// (グレースフルデグレード — networkCollector.js と同じ方針)。
//
// クロスプラットフォーム上の既知の教訓を踏まえた設計判断: `ping`/`arp` の
// タイムアウト・出力形式はmacOS(BSD)とLinuxで細部が異なる
// (README Tech Stackの「Platform note」が netstat -ib で既に踏んだ轍)。
// 同じ轍を踏まないため、
//   - pingのタイムアウトはOS固有フラグ(-W/-t等)に頼らず、Node自身の
//     `execFile` の `timeout` オプションで統一的に強制する(exit code 0
//     のみを「生存」と判定 — これはmacOS/Linux双方のpingで共通の規約)。
//   - MACアドレス突き合わせは `arp -a` を第一候補としつつ、
//     コマンドが無い環境(net-tools未導入の最小Linux)向けに
//     `ip neigh show`(iproute2)へフォールバックする。
//   - `arp -a`/`ip neigh show` にも同様に execFile の `timeout` オプションを
//     課す。`arp -a` は環境によっては逆引きDNSを試みてブロックすることが
//     あり(到達不能なリゾルバがあると特に顕著)、タイムアウト無しでは
//     このPromiseが永久に解決せず、lanEngine.js の再入防止ガード
//     (`this.scanning`)が張られたまま二度と外れなくなる — 以後スキャンが
//     全く走らなくなるサイレント障害になるため、必ず設定する。
const { execFile } = require("child_process");
const os = require("os");
const { lookupVendor } = require("./ouiLookup");

const DEFAULT_CONCURRENCY = 32;
const DEFAULT_PING_TIMEOUT_MS = 1000;
// arp -a / ip neigh show はローカルのカーネル近隣テーブルを読むだけの操作で
// 本来は瞬時に終わるはずだが、環境によっては逆引きDNSでブロックしうる
// (ファイル冒頭コメント参照)。通常時の実行時間に対して十分に余裕を持たせつつ、
// ハング時にはスキャン全体を確実に止める値として2秒に設定。
const DEFAULT_ARP_TIMEOUT_MS = 2000;
// 誤ったネットマスク検出等で意図せず広大な範囲をスキャンしてしまう事故を防ぐ
// 安全弁。/22相当(1024ホスト)まで許容 — 一般的な家庭内LAN(/24=254ホスト)には
// 十分な余裕がある。
const MAX_HOSTS = 1024;

function ipToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    result = (result << 8) + n;
  }
  return result >>> 0;
}

function intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join(".");
}

/**
 * サブネットマスク文字列(例 "255.255.255.0")からプレフィックス長(例 24)を返す。
 * 不正な値は null。
 */
function netmaskToPrefixLength(netmask) {
  let maskInt;
  try {
    maskInt = ipToInt(netmask);
  } catch {
    return null;
  }
  let count = 0;
  for (let bit = 31; bit >= 0; bit--) {
    if ((maskInt >>> bit) & 1) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * "192.168.1.10/24" のようなCIDR表記から、ネットワークアドレス・
 * ブロードキャストアドレス・プレフィックス長・アドレス総数を算出する。
 * @param {string} cidr
 * @returns {{ networkInt: number, broadcastInt: number, prefixLength: number, size: number }}
 */
function cidrToRange(cidr) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!match) {
    throw new Error(`Invalid CIDR notation: ${cidr}`);
  }
  const [, ipPart, prefixPart] = match;
  const prefixLength = Number(prefixPart);
  if (prefixLength < 0 || prefixLength > 32) {
    throw new Error(`Invalid CIDR prefix length: ${cidr}`);
  }

  const ipInt = ipToInt(ipPart);
  const maskInt = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const networkInt = (ipInt & maskInt) >>> 0;
  const hostBits = 32 - prefixLength;
  const size = hostBits === 0 ? 1 : 2 ** hostBits;
  const broadcastInt = (networkInt + size - 1) >>> 0;

  return { networkInt, broadcastInt, prefixLength, size };
}

/**
 * CIDR範囲内の「ホストとして使えるIP」を列挙する。
 * /30以下では先頭(ネットワークアドレス)・末尾(ブロードキャストアドレス)を
 * 除外する。/31・/32(ホストビットが0か1)はRFC 3021等の特殊扱いに配慮し、
 * 除外せず範囲全体をそのまま返す。
 * @param {string} cidr
 * @param {{ maxHosts?: number }} [options]
 * @returns {string[]}
 */
function enumerateHosts(cidr, { maxHosts = MAX_HOSTS } = {}) {
  const { networkInt, broadcastInt, prefixLength, size } = cidrToRange(cidr);

  const usableSize = prefixLength >= 31 ? size : Math.max(size - 2, 0);
  if (usableSize > maxHosts) {
    throw new Error(`Refusing to enumerate ${usableSize} hosts for ${cidr} (exceeds the ${maxHosts}-host safety cap)`);
  }

  const start = prefixLength >= 31 ? networkInt : networkInt + 1;
  const end = prefixLength >= 31 ? broadcastInt : broadcastInt - 1;

  const hosts = [];
  for (let i = start; i <= end; i++) {
    hosts.push(intToIp(i));
  }
  return hosts;
}

/**
 * os.networkInterfaces() の形の入力から、スキャン対象とすべき最初の
 * 非内部(non-internal)IPv4インターフェースを見つけ、そのCIDRを返す。
 * 見つからない場合は null(呼び出し側で明示的にcidrを渡す必要がある)。
 * @param {NodeJS.Dict<import("os").NetworkInterfaceInfo[]>} [interfaces]
 * @returns {{ interfaceName: string, localIp: string, netmask: string, cidr: string }|null}
 */
function detectLocalSubnet(interfaces = os.networkInterfaces()) {
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal || !addr.netmask) continue;
      const prefixLength = netmaskToPrefixLength(addr.netmask);
      if (prefixLength === null) continue;

      let networkInt;
      try {
        networkInt = (ipToInt(addr.address) & ipToInt(addr.netmask)) >>> 0;
      } catch {
        continue;
      }

      return {
        interfaceName: name,
        localIp: addr.address,
        netmask: addr.netmask,
        cidr: `${intToIp(networkInt)}/${prefixLength}`,
      };
    }
  }
  return null;
}

const MAC_PATTERN = "[0-9a-fA-F]{1,2}(?::[0-9a-fA-F]{1,2}){5}";

/**
 * MACアドレスを台帳のキー形式(小文字・各オクテット2桁)に正規化する。
 * lan/deviceStore.js のMapはこの形式でキーされる(recordScan() がここを通した
 * 値のみを渡すため)。ルート層(routes/lan.js)がURLパラメータの :mac を台帳へ
 * 渡す前に必ずこれを通すのは、"AA:BB:CC:DD:EE:FF" のような大文字表記(ルーターの
 * DHCPクライアント一覧等でよく見る書式)が本来存在するデバイスに対して
 * 404を返してしまう不具合を防ぐため。
 * @param {string} mac
 * @returns {string}
 */
function normalizeMac(mac) {
  return mac
    .split(":")
    .map((octet) => octet.toLowerCase().padStart(2, "0"))
    .join(":");
}

/**
 * `arp -a` の出力(macOS/BSD・Linux net-tools のいずれも "(ip) at mac" という
 * 共通部分を持つ)から IP -> MAC の対応表を作る。"incomplete"(MAC未解決)の
 * 行は対応表に含めない。
 * @param {string} stdout
 * @returns {Map<string, string>}
 */
function parseArpTable(stdout) {
  const table = new Map();
  const pattern = new RegExp(`\\(([\\d.]+)\\)\\s+at\\s+(${MAC_PATTERN}|incomplete)`, "gi");
  let match;
  while ((match = pattern.exec(stdout)) !== null) {
    const [, ip, mac] = match;
    if (mac.toLowerCase() === "incomplete") continue;
    table.set(ip, normalizeMac(mac));
  }
  return table;
}

/**
 * `ip neigh show`(iproute2)の出力から IP -> MAC の対応表を作る。
 * net-tools の `arp` コマンドが存在しない最小構成Linux向けのフォールバック。
 * lladdr を持たない(未解決・FAILED)行は対応表に含めない。
 * @param {string} stdout
 * @returns {Map<string, string>}
 */
function parseIpNeighTable(stdout) {
  const table = new Map();
  const pattern = new RegExp(`^(\\S+)\\s+dev\\s+\\S+.*?\\blladdr\\s+(${MAC_PATTERN})`, "gim");
  let match;
  while ((match = pattern.exec(stdout)) !== null) {
    const [, ip, mac] = match;
    table.set(ip, normalizeMac(mac));
  }
  return table;
}

/**
 * 1台のホストへ単発pingを送り、応答の有無を返す。
 * タイムアウトはOS固有のping引数に頼らず、Node側の execFile `timeout`
 * オプションで統一的に強制する(理由はファイル冒頭のコメント参照)。
 * 終了コード0のみを「生存」と判定 — macOS/Linux双方のpingで共通の規約。
 * @param {string} ip
 * @param {{ timeoutMs?: number, execFileImpl?: Function }} [options]
 * @returns {Promise<boolean>}
 */
function pingHost(ip, { timeoutMs = DEFAULT_PING_TIMEOUT_MS, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl("ping", ["-c", "1", ip], { timeout: timeoutMs }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * OSのARPテーブル(またはフォールバックとして ip neigh show)を読み、
 * IP -> MAC の対応表を返す。両方失敗した場合は空のMap
 * (MACなしで続行するグレースフルデグレード)。
 * pingHost() と同じ理由で、両コマンドとも execFile の `timeout` オプションで
 * 強制タイムアウトさせる(ファイル冒頭コメント参照 — `arp -a` の逆引きDNSに
 * よるハングでスキャン全体が永久に止まるのを防ぐ)。
 *
 * `-n`(numeric、シンボリック名解決をしない)は必須のフラグであって単なる
 * 最適化ではない: 実機(macOS)で確認したところ、`-n` 無しの `arp -a` は
 * 到達不能な逆引きDNSリゾルバへの問い合わせでホスト1件あたり数百ms〜
 * 数秒ブロックし、家庭内LAN程度の台数でも合計で `arp -an`(14ms)の
 * 1000倍近く(実測13秒)かかることがあった。この所要時間は
 * DEFAULT_ARP_TIMEOUT_MS(2秒)を大きく超えるため、`-n` を付けない場合
 * `execFile` のタイムアウトで毎回強制終了させられ、`readArpTable()` は
 * (`ip neigh show` も無いmacOSでは)常に空のMapへフォールバックしていた
 * -- 実際に検出された全オンライン機器のMACが解決できず台帳に一切載らない、
 * という不具合として観測された(内部識別番号: 台数不一致調査)。
 * @param {{ timeoutMs?: number, execFileImpl?: Function }} [options]
 * @returns {Promise<Map<string, string>>}
 */
function readArpTable({ timeoutMs = DEFAULT_ARP_TIMEOUT_MS, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl("arp", ["-an"], { timeout: timeoutMs }, (error, stdout) => {
      if (!error && stdout) {
        resolve(parseArpTable(stdout));
        return;
      }
      execFileImpl("ip", ["neigh", "show"], { timeout: timeoutMs }, (ipError, ipStdout) => {
        if (!ipError && ipStdout) {
          resolve(parseIpNeighTable(ipStdout));
          return;
        }
        resolve(new Map());
      });
    });
  });
}

/**
 * items を limit 件まで並行実行しつつ fn(item, index) を全件に適用する。
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * サブネット全体をスキャンし、応答があったホストの一覧を返す。
 *
 * 検知方式は2つを**独立したシグナル**として扱う(どちらか一方だけに頼らない):
 * pingに応答したIPの集合と、OSのARPテーブルに載っているIP(このスキャン範囲内
 * のみ)の集合を別々に求め、**その和集合**を「オンライン」とみなす。
 *
 * 実機検証で判明した理由: 一部の機器(ファイアウォール設定やIoT機器の実装に
 * よる)はICMP echoに応答しないが、ARPには応答する(=このホストと最近何らかの
 * 通信をしていればOSのARPキャッシュに残る)。pingの成否だけでARPを「MAC名を
 * 補完するための付随情報」としてしか使わない初期実装では、こうした機器を
 * 取りこぼす — 実際にホームLANで1台、pingには応答しないがARPには載っている
 * 機器が確認された。逆に、ARPキャッシュは「このホストが最近通信した相手」
 * しか反映しないため、ICMPもブロックしていて直近このホストと無関係な通信も
 * していない機器は、この和集合をもってしても検知できない可能性が残る
 * (既知の限界 — 発見的手法である以上、ルーター管理画面のDHCP/Wi-Fi接続
 * 一覧と完全に一致することを保証しない。フラグとして明記し、黙って
 * 「これが実在台数」と断定しない)。
 *
 * 各デバイスに `respondedToPing`/`inArpTable` を個別に残すのは、検知方式ごとの
 * 結果を後から比較・診断できるようにするため(単一の online フラグへ
 * 握りつぶさない)。
 * @param {{
 *   cidr?: string,
 *   concurrency?: number,
 *   pingTimeoutMs?: number,
 *   arpTimeoutMs?: number,
 *   maxHosts?: number,
 *   pingHostImpl?: Function,
 *   readArpTableImpl?: Function,
 * }} [options]
 * @returns {Promise<{
 *   scannedAt: string,
 *   subnet: string,
 *   totalScanned: number,
 *   onlineCount: number,
 *   devices: Array<{
 *     ip: string,
 *     mac: string|null,
 *     vendor: string|null,
 *     respondedToPing: boolean,
 *     inArpTable: boolean,
 *     online: boolean,
 *   }>,
 * }>}
 */
async function scan(options = {}) {
  const {
    cidr: cidrOption,
    concurrency = DEFAULT_CONCURRENCY,
    pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS,
    arpTimeoutMs = DEFAULT_ARP_TIMEOUT_MS,
    maxHosts = MAX_HOSTS,
    pingHostImpl = pingHost,
    readArpTableImpl = readArpTable,
  } = options;

  let cidr = cidrOption;
  if (!cidr) {
    const detected = detectLocalSubnet();
    if (!detected) {
      throw new Error("Could not auto-detect a local subnet; pass { cidr } explicitly");
    }
    cidr = detected.cidr;
  }

  const hosts = enumerateHosts(cidr, { maxHosts });
  const aliveFlags = await mapWithConcurrency(hosts, concurrency, (ip) => pingHostImpl(ip, { timeoutMs: pingTimeoutMs }));
  const pingedIps = new Set(hosts.filter((_, i) => aliveFlags[i]));
  const arpTable = await readArpTableImpl({ timeoutMs: arpTimeoutMs });

  // ARPテーブルはスキャン範囲外のIP(例: VPNトンネル越しの通信相手や、
  // 別サブネットの残留エントリ)を含みうるため、このスキャンの対象範囲
  // (hosts)に含まれるものだけを採用する。
  const hostSet = new Set(hosts);
  const arpInRange = new Map([...arpTable].filter(([ip]) => hostSet.has(ip)));

  const detectedIps = new Set([...pingedIps, ...arpInRange.keys()]);
  // hosts の元の順序を保つ(検知順ではなくスキャン範囲内の昇順)。
  const devices = hosts
    .filter((ip) => detectedIps.has(ip))
    .map((ip) => {
      const mac = arpInRange.get(ip) || null;
      return {
        ip,
        mac,
        vendor: mac ? lookupVendor(mac) : null,
        respondedToPing: pingedIps.has(ip),
        inArpTable: arpInRange.has(ip),
        online: true,
      };
    });

  return {
    scannedAt: new Date().toISOString(),
    subnet: cidr,
    totalScanned: hosts.length,
    onlineCount: devices.length,
    devices,
  };
}

module.exports = {
  MAX_HOSTS,
  ipToInt,
  intToIp,
  netmaskToPrefixLength,
  cidrToRange,
  enumerateHosts,
  detectLocalSubnet,
  parseArpTable,
  parseIpNeighTable,
  normalizeMac,
  pingHost,
  readArpTable,
  mapWithConcurrency,
  scan,
};
