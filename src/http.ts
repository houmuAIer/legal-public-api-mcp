/**
 * 上流APIへのGETリクエスト共通処理。
 * - タイムアウト
 * - 2層キャッシュ（isolate内メモリ + Cloudflare Cache API）
 *   ※ Cache API が効かない環境（Playground、Access 配下など）でも動くよう、メモリキャッシュを併用する
 */

const USER_AGENT = "legal-public-api-mcp/0.1";

export class UpstreamError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
  }
}

type MemEntry = { expires: number; status: number; body: string; contentType: string };
const memCache = new Map<string, MemEntry>();
const MEM_MAX_ENTRIES = 200;
const MEM_MAX_BODY = 512 * 1024; // 巨大レスポンスはメモリに載せない

function memGet(key: string): MemEntry | undefined {
  const e = memCache.get(key);
  if (!e) return undefined;
  if (e.expires < Date.now()) {
    memCache.delete(key);
    return undefined;
  }
  // LRU: 参照したものを末尾へ
  memCache.delete(key);
  memCache.set(key, e);
  return e;
}

function memSet(key: string, e: MemEntry) {
  if (e.body.length > MEM_MAX_BODY) return;
  memCache.set(key, e);
  while (memCache.size > MEM_MAX_ENTRIES) {
    const oldest = memCache.keys().next().value;
    if (oldest === undefined) break;
    memCache.delete(oldest);
  }
}

export interface FetchOptions {
  /** キャッシュ秒数。0ならキャッシュしない */
  ttlSeconds: number;
  timeoutMs?: number;
  /** キャッシュキーから除外したいクエリ（APIキー等） */
  cacheKeyOmit?: string[];
  /** 上流に送る前に呼ばれる（アクセス間隔の制御など）。キャッシュヒット時は呼ばれない */
  beforeNetwork?: () => Promise<void>;
}

export interface FetchResult {
  status: number;
  body: string;
  contentType: string;
  fromCache: boolean;
}

function cacheKeyFor(url: string, omit: string[] = []): string {
  const u = new URL(url);
  for (const k of omit) u.searchParams.delete(k);
  u.searchParams.sort();
  return u.toString();
}

async function edgeCache(): Promise<Cache | undefined> {
  try {
    // Workers 環境でのみ存在する
    return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  } catch {
    return undefined;
  }
}

export async function getText(url: string, opts: FetchOptions): Promise<FetchResult> {
  const key = cacheKeyFor(url, opts.cacheKeyOmit);

  if (opts.ttlSeconds > 0) {
    const m = memGet(key);
    if (m) return { status: m.status, body: m.body, contentType: m.contentType, fromCache: true };
    const c = await edgeCache();
    if (c) {
      const hit = await c.match(key).catch(() => undefined);
      if (hit) {
        const body = await hit.text();
        const contentType = hit.headers.get("content-type") ?? "";
        memSet(key, { expires: Date.now() + opts.ttlSeconds * 1000, status: hit.status, body, contentType });
        return { status: hit.status, body, contentType, fromCache: true };
      }
    }
  }

  if (opts.beforeNetwork) await opts.beforeNetwork();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json, application/xml;q=0.9, */*;q=0.5" },
      signal: ctrl.signal,
    });
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "上流APIがタイムアウトしました" : `上流APIに接続できません: ${(e as Error).message}`;
    throw new UpstreamError(msg, 0, "");
  } finally {
    clearTimeout(timer);
  }

  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  // 成功時だけキャッシュ（エラーをキャッシュすると復旧後も失敗し続けるため）
  if (opts.ttlSeconds > 0 && res.ok) {
    memSet(key, { expires: Date.now() + opts.ttlSeconds * 1000, status: res.status, body, contentType });
    const c = await edgeCache();
    if (c) {
      const toStore = new Response(body, {
        status: res.status,
        headers: { "content-type": contentType, "cache-control": `public, max-age=${opts.ttlSeconds}` },
      });
      await c.put(key, toStore).catch(() => undefined);
    }
  }

  return { status: res.status, body, contentType, fromCache: false };
}

export async function getJson<T = unknown>(url: string, opts: FetchOptions): Promise<{ status: number; data: T | undefined; raw: string; fromCache: boolean }> {
  const r = await getText(url, opts);
  let data: T | undefined;
  try {
    data = JSON.parse(r.body) as T;
  } catch {
    data = undefined;
  }
  return { status: r.status, data, raw: r.body, fromCache: r.fromCache };
}

export function buildUrl(base: string, path: string, params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URL(base.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** テスト用 */
export function _clearMemCache() {
  memCache.clear();
}
