// routes/monitor.js
// 監視エンジン自体の稼働状態を返すルート(/api/monitor/status)。
// server.js から抽出したもので、動作・レスポンス形状は変更しない。
const express = require("express");
// monitorEngine はモジュールオブジェクトごと require する(分割代入で取り出さない)
// -- routes/system.js と同じ理由(monkey-patchでのテストを可能にするため)。
const monitorEngine = require("../monitor/monitorEngine");

const router = express.Router();

// 監視エンジン自体の稼働状態を返す
router.get("/status", (req, res) => {
  try {
    res.json(monitorEngine.getStatus());
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message || "Unknown error",
    });
  }
});

module.exports = router;
