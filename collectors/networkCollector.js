// collectors/networkCollector.js
// ネットワークインターフェース情報に加えて、主要インターフェース(ローカルIP
// を持つインターフェース)の累積送受信バイト数(rxBytes/txBytes)を収集する。
// 累積値のため、瞬間的な転送速度が必要な場合は履歴上の2点間の差分から
// 呼び出し側(historyStore利用側)で算出する。
// 既存フィールド(interfaces/localIp)は変更せず追加のみ行うため、
// このCollectorを利用する既存コードへの影響はない。
const os = require("os");
const { execFile } = require("child_process");

// このCollectorは monitorEngine.js の5秒間隔のティックに直接組み込まれる
// (lan/lanEngine.js のような独立タイマーを持たない)。テスト中に実測したところ
// `netstat -ib` はこの開発機で約5秒かかる(host名解決等の環境要因と見られる --
// `netstat -ib | head` のようにパイプを早期に閉じると SIGPIPE で早期終了する
// ため気づきにくい)。lan/lanScanner.js の `arp -a` で踏んだのと全く同じ
// タイムアウト無しハングの罠であり、ここでは5秒ティックの真っ只中で発生する
// ため影響がより深刻 -- monitorEngine.js には(lanEngine.jsのscanningガードの
// ような)tick再入防止が無く、netstatがティック間隔と同じかそれ以上かかると
// tickが詰まっていく。pingHost/readArpTable と同じ execFile の `timeout`
// オプションで必ず上限を課す。
const DEFAULT_NETSTAT_TIMEOUT_MS = 2000;

/**
 * `netstat -ib` を実行する。execFileImpl は lan/lanScanner.js の pingHost()/
 * readArpTable() と同じ依存性注入パターン -- 実コマンドを叩かずテストできる
 * ようにするため(既定は本物の execFile)。timeoutMs は上のコメント参照。
 * @param {{ timeoutMs?: number, execFileImpl?: Function }} [options]
 * @returns {Promise<string>}
 */
function runNetstat({ timeoutMs = DEFAULT_NETSTAT_TIMEOUT_MS, execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl("netstat", ["-ib"], { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * `netstat -ib` の出力から、指定インターフェースのリンク層行(Network列が
 * "<Link#N>")を探し、累積受信バイト数(Ibytes)・送信バイト数(Obytes)を返す。
 * 見つからない場合はnullを返す(呼び出し側でグレースフルに扱う)。
 */
function parseThroughput(stdout, interfaceName) {
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) return null;

  const header = lines[0].trim().split(/\s+/);
  const ibytesIdx = header.indexOf("Ibytes");
  const obytesIdx = header.indexOf("Obytes");
  if (ibytesIdx === -1 || obytesIdx === -1) return null;

  for (let i = 1; i < lines.length; i++) {
    const columns = lines[i].trim().split(/\s+/);
    if (columns[0] !== interfaceName) continue;
    if (!columns[2] || !columns[2].startsWith("<Link")) continue;
    if (columns.length <= Math.max(ibytesIdx, obytesIdx)) continue;

    const rxBytes = Number(columns[ibytesIdx]);
    const txBytes = Number(columns[obytesIdx]);
    if (Number.isNaN(rxBytes) || Number.isNaN(txBytes)) continue;

    return { rxBytes, txBytes };
  }

  return null;
}

module.exports = {
  name: "network",
  parseThroughput,
  runNetstat,
  // collect() 自体への execFileImpl の受け渡しは collectorRegistry.js からは
  // 一切使われない(常に引数無しで呼ばれる)が、runNetstat() 単体だけでなく
  // 「netstat失敗時にinterfaces/localIpはそのまま返る」というcollect()内の
  // グレースフルデグレード分岐(下のtry/catch)自体をテストで直接再現するために
  // 必要 -- lan/lanScanner.js の scan() が pingHostImpl/readArpTableImpl を
  // 受け取るのと同じ理由。
  async collect({ execFileImpl } = {}) {
    const nets = os.networkInterfaces();
    const interfaces = [];
    let localIp = null;
    let primaryInterfaceName = null;

    for (const [name, addrs] of Object.entries(nets)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        interfaces.push({
          name,
          address: addr.address,
          family: addr.family,
          internal: addr.internal,
        });
        if (!localIp && addr.family === "IPv4" && !addr.internal) {
          localIp = addr.address;
          primaryInterfaceName = name;
        }
      }
    }

    let rxBytes = null;
    let txBytes = null;

    if (primaryInterfaceName) {
      try {
        const stdout = await runNetstat({ execFileImpl });
        const throughput = parseThroughput(stdout, primaryInterfaceName);
        if (throughput) {
          rxBytes = throughput.rxBytes;
          txBytes = throughput.txBytes;
        }
      } catch (error) {
        // netstatが利用できない環境でも他の値は返す(グレースフルデグレード)
      }
    }

    return { interfaces, localIp, rxBytes, txBytes };
  },
};
