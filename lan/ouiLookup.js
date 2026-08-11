// lan/ouiLookup.js
// MACアドレスの先頭3オクテット(OUI)から、config/ouiPrefixes.json の静的テーブルを
// 引いてベンダー名を返す。IEEEの公式レジストリ(数万件)を丸ごと同梱するのではなく、
// 家庭内LANで見かける主要ベンダーのみを収録した小さな部分集合 — README Tech Stack
// の「dependency-light philosophy」に合わせ、外部通信・追加npm依存なしで完結する。
//
// 未収録のプレフィックスは null を返す(例外を投げない)—
// collectors/networkCollector.js が netstat 非対応環境で null を返す
// 既存のグレースフルデグレード方針と同じ。
const path = require("path");
const fs = require("fs");

const TABLE_PATH = path.join(__dirname, "..", "config", "ouiPrefixes.json");

let table = null;

function loadTable() {
  if (table) return table;
  try {
    const raw = fs.readFileSync(TABLE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // "_comment" はドキュメント用のメタキーであり、実際のOUIエントリではない。
    delete parsed._comment;
    table = parsed;
  } catch (error) {
    console.warn(`[ouiLookup] Failed to load ${TABLE_PATH}: ${error.message}`);
    table = {};
  }
  return table;
}

/**
 * MACアドレス(コロン/ハイフン区切りいずれも可、大文字小文字問わず)から
 * ベンダー名を引く。見つからない・macが不正な形式の場合は null。
 * @param {string} mac
 * @returns {string|null}
 */
function lookupVendor(mac) {
  if (typeof mac !== "string") return null;

  const normalized = mac.toUpperCase().replace(/-/g, ":");
  const octets = normalized.split(":");
  if (octets.length < 3 || octets.slice(0, 3).some((o) => !/^[0-9A-F]{2}$/.test(o))) {
    return null;
  }

  const prefix = octets.slice(0, 3).join(":");
  return loadTable()[prefix] ?? null;
}

module.exports = { lookupVendor };
