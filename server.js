// server.js
require("dotenv").config();
const express = require("express");
const systemRoutes = require("./routes/system");
const monitorRoutes = require("./routes/monitor");
const alertsRoutes = require("./routes/alerts");
const notifiersRoutes = require("./routes/notifiers");
const lanRoutes = require("./routes/lan");
const { startMonitoring, stopMonitoring } = require("./monitor/monitorEngine");
const { start: startAlerting, stop: stopAlerting } = require("./alerts/alertEngine");
const { startLanScanning, stopLanScanning } = require("./lan/lanEngine");
const ruleStore = require("./alerts/ruleStore");

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
app.use("/api/alerts", alertsRoutes);
app.use("/api/notifiers", notifiersRoutes);
app.use("/api/lan", lanRoutes);

// ---------------------------------------------------------
// サーバー起動
// ---------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`SND@HOME server listening on port ${PORT}`);
  // middleware/auth.js の requireAuth はオプトイン(API_KEY 未設定なら無認証) —
  // notifierRegistry の「未設定プラグインをスキップしてログに出す」のと同じ
  // 可視化の考え方で、起動時に一度だけ警告する。
  if (!process.env.API_KEY) {
    console.log(
      "[auth] API_KEY not set — /api/alerts and /api/notifiers mutating endpoints, and all of /api/lan, are running without authentication (see middleware/auth.js)",
    );
  }
  // ruleStore を永続化ファイル(無ければシード)から読み込んでから、
  // alertEngine の購読を確立し、監視(ティック)を開始する — この順序でないと
  // 最初のティックが「ルールが1件も無い」状態で処理されてしまう。
  ruleStore.loadOrSeed();
  // alertEngine は monitorEngine の 'update' イベントの購読者なので、最初のティックを
  // 取りこぼさないよう、監視(ティック)を開始する前に購読を確立しておく。
  startAlerting();
  startMonitoring();
  // lanEngine は monitorEngine/alertEngine のどちらの購読者でもなく、完全に
  // 独立したタイマーで動く(lan/lanEngine.js冒頭コメント参照)ため、
  // 起動順序に依存関係はない。
  startLanScanning();
});

// ---------------------------------------------------------
// 終了処理(監視停止 → サーバークローズ)
// ---------------------------------------------------------

function shutdown() {
  stopMonitoring();
  stopAlerting();
  stopLanScanning();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
