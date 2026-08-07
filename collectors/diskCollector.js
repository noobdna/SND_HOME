// collectors/diskCollector.js
// ディスク使用量を収集するCollectorプラグイン。
// Node標準モジュールにディスク使用量APIが無いため、`df -k /` を実行して解析する。
const { execFile } = require("child_process");

function runDf() {
  return new Promise((resolve, reject) => {
    execFile("df", ["-k", "/"], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * `df -k /` の出力をパースする。
 * macOS/Linuxでは列数(iused/ifree等の有無)が異なるため、
 * 「%」で終わる使用率(Capacity)列を基準に、その直前3列を
 * total/used/available(1024バイト単位)として読み取る。
 */
function parseDfOutput(stdout) {
  const lines = stdout.trim().split("\n");
  const dataLine = lines[1];
  if (!dataLine) throw new Error("dfの出力を解析できませんでした");

  const columns = dataLine.trim().split(/\s+/);
  const capacityIndex = columns.findIndex((col) => col.endsWith("%"));
  if (capacityIndex < 3) throw new Error("dfの出力形式が想定と異なります");

  const totalKb = Number(columns[capacityIndex - 3]);
  const usedKb = Number(columns[capacityIndex - 2]);

  const total = totalKb * 1024;
  const used = usedKb * 1024;
  const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;

  return { used, total, percent };
}

module.exports = {
  name: "disk",
  async collect() {
    const stdout = await runDf();
    return parseDfOutput(stdout);
  },
};
