/**
 * Cloudflare Workers エントリポイント
 * - POST /mcp : MCP（Streamable HTTP, ステートレス, JSONレスポンス）
 * - GET  /health : 稼働確認（認証不要・情報は返さない）
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./env.js";
import { buildServer } from "./server.js";

/** タイミング攻撃を避けるための定数時間比較 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorize(req: Request, env: Env): Response | null {
  const token = env.MCP_AUTH_TOKEN?.trim();
  if (!token) {
    if (env.ALLOW_NO_AUTH === "true") return null;
    // トークン未設定のまま公開されるのを防ぐ（fail closed）
    return json(503, { error: "server_not_configured", message: "MCP_AUTH_TOKEN が未設定です" });
  }
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !timingSafeEqual(m[1].trim(), token)) {
    return json(401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="legal-public-api-mcp"' });
  }
  return null;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return json(200, { ok: true });

    if (url.pathname !== "/mcp") return json(404, { error: "not_found" });

    const denied = authorize(req, env);
    if (denied) return denied;

    // ステートレス運用のため、GET（サーバからのSSEストリーム）と DELETE（セッション終了）は受け付けない
    if (req.method !== "POST") {
      return json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, { Allow: "POST" });
    }

    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } catch (e) {
      return json(500, { jsonrpc: "2.0", error: { code: -32603, message: `Internal error: ${(e as Error).message}` }, id: null });
    }
  },
} satisfies ExportedHandler<Env>;
