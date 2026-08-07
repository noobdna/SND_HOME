// routes/system.js
// システム情報系のルート(/api/system, /api/health, /api/system/latest, /api/system/history)。
// server.js から抽出したもので、動作・レスポンス形状は変更しない。
const express = require("express");
const { collectAll } = require("../monitor/collectorRegistry");
const { getLatestSystemInfo, getStatus, getHistory } = require("../monitor/monitorEngine");

const router = express.Router();

// Collectorを直接実行せず、常時監視エンジンのキャッシュを返す。
// キャッシュが未生成(起動直後の一瞬など)の場合のみ、その場でcollectAll()を実行する。
router.get("/system", async (req, res) => {
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

router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// 常時監視エンジンが保持する最新値を返す(collectAllは直接呼ばない)
router.get("/system/latest", (req, res) => {
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

// 履歴データ(トレンドチャート用に間引かれたメトリクスの配列)を返す。
// ?limit= で件数を指定可能(既定120件 = 監視間隔5秒なら直近10分)。
router.get("/system/history", (req, res) => {
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

module.exports = router;
