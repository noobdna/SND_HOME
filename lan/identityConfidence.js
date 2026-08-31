// lan/identityConfidence.js
// 「MAC＝絶対的な信頼根拠にはしない」という設計方針(Gateway側 Phase 50.1
// 設計ノート参照)に基づき、台帳上の各デバイスへ identity_confidence
// (low / medium / high) を付与する。分類情報の算出のみを行い、隔離・遮断・
// 自動復旧・権限昇格には一切接続しない(Phase 40-A原則「通知する、確定させ
// ない」をこのモジュールでも維持 — そもそもこのモジュールは通知すら行わず、
// 純粋な同期・副作用なしの分類関数のみ)。
//
// 新規の永続状態(IP変化履歴など)は意図的に追加しない -- deviceStore.js
// 既存の firstSeenAt/lastSeenAt/nickname/terminalId と、lan/ouiLookup.js
// の既存ベンダー解決だけを判定材料とする(「MAC未解決なら台帳から除外する」
// という既存の保守的設計思想と同じく、判定材料が無ければ無理に埋めず low
// に倒す)。
//
// 判定材料と根拠:
//   - reviewed (nickname または terminalId が設定済み)
//       = 人間がこのMACを一度でも見て関連付けた、という既存のシグナル。
//         未設定 = 「判定材料不足」として即 low。
//   - terminalId 設定済み (lan/deviceStore.js の groupTerminal() 経由)
//       = nickname 単体より強い人間の確認シグナル。groupTerminal は
//         「このMACはこの主端末と同一物理デバイスである」という明示的な
//         判断を要求する既存機構であり、単なるラベル付けより信頼度が高い。
//   - vendor (lan/ouiLookup.js の lookupVendor() を直接再利用)
//       = OUIベンダーが解決できる = ランダム化されていない可能性が高い
//         (ランダム化/プライベートMACはローカル管理ビットが立ち、実在の
//         ベンダーOUIとは一致しないことが多い)、という既存ロジックからの
//         弱い裏付けシグナル。deviceStore.js が保存済みの device.vendor に
//         依存せず、このモジュール単体で lookupVendor(mac) を呼び直す
//         (呼び出し側の実行順序に依存しない自己完結設計)。
//   - 観測期間 (firstSeenAt から now まで、既存フィールドのみ、新規状態なし)
//       = 長く安定して観測されているMACほど、偽装・一時的な機器である
//         可能性が下がる、という単純な経過時間ヒューリスティック。
"use strict";

const { lookupVendor } = require("./ouiLookup");

const MEDIUM_OBSERVED_MS = 24 * 60 * 60 * 1000; // 1日
const HIGH_OBSERVED_MS = 7 * 24 * 60 * 60 * 1000; // 7日

/**
 * device の identity_confidence ("low" | "medium" | "high") を算出する。
 * 純粋関数 -- 副作用なし、永続状態への読み書きなし、ネットワークアクセス
 * なし。判定材料が不足・不正な場合は例外を投げず "low" に倒す。
 * @param {{mac?: string|null, nickname?: string|null, terminalId?: string|null, firstSeenAt?: string|null}} device
 * @param {{now?: Date}} [options] - テスト用に現在時刻を注入可能
 * @returns {"low"|"medium"|"high"}
 */
function computeIdentityConfidence(device, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();

  const reviewed = Boolean(device && (device.nickname || device.terminalId));
  if (!reviewed) return "low"; // 判定材料不足: 人間による関連付けが一度もない

  const firstSeenAt = device.firstSeenAt ? new Date(device.firstSeenAt) : null;
  const hasValidFirstSeen = firstSeenAt instanceof Date && !Number.isNaN(firstSeenAt.getTime());
  if (!hasValidFirstSeen) return "low"; // 判定材料不足: 観測開始時刻が不明/不正

  const observedMs = now.getTime() - firstSeenAt.getTime();
  if (observedMs < 0) return "low"; // 未来日時などの不正値は信用しない

  const vendor = device.mac ? lookupVendor(device.mac) : null;
  const stronglyReviewed = Boolean(device.terminalId); // groupTerminal()経由の明示的な同一性確認

  if (stronglyReviewed && vendor && observedMs >= HIGH_OBSERVED_MS) {
    return "high";
  }
  if (observedMs >= MEDIUM_OBSERVED_MS) {
    return "medium";
  }
  return "low";
}

module.exports = { computeIdentityConfidence, MEDIUM_OBSERVED_MS, HIGH_OBSERVED_MS };
