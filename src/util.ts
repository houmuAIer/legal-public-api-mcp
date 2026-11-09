import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** 長すぎる本文を切り詰め、切り詰めた旨を明示する */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n…（${text.length}文字中 先頭${maxChars}文字で省略。max_chars を増やすか、範囲を絞って再取得してください）`;
}

const KANJI_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const KANJI_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** 漢数字（例: 四百十五）を数値に。変換できなければ undefined */
export function kanjiToNumber(s: string): number | undefined {
  if (!s) return undefined;
  let total = 0;
  let current = 0;
  for (const ch of s) {
    if (ch in KANJI_DIGITS) {
      current = current * 10 + KANJI_DIGITS[ch];
    } else if (ch in KANJI_UNITS) {
      total += (current === 0 ? 1 : current) * KANJI_UNITS[ch];
      current = 0;
    } else {
      return undefined;
    }
  }
  return total + current;
}

function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function numPart(s: string): number | undefined {
  const t = toHalfWidthDigits(s.trim());
  if (/^\d+$/.test(t)) return Number(t);
  return kanjiToNumber(t);
}

/**
 * 条番号の表記ゆれを e-Gov の elm 形式（例: 415, 3_2, 548_2）に正規化する。
 * 受け付ける例: "415" / "第415条" / "第四百十五条" / "3の2" / "第三条の二" / "3_2" / "548-2"
 */
export function normalizeArticleNum(input: string): string | undefined {
  let s = toHalfWidthDigits(input.trim()).replace(/\s/g, "");
  s = s.replace(/^第/, "");
  // 「第三条の二」→「三の二」、「3条の2」→「3の2」
  s = s.replace(/条/, "");
  const parts = s.split(/の|_|-|－|ー/).filter((p) => p !== "");
  if (parts.length === 0) return undefined;
  const nums = parts.map(numPart);
  if (nums.some((n) => n === undefined || n <= 0)) return undefined;
  return nums.join("_");
}

/** 項・号の番号（"2" / "２" / "二" / "第2項"）を数値文字列に */
export function normalizeSubNum(input: string | number | undefined): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input === "number") return input > 0 ? String(input) : undefined;
  const s = toHalfWidthDigits(input.trim()).replace(/^第/, "").replace(/[項号]$/, "");
  const parts = s.split(/の|_|-/).filter(Boolean);
  const nums = parts.map(numPart);
  if (nums.length === 0 || nums.some((n) => n === undefined || n <= 0)) return undefined;
  return nums.join("_");
}

/** HTMLのハイライトタグなどを除去 */
export function stripTags(s: string, mark = true): string {
  return mark ? s.replace(/<span>/g, "【").replace(/<\/span>/g, "】").replace(/<[^>]+>/g, "") : s.replace(/<[^>]+>/g, "");
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
