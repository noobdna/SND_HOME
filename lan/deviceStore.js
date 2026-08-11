// lan/deviceStore.js
// LANスキャンで見つかった機器の「既知デバイス台帳」。インメモリCRUD + JSON
// 書き込みスルー永続化 — alerts/ruleStore.js と全く同じ設計パターン
// (バリデーション → インメモリMap → 変更のたびpersist() → 起動時load())。
//
// 識別子の設計判断: MACアドレスを安定識別子として使う(IPアドレスは
// DHCPで再割当てされうるため、時系列で同一機器を追跡する識別子として
// 不適切)。lan/lanScanner.js の scan() 結果のうち mac が解決できなかった
// エントリ(mac: null)は、この台帳には記録しない — 安定した識別子が
// 無いものを「新規デバイス」「オフライン」として誤って履歴に残すより、
// 台帳から除外する方が安全側の判断(既存の networkCollector.js 等の
// グレースフルデグレード方針と同じ考え方: 取れない情報は無理に埋めない)。
// mac未解決のエントリ自体は lanScanner.scan() の生の戻り値としては
// 引き続き見える — 台帳(永続履歴)に載らないだけ。
const fs = require("fs");
const path = require("path");

const NICKNAME_MAX_LENGTH = 100;

class DeviceNotFoundError extends Error {
  constructor(mac) {
    super(`Device not found: ${mac}`);
    this.name = "DeviceNotFoundError";
    this.mac = mac;
  }
}

/**
 * ニックネームを検証する。null(未設定に戻す)か、trim後1〜100文字の
 * 非空文字列のみ許可する。エラーメッセージの配列を返す(空配列 = 有効)。
 * @param {*} nickname
 * @returns {string[]}
 */
function validateNickname(nickname) {
  if (nickname === null) return [];
  if (typeof nickname !== "string" || nickname.trim() === "") {
    return ["nickname must be null or a non-empty string"];
  }
  if (nickname.trim().length > NICKNAME_MAX_LENGTH) {
    return [`nickname must be ${NICKNAME_MAX_LENGTH} characters or fewer`];
  }
  return [];
}

// mac(小文字コロン区切りに正規化済み)-> device。
// 内部状態を呼び出し元に直接渡さないよう、出入りの際は必ず cloneDevice() を通す。
const devices = new Map();

function cloneDevice(device) {
  return { ...device };
}

/**
 * lanScanner.scan() の戻り値を台帳へ反映する:
 * - mac が解決できたスキャン内の各デバイスをupsert(ip/vendor/lastSeenAtを更新、
 *   新規なら firstSeenAt も設定)
 * - 台帳内の既知デバイスのうち、今回のスキャンに登場しなかったものは online:false にする
 * - 変更後、まとめて1回だけ persist() する(デバイス数ぶん書き込みを繰り返さない)
 *
 * respondedToPing/inArpTable も台帳へそのまま持ち越す(実機検証で判明した
 * 「pingには応答しないがARPには載っている機器がいる」という事実を踏まえ、
 * lanScanner.js の scan() は検知方式を単一の online フラグへ握りつぶさず
 * 個別に返すようになった — この台帳もその情報を捨てずに保持し、後から
 * 「なぜこの機器はオンライン判定なのか」を検知方式ごとに追跡できるようにする)。
 * オフラインへ遷移したデバイスはこの2フィールドを両方 false にする
 * (直近のスキャンでどちらの方式にも引っかからなかった、という事実を正確に表す)。
 * @param {{ scannedAt: string, devices: Array<{ip:string, mac:string|null, vendor:string|null, respondedToPing?:boolean, inArpTable?:boolean, online:boolean}> }} scanResult
 * @returns {{ upserted: number, skippedNoMac: number, markedOffline: number }}
 */
function recordScan(scanResult) {
  const seenMacs = new Set();
  let upserted = 0;
  let skippedNoMac = 0;

  for (const scanned of scanResult.devices) {
    if (!scanned.mac) {
      skippedNoMac++;
      continue;
    }
    const mac = scanned.mac;
    seenMacs.add(mac);

    const existing = devices.get(mac);
    devices.set(mac, {
      mac,
      ip: scanned.ip,
      vendor: scanned.vendor,
      nickname: existing ? existing.nickname : null,
      online: true,
      respondedToPing: Boolean(scanned.respondedToPing),
      inArpTable: Boolean(scanned.inArpTable),
      firstSeenAt: existing ? existing.firstSeenAt : scanResult.scannedAt,
      lastSeenAt: scanResult.scannedAt,
    });
    upserted++;
  }

  let markedOffline = 0;
  for (const [mac, device] of devices) {
    if (!seenMacs.has(mac) && device.online) {
      devices.set(mac, { ...device, online: false, respondedToPing: false, inArpTable: false });
      markedOffline++;
    }
  }

  persist();
  return { upserted, skippedNoMac, markedOffline };
}

/**
 * 台帳の全デバイスを配列で返す(複製)。
 * @returns {object[]}
 */
function list() {
  return Array.from(devices.values()).map(cloneDevice);
}

/**
 * macで1件取得する(複製)。
 * @param {string} mac
 * @returns {object}
 * @throws {DeviceNotFoundError}
 */
function get(mac) {
  const device = devices.get(mac);
  if (!device) {
    throw new DeviceNotFoundError(mac);
  }
  return cloneDevice(device);
}

/**
 * 既知デバイスにユーザー定義のニックネームを設定する(null で解除)。
 * @param {string} mac
 * @param {string|null} nickname
 * @returns {object} 更新後のデバイス(複製)
 * @throws {DeviceNotFoundError} 対象デバイスが台帳に無い場合
 * @throws {Error} nicknameがバリデーションに失敗した場合(.errors に詳細)
 */
function setNickname(mac, nickname) {
  const existing = devices.get(mac);
  if (!existing) {
    throw new DeviceNotFoundError(mac);
  }

  const errors = validateNickname(nickname);
  if (errors.length > 0) {
    const error = new Error(`Invalid nickname: ${errors.join("; ")}`);
    error.name = "NicknameValidationError";
    error.errors = errors;
    throw error;
  }

  const normalized = nickname === null ? null : nickname.trim();
  const updated = { ...existing, nickname: normalized };
  devices.set(mac, updated);
  persist();
  return cloneDevice(updated);
}

/**
 * 台帳を全消去する(インメモリのみ・ディスクには書き込まない)。
 * テストでの状態リセット、および load() が再読込前に内部状態を空にするために使う。
 */
function clear() {
  devices.clear();
}

// ---------------------------------------------------------
// JSON永続化(alerts/ruleStore.js と同じ方式)
// ---------------------------------------------------------

const DEFAULT_DEVICES_PATH = path.join(__dirname, "..", "data", "lanDevices.json");

function getDevicesPath() {
  return process.env.LAN_DEVICES_PATH || DEFAULT_DEVICES_PATH;
}

function persist(filePath = getDevicesPath()) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const data = Array.from(devices.values());
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/**
 * JSONファイルから台帳を読み込み、インメモリ状態を置き換える。
 * ファイルが存在しない場合は何もしない(初回起動)。壊れた内容は
 * ruleStore.js の load() と同じ方針でスキップ・警告し、クラッシュしない。
 * @param {string} [filePath]
 * @returns {{ loaded: number, skipped: number }}
 */
function load(filePath = getDevicesPath()) {
  clear();

  if (!fs.existsSync(filePath)) {
    return { loaded: 0, skipped: 0 };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.warn(`[deviceStore] Failed to read ${filePath}: ${error.message}`);
    return { loaded: 0, skipped: 0 };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[deviceStore] Failed to parse ${filePath} as JSON: ${error.message}`);
    return { loaded: 0, skipped: 0 };
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[deviceStore] ${filePath} does not contain a JSON array; ignoring`);
    return { loaded: 0, skipped: 0 };
  }

  let loaded = 0;
  let skipped = 0;
  for (const device of parsed) {
    if (!device || typeof device.mac !== "string" || device.mac.trim() === "") {
      console.warn(`[deviceStore] Skipping invalid device entry from ${filePath}`);
      skipped++;
      continue;
    }
    devices.set(device.mac, {
      mac: device.mac,
      ip: device.ip ?? null,
      vendor: device.vendor ?? null,
      nickname: device.nickname ?? null,
      // 再起動直後はまだ一度もスキャンしていないため、「最後に見えた時点の
      // online状態」をそのまま復元するのではなく、常に false から始める —
      // 実際にオンラインかどうかは次のスキャンが確定させる(古いキャッシュ値を
      // 生存確認と偽らないため)。respondedToPing/inArpTable も同じ理由で false。
      online: false,
      respondedToPing: false,
      inArpTable: false,
      firstSeenAt: device.firstSeenAt ?? null,
      lastSeenAt: device.lastSeenAt ?? null,
    });
    loaded++;
  }

  return { loaded, skipped };
}

module.exports = {
  NICKNAME_MAX_LENGTH,
  validateNickname,
  DeviceNotFoundError,
  recordScan,
  list,
  get,
  setNickname,
  clear,
  load,
  persist,
  getDevicesPath,
};
