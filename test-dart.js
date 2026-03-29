const config = require('./config.js');
const https = require('https');
const AdmZip = require('adm-zip');

const KEY = config.dartKey;

function dartRequest(url, binary = false) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": binary ? "application/octet-stream" : "application/json",
      },
    };
    https.request(options, (res) => {
      if (res.statusCode === 302) {
        return reject(new Error("Redirect: " + res.headers.location));
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (binary) return resolve(buf);
        try { resolve(JSON.parse(buf.toString())); }
        catch { reject(new Error("JSON parse error")); }
      });
    }).on("error", reject).end();
  });
}

async function test() {
  console.time("기업코드 다운로드");
  const zipBuffer = await dartRequest(
    `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${KEY}`, true
  );
  const zip = new AdmZip(zipBuffer);
  const xml = zip.readAsText(zip.getEntries()[0]);
  const corps = [];
  const regex = /<corp_code>(\d+)<\/corp_code>\s*<corp_name>([^<]+)<\/corp_name>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    corps.push({ code: match[1], name: match[2] });
  }
  console.timeEnd("기업코드 다운로드");
  console.log("총 기업수:", corps.length);

  // 티엠씨 검색
  const tmc = corps.find(c => c.name === "티엠씨");
  console.log("티엠씨:", tmc);

  if (tmc) {
    const info = await dartRequest(
      `https://opendart.fss.or.kr/api/company.json?crtfc_key=${KEY}&corp_code=${tmc.code}`
    );
    console.log("대표자:", info.ceo_nm);
    console.log("주소:", info.adres);

    const fin = await dartRequest(
      `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${KEY}&corp_code=${tmc.code}&bsns_year=2024&reprt_code=11011&fs_div=CFS`
    );
    console.log("CFS:", fin.status);
    if (fin.list) {
      fin.list.forEach(item => console.log("  ", item.account_nm, ":", item.thstrm_amount));
    }
  }
}
test();
