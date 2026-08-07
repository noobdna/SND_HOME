// collectors/networkCollector.js
// ネットワークインターフェース情報に加えて、主要インターフェース(ローカルIP
// を持つインターフェース)の累積送受信バイト数(rxBytes/txBytes)を収集する。
// 累積値のため、瞬間的な転送速度が必要な場合は履歴上の2点間の差分から
// 呼び出し側(historyStore利用側)で算出する。
// 既存フィールド(interfaces/localIp)は変更せず追加のみ行うため、
// このCollectorを利用する既存コードへの影響はない。
const os = require("os");
const { execFile } = require("child_process");

function runNetstat() {
  return new Promise((resolve, reject) => {
    execFile("netstat", ["-ib"], (error, stdout) => {
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
  async collect() {
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
        const stdout = await runNetstat();
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
