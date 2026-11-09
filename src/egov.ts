/**
 * e-Gov 法令API Version 2
 * 仕様: https://laws.e-gov.go.jp/api/2/swagger-ui/
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import { buildUrl, getJson, UpstreamError } from "./http.js";
import { LAW_ALIASES } from "./aliases.js";
import { fail, normalizeArticleNum, normalizeSubNum, ok, stripTags, truncate } from "./util.js";

const SOURCE = "出典：e-Gov法令検索（デジタル庁）。e-Gov法令検索のデータが官報と異なる場合は官報が優先します。";

const TTL_LAW = 6 * 3600;
const TTL_SEARCH = 3600;

const LAW_TYPES = ["Constitution", "Act", "CabinetOrder", "ImperialOrder", "MinisterialOrdinance", "Rule", "Misc"] as const;
const LAW_TYPE_JA: Record<string, string> = {
  Constitution: "憲法", Act: "法律", CabinetOrder: "政令", ImperialOrder: "勅令",
  MinisterialOrdinance: "府省令", Rule: "規則", Misc: "その他",
};
const REVISION_STATUS_JA: Record<string, string> = {
  CurrentEnforced: "現行", UnEnforced: "未施行", PreviousEnforced: "過去の版", Repeal: "廃止",
};
const REPEAL_JA: Record<string, string> = {
  None: "", Repeal: "廃止", Expire: "失効", Suspend: "停止", LossOfEffectiveness: "実効性喪失",
};

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式で指定してください");

// ---- 型（必要な項目だけ） ----
interface LawInfo { law_id: string; law_num: string; law_type: string; promulgation_date?: string }
interface RevisionInfo {
  law_revision_id: string; law_title: string; abbrev?: string | null; category?: string;
  amendment_enforcement_date?: string | null; amendment_scheduled_enforcement_date?: string | null;
  amendment_enforcement_comment?: string | null; amendment_law_title?: string | null; amendment_law_num?: string | null;
  amendment_promulgate_date?: string | null; repeal_status?: string; current_revision_status?: string; updated?: string;
}
interface LawItem { law_info: LawInfo; revision_info: RevisionInfo; current_revision_info?: RevisionInfo }
interface LawsResponse { total_count: number; count: number; next_offset?: number; laws: LawItem[] }
interface LawDataResponse { law_info: LawInfo; revision_info: RevisionInfo; law_full_text: Node }
interface KeywordResponse {
  total_count: number; sentence_count: number; next_offset?: number;
  items: { law_info: LawInfo; revision_info: RevisionInfo; sentences: { position: string; text: string }[] }[];
}
interface RevisionsResponse { law_info: LawInfo; revisions: RevisionInfo[] }
interface ApiError { code?: string; message?: string }

type Node = string | { tag: string; attr?: Record<string, string>; children?: Node[] };

// ---- 法令本文（JSON詳細版）をプレーンテキストに整形 ----
const INDENT = "　";

function plain(n: Node | undefined): string {
  if (n === undefined) return "";
  if (typeof n === "string") return n;
  if (n.tag === "Rt") return "";
  return (n.children ?? []).map(plain).join("");
}

function render(n: Node, depth = 0): string {
  if (typeof n === "string") return n;
  const ch = n.children ?? [];
  const kids = (d = depth) => ch.map((c) => render(c, d)).join("");
  const tag = n.tag;

  if (tag === "Rt") return "";
  if (tag === "Ruby") return plain(n);

  if (tag === "ArticleCaption" || tag === "ParagraphCaption") return `\n${plain(n)}`;
  if (tag === "ArticleTitle") return `\n${plain(n)}${INDENT}`;

  if (tag === "Paragraph") {
    const numNode = ch.find((c) => typeof c !== "string" && c.tag === "ParagraphNum");
    const num = plain(numNode).trim();
    const rest = ch.filter((c) => c !== numNode).map((c) => render(c, depth)).join("");
    return (num ? `\n${num}${INDENT}` : "") + rest;
  }

  if (tag === "Item" || /^Subitem\d+$/.test(tag)) {
    const d = depth + 1;
    return `\n${INDENT.repeat(d)}` + kids(d);
  }
  if (tag === "ItemTitle" || /^Subitem\d+Title$/.test(tag)) return `${plain(n)}${INDENT}`;

  if (tag === "Column") return `${kids()}${INDENT}`;

  if (/^(Part|Chapter|Section|Subsection|Division)Title$/.test(tag)) return `\n${plain(n)}`;
  if (tag === "SupplProvisionLabel" || tag === "AppdxTableTitle" || tag === "TOCLabel") return `\n${plain(n)}`;

  if (/^TOC(Part|Chapter|Section|Subsection|Division|Article|SupplProvision|AppdxTableLabel|PreambleLabel)$/.test(tag)) {
    const d = depth + 1;
    return `\n${INDENT.repeat(depth)}` + ch.map((c) => render(c, d)).join("").replace(/^\n+/, "");
  }
  if (tag === "ArticleRange") return plain(n);

  if (tag === "TableStruct" || tag === "Table") return `\n${kids()}`;
  if (tag === "TableRow") return `\n` + ch.map((c) => plain(c).trim()).filter(Boolean).join(" | ");
  if (tag === "FigStruct" || tag === "Fig") return "［図］";
  if (tag === "List" || /^Sublist\d+$/.test(tag) || tag === "Remarks") return `\n${INDENT.repeat(depth + 1)}${kids(depth + 1)}`;

  return kids();
}

export function lawNodeToText(n: Node): string {
  return render(n)
    .split("\n")
    .map((l) => l.replace(/\s+$/u, ""))
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n")
    .trim();
}

// ---- 共通 ----
function apiErrorMessage(raw: string): string {
  try {
    const e = JSON.parse(raw) as ApiError;
    if (e.message) return `${e.message}${e.code ? `（code ${e.code}）` : ""}`;
  } catch { /* ignore */ }
  return raw.slice(0, 300);
}

function revisionLine(r: RevisionInfo): string {
  const parts: string[] = [];
  const status = r.current_revision_status ? REVISION_STATUS_JA[r.current_revision_status] ?? r.current_revision_status : "";
  if (status) parts.push(status);
  const enf = r.amendment_enforcement_date ?? r.amendment_scheduled_enforcement_date;
  if (enf) parts.push(`施行日 ${enf}`);
  if (r.amendment_enforcement_comment) parts.push(`（${r.amendment_enforcement_comment}）`);
  if (r.amendment_law_title) parts.push(`改正法令：${r.amendment_law_title}${r.amendment_law_num ? `（${r.amendment_law_num}）` : ""}`);
  const rep = r.repeal_status ? REPEAL_JA[r.repeal_status] : "";
  if (rep) parts.push(`【${rep}】`);
  return parts.join(" / ");
}

const LAW_ID_RE = /^\d{3}[A-Z]{2}\d{10}$/;
const LAW_NUM_RE = /(明治|大正|昭和|平成|令和).+第.+号$/;

type Resolved = { ok: true; idOrNum: string; title?: string } | { ok: false; message: string };

/** 法令名・略称・法令ID・法令番号のいずれかから、本文取得に使えるIDを決める */
async function resolveLaw(env: Env, law: string, asof?: string): Promise<Resolved> {
  const input = law.trim();
  if (LAW_ID_RE.test(input) || LAW_NUM_RE.test(input)) return { ok: true, idOrNum: input };
  const q = LAW_ALIASES[input.replace(/\s/g, "")] ?? input;

  const url = buildUrl(env.EGOV_API_BASE, "/laws", { law_title: q, asof, limit: 30, response_format: "json", omit_current_revision_info: true });
  const r = await getJson<LawsResponse>(url, { ttlSeconds: TTL_LAW });
  if (r.status !== 200 || !r.data) return { ok: false, message: `法令の検索に失敗しました：${apiErrorMessage(r.raw)}` };
  const laws = r.data.laws ?? [];
  if (laws.length === 0) return { ok: false, message: `「${input}」に該当する法令が見つかりません。正式名称で指定するか、egov_search_laws で名称を確認してください。` };

  const norm = (s: string) => s.replace(/\s/g, "");
  const exact = laws.filter((l) => norm(l.revision_info.law_title) === norm(q));
  const byAbbrev = laws.filter((l) => (l.revision_info.abbrev ?? "").split(/[,、，]/).map(norm).includes(norm(q)));
  const alive = (arr: LawItem[]) => arr.filter((l) => (l.revision_info.repeal_status ?? "None") === "None");

  // 1件だけヒットした場合も、題名に検索語を含むときに限って採用する（「下請法」で「下請法施行令」だけが略称ヒットする誤採用を防ぐ）
  const single = laws.length === 1 && norm(laws[0].revision_info.law_title).includes(norm(q)) ? laws[0] : undefined;
  const pick = alive(exact)[0] ?? exact[0] ?? alive(byAbbrev)[0] ?? byAbbrev[0] ?? single;
  if (pick) return { ok: true, idOrNum: pick.law_info.law_id, title: pick.revision_info.law_title };

  const list = laws.slice(0, 10).map((l) => `- ${l.revision_info.law_title}（${l.law_info.law_num}／法令ID ${l.law_info.law_id}）`).join("\n");
  return {
    ok: false,
    message: `「${input}」から法令を1つに特定できません。正式名称か法令IDで指定し直してください。\n${list}${laws.length > 10 ? `\n…ほか${laws.length - 10}件` : ""}`,
  };
}

function header(d: LawDataResponse, asof?: string): string {
  const r = d.revision_info;
  const lines = [
    `■ ${r.law_title}（${d.law_info.law_num}）`,
    `法令ID：${d.law_info.law_id}／版：${r.law_revision_id}`,
    `この版：${revisionLine(r)}`,
  ];
  if (asof) lines.push(`取得時点（asof）：${asof}`);
  return lines.join("\n");
}

async function getLawData(env: Env, idOrNum: string, params: Record<string, string | undefined>) {
  const url = buildUrl(env.EGOV_API_BASE, `/law_data/${encodeURIComponent(idOrNum)}`, {
    ...params,
    response_format: "json",
    law_full_text_format: "json",
    json_format: "full",
  });
  return getJson<LawDataResponse>(url, { ttlSeconds: TTL_LAW, timeoutMs: 30000 });
}

// ---- ツール登録 ----
export function registerEgovTools(server: McpServer, env: Env) {
  server.registerTool(
    "egov_search_laws",
    {
      title: "法令を名称で検索（e-Gov）",
      description:
        "日本の法令（憲法・法律・政令・府省令・規則）を名称や略称で検索し、正式名称・法令番号・法令ID・最新の改正と施行日を返す。" +
        "「○○法の正式名称は？」「○○に関する法律はどれか」「この法令はまだ有効か」といった問いに使う。" +
        "条文そのものが必要なら egov_get_article、本文中の語句の所在を探すなら egov_keyword_search を使う。" +
        "告示・通達・条例・判例は収録対象外。",
      inputSchema: {
        title: z.string().optional().describe("法令名または略称（部分一致）。例：個人情報保護法、下請"),
        law_num: z.string().optional().describe("法令番号（部分一致）。例：平成十五年法律第五十七号"),
        law_type: z.array(z.enum(LAW_TYPES)).optional().describe("法令種別で絞り込み。Act=法律、CabinetOrder=政令、MinisterialOrdinance=府省令、Rule=規則"),
        asof: dateSchema.optional().describe("この日付時点の状態で検索（YYYY-MM-DD）。省略時は現在"),
        include_repealed: z.boolean().default(false).describe("廃止・失効した法令も含めるか"),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ title, law_num, law_type, asof, include_repealed, limit }) => {
      if (!title && !law_num) return fail("title か law_num のどちらかを指定してください。");
      try {
        const url = buildUrl(env.EGOV_API_BASE, "/laws", {
          law_title: title ? LAW_ALIASES[title.replace(/\s/g, "")] ?? title : undefined, law_num, law_type: law_type?.join(","), asof,
          repeal_status: include_repealed ? undefined : "None",
          limit, response_format: "json", omit_current_revision_info: true,
        });
        const r = await getJson<LawsResponse>(url, { ttlSeconds: TTL_LAW });
        if (r.status !== 200 || !r.data) return fail(`検索に失敗しました：${apiErrorMessage(r.raw)}`);
        const { laws, total_count } = r.data;
        if (!laws?.length) return ok(`該当する法令はありません。\n\n${SOURCE}`);
        const lines = laws.map((l) => {
          const ri = l.revision_info;
          const ab = ri.abbrev ? `［略称：${ri.abbrev}］` : "";
          return `- ${ri.law_title}${ab}\n  ${l.law_info.law_num}／${LAW_TYPE_JA[l.law_info.law_type] ?? l.law_info.law_type}／法令ID ${l.law_info.law_id}\n  ${revisionLine(ri)}`;
        });
        return ok(`${total_count}件中${laws.length}件\n${lines.join("\n")}\n\n${SOURCE}`);
      } catch (e) {
        return fail(e instanceof UpstreamError ? e.message : `エラー：${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "egov_get_article",
    {
      title: "条文を取得（e-Gov）",
      description:
        "法令の特定の条（必要なら項・号まで）の本文を、条見出し付きのテキストで返す。過去や将来の時点（asof）の条文も取得できる。" +
        "「民法415条の文言」「個人情報保護法27条1項」「改正前（2022-03-31時点）の○条」のような問いに使う。" +
        "法令は名称・略称・法令ID・法令番号のどれでも指定できる。条番号は「415」「第四百十五条」「3の2」「548_2」いずれの書き方でもよい。" +
        "本則の条文のみ対象（附則・別表は対象外）。どの条に何があるか分からないときは先に egov_get_toc か egov_keyword_search を使う。",
      inputSchema: {
        law: z.string().describe("法令名・略称・法令ID・法令番号のいずれか。例：民法、個人情報保護法、415AC0000000057"),
        article: z.string().describe("条番号。例：415、第四百十五条、3の2"),
        paragraph: z.union([z.string(), z.number()]).optional().describe("項番号（省略時は条全体）"),
        item: z.union([z.string(), z.number()]).optional().describe("号番号（paragraph と併用）"),
        asof: dateSchema.optional().describe("この日付時点で有効な条文を取得（YYYY-MM-DD）。省略時は現在"),
        max_chars: z.number().int().min(500).max(50000).default(8000),
      },
    },
    async ({ law, article, paragraph, item, asof, max_chars }) => {
      const art = normalizeArticleNum(article);
      if (!art) return fail(`条番号「${article}」を解釈できません。例：415、第四百十五条、3の2`);
      const para = normalizeSubNum(paragraph);
      const it = normalizeSubNum(item);
      if (item !== undefined && !para) return fail("号を指定するときは項（paragraph）も指定してください（第1項なら 1）。");

      let elm = `MainProvision-Article_${art}`;
      if (para) elm += `-Paragraph_${para}`;
      if (it) elm += `-Item_${it}`;

      try {
        const res = await resolveLaw(env, law, asof);
        if (!res.ok) return fail(res.message);
        const r = await getLawData(env, res.idOrNum, { elm, asof });
        if (r.status !== 200 || !r.data) {
          const msg = apiErrorMessage(r.raw);
          const hint = /400021/.test(r.raw) ? "\n指定した条・項・号がこの版に存在しません。条番号の誤り、削除済みの条、または施行前の条の可能性があります。egov_get_toc で構成を確認してください。" : "";
          return fail(`条文を取得できませんでした：${msg}${hint}`);
        }
        const text = lawNodeToText(r.data.law_full_text);
        return ok(`${header(r.data, asof)}\n\n${truncate(text, max_chars)}\n\n${SOURCE}`);
      } catch (e) {
        return fail(e instanceof UpstreamError ? e.message : `エラー：${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "egov_get_toc",
    {
      title: "法令の目次を取得（e-Gov）",
      description:
        "法令の目次（編・章・節と、各章に含まれる条の範囲）を返す。条文全体を読まずに構成を把握したいとき、" +
        "「○○法で罰則はどこにあるか」「第4章は何条から何条か」を調べるときに使う。短い法令には目次がないことがある。",
      inputSchema: {
        law: z.string().describe("法令名・略称・法令ID・法令番号のいずれか"),
        asof: dateSchema.optional(),
        max_chars: z.number().int().min(500).max(50000).default(10000),
      },
    },
    async ({ law, asof, max_chars }) => {
      try {
        const res = await resolveLaw(env, law, asof);
        if (!res.ok) return fail(res.message);
        const r = await getLawData(env, res.idOrNum, { elm: "TOC", asof });
        if (r.status !== 200 || !r.data) {
          if (/400021/.test(r.raw)) return ok(`この法令には目次がありません。条数が少ない法令の可能性が高いので、egov_get_article で第1条から順に取得するか、egov_keyword_search で語句の所在を探してください。\n\n${SOURCE}`);
          return fail(`目次を取得できませんでした：${apiErrorMessage(r.raw)}`);
        }
        return ok(`${header(r.data, asof)}\n\n${truncate(lawNodeToText(r.data.law_full_text), max_chars)}\n\n${SOURCE}`);
      } catch (e) {
        return fail(e instanceof UpstreamError ? e.message : `エラー：${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "egov_keyword_search",
    {
      title: "法令本文を語句で全文検索（e-Gov）",
      description:
        "すべての法令の本文から語句を検索し、どの法令のどの箇所に出てくるかを抜粋付きで返す。" +
        "「『定型約款』を定義している条文はどこか」「『電磁的方法』を使っている法令」「○○について定めた規定を探したい」といった、条番号が分からない段階で使う。" +
        "AND/OR/NOT 検索（例：「個人情報 AND 第三者提供」）、ワイルドカード（例：「第*条」）が使える。法令名が分かっていて条文が欲しいなら egov_get_article を使う。",
      inputSchema: {
        keyword: z.string().min(1).describe("検索語。例：定型約款、個人データ AND 委託"),
        law_type: z.array(z.enum(LAW_TYPES)).optional().describe("法令種別で絞り込み"),
        asof: dateSchema.optional(),
        limit: z.number().int().min(1).max(200).default(30).describe("ヒット箇所数の上限（全法令合計）"),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ keyword, law_type, asof, limit, offset }) => {
      try {
        const url = buildUrl(env.EGOV_API_BASE, "/keyword", {
          keyword, law_type: law_type?.join(","), asof, limit, offset,
          sentence_text_size: 120, response_format: "json",
        });
        const r = await getJson<KeywordResponse>(url, { ttlSeconds: TTL_SEARCH, timeoutMs: 30000 });
        if (r.status !== 200 || !r.data) return fail(`検索に失敗しました：${apiErrorMessage(r.raw)}`);
        const { items, total_count, sentence_count, next_offset } = r.data;
        if (!items?.length) return ok(`「${keyword}」を含む法令は見つかりませんでした。\n\n${SOURCE}`);
        const blocks = items.map((it) => {
          const hits = it.sentences.map((s) => `  - [${s.position}] ${stripTags(s.text)}`).join("\n");
          return `■ ${it.revision_info.law_title}（${it.law_info.law_num}／法令ID ${it.law_info.law_id}）\n${hits}`;
        });
        const more = next_offset ? `\n\n続きは offset=${next_offset} で取得できます。` : "";
        return ok(`該当法令 ${total_count}件／ヒット箇所 ${sentence_count}件（【】がヒット語）\n\n${blocks.join("\n\n")}${more}\n\n位置の見方：caption=条見出し、mainprovision=本則、toc=目次、supplprovision=附則\n${SOURCE}`);
      } catch (e) {
        return fail(e instanceof UpstreamError ? e.message : `エラー：${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "egov_get_revisions",
    {
      title: "法令の改正履歴を取得（e-Gov）",
      description:
        "法令の改正履歴（各版の施行日、改正法令名、現行・未施行の別）を新しい順に返す。" +
        "「この法律の直近の改正はいつか」「未施行の改正はあるか」「○年改正の施行日は」といった問いに使う。" +
        "改正前の条文が必要なら、ここで施行日を確認したうえで egov_get_article の asof に施行日の前日を指定する。" +
        "収録は2017年4月1日時点の条文以降で、それより前の改正履歴は不完全。",
      inputSchema: {
        law: z.string().describe("法令名・略称・法令ID・法令番号のいずれか"),
        limit: z.number().int().min(1).max(100).default(15),
      },
    },
    async ({ law, limit }) => {
      try {
        const res = await resolveLaw(env, law);
        if (!res.ok) return fail(res.message);
        const url = buildUrl(env.EGOV_API_BASE, `/law_revisions/${encodeURIComponent(res.idOrNum)}`, { response_format: "json" });
        const r = await getJson<RevisionsResponse>(url, { ttlSeconds: TTL_LAW });
        if (r.status !== 200 || !r.data) return fail(`改正履歴を取得できませんでした：${apiErrorMessage(r.raw)}`);
        const revs = r.data.revisions ?? [];
        const title = revs[0]?.law_title ?? res.title ?? law;
        const lines = revs.slice(0, limit).map((v) => `- ${revisionLine(v)}\n  版ID ${v.law_revision_id}`);
        return ok(`■ ${title}（${r.data.law_info.law_num}）改正履歴 ${revs.length}件中${Math.min(limit, revs.length)}件\n${lines.join("\n")}\n\n${SOURCE}`);
      } catch (e) {
        return fail(e instanceof UpstreamError ? e.message : `エラー：${(e as Error).message}`);
      }
    },
  );
}
