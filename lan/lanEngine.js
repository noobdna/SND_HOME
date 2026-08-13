// lan/lanEngine.js
// LANスキャンの常時ポーリングエンジン。monitor/monitorEngine.jsと同じ
// 「EventEmitterでupdate/errorを発行し、最新値だけをメモリにキャッシュする」
// 設計を踏襲するが、**monitorEngine.js自体は一切変更しない** —
// 完全に独立した、別タイマーで動く並行エンジンとして実装する。
//
// 独立タイマーにする理由: monitorEngine.js は5秒間隔でcollectorRegistry
// 配下の全Collectorを直列に(awaitで)実行する設計。LANスキャンは254ホスト
// への並行ping+arp読み取りを伴い、数秒〜十数秒かかる重い処理(実測: 自宅
// /24で約5〜18秒)— これを5秒間隔の輪に混ぜると、次のtickを詰まらせたり、
// 家庭内LANに対して過度に高頻度のスキャンを繰り返すことになる。そのため
// 既定の間隔を大幅に長く(2分)取り、独自のタイマーで動かす。
//
// collectors/lanCollector.js はこのエンジンの最新キャッシュを読むだけの
// 軽量な {name, collect()} として別途登録される — collectorRegistry.js の
// 5秒ループ自体はここでは一切ブロックされない。
const EventEmitter = require("events");
const lanScanner = require("./lanScanner");
const deviceStore = require("./deviceStore");
const eventLogStore = require("../monitor/eventLogStore");

const DEFAULT_INTERVAL_MS = 120_000; // 2分

class LanEngine extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.latestScan = null;
    this.lastUpdated = null;
    this.lastError = null;
    this.startedAt = null;
    // 1回のスキャンが intervalMs を超えて長引いた場合に、次のtickが
    // 重複して実行されるのを防ぐガード。monitorEngine.js の5秒間隔の
    // Collector群(すべてミリ秒未満〜数百ms程度で完了)には存在しない
    // 懸念だが、数秒〜十数秒かかりうるLANスキャンでは必要な保護。
    this.scanning = false;
    // deviceStore.recordScan() の最新の戻り値。特に skippedNoMac (mac未解決で
    // 台帳に載らなかった件数) を getStatus() から見えるようにするための保持。
    // 「オンライン検出数(latestScan.onlineCount)」と「台帳の既知デバイス数
    // (knownDeviceCount)」が食い違って見える最大の原因がこれ -- ping には
    // 応答したが arp -a/ip neigh show の時点でMACが解決できなかった機器は、
    // lanScanner.scan() の onlineCount には数えられるが、deviceStore.js の
    // 意図的な設計(このファイル冒頭コメント参照: 安定識別子の無いものは
    // 台帳に残さない)によりknownDeviceCountには数えられない。どちらの数値も
    // それぞれ正しいが、この差分自体が今まで観測不能だった。
    this.lastRecordStats = null;
  }

  /**
   * lanScanner.scan() を1回実行し、deviceStore へ反映する。
   * 成功時は update イベントを発行してキャッシュを更新し、失敗時は error
   * イベントを発行して直前のキャッシュ値を保持する(monitorEngine.tick()と
   * 同じ「1回の失敗でループ全体を止めない」方針)。
   *
   * 注意(monitorEngine.jsとは意図的に異なる一点): "error" は Node の
   * EventEmitter において特別扱いされるイベント名で、リスナーが1つも
   * 登録されていない状態で emit("error", ...) すると、その場で例外が
   * **再スローされ、ハンドリングされなければプロセスがクラッシュする**
   * (Node公式ドキュメントに明記された既知の挙動)。lanEngineはまだ
   * server.jsへ配線されておらず(Stage 4以降の対象)"error" リスナーが
   * 常に存在する保証が無いため、リスナーが実際に登録されている場合に
   * 限って emit する — 未登録時は console.error の記録のみで、スキャン
   * ループ自体は静かに継続する(既に上のconsole.errorでログには残る)。
   */
  async tick() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      // LAN_SCAN_CIDR: 任意の運用者向けオーバーライド。lanScanner.detectLocalSubnet()
      // は os.networkInterfaces() の最初の非内部IPv4インターフェースを機械的に
      // 選ぶだけなので、複数のネットワークインターフェース(VPN・Docker仮想
      // ブリッジ・複数NIC等)が有効なホストでは本来の家庭内LANとは異なる
      // サブネットを誤って選びうる -- その場合、実在する機器の一部がそもそも
      // スキャン対象IP範囲に入らず検出されない。未設定時は既存どおり自動検出。
      const cidr = process.env.LAN_SCAN_CIDR || undefined;
      const result = await lanScanner.scan(cidr ? { cidr } : {});
      this.lastRecordStats = deviceStore.recordScan(result);
      this.latestScan = result;
      this.lastUpdated = new Date().toISOString();
      this.lastError = null;
      console.log(
        `[lanEngine] scan complete: ${result.onlineCount}/${result.totalScanned} online` +
          ` (${this.lastRecordStats.skippedNoMac} skipped: no MAC resolved)`,
      );
      this.emit("update", result);
    } catch (error) {
      this.lastError = error.message || String(error);
      console.error("[lanEngine] scan error:", this.lastError);
      eventLogStore.record({ category: "lan", severity: "error", message: `Scan error: ${this.lastError}` });
      if (this.listenerCount("error") > 0) {
        this.emit("error", error);
      }
    } finally {
      this.scanning = false;
    }
  }

  /**
   * ポーリングを開始する。既に稼働中なら何もしない(二重起動防止)。
   * @param {number} [ms] ポーリング間隔(ms)。省略時は DEFAULT_INTERVAL_MS(2分)。
   */
  start(ms = DEFAULT_INTERVAL_MS) {
    if (this.timer) return;

    this.intervalMs = ms;
    this.startedAt = Date.now();
    console.log(`[lanEngine] LAN scanning started (interval=${ms}ms)`);
    this.tick(); // 初回スキャンをすぐに実行する
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /**
   * ポーリングを停止する。タイマーが無い場合は何もしない。
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.startedAt = null;
  }

  getLatestScan() {
    return this.latestScan;
  }

  getStatus() {
    return {
      running: this.timer !== null,
      interval: this.intervalMs,
      lastUpdated: this.lastUpdated,
      lastError: this.lastError,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      knownDeviceCount: deviceStore.list().length,
      onlineCount: this.latestScan ? this.latestScan.onlineCount : 0,
      // onlineCount(このスキャンで検出できた台数)より低くなりうる:
      // ping/arpのどちらかで見つかったがMACが解決できなかった台数。
      // knownDeviceCount + unresolvedMacCount がおおよそ onlineCount に
      // 一致する(既知デバイスの中にはこのスキャンではオフラインだった
      // ものも含まれるため、必ずしも厳密な恒等式ではない)。
      unresolvedMacCount: this.lastRecordStats ? this.lastRecordStats.skippedNoMac : 0,
    };
  }
}

const engine = new LanEngine();

module.exports = {
  startLanScanning: (ms) => engine.start(ms),
  stopLanScanning: () => engine.stop(),
  getLatestScan: () => engine.getLatestScan(),
  getStatus: () => engine.getStatus(),
  // 将来の購読者(routes/lan.js、通知層等)向けのフック — monitorEngine.js の
  // 同名エクスポートと同じ形。
  on: (eventName, listener) => engine.on(eventName, listener),
  off: (eventName, listener) => engine.off(eventName, listener),
  // テスト用: モジュール共有のシングルトン(上記のエクスポート群が操作する
  // engine)とは別に、独立したインスタンスを都度生成してテストできるように
  // クラス自体もエクスポートする — 複数テストが同じタイマー状態を共有して
  // 干渉し合うことを避けるため(lan/lanEngine.test.js 参照)。
  LanEngine,
};
