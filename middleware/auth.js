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
  if (scheme !== "Bearer" || token !== apiKey) {
    res.status(401).json({ status: "error", message: "Unauthorized" });
    return;
  }

  next();
}

module.exports = { requireAuth };
