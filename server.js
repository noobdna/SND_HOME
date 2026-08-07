// server.js
const express = require("express");
const { collectAll } = require("./monitor/collectorRegistry");
const {
  startMonitoring,
  stopMonitoring,
  getLatestSystemInfo,
  getStatus,
  getHistory,
} = require("./monitor/monitorEngine");

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

// Collectorを直接実行せず、常時監視エンジンのキャッシュを返す。
// キャッシュが未生成(起動直後の一瞬など)の場合のみ、その場でcollectAll()を実行する。
app.get("/api/system", async (req, res) => {
  try {
    let info = getLatestSystemInfo();
    if (!info) {
      info = await collectAll();
    }
    res.json(info);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// 常時監視エンジンが保持する最新値を返す(collectAllは直接呼ばない)
app.get("/api/system/latest", (req, res) => {
  try {
    const info = getLatestSystemInfo();
    if (!info) {
      res.status(503).json({
        status: "error",
        message: "監視データがまだ収集されていません",
      });
      return;
    }
    res.json(info);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

// 監視エンジン自体の稼働状態を返す
app.get("/api/monitor/status", (req, res) => {
  try {
    res.json(getStatus());
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

// 履歴データ(トレンドチャート用に間引かれたメトリクスの配列)を返す。
// ?limit= で件数を指定可能(既定120件 = 監視間隔5秒なら直近10分)。
app.get("/api/system/history", (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 120;
    const data = getHistory({ limit });
    res.json({
      status: "ok",
      count: data.length,
      interval: getStatus().interval,
      data,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

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
