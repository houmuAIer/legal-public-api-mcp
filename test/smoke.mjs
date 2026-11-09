// MCPクライアントとして全ツールを呼び出す動作確認スクリプト
// 使い方: MCP_URL=http://127.0.0.1:8787/mcp MCP_TOKEN=... node test/smoke.mjs [ツール名で絞り込み]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp";
const TOKEN = process.env.MCP_TOKEN ?? "local-test-token";
const only = process.argv[2];

const cases = [
  ["egov_search_laws", { title: "個人情報保護法" }],
  ["egov_get_article", { law: "民法", article: "第四百十五条" }],
  ["egov_get_article", { law: "個人情報保護法", article: "27", paragraph: 1, item: 2 }],
  ["egov_get_article", { law: "民法", article: "548の2" }],
  ["egov_get_article", { law: "民法", article: "415", asof: "2019-04-01" }],
  ["egov_get_article", { law: "民法", article: "9999" }],
  ["egov_get_article", { law: "下請", article: "1" }],
  ["egov_get_toc", { law: "個人情報の保護に関する法律" }],
  ["egov_keyword_search", { keyword: "定型約款", limit: 5 }],
  ["egov_get_revisions", { law: "民法", limit: 5 }],
  ["kokkai_search_speeches", { any: "定型約款 不当条項", name_of_meeting: "法務委員会", max_records: 3 }],
  ["kokkai_get_speech", { speech_id: "120804536X00520220412_068", max_chars: 800 }],
  ["kokkai_get_meeting_outline", { issue_id: "120804536X00520220412" }],
  ["houjin_get_by_number", { corporate_numbers: ["2040001999902"], include_history: true }],
  ["houjin_get_by_number", { corporate_numbers: ["2040001999903"] }],
  ["houjin_search_by_name", { name: "株式会社国税商事", match: "prefix" }],
];

async function connect(token) {
  const client = new Client({ name: "smoke", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  });
  await client.connect(transport);
  return client;
}

// 認証なしは拒否されること
try {
  await connect(undefined);
  console.log("NG: 認証なしで接続できてしまった");
  process.exitCode = 1;
} catch (e) {
  console.log("OK: 認証なしは拒否された ->", String(e.message).slice(0, 80));
}

const client = await connect(TOKEN);
const { tools } = await client.listTools();
console.log(`\nツール ${tools.length}件: ${tools.map((t) => t.name).join(", ")}`);
const defBytes = JSON.stringify(tools).length;
console.log(`ツール定義の合計サイズ: ${defBytes} bytes`);

for (const [name, args] of cases) {
  if (only && !name.includes(only)) continue;
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = r.content.map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)}  (${ms}ms${r.isError ? ", isError" : ""})`);
  console.log(text.length > 900 ? text.slice(0, 900) + `\n…(${text.length}文字)` : text);
}
await client.close();
