# legal-public-api-mcp

**課題**：AIに法令や立法趣旨を聞くと、条文の文言・改正時点・国会答弁を記憶で答えてしまい、一次情報で裏付けられない。公的APIは揃っているが、APIごとに仕様もキーの扱いもばらばらで、AIからそのまま使えない。

**解決**：e-Gov法令・国会会議録・法人番号の3つの公的APIを、1つのMCPサーバにまとめた。Claudeが条文（過去時点を含む）・国会答弁・契約相手の法人情報を一次情報から直接引き、出典つきで答えられるようにする。

| API | 用途 | キー |
|---|---|---|
| e-Gov 法令API v2（デジタル庁） | 条文・目次・改正履歴・全文検索 | 不要 |
| 国会会議録検索システムAPI（国立国会図書館） | 立法趣旨・政府答弁 | 不要 |
| 法人番号システムWeb-API Ver.4（国税庁） | 契約相手の商号・所在地・閉鎖／合併の確認 | アプリケーションID（サーバ側で保持） |

## ツール（10個）

| ツール | 内容 |
|---|---|
| `egov_search_laws` | 法令を名称・略称・法令番号で検索 |
| `egov_get_article` | 条（項・号まで指定可）を取得。`asof` で過去・将来時点の条文 |
| `egov_get_toc` | 目次（章・節と条の範囲） |
| `egov_keyword_search` | 全法令の本文を語句で検索（AND/OR/NOT、ワイルドカード） |
| `egov_get_revisions` | 改正履歴（施行日・改正法令・未施行の別） |
| `kokkai_search_speeches` | 会議録の発言を検索（検索語周辺の抜粋つき） |
| `kokkai_get_speech` | 発言の全文 |
| `kokkai_get_meeting_outline` | 会議の発言者一覧（発言順） |
| `houjin_get_by_number` | 法人番号から商号・所在地・閉鎖の有無・承継先・変更履歴 |
| `houjin_search_by_name` | 商号から法人番号の候補を検索 |

設計上の工夫：
- 条文は e-Gov の `elm` パラメータで該当条だけを取得する（全文を取らない）ため、1リクエストのCPU時間は数ms程度。
- 法令は名称・略称・法令ID・法令番号のどれでも指定可能。e-Gov に略称登録がない実務略称（個情法・下請法・特商法など）は `src/aliases.ts` で補完。
- 条番号は「415」「第四百十五条」「3の2」などの表記ゆれを吸収。
- 法人番号はチェックデジットを検証してから照会（転記ミスを先に弾く）。
- 各ツールの応答に出典表示を付ける。

## デプロイ手順

前提：Node.js 20 以上、Cloudflare アカウント。

```bash
npm install

# 1. Cloudflare にログイン（ブラウザで承認）
npx wrangler login

# 2. シークレットを登録（値は対話入力。コードや設定ファイルには書かない）
openssl rand -hex 32            # ← 出力をMCP接続用トークンとして控える
npx wrangler secret put MCP_AUTH_TOKEN
npx wrangler secret put HOUJIN_APP_ID   # 国税庁から届いた13桁。届くまでは未登録でよい（法人番号ツールだけが「未設定」と返す）

# 3. デプロイ
npm run deploy
# → https://legal-public-api-mcp.<アカウント名>.workers.dev が払い出される

# 4. 稼働確認
curl https://legal-public-api-mcp.<アカウント名>.workers.dev/health   # {"ok":true}
```

`MCP_AUTH_TOKEN` が未登録のままだと、サーバは全リクエストを 503 で拒否する（認証なしで公開されるのを防ぐため）。

## Claude への登録

### Claude Code

```bash
claude mcp add --transport http --scope user legal-public-api \
  https://legal-public-api-mcp.<アカウント名>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN の値>"
```

### claude.ai（カスタムコネクタ）

このプロトタイプは固定トークン方式のため、claude.ai のコネクタにはそのまま登録できない。claude.ai から使うには OAuth への対応が必要（次の段階の作業）。

## ローカル開発

```bash
cp .dev.vars.example .dev.vars
node test/mock-houjin.mjs &      # 法人番号APIのモック（ポート8799）
npm run dev                       # http://127.0.0.1:8787/mcp
node test/smoke.mjs               # 全ツールを呼び出して確認（e-Gov・国会会議録は実APIに接続）
npm test                          # 単体テスト
npm run typecheck
```

## トラブルシューティング

- **Windows版Claude Codeで `InvalidHTTPResponse` になる**：ウイルス対策ソフトのHTTPS検査（AVGのウェブ シールドで確認）が応答を書き換えている。`curl.exe` やブラウザでは届くのにClaude Codeだけ失敗する場合はこれ。AVGなら［設定］→［一般］→［例外］で `https://<サーバのURL>/*` を例外に追加すると解消する。

## 利用規約・運用上の注意

- **法人番号のアプリケーションID**：第三者への譲渡・貸与・開示は禁止（法人番号システムWeb-API機能利用規約 9条1項5号）。IDは Workers のシークレットにのみ置き、応答・ログ・キャッシュキーには含めていない。このサーバを他人に使わせる場合は「IDの貸与」と評価されないよう、ツールを目的別に絞った現在の形を維持し、生のリクエストを素通しする機能は追加しない。
- **国会会議録**：機械的なアクセスは数秒の間隔を空けるよう求められているため、同一 isolate 内で3秒間隔に直列化し、結果を6時間キャッシュしている。ただし isolate をまたいだ制御はしていない（利用者が少ないうちは問題にならない想定）。発言の著作権は原則として発言者に帰属する（公開の場での政治上の演説・陳述は著作権法40条1項により利用可能）。
- **e-Gov**：データが官報と異なる場合は官報が優先する。収録は2017年4月1日時点の条文以降。
- **照会内容の機密性**：法人名の検索語（＝取引検討中の相手先）は Cloudflare のログに残りうる。業務で使う場合は、個人アカウントで運用するか会社アカウントで運用するかを決めてから使う。`wrangler.jsonc` の `observability` を無効にすればログ保存を止められる。

## 既知の制限・今後の候補

- 条文取得は本則のみ（附則・別表は未対応）。
- キャッシュは「isolate 内メモリ＋Cloudflare Cache API」の2層。`workers.dev` で Cache API が効くかは Cloudflare 側の仕様変更が続いているため、効かない場合もメモリキャッシュだけで動くようにしてある。
- 法人番号ツールはモックでのみ動作確認済み。実IDの登録後に `houjin_get_by_number` と `houjin_search_by_name` を実データで確認すること。
- claude.ai 対応のための OAuth は未実装。

## ライセンス

MIT License（[LICENSE](LICENSE)）。各公的APIの利用には、それぞれの提供元の利用規約が適用される。
