import { describe, expect, it } from "vitest";
import { normalizeArticleNum, normalizeSubNum, kanjiToNumber } from "../src/util";
import { lawNodeToText } from "../src/egov";
import { isValidCorporateNumber, parseHoujinXml, stripCorporateKind, toFullWidth } from "../src/houjin";
import { excerpt } from "../src/kokkai";

describe("条番号の正規化", () => {
  it.each([
    ["415", "415"], ["第415条", "415"], ["第四百十五条", "415"], ["３の２", "3_2"],
    ["第三条の二", "3_2"], ["548_2", "548_2"], ["548-2", "548_2"], ["第千五十条", "1050"], ["第五百四十八条の二", "548_2"],
  ])("%s → %s", (i, o) => expect(normalizeArticleNum(i)).toBe(o));
  it("解釈できないものは undefined", () => {
    expect(normalizeArticleNum("abc")).toBeUndefined();
    expect(normalizeArticleNum("0")).toBeUndefined();
  });
  it("項・号", () => {
    expect(normalizeSubNum(2)).toBe("2");
    expect(normalizeSubNum("第二項")).toBe("2");
    expect(normalizeSubNum("三")).toBe("3");
    expect(normalizeSubNum(undefined)).toBeUndefined();
  });
  it("漢数字", () => {
    expect(kanjiToNumber("二十一")).toBe(21);
    expect(kanjiToNumber("百")).toBe(100);
  });
});

describe("条文の整形", () => {
  it("条見出し・項番号・号を改行とインデントで表す", () => {
    const node = {
      tag: "Article", attr: { Num: "1" }, children: [
        { tag: "ArticleCaption", children: ["（目的）"] },
        { tag: "ArticleTitle", children: ["第一条"] },
        { tag: "Paragraph", attr: { Num: "1" }, children: [
          { tag: "ParagraphNum", children: [] },
          { tag: "ParagraphSentence", children: [{ tag: "Sentence", children: ["本文。"] }] },
          { tag: "Item", children: [{ tag: "ItemTitle", children: ["一"] }, { tag: "ItemSentence", children: [{ tag: "Sentence", children: ["号の文"] }] }] },
        ] },
        { tag: "Paragraph", attr: { Num: "2" }, children: [
          { tag: "ParagraphNum", children: ["２"] },
          { tag: "ParagraphSentence", children: [{ tag: "Sentence", children: [{ tag: "Ruby", children: ["瑕", { tag: "Rt", children: ["か"] }] }, "疵"] }] },
        ] },
      ],
    };
    expect(lawNodeToText(node)).toBe("（目的）\n第一条　本文。\n　一　号の文\n２　瑕疵");
  });
});

describe("法人番号", () => {
  it("チェックデジット", () => {
    expect(isValidCorporateNumber("8000012010038")).toBe(true);
    expect(isValidCorporateNumber("4000012090001")).toBe(true);
    expect(isValidCorporateNumber("8000012010039")).toBe(false);
    expect(isValidCorporateNumber("123")).toBe(false);
  });
  it("法人種別の除去と全角化", () => {
    expect(stripCorporateKind("株式会社国税商事")).toBe("国税商事");
    expect(stripCorporateKind("国税商事株式会社")).toBe("国税商事");
    expect(toFullWidth("Sansan 1")).toBe("Ｓａｎｓａｎ　１");
  });
  it("XMLの解析", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><corporations><lastUpdateDate>2019-04-05</lastUpdateDate><count>1</count><divideNumber>1</divideNumber><divideSize>1</divideSize><corporation><corporateNumber>5111101000006</corporateNumber><name>株式会社検索対象除外</name><kind>301</kind><closeDate/></corporation></corporations>`;
    const p = parseHoujinXml(xml);
    expect(p.count).toBe("1");
    expect(p.corporations[0]).toMatchObject({ corporateNumber: "5111101000006", name: "株式会社検索対象除外", kind: "301" });
    expect(p.corporations[0].closeDate).toBeUndefined();
  });
});

describe("会議録の抜粋", () => {
  it("検索語の周辺を切り出す", () => {
    const text = "あ".repeat(500) + "定型約款" + "い".repeat(500);
    const e = excerpt(text, ["定型約款"], 100);
    expect(e).toContain("定型約款");
    expect(e.startsWith("…")).toBe(true);
  });
});
