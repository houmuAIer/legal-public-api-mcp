/**
 * 国会会議録検索システム 検索用API
 * 仕様: https://kokkai.ndl.go.jp/api.html
 * 「機械的にアクセスする場合は、データ取得後、数秒程度空けて次のリクエストを行う」よう求められているため、
 * isolate 内で直前のリクエストから一定時間空ける。加えて結果をキャッシュして上流への負荷を減らす。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import { buildUrl, getJson, UpstreamError } from "./http.js";
import { fail, ok, sleep, truncate } from "./util.js";

const SOURCE =
  "出典：国会会議録検索システム（国立国会図書館）。発言の著作権は原則として発言者に帰属します（公開の場での政治上の演説・陳述は著作権法40条1項により利用可能）。";

const MIN_INTERVAL_MS = 3000;
const TTL = 6 * 3600;

let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();

/** 同一 isolate 内のリクエストを直列化し、最低 MIN_INTERVAL_MS 空ける */
function throttle(): Promise<void> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  queue = run.catch(() => undefined);
  return run;
}

interface SpeechRecord {
  speechID: string; issueID: string; session: number; nameOfHouse: string; nameOfMeeting: string;
  issue: string; date: string; speechOrder: number; speaker: string; speakerYomi?: string | null;
  speakerGroup?: string | null; speakerPosition?: string | null; speakerRole?: string | null;
  speech?: string; speechURL: string; meetingURL?: string; pdfURL?: string;
}
interface SpeechResponse {
  numberOfRecords: number; numberOfReturn: number; startRecord: number; nextRecordPosition: number | null;
  speechRecord?: SpeechRecord[];
  message?: string; details?: string[];
}
interface MeetingRecord {
  issueID: string; session: number; nameOfHouse: string; nameOfMeeting: string; issue: string; date: string;
  closing?: string | null; meetingURL: string; pdfURL?: string;
  speechRecord: { speechID: string; speechOrder: number; speaker: string; speechURL: string }[];
}
interface MeetingListResponse {
  numberOfRecords: number; numberOfReturn: number; startRecord: number; nextRecordPosition: number | null;
  meetingRecord?: MeetingRecord[];
  message?: string; details?: string[];
}

function errMsg(d: { message?: string; details?: string[] } | undefined, raw: string): string {
  if (d?.message) return [d.message, ...(d.details ?? [])].join(" ");
  return raw.slice(0, 300);
}

/** 本文から、最初の検索語の周辺を抜き出す */
export function excerpt(text: string, terms: string[], size: number): string {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n+/g, " ").trim();
  if (clean.length <= size) return clean;
  let idx = -1;
  for (const t of terms) {
    const i = clean.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return clean.slice(0, size) + "…";
  const start = Math.max(0, idx - Math.floor(size / 3));
  const end = Math.min(clean.length, start + size);
  return (start > 0 ? "…" : "") + clean.slice(start, end) + (end < clean.length ? "…" : "");
}

function speakerLabel(s: SpeechRecord): string {
  const extra = [s.speakerPosition, s.speakerGroup, s.speakerRole].filter(Boolean).join("・");
  return extra ? `${s.speaker}（${extra}）` : s.speaker;
}

const HOUSES = ["衆議院", "参議院", "両院"] as const;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式で指定してください");

export function registerKokkaiTools(server: McpServer, env: Env) {
  server.registerTool(
    "kokkai_search_speeches",
    {
      title: "国会会議録の発言を検索",
      description:
        "国会（衆議院・参議院）の会議録から発言を検索し、発言者・会議名・日付と、検索語の周辺の抜粋を返す。" +
        "立法趣旨や政府答弁の確認に使う。例：「定型約款の規定について法案審議で政府はどう説明したか」「○○大臣が個人情報保護法改正について答弁した内容」。" +
        "条文の文言の確認はできないので、e-Gov のツール（egov_get_article など）と組み合わせる。" +
        "全文が必要な発言は、返された speechID を kokkai_get_speech に渡す。" +
        "政府答弁を探すときは speaker に大臣・政府参考人の名前を入れるか、any に法案名と論点の語を空白区切りで入れる（AND検索）。",
      inputSchema: {
        any: z.string().optional().describe("発言内容の検索語。空白区切りでAND検索。例：定型約款 不当条項"),
        speaker: z.string().optional().describe("発言者名（部分一致、空白区切りでOR）"),
        name_of_house: z.enum(HOUSES).optional().describe("院"),
        name_of_meeting: z.string().optional().describe("会議名（部分一致）。例：法務委員会、本会議"),
        from: dateSchema.optional().describe("開会日の始点（YYYY-MM-DD）"),
        until: dateSchema.optional().describe("開会日の終点（YYYY-MM-DD）"),
        session_from: z.number().int().min(1).max(999).optional().describe("国会回次（開始）"),
        session_to: z.number().int().min(1).max(999).optional().describe("国会回次（終了）"),
        speaker_role: z.enum(["証人", "参考人", "公述人"]).optional(),
        max_records: z.number().int().min(1).max(30).default(10),
        start_record: z.number().int().min(1).default(1).describe("取得開始位置（続きを取るとき）"),
        excerpt_chars: z.number().int().min(100).max(2000).default(400),
      },
    },
    async (a) => {
      if (!a.any && !a.speaker && !a.name_of_meeting && !a.from && !a.until && !a.session_from && !a.session_to && !a.speaker_role) {
        return fail("検索条件を少なくとも1つ指定してください（any・speaker・name_of_meeting・期間など）。");
      }
      try {
        const url = buildUrl(env.KOKKAI_API_BASE, "/speech", {
          any: a.any, speaker: a.speaker, nameOfHouse: a.name_of_house, nameOfMeeting: a.name_of_meeting,
          from: a.from, until: a.until, sessionFrom: a.session_from, sessionTo: a.session_to,
          speakerRole: a.speaker_role, maximumRecords: a.max_records, startRecord: a.start_record,
          recordPacking: "json",
        });
        const r = await getJson<SpeechResponse>(url, { ttlSeconds: TTL, beforeNetwork: throttle, timeoutMs: 30000 });
        if (r.status !== 200 || !r.data || r.data.message) return fail(`検索に失敗しました：${errMsg(r.data, r.raw)}`);
        const d = r.data;
        const recs = d.speechRecord ?? [];
        if (recs.length === 0) return ok(`該当する発言はありません。\n\n${SOURCE}`);
        const terms = (a.any ?? "").split(/\s+/).filter(Boolean);
        const blocks = recs.map((s) =>
          [
            `■ ${s.date} 第${s.session}回国会 ${s.nameOfHouse} ${s.nameOfMeeting} ${s.issue}`,
            `発言者：${speakerLabel(s)}／speechID ${s.speechID}`,
            excerpt(s.speech ?? "", terms, a.excerpt_chars),
            s.speechURL,
          ].join("\n"),
        );
        const more = d.nextRecordPosition ? `\n\n続きは start_record=${d.nextRecordPosition} で取得できます。` : "";
        return ok(`該当 ${d.numberOfRecords}件中 ${d.startRecord}〜${d.startRecord + d.numberOfReturn - 1}件目（新しい順）\n\n${blocks.join("\n\n")}${more}\n\n${SOURCE}`);
      } catch (e) {
        return fail(e instanceof UpstreamError ? e.message : `エラー：${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "kokkai_get_speech",
    {
      title: "国会会議録の発言全文を取得",
      description:
        "speechID を指定して、1つの発言の全文を返す。kokkai_search_speeches の抜粋では足りないとき（答弁の前後の文脈、質問と答弁の対応を確かめたいとき）に使う。" +
        "直前の質問も確認したい場合は、speechID 末尾の発言番号を1つ前にして取得する（例：…_068 の前は …_067）。",
      inputSchema: {
        speech_id: z.string().regex(/^[0-9A-Za-z]{21}_\d{3}$/, "speechID の形式は「会議録ID(21桁)_発言番号(3桁)」です").describe("例：120804536X00520220412_068"),
        max_chars: z.number().int().min(500).max(50000).default(10000),
      },
    },
    async ({ speech_id, max_chars }) => {
      try {
        const url = buildUrl(env.KOKKAI_API_BASE, "/speech", { speechID: speech_id, recordPacking: "json" });
        const r = await getJson<SpeechResponse>(url, { ttlSeconds: TTL, beforeNetwork: throttle, timeoutMs: 30000 });
        if (r.status !== 200 || !r.data || r.data.message) return fail(`取得に失敗しました：${errMsg(r.data, r.raw)}`);
        const s = r.data.speechRecord?.[0];
        if (!s) return fail(`speechID ${speech_id} の発言は見つかりませんでした。`);
        const body = (s.speech ?? "").replace(/\r\n/g, "\n").trim();
        return ok(
          [
            `■ ${s.date} 第${s.session}回国会 ${s.nameOfHouse} ${s.nameOfMeeting} ${s.issue}（発言番号 ${s.speechOrder}）`,
            `発言者：${speakerLabel(s)}`,
            s.speechURL,
            "",
            truncate(body, max_chars),
            "",
            SOURCE,
          ].join("\n"),
        );
      } catch (e) {
        return fail(e instanceof UpstreamError ? e.message : `エラー：${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "kokkai_get_meeting_outline",
    {
      title: "国会の会議の発言者一覧を取得",
      description:
        "会議録ID（issueID）を指定して、その会議の発言の順番と発言者の一覧を返す（本文は含まない）。" +
        "ある委員会の審議で誰がどの順で発言したかを把握し、質問者と答弁者の対応から読むべき発言を絞り込むときに使う。" +
        "issueID は kokkai_search_speeches の speechID の「_」より前の部分。",
      inputSchema: {
        issue_id: z.string().regex(/^[0-9A-Za-z]{21}$/, "issueID は21桁の英数字です").describe("例：120804536X00520220412"),
      },
    },
    async ({ issue_id }) => {
      try {
        const url = buildUrl(env.KOKKAI_API_BASE, "/meeting_list", { issueID: issue_id, recordPacking: "json" });
        const r = await getJson<MeetingListResponse>(url, { ttlSeconds: TTL, beforeNetwork: throttle, timeoutMs: 30000 });
        if (r.status !== 200 || !r.data || r.data.message) return fail(`取得に失敗しました：${errMsg(r.data, r.raw)}`);
        const m = r.data.meetingRecord?.[0];
        if (!m) return fail(`issueID ${issue_id} の会議録は見つかりませんでした。`);
        const lines = m.speechRecord.map((s) => `${String(s.speechOrder).padStart(3, "0")} ${s.speaker}（${s.speechID}）`);
        return ok(`■ ${m.date} 第${m.session}回国会 ${m.nameOfHouse} ${m.nameOfMeeting} ${m.issue}\n${m.meetingURL}\n発言 ${lines.length}件\n${lines.join("\n")}\n\n${SOURCE}`);
      } catch (e) {
        return fail(e instanceof UpstreamError ? e.message : `エラー：${(e as Error).message}`);
      }
    },
  );
}
