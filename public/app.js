// SND@HOME Monitoring Dashboard
// Vanilla JavaScript only - no external libraries

const REFRESH_INTERVAL_MS = 3000;
const API_ENDPOINT = "/api/system";
const HISTORY_ENDPOINT = "/api/system/history";
const MONITOR_STATUS_ENDPOINT = "/api/monitor/status";
const ALERTS_STATUS_ENDPOINT = "/api/alerts/engine/status";
const LAN_STATUS_ENDPOINT = "/api/lan/status";
const EVENTS_ENDPOINT = "/api/events";
const AUTH_STATUS_ENDPOINT = "/api/auth/status";
const CONNECTIONS_SOURCES_ENDPOINT = "/api/connections/sources";
const PI_STATUS_ENDPOINT = "/api/pi-status";

// DOM要素の参照をキャッシュ
const elements = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  errorBanner: document.getElementById("errorBanner"),

  cpuValue: document.getElementById("cpuValue"),
  cpuBar: document.getElementById("cpuBar"),
  cpuCores: document.getElementById("cpuCores"),

  memValue: document.getElementById("memValue"),
  memBar: document.getElementById("memBar"),
  memDetail: document.getElementById("memDetail"),

  diskValue: document.getElementById("diskValue"),
  diskBar: document.getElementById("diskBar"),
  diskDetail: document.getElementById("diskDetail"),

  hostname: document.getElementById("hostname"),
  ipAddress: document.getElementById("ipAddress"),
  uptime: document.getElementById("uptime"),
  lastUpdated: document.getElementById("lastUpdated"),

  monitorStatusDot: document.getElementById("monitorStatusDot"),
  monitorStatusValue: document.getElementById("monitorStatusValue"),
  alertsStatusDot: document.getElementById("alertsStatusDot"),
  alertsStatusValue: document.getElementById("alertsStatusValue"),
  lanStatusDot: document.getElementById("lanStatusDot"),
  lanStatusValue: document.getElementById("lanStatusValue"),

  cpuChart: document.getElementById("cpuChart"),
  cpuHistoryValue: document.getElementById("cpuHistoryValue"),
  memChart: document.getElementById("memChart"),
  memHistoryValue: document.getElementById("memHistoryValue"),
  diskChart: document.getElementById("diskChart"),
  diskHistoryValue: document.getElementById("diskHistoryValue"),
  netChart: document.getElementById("netChart"),
  netHistoryValue: document.getElementById("netHistoryValue"),

  errorsCount: document.getElementById("errorsCount"),
  errorsList: document.getElementById("errorsList"),
  eventLogList: document.getElementById("eventLogList"),

  authEnforcedValue: document.getElementById("authEnforcedValue"),
  authEventsList: document.getElementById("authEventsList"),

  connectionsCurrent: document.getElementById("connectionsCurrent"),
  connectionsSub: document.getElementById("connectionsSub"),
  sourceIpList: document.getElementById("sourceIpList"),

  connectionsChart: document.getElementById("connectionsChart"),
  connectionsHistoryValue: document.getElementById("connectionsHistoryValue"),

  piStatusDot: document.getElementById("piStatusDot"),
  piStatusValue: document.getElementById("piStatusValue"),
  piIpAddress: document.getElementById("piIpAddress"),
  piLastSeenAt: document.getElementById("piLastSeenAt"),
};

// チャートの色はCSSカスタムプロパティ(テーマ)から取得し、既存の配色と統一する
const chartColors = {
  accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  green: getComputedStyle(document.documentElement).getPropertyValue("--green").trim(),
  border: getComputedStyle(document.documentElement).getPropertyValue("--border-color").trim(),
};

/**
 * バイト数を人間が読みやすい単位(KB/MB/GB)に変換する
 */
function formatBytes(bytes) {
  if (typeof bytes !== "number" || isNaN(bytes)) return "--";
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);

  return `${value.toFixed(1)} ${units[i]}`;
}

/**
 * 秒数を「◯日 ◯時間 ◯分」形式に変換する
 */
function formatUptime(seconds) {
  if (typeof seconds !== "number" || isNaN(seconds)) return "--";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  parts.push(`${minutes}分`);

  return parts.join(" ");
}

/**
 * 現在時刻を HH:MM:SS 形式で返す
 */
function formatTime(date) {
  return date.toLocaleTimeString("ja-JP", { hour12: false });
}

/**
 * /api/events のエントリ配列を <ul> 要素へ描画する共通ヘルパー
 * (「エラー/警告」カードと「イベントログ」パネルの両方から使う --
 * どちらも同じ /api/events を severity フィルタの有無だけ変えて呼ぶだけなので、
 * 表示側も1つのレンダラを共有する)。DOM構築は innerHTML ではなく
 * createElement/textContent で行う(サーバー側生成の文字列とはいえ、
 * このプロジェクトの既存コードにも innerHTML への文字列連結は一切無い)。
 * @param {HTMLElement} listEl
 * @param {object[]} entries
 */
function renderLogEntries(listEl, entries) {
  listEl.textContent = "";

  if (!Array.isArray(entries) || entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "log-empty";
    empty.textContent = "記録なし";
    listEl.appendChild(empty);
    return;
  }

  // 新しいものを上に表示する(取得順は古い→新しいなので逆順に並べる)
  entries
    .slice()
    .reverse()
    .forEach((entry) => {
      const li = document.createElement("li");
      li.className = `log-entry severity-${entry.severity || "info"}`;

      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = entry.timestamp ? formatTime(new Date(entry.timestamp)) : "--";

      const category = document.createElement("span");
      category.className = "log-category";
      category.textContent = entry.category || "";

      const message = document.createElement("span");
      message.className = "log-message";
      message.textContent = entry.message || "";

      li.appendChild(time);
      li.appendChild(category);
      li.appendChild(message);
      listEl.appendChild(li);
    });
}

/**
 * /api/connections/sources のエントリ配列(IP・リクエスト数・最終アクセス時刻)を
 * <ul> 要素へ描画する。renderLogEntries() とは列の形が異なる(severity/category/
 * messageではなくip/requestCount/lastSeenAt)ため、専用のレンダラとする。
 * @param {HTMLElement} listEl
 * @param {object[]} sources
 */
function renderSourceIps(listEl, sources) {
  listEl.textContent = "";

  if (!Array.isArray(sources) || sources.length === 0) {
    const empty = document.createElement("li");
    empty.className = "log-empty";
    empty.textContent = "記録なし";
    listEl.appendChild(empty);
    return;
  }

  sources.forEach((source) => {
    const li = document.createElement("li");
    li.className = "log-entry";

    const ip = document.createElement("span");
    ip.className = "log-message";
    ip.textContent = source.ip || "--";

    const count = document.createElement("span");
    count.className = "log-category";
    count.textContent = `${source.requestCount}件`;

    const lastSeen = document.createElement("span");
    lastSeen.className = "log-time";
    lastSeen.textContent = source.lastSeenAt ? formatTime(new Date(source.lastSeenAt)) : "--";

    li.appendChild(ip);
    li.appendChild(count);
    li.appendChild(lastSeen);
    listEl.appendChild(li);
  });
}

/**
 * network情報からローカルIPアドレスを抽出する。
 * server.js の /api/system は network.localIp を返す構成に対応。
 * 万一 localIp が無い場合は interfaces から探すフォールバックも用意。
 */
function extractLocalIp(network) {
  if (!network) return "--";

  if (network.localIp) return network.localIp;

  if (Array.isArray(network.interfaces)) {
    const found = network.interfaces.find(
      (iface) => iface.family === "IPv4" && !iface.internal
    );
    if (found) return found.address;
  }

  return "--";
}

/**
 * 使用率(%)に応じてプログレスバーの色クラスを切り替える
 */
function applyBarColor(barElement, percent) {
  barElement.classList.remove("warning", "critical");

  if (percent >= 85) {
    barElement.classList.add("critical");
  } else if (percent >= 60) {
    barElement.classList.add("warning");
  }
}

function setOnlineStatus(isOnline) {
  elements.statusDot.classList.remove("online", "offline");
  elements.statusDot.classList.add(isOnline ? "online" : "offline");
  elements.statusText.textContent = isOnline ? "オンライン" : "接続エラー";
}

/**
 * SNDサービス状態カードの1行分(dot + value)を更新する共通ヘルパー。
 * @param {HTMLElement} dotEl
 * @param {HTMLElement} valueEl
 * @param {boolean} isRunning
 * @param {string} runningText
 */
function setServiceRow(dotEl, valueEl, isRunning, runningText) {
  dotEl.classList.remove("online", "offline");
  dotEl.classList.add(isRunning ? "online" : "offline");
  valueEl.textContent = isRunning ? runningText : "停止中";
}

/**
 * SNDサービス状態カードの1行分を「取得失敗」状態にする。
 * @param {HTMLElement} dotEl
 * @param {HTMLElement} valueEl
 */
function setServiceRowError(dotEl, valueEl) {
  dotEl.classList.remove("online", "offline");
  valueEl.textContent = "--";
}

function showError(message) {
  elements.errorBanner.textContent = `⚠ ${message}`;
  elements.errorBanner.hidden = false;
}

function hideError() {
  elements.errorBanner.hidden = true;
  elements.errorBanner.textContent = "";
}

/**
 * 取得したシステム情報をダッシュボードに反映する
 */
function renderSystemInfo(data) {
  // CPU
  const cpuUsage = data.cpu && typeof data.cpu.usage === "number" ? data.cpu.usage : 0;
  const cpuCores = data.cpu && data.cpu.cores ? data.cpu.cores : "--";

  elements.cpuValue.textContent = `${cpuUsage.toFixed(1)}%`;
  elements.cpuBar.style.width = `${Math.min(cpuUsage, 100)}%`;
  applyBarColor(elements.cpuBar, cpuUsage);
  elements.cpuCores.textContent = `コア数: ${cpuCores}`;

  // Memory
  const memPercent = data.memory && typeof data.memory.percent === "number" ? data.memory.percent : 0;
  const memUsed = data.memory ? data.memory.used : null;
  const memTotal = data.memory ? data.memory.total : null;

  elements.memValue.textContent = `${memPercent.toFixed(1)}%`;
  elements.memBar.style.width = `${Math.min(memPercent, 100)}%`;
  applyBarColor(elements.memBar, memPercent);
  elements.memDetail.textContent = `${formatBytes(memUsed)} / ${formatBytes(memTotal)}`;

  // Disk
  const diskPercent = data.disk && typeof data.disk.percent === "number" ? data.disk.percent : 0;
  const diskUsed = data.disk ? data.disk.used : null;
  const diskTotal = data.disk ? data.disk.total : null;

  elements.diskValue.textContent = `${diskPercent.toFixed(1)}%`;
  elements.diskBar.style.width = `${Math.min(diskPercent, 100)}%`;
  applyBarColor(elements.diskBar, diskPercent);
  elements.diskDetail.textContent = `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`;

  // Host Info
  elements.hostname.textContent = data.hostname || "--";
  elements.ipAddress.textContent = extractLocalIp(data.network);
  elements.uptime.textContent = formatUptime(data.uptime);
  elements.lastUpdated.textContent = formatTime(new Date());

  // Current Connections (collectors/connectionsCollector.js 経由で /api/system に
  // 自動的に載る -- 他のCollectorと同じ「新規エンドポイント不要」パターン)
  const connCurrent = data.connections && typeof data.connections.current === "number" ? data.connections.current : "--";
  const connLastMinute =
    data.connections && typeof data.connections.requestsLastMinute === "number" ? data.connections.requestsLastMinute : "--";
  elements.connectionsCurrent.textContent = String(connCurrent);
  elements.connectionsSub.textContent = `直近1分: ${connLastMinute} リクエスト`;
}

/**
 * Canvas上に1本以上の折れ線グラフを描画する軽量チャート関数。
 * 外部ライブラリを使わず、Canvas 2D APIのみで実装する。
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{values: (number|null)[], color: string}>} series 同じ長さの系列を複数描画可能
 * @param {{min?: number, max?: number}} [options] 省略時はデータの最小/最大値を使う
 */
function drawLineChart(canvas, series, options = {}) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  const allValues = series
    .flatMap((s) => s.values)
    .filter((v) => typeof v === "number" && !isNaN(v));
  if (allValues.length < 2) return;

  const min = typeof options.min === "number" ? options.min : Math.min(...allValues);
  let max = typeof options.max === "number" ? options.max : Math.max(...allValues);
  if (max <= min) max = min + 1;
  const range = max - min;

  // 背景グリッド線(25%刻み)
  ctx.strokeStyle = chartColors.border;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  series.forEach(({ values, color }) => {
    const stepX = width / (values.length - 1);
    let started = false;

    ctx.beginPath();
    values.forEach((v, i) => {
      if (typeof v !== "number" || isNaN(v)) {
        started = false;
        return;
      }
      const x = i * stepX;
      const clamped = Math.min(Math.max(v, min), max);
      const y = height - ((clamped - min) / range) * height;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
  });
}

/**
 * バイト/秒を人間が読みやすい単位の転送速度文字列に変換する
 */
function formatRate(bytesPerSec) {
  if (typeof bytesPerSec !== "number" || isNaN(bytesPerSec)) return "--";
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * 累積送受信バイト数の履歴から、区間ごとの転送速度(bytes/sec)を算出する。
 * 系列の先頭は差分が取れないためnullとする。カウンタリセット(再起動等)で
 * 差分が負になった場合は0として扱う。
 */
function computeNetworkRates(history) {
  const rxRates = [null];
  const txRates = [null];

  for (let i = 1; i < history.length; i++) {
    const prevNet = (history[i - 1] && history[i - 1].network) || {};
    const currNet = (history[i] && history[i].network) || {};
    const dtSec = (new Date(history[i].timestamp) - new Date(history[i - 1].timestamp)) / 1000;

    if (typeof prevNet.rxBytes === "number" && typeof currNet.rxBytes === "number" && dtSec > 0) {
      rxRates.push(Math.max(0, (currNet.rxBytes - prevNet.rxBytes) / dtSec));
    } else {
      rxRates.push(null);
    }

    if (typeof prevNet.txBytes === "number" && typeof currNet.txBytes === "number" && dtSec > 0) {
      txRates.push(Math.max(0, (currNet.txBytes - prevNet.txBytes) / dtSec));
    } else {
      txRates.push(null);
    }
  }

  return { rxRates, txRates, latestRx: rxRates[rxRates.length - 1], latestTx: txRates[txRates.length - 1] };
}

/**
 * 履歴データを取得してCPU/メモリ/ディスク/ネットワークの4チャートを再描画する
 */
function renderCharts(history) {
  if (!Array.isArray(history) || history.length === 0) return;

  const cpuValues = history.map((h) => (h.cpu ? h.cpu.usage : null));
  const memValues = history.map((h) => (h.memory ? h.memory.percent : null));
  const diskValues = history.map((h) => (h.disk ? h.disk.percent : null));

  drawLineChart(elements.cpuChart, [{ values: cpuValues, color: chartColors.accent }], { min: 0, max: 100 });
  drawLineChart(elements.memChart, [{ values: memValues, color: chartColors.accent }], { min: 0, max: 100 });
  drawLineChart(elements.diskChart, [{ values: diskValues, color: chartColors.accent }], { min: 0, max: 100 });

  const latestCpu = cpuValues[cpuValues.length - 1];
  const latestMem = memValues[memValues.length - 1];
  const latestDisk = diskValues[diskValues.length - 1];
  elements.cpuHistoryValue.textContent = typeof latestCpu === "number" ? `${latestCpu.toFixed(1)}%` : "--%";
  elements.memHistoryValue.textContent = typeof latestMem === "number" ? `${latestMem.toFixed(1)}%` : "--%";
  elements.diskHistoryValue.textContent = typeof latestDisk === "number" ? `${latestDisk.toFixed(1)}%` : "--%";

  const { rxRates, txRates, latestRx, latestTx } = computeNetworkRates(history);
  drawLineChart(
    elements.netChart,
    [
      { values: rxRates, color: chartColors.accent },
      { values: txRates, color: chartColors.green },
    ],
    { min: 0 }
  );
  elements.netHistoryValue.textContent = `↓ ${formatRate(latestRx)}  ↑ ${formatRate(latestTx)}`;

  const connCurrentValues = history.map((h) => (h.connections ? h.connections.current : null));
  const connLastMinuteValues = history.map((h) => (h.connections ? h.connections.requestsLastMinute : null));
  drawLineChart(
    elements.connectionsChart,
    [
      { values: connCurrentValues, color: chartColors.accent },
      { values: connLastMinuteValues, color: chartColors.green },
    ],
    { min: 0 }
  );
  const latestConnCurrent = connCurrentValues[connCurrentValues.length - 1];
  elements.connectionsHistoryValue.textContent = typeof latestConnCurrent === "number" ? String(latestConnCurrent) : "--";
}

/**
 * /api/system/history を取得してチャートを更新する。
 * 取得失敗時は致命的エラーではないため、既存のチャート表示を維持して黙って諦める。
 */
async function fetchHistory() {
  try {
    const response = await fetch(HISTORY_ENDPOINT);
    if (!response.ok) return;

    const json = await response.json();
    if (json.status !== "ok") return;

    renderCharts(json.data);
  } catch (error) {
    // ネットワーク断などでも致命的ではないため無視する
  }
}

/**
 * 既存の /api/monitor/status・/api/alerts/engine/status・/api/lan/status を
 * 個別に取得し、SNDサービス状態カードへ反映する。3つとも既存の(このカード
 * のために新設したわけではない)ステータスエンドポイントで、バックエンドの
 * 変更は一切不要。1つの取得が失敗しても他の行の表示は保つため、
 * Promise.all ではなく Promise.allSettled を使う
 * (notifierRegistry.dispatch() の「1チャンネルの失敗が他を巻き込まない」
 * という既存方針と同じ考え方)。
 */
async function fetchServiceStatus() {
  const [monitorResult, alertsResult, lanResult] = await Promise.allSettled([
    fetch(MONITOR_STATUS_ENDPOINT).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    fetch(ALERTS_STATUS_ENDPOINT).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    fetch(LAN_STATUS_ENDPOINT).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
  ]);

  if (monitorResult.status === "fulfilled") {
    setServiceRow(elements.monitorStatusDot, elements.monitorStatusValue, Boolean(monitorResult.value.running), "稼働中");
  } else {
    setServiceRowError(elements.monitorStatusDot, elements.monitorStatusValue);
  }

  if (alertsResult.status === "fulfilled") {
    const { running, rulesCount } = alertsResult.value;
    const text = typeof rulesCount === "number" ? `稼働中 (${rulesCount}ルール)` : "稼働中";
    setServiceRow(elements.alertsStatusDot, elements.alertsStatusValue, Boolean(running), text);
  } else {
    setServiceRowError(elements.alertsStatusDot, elements.alertsStatusValue);
  }

  if (lanResult.status === "fulfilled") {
    const { running, onlineCount } = lanResult.value;
    const text = typeof onlineCount === "number" ? `稼働中 (${onlineCount}台)` : "稼働中";
    setServiceRow(elements.lanStatusDot, elements.lanStatusValue, Boolean(running), text);
  } else {
    setServiceRowError(elements.lanStatusDot, elements.lanStatusValue);
  }
}

/**
 * /api/events を複数の絞り込みで取得し、「エラー/警告」「認証イベント」
 * 「イベントログ」の3枠を更新する。severity=warning,error の絞り込みが
 * 「エラー/警告」表示そのもの、category=auth の絞り込みが「認証イベント」
 * 表示そのもの(専用の /api/errors・/api/auth/events は存在しない、
 * OBSERVABILITY_PLAN.md参照)。/api/auth/status の enforced は、API_KEY未設定時
 * (チェック自体が発生しない)にイベントを記録しない代わりに見せる静的フィールド。
 * 取得失敗時は他の致命的でない取得と同様、既存表示を維持して黙って諦める。
 */
async function fetchEvents() {
  const [errorsResult, allResult, authEventsResult, authStatusResult] = await Promise.allSettled([
    fetch(`${EVENTS_ENDPOINT}?severity=warning,error&limit=10`).then((r) =>
      r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
    ),
    fetch(`${EVENTS_ENDPOINT}?limit=50`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    fetch(`${EVENTS_ENDPOINT}?category=auth&limit=10`).then((r) =>
      r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
    ),
    fetch(AUTH_STATUS_ENDPOINT).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
  ]);

  if (errorsResult.status === "fulfilled" && errorsResult.value.status === "ok") {
    const data = errorsResult.value.data;
    elements.errorsCount.textContent = String(data.length);
    renderLogEntries(elements.errorsList, data);
  }

  if (allResult.status === "fulfilled" && allResult.value.status === "ok") {
    renderLogEntries(elements.eventLogList, allResult.value.data);
  }

  if (authEventsResult.status === "fulfilled" && authEventsResult.value.status === "ok") {
    renderLogEntries(elements.authEventsList, authEventsResult.value.data);
  }

  if (authStatusResult.status === "fulfilled") {
    elements.authEnforcedValue.textContent = authStatusResult.value.enforced ? "有効" : "無効";
  }
}

/**
 * /api/connections/sources を取得して「接続元IP一覧」カードを更新する。
 * current/requestsLastMinute 自体は /api/system(collectors/connectionsCollector.js
 * 経由)から renderSystemInfo() が既に反映しているため、ここではIP一覧のみを扱う。
 */
async function fetchConnectionSources() {
  try {
    const response = await fetch(`${CONNECTIONS_SOURCES_ENDPOINT}?limit=20`);
    if (!response.ok) return;

    const json = await response.json();
    if (json.status !== "ok") return;

    renderSourceIps(elements.sourceIpList, json.data);
  } catch (error) {
    // ネットワーク断などでも致命的ではないため無視する
  }
}

/**
 * /api/pi-status を取得して「Raspberry Pi」カードを更新する。
 * PI_MONITOR_MAC 未設定(configured:false)の場合は「未設定」と表示する --
 * lan/deviceStore.js の既存スキャン結果を再利用するだけで、新規のping/SSH等の
 * ポーリングはここでも一切行わない(OBSERVABILITY_PLAN.mdで確認済みの方針)。
 * setServiceRow/setServiceRowError は「SNDサービス状態」カードで既に使っている
 * dot+valueの共通ヘルパーをそのまま再利用する。
 */
async function fetchPiStatus() {
  try {
    const response = await fetch(PI_STATUS_ENDPOINT);
    if (!response.ok) {
      setServiceRowError(elements.piStatusDot, elements.piStatusValue);
      elements.piIpAddress.textContent = "--";
      elements.piLastSeenAt.textContent = "--";
      return;
    }

    const data = await response.json();
    if (!data.configured) {
      elements.piStatusDot.classList.remove("online", "offline");
      elements.piStatusValue.textContent = "未設定";
      elements.piIpAddress.textContent = "--";
      elements.piLastSeenAt.textContent = "--";
      return;
    }

    if (!data.found) {
      elements.piStatusDot.classList.remove("online");
      elements.piStatusDot.classList.add("offline");
      elements.piStatusValue.textContent = "未検出";
      elements.piIpAddress.textContent = "--";
      elements.piLastSeenAt.textContent = "--";
      return;
    }

    setServiceRow(elements.piStatusDot, elements.piStatusValue, Boolean(data.online), "オンライン");
    elements.piIpAddress.textContent = data.ip || "--";
    elements.piLastSeenAt.textContent = data.lastSeenAt ? formatTime(new Date(data.lastSeenAt)) : "--";
  } catch (error) {
    setServiceRowError(elements.piStatusDot, elements.piStatusValue);
  }
}

/**
 * /api/system を取得してダッシュボードを更新する
 */
async function fetchSystemInfo() {
  try {
    const response = await fetch(API_ENDPOINT);

    if (!response.ok) {
      throw new Error(`APIエラー: HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== "ok") {
      throw new Error(data.message || "サーバーがエラーを返しました");
    }

    renderSystemInfo(data);
    setOnlineStatus(true);
    hideError();
  } catch (error) {
    setOnlineStatus(false);
    showError(error.message || "データの取得に失敗しました");
  }
}

// 初回実行 + 3秒ごとの自動更新
fetchSystemInfo();
setInterval(fetchSystemInfo, REFRESH_INTERVAL_MS);

fetchHistory();
setInterval(fetchHistory, REFRESH_INTERVAL_MS);

fetchServiceStatus();
setInterval(fetchServiceStatus, REFRESH_INTERVAL_MS);

fetchEvents();
setInterval(fetchEvents, REFRESH_INTERVAL_MS);

fetchConnectionSources();
setInterval(fetchConnectionSources, REFRESH_INTERVAL_MS);

fetchPiStatus();
setInterval(fetchPiStatus, REFRESH_INTERVAL_MS);
