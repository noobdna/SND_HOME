// collectors/lanCollector.js
// monitor/collectorRegistry.js の既存Collectorプラグイン規約({name, collect()})
// に沿った軽量アダプタ。**LANスキャンそのものはここでは行わない** —
// lan/lanEngine.js が独立した(2分間隔の)タイマーで既に管理しているキャッシュを
// 読むだけの、ミリ秒未満で完了する軽い呼び出し。cpu/memory/disk/network の
// 各Collectorと同じ「5秒ごとに呼ばれても問題ない」性質をそのまま満たす
// (lan/lanEngine.js のファイル冒頭コメント参照 — なぜLANスキャン自体を
// この5秒ループに混ぜないかの理由)。
//
// デバイス一覧を配列ではなく「MACアドレスをキーにしたオブジェクト」として
// 公開しているのは、alerts/ruleEvaluator.js のドットパス解決
// (resolveMetric()、"."区切りでオブジェクトを辿るだけの既存実装、
// 一切変更していない)をそのまま使って、個別デバイスの死活をアラート
// ルール化できるようにするため — 例:
// { metric: "lan.devices.aa_bb_cc_dd_ee_ff.online", operator: "<", threshold: 1 }
// で「特定デバイスがオフラインになったら通知」が、alertEngine.js/
// ruleEvaluator.js に一切手を入れずに実現できる。MAC内の ":" は
// ドットパスの区切り文字と衝突しないよう "_" に置換する。
//
// 重要な設計判断: 個々のデバイスは lan/lanEngine.js の最新スキャン結果
// (latest.devices)ではなく、**lan/deviceStore.js の台帳(list())** から
// 列挙する。scan()の devices 配列はその回のスキャンで検出できたデバイス
// **だけ**を含み、オフラインになったデバイスはそもそも配列から消える —
// もしそちらを使うと、デバイスがオフラインになった瞬間 "lan.devices.<mac>"
// というキー自体がスナップショットから消滅し、resolveMetric() はそれを
// 「途中のプロパティが存在しない」= undefined = 「データなし、この回の
// 評価はスキップ」として扱ってしまう(alerts/ruleEvaluator.js 自身の
// JSDocの通り)。つまり「オフラインになった」という事実がアラート評価に
// 一切届かない、という静かなバグになる。deviceStore.list() は台帳に
// 一度でも記録された既知デバイスを online:false のまま保持し続けるため、
// online フィールドの値そのものが 0 になり、既存の operator/threshold
// 比較(例: "<" 1)で正しく検知できる。
const lanEngine = require("../lan/lanEngine");
const deviceStore = require("../lan/deviceStore");

/**
 * MACアドレス(コロン区切り)を、ドットパスのキーとして安全な形に変換する。
 * @param {string} mac
 * @returns {string}
 */
function macToKey(mac) {
  return mac.replace(/:/g, "_");
}

module.exports = {
  name: "lan",
  async collect() {
    const latest = lanEngine.getLatestScan();

    // list() は呼ぶたびに台帳全体を複製する(deviceStore.js の cloneDevice()
    // 参照)ため、同じ結果を件数(knownDeviceCount)にも使い回し、5秒ごとの
    // collect() 呼び出しで無駄にMap全体を2回走査・複製しない。
    const knownDevices = deviceStore.list();

    const devices = {};
    for (const device of knownDevices) {
      devices[macToKey(device.mac)] = {
        ip: device.ip,
        vendor: device.vendor,
        nickname: device.nickname,
        online: device.online ? 1 : 0,
        respondedToPing: device.respondedToPing ? 1 : 0,
        inArpTable: device.inArpTable ? 1 : 0,
        lastSeenAt: device.lastSeenAt,
      };
    }

    return {
      // まだ一度もスキャンが完了していない(起動直後、あるいはlanEngineが
      // 起動されていない)場合、scanned:false かつ latest系フィールドはnull
      // -- 他のCollectorと同じグレースフルデグレード(例外を投げない)。
      scanned: latest !== null,
      scannedAt: latest ? latest.scannedAt : null,
      onlineCount: latest ? latest.onlineCount : 0,
      totalScanned: latest ? latest.totalScanned : 0,
      knownDeviceCount: knownDevices.length,
      devices,
    };
  },
};
