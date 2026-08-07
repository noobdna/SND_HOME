// server.js
require("dotenv").config();
const express = require("express");
const systemRoutes = require("./routes/system");
const monitorRoutes = require("./routes/monitor");
const { startMonitoring, stopMonitoring } = require("./monitor/monitorEngine");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// ---------------------------------------------------------
// ルート定義
// ---------------------------------------------------------

app.get("/", (req, res) => {
  res.send("🚀 SND@HOME 起動成功");
});

app.use("/api", systemRoutes);
app.use("/api/monitor", monitorRoutes);

// ---------------------------------------------------------
// サーバー起動
// ---------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`SND@HOME server listening on port ${PORT}`);
  startMonitoring();
});

// ---------------------------------------------------------
// 終了処理(監視停止 → サーバークローズ)
// ---------------------------------------------------------

function shutdown() {
  stopMonitoring();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
