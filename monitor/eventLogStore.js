// monitor/eventLogStore.js
// アプリケーション全体の構造化イベント(認証成功/失敗、監視/LANスキャンの
// エラー、通知チャネル失敗等)を一定件数だけメモリに保持するリングバッファ。
// monitor/historyStore.js・alerts/alertHistoryStore.js と同じ設計
// (FIFO、上限超過分は古い順に破棄 -- ただしこのストアに限っては「破棄」ではなく
// 「アーカイブへ退避」に変更した。理由は下記 archiveStore のコメント参照)。
//
// 「エラー/警告」表示と「イベントログ」表示は、このストアを持つ1本の
// タイムラインに対する severity フィルタの有無の違いでしかない — 別ストアを
// 2つ持つと「何がエラーか」の判定をストア間で二重に管理する必要が生まれるため、
// あえて1本にまとめている(OBSERVABILITY_PLAN.md 参照)。
//
// このファイル自体は各エンジン/ミドルウェアを一切知らない(record() を実際に
// 呼ぶ側の配線は各呼び出し元に任せる) -- historyStore.js が monitorEngine.js
// を知らないのと同じ設計。
//
// 永続化: monitor/historyStore.js と同じ理由・同じ方式(定期スナップショット、
// monitor/ringBufferPersistence.js 共有ヘルパー使用)でJSON永続化する。
//
// --- 3階層ログ設計(2026-09-02 追加) ---
// 「現在の状態」「履歴」「過去ログ/Archive」を明確に区別してほしいという要望に
// 対応する変更。区別の境目は以下の通り:
//   1. 現在の状態  … このストアの管轄外。lanEngine/monitorEngine の lastError
//                    (直近1回の処理結果そのもの)が一次情報。過去に何が
//                    起きたかの記録であるこのストアを見ても「現在」は
//                    判定できない(過去のエラーが引き続き表示され続ける
//                    という誤解の原因そのものだったため、あえて分離を保つ)。
//   2. 履歴        … このファイルの `store`(従来通りの EventLogStore)。
//                    直近 HISTORY_RETENTION_DAYS(既定30日)以内のイベントのみを保持する。
//   3. 過去ログ/Archive … 新設の `archiveStore`。30日を超えたイベントは
//                    削除せず archiveExpiredEntries() でこちらへ移動する
//                    (record()時のリングバッファ上限超過による退避も同様、
//                    onEvict フック経由)。EventLogStore クラス自体は変更せず
//                    (既存の class-levelテストへの影響を避ける)、
//                    「エントリを積む先が2箇所になる」配線をモジュールの
//                    シングルトン層だけに閉じている。
const path = require("path");
const { writeEntries, readEntries, createAutoFlush } = require("./ringBufferPersistence");

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;
// Archiveは「削除しない」の受け皿なので上限は履歴よりずっと大きく取る。
// 家庭内LAN監視という規模では現実的に到達しない安全上限であって、
// 「Archiveも無限ではない」という設計上の誠実さのためだけに存在する
// (本当に到達しそうな運用になったら、その時点でファイルローテーション等を
// 別途検討する — 現時点でそれを先回りして作るのはこのタスクの範囲を超える)。
const DEFAULT_ARCHIVE_MAX_ENTRIES = 20_000;
// 「履歴」として保持する期間。これを超えたイベントは archiveExpiredEntries() が
// 自動的に Archive へ移す(削除はしない)。
const DEFAULT_HISTORY_RETENTION_DAYS = 30;

const VALID_SEVERITIES = new Set(["info", "warning", "error"]);
const VALID_CATEGORIES = new Set(["auth", "monitor", "lan", "notifier"]);

class EventLogStore {
  /**
   * @param {number} [maxEntries]
   * @param {{ onEvict?: (entry: object) => void }} [options] onEvict: リング
   *   バッファの上限超過で古いエントリが追い出される瞬間に、そのエントリを
   *   引数に呼ばれる(呼び出し元がアーカイブ等へ退避できるようにするための
   *   フック)。省略時は従来通り何もせず破棄する(このクラス単体のテストや、
   *   使い捨てのインスタンスには不要なため、デフォルトでは配線しない)。
   */
  constructor(maxEntries = DEFAULT_MAX_ENTRIES, { onEvict } = {}) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this.onEvict = typeof onEvict === "function" ? onEvict : null;
  }

  /**
   * 1件のイベントを記録する。上限を超えた分は古い順に追い出す
   * (onEvict が設定されていればそのエントリを渡してから破棄する)。
   * timestamp は呼び出し側が指定しなければ記録時刻を使う。
   * @param {{ category: string, severity: string, message: string, meta?: object, timestamp?: string }} event
   */
  record(event) {
    this.entries.push({
      timestamp: event.timestamp || new Date().toISOString(),
      category: event.category,
      severity: event.severity,
      message: event.message,
      meta: event.meta || {},
    });
    if (this.entries.length > this.maxEntries) {
      const evicted = this.entries.shift();
      if (this.onEvict) {
        this.onEvict(evicted);
      }
    }
  }

  /**
   * 履歴を取得する。limit指定時は直近limit件のみを返す
   * (alerts/alertHistoryStore.js の getHistory({limit}) と同じページング方針)。
   * severity/category を指定すると、それぞれ配列に含まれるものだけに絞り込む
   * (絞り込みを先に行い、その結果に対して limit を適用する — 「直近N件の
   * 絞り込み後の結果」を返す、routes/alerts.js の ?limit= と同じ「最新から
   * 数える」考え方)。
   * from/to はISO 8601文字列で、timestampがその範囲内(両端含む)のものだけに
   * 絞り込む。q はメッセージ本文の部分一致検索(大文字小文字を無視)。
   * どちらも Archive の「後から参照・検索できる構造」要件のために追加したが、
   * 履歴側でも同じフィルタが使える(専用の別実装を持たない)。
   * @param {{ limit?: number, severity?: string[], category?: string[], from?: string, to?: string, q?: string }} [options]
   * @returns {object[]}
   */
  getHistory({ limit, severity, category, from, to, q } = {}) {
    let filtered = this.entries;
    if (Array.isArray(severity) && severity.length > 0) {
      filtered = filtered.filter((e) => severity.includes(e.severity));
    }
    if (Array.isArray(category) && category.length > 0) {
      filtered = filtered.filter((e) => category.includes(e.category));
    }
    if (typeof from === "string" && from) {
      filtered = filtered.filter((e) => e.timestamp >= from);
    }
    if (typeof to === "string" && to) {
      filtered = filtered.filter((e) => e.timestamp <= to);
    }
    if (typeof q === "string" && q.trim()) {
      const needle = q.trim().toLowerCase();
      filtered = filtered.filter((e) => (e.message || "").toLowerCase().includes(needle));
    }

    if (!limit || limit >= filtered.length) {
      return filtered.slice();
    }
    return filtered.slice(filtered.length - limit);
  }

  /**
   * timestamp が cutoffIso より古い(文字列比較で cutoffIso 未満)エントリを
   * 内部配列から取り除いて返す。ISO 8601文字列は辞書式順序と時系列順序が
   * 一致するため、Date化せず文字列比較で済む(このファイル/プロジェクト内の
   * 他のタイムスタンプ比較と同じ前提)。onEvict は呼ばない -- こちらは
   * 呼び出し側(archiveExpiredEntries())が明示的にアーカイブへ渡す設計で、
   * onEvict(record()の上限超過用)と二重にアーカイブされることを避ける。
   * @param {string} cutoffIso
   * @returns {object[]} 取り除かれたエントリ(古い順)
   */
  extractOlderThan(cutoffIso) {
    const kept = [];
    const removed = [];
    for (const entry of this.entries) {
      if (entry.timestamp && entry.timestamp < cutoffIso) {
        removed.push(entry);
      } else {
        kept.push(entry);
      }
    }
    this.entries = kept;
    return removed;
  }

  /**
   * 現在のentries配列をJSONファイルへ書き込む。
   * @param {string} filePath
   */
  persist(filePath) {
    writeEntries(filePath, this.entries);
  }

  /**
   * JSONファイルからentries配列を読み込み、内部状態を置き換える。
   * ファイルが無い/壊れている場合は空のまま(グレースフルデグレード)。
   * 上限件数(maxEntries)を超えて保存されていた場合は直近maxEntries件だけを
   * 採用する。
   * @param {string} filePath
   * @returns {{ loaded: number }}
   */
  load(filePath) {
    const entries = readEntries(filePath, "eventLogStore").filter((e) => e && typeof e === "object");
    this.entries = entries.slice(-this.maxEntries);
    return { loaded: this.entries.length };
  }
}

// Archiveを先に作る(下のstoreのonEvictがこれを参照するため)。
// あえて別インスタンス(同じEventLogStoreクラスを再利用)にしているのは、
// フィルタ/検索(getHistory)・永続化(persist/load)の実装をもう一本
// 増やさずに済ませるため -- 「履歴」と「Archive」は上限件数と用途が
// 違うだけで、データの形も操作も同じリングバッファという判断。
const archiveStore = new EventLogStore(DEFAULT_ARCHIVE_MAX_ENTRIES);
const store = new EventLogStore(DEFAULT_MAX_ENTRIES, {
  onEvict: (entry) => archiveStore.record(entry),
});

const DEFAULT_EVENT_LOG_PATH = path.join(__dirname, "..", "data", "eventLog.json");
const DEFAULT_EVENT_LOG_ARCHIVE_PATH = path.join(__dirname, "..", "data", "eventLogArchive.json");

/**
 * 永続化ファイルのパスを返す。EVENT_LOG_PATH 環境変数があればそれを優先する。
 * @returns {string}
 */
function getEventLogPath() {
  return process.env.EVENT_LOG_PATH || DEFAULT_EVENT_LOG_PATH;
}

/**
 * Archive永続化ファイルのパスを返す。EVENT_LOG_ARCHIVE_PATH 環境変数が
 * あればそれを優先する(EVENT_LOG_PATH と対になる命名)。
 * @returns {string}
 */
function getEventLogArchivePath() {
  return process.env.EVENT_LOG_ARCHIVE_PATH || DEFAULT_EVENT_LOG_ARCHIVE_PATH;
}

/**
 * 履歴(store)のうち、指定日数(既定 DEFAULT_HISTORY_RETENTION_DAYS)より
 * 古いエントリを Archive(archiveStore)へ移す。削除ではなく移動 --
 * 呼び出しごとに store から取り除いた分をそのまま archiveStore.record() に
 * 渡すため、合計件数(履歴+Archive)は必ず保存される。
 * `now` はテストで固定時刻を注入できるよう引数化してある(他のストアの
 * record()がtimestampを注入できるのと同じ理由)。
 * @param {{ now?: Date, maxAgeDays?: number }} [options]
 * @returns {{ archivedCount: number }}
 */
function archiveExpiredEntries({ now = new Date(), maxAgeDays = DEFAULT_HISTORY_RETENTION_DAYS } = {}) {
  const cutoffMs = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const expired = store.extractOlderThan(cutoffIso);
  for (const entry of expired) {
    archiveStore.record(entry);
  }
  return { archivedCount: expired.length };
}

/**
 * 履歴・Archive両方をディスクへ書き込む。server.js からは従来通り
 * `eventLogStore.persist()` を引数なしで呼ぶだけでよい(Archiveの配線を
 * 呼び出し側に意識させない -- 「最小限の変更」要件のため、server.jsは無変更)。
 * @param {string} [filePath]
 * @param {string} [archiveFilePath]
 */
function persist(filePath = getEventLogPath(), archiveFilePath = getEventLogArchivePath()) {
  store.persist(filePath);
  archiveStore.persist(archiveFilePath);
}

/**
 * 履歴・Archive両方をディスクから読み込む。読み込み直後に一度
 * archiveExpiredEntries() を走らせる -- プロセスが30日以上停止していた場合、
 * 次の定期スイープ(最大30秒後)を待たずに反映するため。
 * @param {string} [filePath]
 * @param {string} [archiveFilePath]
 * @returns {{ loaded: number, archiveLoaded: number }}
 */
function load(filePath = getEventLogPath(), archiveFilePath = getEventLogArchivePath()) {
  const historyResult = store.load(filePath);
  const archiveResult = archiveStore.load(archiveFilePath);
  archiveExpiredEntries();
  return { loaded: historyResult.loaded, archiveLoaded: archiveResult.loaded };
}

// 定期スナップショット(既存の30秒間隔をそのまま再利用 -- 新しいタイマーを
// 増やさない)。毎tickで期限切れイベントのアーカイブ移動 → 両ファイルの
// 保存、の順に行う。
const autoFlush = createAutoFlush(() => {
  archiveExpiredEntries();
  persist();
}, DEFAULT_SNAPSHOT_INTERVAL_MS);

module.exports = {
  record: (event) => store.record(event),
  // 「履歴」(直近 HISTORY_RETENTION_DAYS 日以内)のみを返す -- 期限切れは
  // archiveExpiredEntries() が定期的に取り除いているため、このAPIの返り値は
  // 常に「現在の履歴ウィンドウ」を表す。
  getHistory: (options) => store.getHistory(options),
  // 「過去ログ/Archive」(30日を超えて移動されたイベント)を返す。
  // getHistory() と同じフィルタ(severity/category/from/to/q)が使える。
  getArchive: (options) => archiveStore.getHistory(options),
  archiveExpiredEntries,
  getMaxEntries: () => store.maxEntries,
  getArchiveMaxEntries: () => archiveStore.maxEntries,
  getRetentionDays: () => DEFAULT_HISTORY_RETENTION_DAYS,
  persist,
  load,
  getEventLogPath,
  getEventLogArchivePath,
  startAutoFlush: autoFlush.start,
  stopAutoFlush: autoFlush.stop,
  VALID_SEVERITIES,
  VALID_CATEGORIES,
  // テスト用: 実運用の(500件・共有シングルトンの)storeとは別に、小さい
  // maxEntries で独立したインスタンスを都度生成してリングバッファの境界条件を
  // 検証できるようにする -- monitor/historyStore.js の HistoryStore エクスポートと同じ理由。
  EventLogStore,
};
