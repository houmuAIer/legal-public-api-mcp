import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import { registerEgovTools } from "./egov.js";
import { registerKokkaiTools } from "./kokkai.js";
import { registerHoujinTools } from "./houjin.js";

export const SERVER_NAME = "legal-public-api";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `日本の公的オープンAPIを法務調査向けにまとめたサーバです。
- 法令の条文・目次・改正履歴・全文検索：egov_* （e-Gov法令検索）
- 立法趣旨・国会答弁：kokkai_* （国会会議録検索システム）
- 契約相手の法人番号・商号・所在地・閉鎖の有無：houjin_* （国税庁法人番号公表サイト）
典型的な流れ：
1) 条番号が分かっている → egov_get_article。分からない → egov_keyword_search か egov_get_toc で所在を特定してから egov_get_article。
2) 改正前の条文が必要 → egov_get_revisions で施行日を確認し、egov_get_article の asof に施行日の前日を指定。
3) 立法趣旨 → kokkai_search_speeches（法案名＋論点語）で答弁を探し、必要な発言だけ kokkai_get_speech で全文取得。
4) 契約相手の確認 → houjin_search_by_name で候補を出し、houjin_get_by_number で閉鎖・合併・商号変更を確認。
回答に条文や答弁を引用するときは、各ツールの出典表示も添えてください。`;

export function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerEgovTools(server, env);
  registerKokkaiTools(server, env);
  registerHoujinTools(server, env);
  return server;
}
