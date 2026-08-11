// routes/lan.js
// LAN機器監視のREST API(/api/lan/*)。lan/deviceStore.js・lan/lanEngine.js を
// 薄くラップするだけで、スキャンやビジネスロジックはここに書かない
// (routes/alerts.js・routes/monitor.js と同じ「ルートは薄いアダプタ」方針)。
//   GET   /devices       — 既知デバイス一覧(台帳全件、オンライン/オフライン問わず)
//   GET   /devices/:mac  — 1台の詳細
//   PATCH /devices/:mac  — ニックネームの設定/解除({ nickname: string|null })
//   GET   /status         — lanEngine自体の稼働状態(monitorEngine/alertEngineの
//                           GET .../status と同じく、envelopeで包まず生のオブジェクトを返す)
//
// レスポンス形は既存の routes/alerts.js 等と同じenvelope
// (`{ status: "ok", data }` / `{ status: "error", message }`)に揃える。
// GET /status のみ既存の /api/monitor/status・/api/alerts/engine/status に
// 倣い envelope なし。
//
// SECURITY: このファイルの全ルート(GETを含む)を middleware/auth.js の
// requireAuth で一律保護する — routes/alerts.js・routes/notifiers.js が
// 変更系(POST/PUT/DELETE)エンドポイントだけを個別に保護しているのとは
// 異なる判断。LANデバイス一覧(IP/MAC/ベンダー名/在圏履歴)は家庭内の
// 在室状況・生活パターンを推測できる機微情報になり得るため、CPU/メモリ等の
// 既存の無認証GETエンドポイントとは質的にリスクが異なると判断し、
// ユーザーとの事前確認の上でルーター全体を一括保護する方針とした。
// requireAuth自体はオプトイン(API_KEY未設定なら他のAPIと同様に無認証のまま)
// という既存の全体方針は変えていない。
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const deviceStore = require("../lan/deviceStore");
const lanEngine = require("../lan/lanEngine");
const { normalizeMac } = require("../lan/lanScanner");

const router = express.Router();

router.use(requireAuth);

router.get("/devices", (req, res) => {
  try {
    res.json({ status: "ok", data: deviceStore.list() });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

router.get("/devices/:mac", (req, res) => {
  try {
    // 台帳は lan/lanScanner.js の normalizeMac() を通した形(小文字・2桁パディング)
    // でキーされているため、URLパラメータも同じ正規化を通してから照合する —
    // でないと "AA:BB:CC:DD:EE:FF" のような大文字表記(ルーター管理画面等で
    // よく見る書式)で実在デバイスが404になってしまう。
    const device = deviceStore.get(normalizeMac(req.params.mac));
    res.json({ status: "ok", data: device });
  } catch (error) {
    if (error instanceof deviceStore.DeviceNotFoundError) {
      res.status(404).json({ status: "error", message: error.message });
      return;
    }
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

router.patch("/devices/:mac", (req, res) => {
  try {
    const nickname = req.body && "nickname" in req.body ? req.body.nickname : undefined;
    if (nickname === undefined) {
      res.status(400).json({ status: "error", message: "Request body must include a 'nickname' field (string or null)" });
      return;
    }
    // GET /devices/:mac と同じ理由(コメント参照)で正規化してから台帳を引く。
    const device = deviceStore.setNickname(normalizeMac(req.params.mac), nickname);
    res.json({ status: "ok", data: device });
  } catch (error) {
    if (error instanceof deviceStore.DeviceNotFoundError) {
      res.status(404).json({ status: "error", message: error.message });
      return;
    }
    if (error.name === "NicknameValidationError") {
      res.status(400).json({ status: "error", message: error.message, errors: error.errors });
      return;
    }
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

router.get("/status", (req, res) => {
  try {
    res.json(lanEngine.getStatus());
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

module.exports = router;
