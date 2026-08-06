// SND@HOME Monitoring Dashboard
// Vanilla JavaScript only - no external libraries

const REFRESH_INTERVAL_MS = 3000;
const API_ENDPOINT = "/api/system";

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

  hostname: document.getElementById("hostname"),
  ipAddress: document.getElementById("ipAddress"),
  uptime: document.getElementById("uptime"),
  lastUpdated: document.getElementById("lastUpdated"),
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

  // Host Info
  elements.hostname.textContent = data.hostname || "--";
  elements.ipAddress.textContent = extractLocalIp(data.network);
  elements.uptime.textContent = formatUptime(data.uptime);
  elements.lastUpdated.textContent = formatTime(new Date());
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
