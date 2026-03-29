try { require("dotenv").config(); } catch {}
const { Telegraf } = require("telegraf");
const Anthropic = require("@anthropic-ai/sdk").default;
const https = require("https");
const config = require("./config.js");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || config.telegramToken);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicKey });
const DART_API_KEY = process.env.DART_API_KEY || config.dartKey;

// DART API: 기업명으로 고유번호 검색
function dartRequest(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("DART JSON parse error"));
          }
        });
      })
      .on("error", reject);
  });
}

async function getDartFinancials(companyName) {
  try {
    // 1. 기업 검색 (고유번호 조회)
    const searchUrl = `https://opendart.fss.or.kr/api/company.json?crtfc_key=${DART_API_KEY}&corp_name=${encodeURIComponent(companyName)}`;
    const searchResult = await dartRequest(searchUrl);

    if (searchResult.status !== "000" || !searchResult.corp_code) {
      return null;
    }

    const corpCode = searchResult.corp_code;
    const year = new Date().getFullYear() - 1;

    // 2. 연결(CFS) + 개별(OFS) 동시 조회
    const [cfsResult, ofsResult] = await Promise.all([
      dartRequest(`https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${DART_API_KEY}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011&fs_div=CFS`),
      dartRequest(`https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${DART_API_KEY}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011&fs_div=OFS`),
    ]);

    const hasCfs = cfsResult.status === "000" && cfsResult.list;
    const hasOfs = ofsResult.status === "000" && ofsResult.list;

    if (!hasCfs && !hasOfs) return null;

    let result = `\n📊 DART 공시 데이터 (${year}년 사업보고서)\n`;
    if (hasCfs) result += formatDartSection(cfsResult.list, "연결");
    if (hasOfs) result += formatDartSection(ofsResult.list, "개별");

    return result;
  } catch (error) {
    console.error("DART API error:", error.message);
    return null;
  }
}

function formatDartSection(list, label) {
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

const SYSTEM_PROMPT = `기업정보를 출력해. 반드시 아래 형식을 그대로 따라.

형식 규칙:
1. 각 섹션은 "이모지 제목" 줄과 "내용" 줄로 구성
2. 제목 줄: ● + 제목 텍스트 (예: "● 사업내용"). 🏢 외에는 반드시 ●만 사용
3. 내용 줄: 다음 줄에 3칸 공백 들여쓰기 후 내용 작성
4. 섹션 사이에 빈 줄 1개

출력 형식 (이 형식을 정확히 복사해서 내용만 바꿔):

🏢 [기업명] ([종목코드] · [시장명])

● 대표자
      홍길동
● 소재지
      서울시 강남구
● 사업내용
      반도체·스마트폰·가전 제조
● 주요제품
      DRAM, NAND, 갤럭시 스마트폰
● 주요고객사
      애플, 엔비디아, 퀄컴
● 실적 (2024년, 연결)
      매출 300조 / 영업이익 32조
● 이슈
      이슈1 (한 줄)
      이슈2 (한 줄)
(반드시 2줄로 분리. 쉼표로 이어붙이지 마)

● 홈페이지
      [URL]

문체 규칙:
- 개조식. 서술형 금지
- 조사 최소화. 키워드 나열
- 각 섹션 내용 1줄. 절대 2줄 이상 금지
- 짧고 간결하게. 부연설명·배경설명·역사·참고사항·주석 넣지 마
- 실적은 "매출 X억 / 영업이익 X억" 딱 이것만. 적자면 "영업이익 -X억"으로 숫자 표기. "적자", "손실 지속" 같은 말 금지
- 분기실적·부연·역대기록·괄호 설명 절대 금지
- ※, >, 참고, 주 같은 주석 절대 넣지 마
- 고객사 등 나열 시 "등"으로 줄바꿈하지 마. 한 줄에 다 쓸 것

절대 규칙:
- "📋 사업내용"처럼 이모지 옆에 반드시 제목을 쓰고, 내용은 반드시 다음 줄에 써
- 이모지 바로 옆에 내용을 쓰지 마 (❌ "📋 반도체 제조업체" → ⭕ "📋 사업내용" 줄바꿈 후 "      반도체 제조업체")
- 같은 섹션 내용 안에서 빈 줄(엔터 2번) 절대 넣지 마. 내용이 여러 줄이면 줄바꿈(엔터 1번)만 사용
- 섹션과 섹션 사이에만 빈 줄 1개
- 첫 글자는 🏢로 시작. 앞에 어떤 텍스트도 금지
- 마지막은 URL로 끝. 뒤에 어떤 텍스트도 금지
- 연간 실적만(분기X)
- 확인 불가 항목은 생략. 단 대표자·소재지는 반드시 포함
- DART 공시 데이터 제공 시 우선 사용`;

async function lookupCompany(companyName) {
  // Claude 웹 검색과 DART API 동시 호출
  let claudeResponse;
  try {
    // 먼저 웹 검색 포함으로 시도
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
    // 웹 검색 실패 시 일반 모드로 재시도
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

  const dartData = await getDartFinancials(companyName);

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
      if (t === "" || t === "/" || t === "." || t === "·" || t === "-") return false;
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

  // Append DART data if available
  if (dartData) {
    result += "\n---\n" + dartData;
  }

  return result;
}

// /start command
bot.start((ctx) => {
  ctx.reply(
    "🏢 *기업정보 조회 봇*\n\n" +
      "기업명을 입력하면 다음 정보를 조회합니다:\n" +
      "• 사업내용\n" +
      "• 주요제품/서비스\n" +
      "• 주요고객사\n" +
      "• 최근 매출액/영업이익 (DART 공시 포함)\n\n" +
      "예시: `삼성전자`, `티엠씨`, `네이버`",
    { parse_mode: "Markdown", disable_web_page_preview: true }
  );
});

// /help command
bot.help((ctx) => {
  ctx.reply(
    "기업명을 입력하시면 해당 기업의 정보를 조회합니다.\n\n" +
      "예시:\n" +
      "• `삼성전자`\n" +
      "• `현대자동차`\n" +
      "• `카카오`",
    { parse_mode: "Markdown", disable_web_page_preview: true }
  );
});

// Handle text messages
bot.on("text", async (ctx) => {
  const companyName = ctx.message.text.trim();

  // Ignore commands
  if (companyName.startsWith("/")) return;

  // Ignore very short or very long inputs
  if (companyName.length < 2) {
    return ctx.reply("2글자 이상의 기업명을 입력해주세요.");
  }
  if (companyName.length > 50) {
    return ctx.reply("기업명이 너무 깁니다. 간단한 기업명을 입력해주세요.");
  }

  const statusMsg = await ctx.reply(`🔍 "${companyName}" 조회 중...`);

  try {
    const result = await lookupCompany(companyName);

    // Try Markdown first, fall back to plain text
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

  // Delete "조회 중" message
  try {
    await ctx.deleteMessage(statusMsg.message_id);
  } catch {
    // ignore if can't delete
  }
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
