// collectors/networkCollector.js
// ネットワークインターフェース情報を収集するCollectorプラグイン。
const os = require("os");

module.exports = {
  name: "network",
  async collect() {
    const nets = os.networkInterfaces();
    const interfaces = [];
    let localIp = null;

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
        }
      }
    }

    return { interfaces, localIp };
  },
};
