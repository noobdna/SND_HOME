// routes/piStatus.js
// 特定の1台(Raspberry Pi等)のオンライン状態を返すルート(/api/pi-status)。
// lan/deviceStore.js を直接参照する -- routes/lan.js の requireAuth 一括保護
// (デバイス一覧全体は家庭内の在室状況等を推測できる機微情報、というPhase 5の
// 判断)を経由せず、あえて別ルーターとして切り出している。理由:
//
// 1. PI_MONITOR_MAC で指定した「1台だけ」の派生フィールド(online/ip/
//    lastSeenAt)のみを返し、ベンダー名・ニックネーム・台帳全体には一切
//    触れない -- /api/lan/devices 一覧よりも露出範囲が狭い。
// 2. 現在のダッシュボードUIは Authorization ヘッダーを送信する仕組みを
//    持たない。/api/lan と同じ扱いで保護すると、API_KEY設定時にこのカードだけ
//    静かに表示できなくなる(OBSERVABILITY_PLAN.mdで確認済みの、他の新規
//    エンドポイント群と同じ判断: /api/system と同水準の公開エンドポイントとする)。
//
// PI_MONITOR_MAC が未設定の場合は configured:false を返し、対象デバイスが
// まだ一度もスキャンで観測されていない場合は found:false を返す -- lanEngine
// の既存の2分間隔スキャン(lan/lanEngine.js)が既にこのMACを含む全LANを
// カバーしているため、新規のポーリング機構は一切追加しない
// (OBSERVABILITY_PLAN.mdで確認済み: SSHベースの能動チェックではなく、
// 既存の受動的なLANスキャン結果を再利用する)。
const express = require("express");
const deviceStore = require("../lan/deviceStore");
const { normalizeMac } = require("../lan/lanScanner");

const router = express.Router();

router.get("/", (req, res) => {
  const rawMac = process.env.PI_MONITOR_MAC;
  if (!rawMac) {
    res.json({ configured: false });
    return;
  }

  try {
    const device = deviceStore.get(normalizeMac(rawMac));
    res.json({
      configured: true,
      found: true,
      online: device.online,
      ip: device.ip,
      lastSeenAt: device.lastSeenAt,
    });
  } catch (error) {
    if (error instanceof deviceStore.DeviceNotFoundError) {
      res.json({ configured: true, found: false });
      return;
    }
    res.status(500).json({ status: "error", message: error.message || "Unknown error" });
  }
});

module.exports = router;
