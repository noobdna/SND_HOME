# SND@HOME — プロジェクト運用方針

## このプロジェクトについて

SND@HOME は `~/Projects/SND_HOME` を正式な開発ルートとする、**独立した**ホームインフラ監視プラットフォームです。`~/Projects/Takomachi`（タコマチ）や麻雀プロジェクト等、他の一切のプロジェクトとは無関係であり、混在させません。作業は常にこのディレクトリ配下で行います。

Node.js/Express製、DB無し（メトリクスはメモリ＋JSONファイル永続化）、CommonJS、依存最小限。詳細は `README.md`、フェーズごとの設計は `PHASE5_PLAN.md` / `PHASE6_*.md` / `LAN_TERMINAL_AGGREGATION_PLAN.md` を参照。

## 関連する既存資産（変更・削除禁止）

以下はこのプロジェクトの前身または旧アーカイブであり、**変更・削除・移動は行いません**。参照のみ可。

- `~/Projects/SND` — 初期プロトタイプ（Git未管理、単一ファイル構成）
- `~/iCloud Drive（アーカイブ）/JOBS/snd-project` — 旧 Cloudflare Workers + D1 (TypeScript) 版、Phase 0
- `~/iCloud Drive（アーカイブ）/Desktop/snd-project` — 同上、Phase 4まで進んだ版
- `~/iCloud Drive（アーカイブ）/JOBS/snd-project.zip` — 上記のバックアップ

現行の SND_HOME は上記いずれとも別アーキテクチャ（Express、DB無し）であり、コードは引き継いでいません。

## 開発方針：人間承認付き自律開発

詳細な運用ルールは `AUTOLOOP_POLICY.md` を正とします。要点：

**承認不要（フルリバーシブル、featureブランチ内で完結する場合）：**
- 調査・分析・設計・コード作成・テスト作成
- `main` から切ったブランチ上での実装、`npm test` によるリグレッション確認、コミット
- ブランチの `origin` への push、PR作成（`gh pr create`）

**必ず人間の承認が必要（実行前に変更内容と理由を提示し、承認後のみ実行）：**
- `main`/`master` への直接 push・マージ
- git push（フルリバーシブルなfeatureブランチへのpushを除く、状況に応じて要確認）
- force push、履歴の書き換え、ブランチ/タグ/リリースの削除
- Cloudflareへのデプロイ・設定変更
- Raspberry Pi / Linux Mint 実機への変更
- 既存ファイルの削除・大規模な構成変更
- 本番反映

不明な場合は実行前に必ず人間に確認する。
