// middleware/auth.js
// Opt-in Bearer-token auth for this project's first mutating (POST/PUT/DELETE)
// endpoints -- routes/alerts.js と routes/notifiers.js の ⚠️ SECURITY TODO
// コメントが説明している通り、認証ミドルウェアがこのリポジトリに存在しないまま
// これらのエンドポイントを実装した経緯があり、これがその解消。
//
// 設計判断(ユーザーと協議の上、明示的に決定): デフォルトの挙動は変えない
// (`npm start` がそのまま無認証で動く、既存のホームラボ/単一ユーザー運用を
// 壊さない) —  API_KEY を .env で設定した場合にのみ、Bearer トークン認証を
// 強制する。この notifiers/*.js の configured() と全く同じ「オプトインの機能は
// 環境変数の有無で自己判定する」パターンに揃えた。
//
// process.env.API_KEY はリクエストのたびに読む(モジュール読み込み時にキャッシュ
// しない)— notifiers/*.js の configured() が既に確立している「毎回 process.env を
// 読む」規約と同じで、これによりテストが beforeEach/afterEach で process.env を
// 差し替えても正しく反映される。
const crypto = require("crypto");
const eventLogStore = require("../monitor/eventLogStore");

// 単純な `token !== apiKey`(文字列の厳密不等価)は、最初に異なるバイトが
// 見つかった時点で処理を打ち切る非定数時間比較 — API_KEY をこのサーバー
// より信頼度の低いネットワーク越しに公開する運用(README/API節が想定する
// 「localhost/自宅LANを超えて公開する場合」)では、応答時間の差からAPI_KEYを
// 1バイトずつ推測されるタイミング攻撃の理論的な糸口になりうる。
// crypto.timingSafeEqual() で定数時間比較する。ただし同関数は長さの異なる
// バッファを渡すと例外を投げるため、長さが違う場合はそれ自体で「不一致」と
// 早期returnする(トークン長の違いだけでは、内容そのものを1バイトずつ
// 推測できるタイミング攻撃の主要な糸口にはならないため、許容できるトレード
// オフとする — 多くの定数時間比較実装が採用する標準的なパターン)。
function safeCompare(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// OBSERVABILITY_PLAN.md で確認済みの方針: API_KEY 未設定時(下の早期return)は
// 実際にはチェックが一切発生していないため、イベントログには何も記録しない
// -- 「成功」として記録すると、チェックが行われたかのように誤って見えてしまう。
// 認証が有効かどうか自体は routes/auth.js の GET /api/auth/status
// (`enforced: Boolean(process.env.API_KEY)`)という別の静的フィールドで見せる。
// meta には ip/path/method のみを記録し、トークンや API_KEY の値そのものは
// 絶対に含めない(このファイルの他のどこにもログ出力していないのと同じ理由)。
function requireAuth(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    // API_KEY 未設定 = このプロジェクトの機能では「オプトイン機能が無効」を
    // 意味する既存の規約(notifiers/*.js の configured() 参照)と同じ扱い。
    // 認証を要求せず、これまで通り無認証で通す。
    next();
    return;
  }

  const header = req.get("Authorization") || "";
  const [scheme, token] = header.split(" ");
  const meta = { ip: req.ip, path: req.originalUrl, method: req.method };

  if (scheme !== "Bearer" || typeof token !== "string" || !safeCompare(token, apiKey)) {
    eventLogStore.record({ category: "auth", severity: "warning", message: "Authentication failed", meta });
    res.status(401).json({ status: "error", message: "Unauthorized" });
    return;
  }

  eventLogStore.record({ category: "auth", severity: "info", message: "Authenticated request", meta });
  next();
}

module.exports = { requireAuth };
