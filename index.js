try { require("dotenv").config(); } catch {}
const { Telegraf } = require("telegraf");
const Anthropic = require("@anthropic-ai/sdk").default;
const https = require("https");
const config = require("./config.js");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || config.telegramToken);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicKey });
const DART_API_KEY = process.env.DART_API_KEY || config.dartKey;

// DART API
const AdmZip = require("adm-zip");

function dartJsonRequest(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("DART JSON parse error")); }
      });
    }).on("error", reject);
  });
}

function dartBinaryRequest(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

// 기업코드 캐시
let corpCodeCache = null;
let corpCodeTime = 0;

async function getCorpCode(companyName) {
  try {
    // 캐시 24시간 유지
    if (!corpCodeCache || Date.now() - corpCodeTime > 86400000) {
      console.log("DART 기업코드 목록 다운로드 중...");
      const zipBuffer = await dartBinaryRequest(
        `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_API_KEY}`
      );
      const zip = new AdmZip(zipBuffer);
      const xml = zip.readAsText(zip.getEntries()[0]);
      // XML 파싱: <corp_code>코드</corp_code><corp_name>이름</corp_name> 추출
      const corps = [];
      const regex = /<corp_code>(\d+)<\/corp_code>\s*<corp_name>([^<]+)<\/corp_name>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        corps.push({ code: match[1], name: match[2] });
      }
      corpCodeCache = corps;
      corpCodeTime = Date.now();
      console.log(`DART 기업코드 ${corps.length}개 로드 완료`);
    }

    // 정확 매칭 → 부분 매칭 순서로 검색
    const exact = corpCodeCache.find((c) => c.name === companyName);
    if (exact) return exact.code;
    const partial = corpCodeCache.find((c) => c.name.includes(companyName));
    if (partial) return partial.code;
    return null;
  } catch (error) {
    console.error("기업코드 검색 오류:", error.message);
    return null;
  }
}

async function getDartFinancials(companyName) {
  try {
    // 1. 기업코드 검색
    const corpCode = await getCorpCode(companyName);
    if (!corpCode) return null;

    // 2. 기업 상세정보 (대표자, 주소)
    const companyInfo = await dartJsonRequest(
      `https://opendart.fss.or.kr/api/company.json?crtfc_key=${DART_API_KEY}&corp_code=${corpCode}`
    );
    const dartCeo = companyInfo.status === "000" ? companyInfo.ceo_nm : null;
    const dartAddr = companyInfo.status === "000" ? companyInfo.adres : null;

    // 3. 최근 연도 재무제표 (연결 + 개별)
    const year = new Date().getFullYear() - 1;
    const [cfsResult, ofsResult] = await Promise.all([
      dartJsonRequest(`https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${DART_API_KEY}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011&fs_div=CFS`),
      dartJsonRequest(`https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${DART_API_KEY}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011&fs_div=OFS`),
    ]);

    const hasCfs = cfsResult.status === "000" && cfsResult.list;
    const hasOfs = ofsResult.status === "000" && ofsResult.list;

    if (!hasCfs && !hasOfs && !dartCeo) return null;

    let result = "\n";
    if (dartCeo) result += `대표자: ${dartCeo}\n`;
    if (dartAddr) result += `소재지: ${dartAddr}\n`;
    if (hasCfs) result += formatDartSection(cfsResult.list, "연결", year);
    if (hasOfs) result += formatDartSection(ofsResult.list, "개별", year);

    return result;
  } catch (error) {
    console.error("DART API error:", error.message);
    return null;
  }
}

function formatDartSection(list, label, year) {
  const revenue = list.find(
    (item) =>
      item.account_nm === "매출액" || item.account_nm === "수익(매출액)"
  );
  const operatingProfit = list.find(
    (item) => item.account_nm === "영업이익" || item.account_nm === "영업이익(손실)"
  );
  const netIncome = list.find(
    (item) =>
      item.account_nm === "당기순이익" ||
      item.account_nm === "당기순이익(손실)"
  );

  let result = `[${label}]\n`;
  if (revenue) result += `• 매출액: ${revenue.thstrm_amount}원\n`;
  if (operatingProfit)
    result += `• 영업이익: ${operatingProfit.thstrm_amount}원\n`;
  if (netIncome) result += `• 당기순이익: ${netIncome.thstrm_amount}원\n`;

  return result;
}

const SYSTEM_PROMPT = `기업정보를 아래 형식 그대로 출력. 서론·사족·주석 절대 금지.

🏢 기업명 (종목코드 · 시장)
● 대표자
   이름
● 소재지
   시/도 구/군
● 사업내용
   한 줄 요약
● 주요제품
   제품1, 제품2, 제품3
● 주요고객사
   고객1, 고객2, 고객3
● 실적 (연도, 연결/개별)
   매출 X억 / 영업이익 X억
● 이슈
   핵심 이슈1
   핵심 이슈2
● 홈페이지
   URL

규칙:
- 개조식. 키워드 나열. 조사 최소화
- 이슈만 2줄. 나머지 섹션은 전부 1줄
- 실적: "매출 X억 / 영업이익 X억"만. 적자면 -X억. 괄호 설명 금지
- 매출 미확인 시 "매출 미공개 / 누적투자 X억"
- 🏢로 시작, URL로 끝. 앞뒤 텍스트 금지
- 대표자·소재지 반드시 포함
- 실적·대표자·소재지는 DART 전자공시(opendart.fss.or.kr) 또는 사업보고서 기준 최신 데이터 우선 사용
- 웹 검색 시 "DART 기업명 사업보고서"로 검색하여 공시 데이터 확인`;

async function lookupCompany(companyName) {
  // Claude 웹 검색과 DART API 동시 호출
  // Claude 웹 검색과 DART를 병렬 호출 (속도 개선)
  const dartPromise = getDartFinancials(companyName);

  let claudeResponse;
  try {
    claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
          user_location: {
            type: "approximate",
            country: "KR",
            timezone: "Asia/Seoul",
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: `"${companyName}" 기업의 사업내용, 주요제품, 주요고객사, 최근 매출액/영업이익을 조회해주세요.`,
        },
      ],
    });
  } catch (err) {
    console.error("Web search API error:", err.message);
    claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `"${companyName}" 기업에 대해 알고 있는 정보를 바탕으로 사업내용, 주요제품, 주요고객사, 최근 매출액/영업이익을 정리해주세요.`,
        },
      ],
    });
  }

  const dartData = await dartPromise;

  // Extract text from Claude response
  const textBlocks = claudeResponse.content.filter(
    (block) => block.type === "text"
  );
  let result = textBlocks.map((block) => block.text).join("\n");

  // === 통합 검증 에이전트 ===
  result = validateAndFormat(result);

  function validateAndFormat(text) {
    const SECTIONS = ["대표자", "소재지", "사업내용", "주요제품", "주요고객사", "실적", "이슈", "홈페이지"];

    // 1. 🏢 앞 텍스트 제거
    const startIdx = text.indexOf("🏢");
    if (startIdx > 0) text = text.substring(startIdx);

    // 2. 홈페이지 URL 뒤 텍스트 제거
    const rawLines = text.split("\n");
    let cutAt = -1;
    let homepageFound = false;
    for (let i = 0; i < rawLines.length; i++) {
      if (rawLines[i].includes("홈페이지")) homepageFound = true;
      if (homepageFound && rawLines[i].match(/https?:\/\/|www\.|\.com|\.co\.kr|\.kr|\.net|\.org/)) {
        cutAt = i;
        break;
      }
    }
    if (cutAt > 0) text = rawLines.slice(0, cutAt + 1).join("\n");

    // 3. 쓸모없는 줄 제거 (빈 줄, 단독 기호, 주석)
    let lines = text.split("\n").filter((l) => {
      const t = l.trim();
      if (t === "" || t === "/" || t === "." || t === "·" || t === "-" || t === "," || t === ";" || t === "—" || t === "–" || t.length <= 2) return false;
      if (t.includes("적자 상태") || t.includes("적자상태") || t.includes("손실 지속") || t.includes("현재도 적자")) return false;
      if (t.includes("기준)") && t.includes("평가")) return false;
      if (t.startsWith("※") || t.startsWith(">") || t.startsWith("참고") || t.startsWith("주:")) return false;
      if (t.includes("권장드립니다") || t.includes("확인하시") || t.includes("참고하세요")) return false;
      if (t.includes("DART 전자공시") || t.includes("KIND에서") || t.includes("직접 확인")) return false;
      return true;
    });

    // 4. 섹션 판별 함수
    function isSectionTitle(line) {
      const t = line.trimStart();
      return SECTIONS.some((kw) => {
        const idx = t.indexOf(kw);
        return idx >= 0 && idx <= 4 && t.length <= kw.length + 20;
      });
    }

    // 5. 구조화: 섹션 제목 앞 빈 줄 + 내용 들여쓰기
    const structured = [];
    for (const line of lines) {
      const isFirst = line.startsWith("🏢");
      const isSection = isSectionTitle(line);

      if (isFirst) {
        structured.push(line);
      } else if (isSection) {
        if (structured.length > 0) structured.push(""); // 섹션 앞 빈 줄
        // 이모지를 ●로 교체
        const trimmed = line.trimStart();
        const matchedSection = SECTIONS.find((s) => trimmed.includes(s));
        if (matchedSection) {
          const titleIdx = trimmed.indexOf(matchedSection);
          structured.push("● " + trimmed.substring(titleIdx));
        } else {
          structured.push(line);
        }
      } else {
        // 내용줄: 3칸 들여쓰기
        structured.push("   " + line.trimStart());
      }
    }

    let output = structured.join("\n");

    // 6. 서술형 어미 제거
    output = output.replace(/하고 있습니다/g, "");
    output = output.replace(/입니다\./g, "");
    output = output.replace(/있습니다\./g, "");

    // 7. "적자", "손실 지속" → 숫자 유지 (이미 프롬프트에서 처리)

    // 8. 최종 검증 로그
    const hasBuilding = output.startsWith("🏢");
    const hasURL = output.match(/https?:\/\/|www\.|\.com|\.co\.kr/);
    const sections = SECTIONS.filter((s) => output.includes("● " + s));
    console.log(`[검증] 🏢시작:${hasBuilding} URL끝:${!!hasURL} 섹션:${sections.join(",")}`);

    return output;
  }

  // DART 데이터로 대표자/소재지 교체 및 재무데이터 추가
  if (dartData) {
    const dartLines = dartData.split("\n");
    for (const dl of dartLines) {
      if (dl.startsWith("대표자: ")) {
        const dartCeo = dl.replace("대표자: ", "");
        result = result.replace(/(● 대표자\n)(   .+)/m, `$1   ${dartCeo}`);
      }
      if (dl.startsWith("소재지: ")) {
        const dartAddr = dl.replace("소재지: ", "");
        result = result.replace(/(● 소재지\n)(   .+)/m, `$1   ${dartAddr}`);
      }
    }
  }

  return result;
}

// 기사검색 함수
async function searchNews(companyName) {
  let response;
  try {
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: `"${companyName}" 관련 최신 주요 기사/뉴스를 검색해서 아래 형식으로 출력. 서론·사족 금지.

📰 ${companyName} 최신 기사

1. [기사 제목]
   출처 / 날짜
   한 줄 요약

2. [기사 제목]
   출처 / 날짜
   한 줄 요약

3. [기사 제목]
   출처 / 날짜
   한 줄 요약

규칙:
- 최신순으로 3~5개
- 개조식. 간결하게
- 📰로 시작. 앞뒤 사족 금지
- 요약은 1줄로 핵심만`,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
          user_location: { type: "approximate", country: "KR", timezone: "Asia/Seoul" },
        },
      ],
      messages: [{ role: "user", content: `"${companyName}" 최신 뉴스 기사 검색` }],
    });
  } catch (err) {
    console.error("News search error:", err.message);
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "user", content: `"${companyName}" 관련 최근 주요 뉴스를 알려줘. 개조식, 간결하게.` }],
    });
  }

  const textBlocks = response.content.filter((b) => b.type === "text");
  let result = textBlocks.map((b) => b.text).join("\n");

  // 📰 앞 텍스트 제거
  const startIdx = result.indexOf("📰");
  if (startIdx > 0) result = result.substring(startIdx);

  // 빈 줄 정리
  result = result.split("\n").filter((l) => l.trim() !== "").join("\n");

  return result;
}

// /start command
bot.start((ctx) => {
  ctx.reply(
    "기업명을 입력하면 정보를 조회합니다.\n예시: 삼성전자, 티엠씨, 네이버",
    { disable_web_page_preview: true }
  );
});

// /help command
bot.help((ctx) => {
  ctx.reply("기업명을 입력하면 정보를 조회합니다.");
});

// Handle text messages
bot.on("text", async (ctx) => {
  const companyName = ctx.message.text.trim();

  if (companyName.startsWith("/")) return;

  if (companyName.length < 2) {
    return ctx.reply("2글자 이상의 기업명을 입력해주세요.");
  }
  if (companyName.length > 50) {
    return ctx.reply("기업명이 너무 깁니다. 간단한 기업명을 입력해주세요.");
  }

  const statusMsg = await ctx.reply(`🔍 "${companyName}" 조회 중...`);

  try {
    const result = await lookupCompany(companyName);

    try {
      await ctx.reply(result, { parse_mode: "Markdown", disable_web_page_preview: true });
    } catch {
      await ctx.reply(result);
    }
  } catch (error) {
    console.error("Error:", error.message, error.status, JSON.stringify(error.error || {}));
    await ctx.reply(
      "⚠️ 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요."
    );
  }

  try {
    await ctx.deleteMessage(statusMsg.message_id);
  } catch {}
});

// Error handling
bot.catch((err) => {
  console.error("Bot error:", err.message);
});

// Start bot - 기존 webhook 제거 후 polling 시작
bot.launch({ dropPendingUpdates: true });
console.log("✅ 기업정보 조회 봇이 시작되었습니다! (Claude + DART 연동)");

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
