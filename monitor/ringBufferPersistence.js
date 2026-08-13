// monitor/ringBufferPersistence.js
// monitor/historyStore.js・alerts/alertHistoryStore.js・monitor/eventLogStore.js・
// monitor/requestLogStore.js の4つのリングバッファストアが共通して必要とする
// 「entries配列をJSONファイルへ書き込み/読み込みする」部分だけを切り出した
// 薄いヘルパー。alerts/ruleStore.js・lan/deviceStore.js と全く同じ
// fs.mkdirSync + fs.writeFileSync(JSON.stringify) 書き込みパターンを、
// 4ファイルで重複させないために共通化する。
//
// record()毎に同期書き込みしない理由: historyStore は5秒間隔、
// requestLogStore はHTTPリクエスト毎という高頻度で record() が呼ばれるため、
// 呼ばれるたびにディスクへ書き込むと過剰なI/Oになる。代わりに
// createAutoFlush() で一定間隔(既定30秒)ごとの定期スナップショットに留め、
// 万一のクラッシュで失われるのは直近最大30秒分の履歴のみに抑える
// (server.js の SIGINT/SIGTERM ハンドラでの明示的flushが実質的な
// 「最終保存」を担う)。
const fs = require("fs");
const path = require("path");

/**
 * entries配列をJSONファイルへ書き込む(ruleStore.js/deviceStore.js と同じ方式)。
 * @param {string} filePath
 * @param {object[]} entries
 */
function writeEntries(filePath, entries) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

/**
 * JSONファイルからentries配列を読み込む。ファイルが存在しない・読み込めない・
 * 壊れている・配列でない場合は空配列を返し、クラッシュしない
 * (ruleStore.js の load() と同じグレースフルデグレード方針)。
 * @param {string} filePath
 * @param {string} label ログメッセージの先頭に使うストア名(例 "historyStore")
 * @returns {object[]}
 */
function readEntries(filePath, label) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.warn(`[${label}] Failed to read ${filePath}: ${error.message}`);
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[${label}] Failed to parse ${filePath} as JSON: ${error.message}`);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[${label}] ${filePath} does not contain a JSON array; ignoring`);
    return [];
  }

  return parsed;
}

/**
 * 一定間隔ごとに flushFn を呼ぶだけの薄いタイマーラッパー。dirty追跡は
 * あえて行わない(小さいJSONファイルを30秒毎に無条件で書き込むコストは
 * 無視できるレベルで、dirty追跡の複雑さに見合わないと判断した)。
 * @param {() => void} flushFn
 * @param {number} intervalMs
 * @returns {{ start: () => void, stop: () => void }}
 */
function createAutoFlush(flushFn, intervalMs) {
  let timer = null;

  return {
    start() {
      if (timer) return;
      timer = setInterval(flushFn, intervalMs);
      // このタイマーだけの理由でNodeプロセスが終了できなくならないように —
      // 実際の「最終保存」は server.js の SIGINT/SIGTERM ハンドラでの
      // 明示的な flush() 呼び出しが担う。
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

module.exports = {
  writeEntries,
  readEntries,
  createAutoFlush,
};
