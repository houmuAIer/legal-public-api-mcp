/**
 * 国税庁 法人番号システム Web-API（Ver.4）
 * 仕様: https://www.houjin-bangou.nta.go.jp/webapi/
 * アプリケーションIDはサーバ側のシークレット（HOUJIN_APP_ID）として保持し、クライアントには一切渡さない。
 * 利用規約上、アプリケーションIDの第三者への譲渡・貸与・開示は禁止（9条1項5号）。
 */
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import { buildUrl, getText, UpstreamError } from "./http.js";
import { fail, ok } from "./util.js";

const SOURCE =
  "出典：国税庁法人番号公表サイト（法人番号システムWeb-API）。本情報は国税庁Web-APIから取得したものですが、内容は国税庁によって保証されたものではありません。";

const TTL = 24 * 3600; // 公表サイトの更新は1日単位

export const PROCESS_JA: Record<string, string> = {
  "01": "新規", "11": "商号又は名称の変更", "12": "国内所在地の変更", "13": "国外所在地の変更",
  "21": "登記記録の閉鎖等", "22": "登記記録の復活等", "71": "吸収合併", "72": "吸収合併無効",
  "81": "商号の登記の抹消", "99": "削除",
};
export const KIND_JA: Record<string, string> = {
  "101": "国の機関", "201": "地方公共団体", "301": "株式会社", "302": "有限会社", "303": "合名会社",
  "304": "合資会社", "305": "合同会社", "399": "その他の設立登記法人", "401": "外国会社等", "499": "その他",
};
export const CLOSE_CAUSE_JA: Record<string, string> = {
  "01": "清算の結了等", "11": "合併による解散等", "21": "登記官による閉鎖", "31": "その他の清算の結了等",
};

/** 法人番号のチェックデジット検証（先頭1桁が検査用数字） */
export function isValidCorporateNumber(n: string): boolean {
  if (!/^\d{13}$/.test(n)) return false;
  const base = n.slice(1).split("").map(Number).reverse();
  const sum = base.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 2), 0);
  return 9 - (sum % 9) === Number(n[0]);
}

export interface Corporation {
  sequenceNumber?: string; corporateNumber: string; process?: string; correct?: string;
  updateDate?: string; changeDate?: string; name?: string; kind?: string;
  prefectureName?: string; cityName?: string; streetNumber?: string; postCode?: string;
  addressOutside?: string; closeDate?: string; closeCause?: string; successorCorporateNumber?: string;
  changeCause?: string; assignmentDate?: string; latest?: string; enName?: string; furigana?: string; hihyoji?: string;
}
interface Parsed { lastUpdateDate?: string; count?: string; divideNumber?: string; divideSize?: string; corporations: Corporation[] }

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true, isArray: (name) => name === "corporation" });

export function parseHoujinXml(xml: string): Parsed {
  const doc = parser.parse(xml) as { corporations?: Record<string, unknown> };
  const root = doc.corporations ?? {};
  const list = (root.corporation as Record<string, unknown>[] | undefined) ?? [];
  const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
  const corporations = list.map((c) => {
    const o: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(c)) o[k] = str(v);
    return o as unknown as Corporation;
  });
  return {
    lastUpdateDate: str(root.lastUpdateDate), count: str(root.count),
    divideNumber: str(root.divideNumber), divideSize: str(root.divideSize), corporations,
  };
}

function address(c: Corporation): string {
  const dom = [c.prefectureName, c.cityName, c.streetNumber].filter(Boolean).join("");
  return dom || c.addressOutside || "（所在地なし）";
}

export function formatCorporation(c: Corporation): string {
  const lines = [`${c.name ?? "（名称なし）"}　法人番号 ${c.corporateNumber}`];
  lines.push(`  種別：${KIND_JA[c.kind ?? ""] ?? c.kind ?? "不明"}／所在地：${c.postCode ? `〒${c.postCode} ` : ""}${address(c)}`);
  const ev = [`処理区分：${PROCESS_JA[c.process ?? ""] ?? c.process ?? "不明"}`];
  if (c.changeDate) ev.push(`変更日 ${c.changeDate}`);
  if (c.assignmentDate) ev.push(`番号指定日 ${c.assignmentDate}`);
  if (c.latest === "0") ev.push("※過去の情報");
  if (c.correct === "1") ev.push("※訂正あり");
  lines.push(`  ${ev.join("／")}`);
  if (c.closeDate || c.closeCause) {
    lines.push(`  【登記記録の閉鎖等】${c.closeDate ?? ""} ${CLOSE_CAUSE_JA[c.closeCause ?? ""] ?? c.closeCause ?? ""}${c.successorCorporateNumber ? `／承継先法人番号 ${c.successorCorporateNumber}` : ""}`);
  }
  if (c.changeCause) lines.push(`  変更事由の詳細：${c.changeCause}`);
  if (c.furigana) lines.push(`  フリガナ：${c.furigana}`);
  if (c.enName) lines.push(`  英語表記：${c.enName}`);
  if (c.hihyoji === "1") lines.push("  ※検索対象除外の申出がある法人（名称検索ではヒットしません）");
  return lines.join("\n");
}

/** 前方一致検索では法人種別を除く必要があるため、よくある表記を取り除く */
export function stripCorporateKind(name: string): string {
  const kinds = ["株式会社", "有限会社", "合同会社", "合名会社", "合資会社", "一般社団法人", "一般財団法人", "公益社団法人", "公益財団法人", "特定非営利活動法人", "（株）", "(株)", "㈱", "（有）", "(有)", "㈲"];
  let s = name.trim();
  for (const k of kinds) {
    if (s.startsWith(k)) s = s.slice(k.length);
    if (s.endsWith(k)) s = s.slice(0, -k.length);
  }
  return s.trim();
}

/** 仕様上、検索対象が JIS 第一〜第四水準の場合は全角で送る必要があるため、半角英数記号・スペースを全角化する */
export function toFullWidth(s: string): string {
  return s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, "　");
}

function requireAppId(env: Env): string | undefined {
  const id = env.HOUJIN_APP_ID?.trim();
  return id ? id : undefined;
}

async function callHoujin(env: Env, path: string, params: Record<string, string | number | undefined>): Promise<Parsed> {
  const appId = requireAppId(env)!;
  const url = buildUrl(env.HOUJIN_API_BASE, path, { id: appId, ...params, type: "12" });
  // キャッシュキーからアプリケーションIDを除外（ID変更でキャッシュが無効化されないように、かつキーにIDを残さないように）
  const r = await getText(url, { ttlSeconds: TTL, cacheKeyOmit: ["id"], timeoutMs: 20000 });
  if (r.status !== 200) {
    const body = r.body.replace(/\s+/g, " ").slice(0, 300);
    throw new UpstreamError(`法人番号Web-APIがエラーを返しました（HTTP ${r.status}）：${body}`, r.status, r.body);
  }
  return parseHoujinXml(r.body);
}

const NOT_CONFIGURED = "法人番号Web-APIのアプリケーションIDが未設定です。サーバ管理者が `wrangler secret put HOUJIN_APP_ID` で登録すると使えるようになります。";

export function registerHoujinTools(server: McpServer, env: Env) {
  server.registerTool(
    "houjin_get_by_number",
    {
      title: "法人番号で法人情報を照会（国税庁）",
      description:
        "13桁の法人番号から、商号・本店所在地・法人種別・登記記録の閉鎖（清算結了・合併による解散）の有無と承継先を返す。" +
        "契約書の当事者表示（正式商号・本店所在地）の確認、相手方が現在も存続しているか、合併で消滅していないかの確認に使う。" +
        "include_history=true にすると、商号変更や本店移転の履歴も返す。法人番号が分からないときは houjin_search_by_name で先に探す。" +
        "代表者名・資本金・事業目的は公表対象外なので取得できない（登記事項証明書で確認する）。",
      inputSchema: {
        corporate_numbers: z.array(z.string().regex(/^\d{13}$/, "法人番号は13桁の数字です")).min(1).max(10).describe("法人番号（最大10件）"),
        include_history: z.boolean().default(false).describe("商号・所在地の変更履歴を含めるか"),
      },
    },
    async ({ corporate_numbers, include_history }) => {
      if (!requireAppId(env)) return fail(NOT_CONFIGURED);
      const bad = corporate_numbers.filter((n) => !isValidCorporateNumber(n));
      if (bad.length) return fail(`法人番号のチェックデジットが一致しません：${bad.join(", ")}。番号の転記ミスがないか確認してください。`);
      try {
        const p = await callHoujin(env, "/num", { number: corporate_numbers.join(","), history: include_history ? 1 : 0 });
        if (p.corporations.length === 0) return ok(`該当する法人はありません。\n\n${SOURCE}`);
        const blocks = p.corporations.map(formatCorporation);
        return ok(`公表サイト最終更新日：${p.lastUpdateDate ?? "不明"}／${p.corporations.length}件\n\n${blocks.join("\n\n")}\n\n${SOURCE}`);
      } catch (e) {
        return fail(e instanceof UpstreamError ? e.message : `エラー：${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "houjin_search_by_name",
    {
      title: "法人名で法人番号を検索（国税庁）",
      description:
        "商号・名称から法人を検索し、法人番号・所在地・種別の候補を返す。契約相手の法人番号を特定したいとき、同名の別法人と取り違えていないか確かめたいときに使う。" +
        "同名法人が多い場合は prefecture_code（都道府県コード2桁、または都道府県＋市区町村の5桁）で絞り込む。" +
        "特定できたら houjin_get_by_number で詳細と履歴を確認する。旧商号で探す場合は include_history=true にする。",
      inputSchema: {
        name: z.string().min(1).describe("商号又は名称。例：Sansan、国税商事"),
        match: z.enum(["prefix", "partial"]).default("partial").describe("prefix=前方一致（法人種別は自動で除去）、partial=部分一致"),
        fuzzy: z.boolean().default(true).describe("true=あいまい検索（ひらがな/カタカナ・英大小文字のゆれを吸収）、false=完全一致検索"),
        prefecture_code: z.string().regex(/^(\d{2}|\d{5})$/).optional().describe("所在地の都道府県コード（例：13=東京都）または都道府県＋市区町村コード（例：13113=渋谷区）。国外は99"),
        kind: z.array(z.enum(["01", "02", "03", "04"])).max(4).optional().describe("法人種別：01=国の機関、02=地方公共団体、03=設立登記法人、04=外国会社等・その他"),
        include_history: z.boolean().default(false).describe("旧商号・旧所在地も検索対象に含めるか（含めた場合、変更前の情報としてヒットした法人は最新情報が返らない）"),
        include_closed: z.boolean().default(true).describe("清算結了・合併等で登記記録が閉鎖された法人も含めるか"),
        max_results: z.number().int().min(1).max(50).default(20),
      },
    },
    async (a) => {
      if (!requireAppId(env)) return fail(NOT_CONFIGURED);
      const name = toFullWidth(a.match === "prefix" ? stripCorporateKind(a.name) : a.name.trim());
      if (!name) return fail("法人種別を除くと検索語が空になります。名称部分を指定してください。");
      try {
        const p = await callHoujin(env, "/name", {
          name,
          mode: a.match === "prefix" ? 1 : 2,
          target: a.fuzzy ? 1 : 2,
          address: a.prefecture_code,
          kind: a.kind?.join(","),
          change: a.include_history ? 1 : 0,
          close: a.include_closed ? 1 : 0,
        });
        const total = Number(p.count ?? p.corporations.length);
        if (p.corporations.length === 0) return ok(`「${name}」に該当する法人はありません。表記ゆれ（全角/半角、旧商号）や match・fuzzy の設定を変えて再検索してください。\n\n${SOURCE}`);
        const shown = p.corporations.slice(0, a.max_results);
        const blocks = shown.map(formatCorporation);
        const note = total > shown.length ? `\n\n※${total}件中${shown.length}件を表示。prefecture_code などで絞り込んでください。` : "";
        const div = p.divideSize && p.divideSize !== "1" ? `\n※応答が${p.divideSize}分割されており、1分割目のみ表示しています。` : "";
        return ok(`検索語「${name}」：${total}件（公表サイト最終更新日：${p.lastUpdateDate ?? "不明"}）\n\n${blocks.join("\n\n")}${note}${div}\n\n${SOURCE}`);
      } catch (e) {
        return fail(e instanceof UpstreamError ? e.message : `エラー：${(e as Error).message}`);
      }
    },
  );
}
