// 法人番号Web-APIのモック（アプリケーションID発行前の動作確認用）
// 応答は国税庁の仕様書（第六編 Ver.4）の応答サンプルの構造に合わせている。値は仕様書のテスト用データ。
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8799);

const corp = (o) => `
  <corporation>
    <sequenceNumber>${o.seq}</sequenceNumber>
    <corporateNumber>${o.num}</corporateNumber>
    <process>${o.process ?? "01"}</process>
    <correct>0</correct>
    <updateDate>2019-04-03</updateDate>
    <changeDate>${o.changeDate ?? "2015-10-05"}</changeDate>
    <name>${o.name}</name>
    <nameImageId/>
    <kind>301</kind>
    <prefectureName>千葉県</prefectureName>
    <cityName>千葉市中央区</cityName>
    <streetNumber>中央４丁目５番８号</streetNumber>
    <addressImageId/>
    <prefectureCode>12</prefectureCode>
    <cityCode>101</cityCode>
    <postCode>2600013</postCode>
    <addressOutside/>
    <addressOutsideImageId/>
    <closeDate>${o.closeDate ?? ""}</closeDate>
    <closeCause>${o.closeCause ?? ""}</closeCause>
    <successorCorporateNumber>${o.successor ?? ""}</successorCorporateNumber>
    <changeCause/>
    <assignmentDate>2015-10-05</assignmentDate>
    <latest>${o.latest ?? "1"}</latest>
    <enName/>
    <enPrefectureName/>
    <enCityName/>
    <enAddressOutside/>
    <furigana>コクゼイショウジ</furigana>
    <hihyoji>0</hihyoji>
  </corporation>`;

const wrap = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<corporations>
  <lastUpdateDate>2019-04-05</lastUpdateDate>
  <count>${items.length}</count>
  <divideNumber>1</divideNumber>
  <divideSize>1</divideSize>${items.join("")}
</corporations>`;

export const requests = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  requests.push(u.toString());
  console.log("[mock-houjin]", req.method, u.pathname, Object.fromEntries(u.searchParams));
  if (u.searchParams.get("id") !== "TESTAPPID0001") {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    return res.end("アプリケーションIDが不正です");
  }
  res.setHeader("content-type", "application/xml; charset=utf-8");
  if (u.pathname === "/4/num") {
    const nums = (u.searchParams.get("number") ?? "").split(",");
    const items = nums.map((n, i) =>
      n === "2040001999902"
        ? corp({ seq: i + 1, num: n, name: "株式会社国税商事あ", process: "21", changeDate: "2018-06-30", closeDate: "2018-06-30", closeCause: "11", successor: "3040001999901" })
        : corp({ seq: i + 1, num: n, name: "株式会社国税商事Ａ" }),
    );
    return res.end(wrap(items));
  }
  if (u.pathname === "/4/name") {
    return res.end(
      wrap([
        corp({ seq: 1, num: "2040001999902", name: "株式会社国税商事あ", process: "21", closeDate: "2018-06-30", closeCause: "11", successor: "3040001999901" }),
        corp({ seq: 2, num: "3040001999901", name: "株式会社国税商事Ａ" }),
      ]),
    );
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => console.log(`[mock-houjin] listening on ${PORT}`));
