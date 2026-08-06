// collectors/memoryCollector.js
// メモリ使用量を収集するCollectorプラグイン。
const os = require("os");

module.exports = {
  name: "memory",
  async collect() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
    return { used, total, percent };
  },
};
