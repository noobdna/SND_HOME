// collectors/cpuCollector.js
// CPU使用率・コア数を収集するCollectorプラグイン。
const os = require("os");

/**
 * CPU使用率を算出する。
 * os.cpus() の瞬間値だけでは使用率が出せないため、
 * 短い間隔(100ms)で2回サンプリングし差分から計算する。
 */
function getCpuUsage() {
  return new Promise((resolve) => {
    const start = os.cpus();

    setTimeout(() => {
      const end = os.cpus();
      let idleDiff = 0;
      let totalDiff = 0;

      for (let i = 0; i < start.length; i++) {
        const s = start[i].times;
        const e = end[i].times;
        const sTotal = s.user + s.nice + s.sys + s.idle + s.irq;
        const eTotal = e.user + e.nice + e.sys + e.idle + e.irq;
        idleDiff += e.idle - s.idle;
        totalDiff += eTotal - sTotal;
      }

      const usage = totalDiff > 0 ? 100 - (idleDiff / totalDiff) * 100 : 0;
      resolve(Math.round(usage * 10) / 10);
    }, 100);
  });
}

module.exports = {
  name: "cpu",
  async collect() {
    const usage = await getCpuUsage();
    return { usage, cores: os.cpus().length };
  },
};
