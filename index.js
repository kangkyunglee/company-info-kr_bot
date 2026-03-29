try { require("dotenv").config(); } catch {}
const { Telegraf } = require("telegraf");
const Anthropic = require("@anthropic-ai/sdk").default;
const https = require("https");

// Debug: log ALL env var keys to check Railway injection
console.log("Total env vars:", Object.keys(process.env).length);
console.log("All env keys:", Object.keys(process.env).join(", "));
console.log("TELEGRAM_BOT_TOKEN value length:", (process.env.TELEGRAM_BOT_TOKEN || "").length);

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is not set! Waiting 10s and retrying...");
  setTimeout(() => {
    console.log("Retry - TELEGRAM_BOT_TOKEN:", !!process.env.TELEGRAM_BOT_TOKEN);
  }, 10000);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DART_API_KEY = process.env.DART_API_KEY;

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

    // 2. 최근 사업연도 재무정보 조회 (단일회사)
    const year = new Date().getFullYear() - 1;
    const finUrl = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${DART_API_KEY}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011&fs_div=CFS`;
    const finResult = await dartRequest(finUrl);

    if (finResult.status !== "000" || !finResult.list) {
      // CFS(연결) 실패 시 OFS(개별)로 재시도
      const finUrl2 = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${DART_API_KEY}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011&fs_div=OFS`;
      const finResult2 = await dartRequest(finUrl2);
      if (finResult2.status !== "000" || !finResult2.list) return null;
      return formatDartData(finResult2.list, year);
    }

    return formatDartData(finResult.list, year);
  } catch (error) {
    console.error("DART API error:", error.message);
    return null;
  }
}

function formatDartData(list, year) {
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

  let result = `\n📊 DART 공시 데이터 (${year}년 사업보고서)\n`;
  if (revenue) result += `• 매출액: ${revenue.thstrm_amount}원\n`;
  if (operatingProfit)
    result += `• 영업이익: ${operatingProfit.thstrm_amount}원\n`;
  if (netIncome) result += `• 당기순이익: ${netIncome.thstrm_amount}원\n`;

  return result;
}

const SYSTEM_PROMPT = `당신은 기업정보 조회 전문가입니다. 사용자가 기업명을 입력하면 웹 검색을 통해 다음 정보를 정리해서 제공합니다:

1. **사업내용** - 주요 사업 영역 (2~3줄)
2. **주요제품/서비스** - 핵심 제품 나열
3. **주요고객사** - 알려진 고객사 (공개된 경우)
4. **최근 실적** - 가장 최근 연도의 매출액, 영업이익 (가능하면 전년도 대비 증감률 포함)

규칙:
- 한국어로 답변
- 상장기업이면 종목코드 포함
- 동명 기업이 여러 개이면 가장 대표적인 기업 1개를 선택하고, 다른 동명 기업도 간단히 언급
- 정보를 찾기 어려운 경우 솔직하게 "공개된 정보가 제한적입니다"라고 안내
- 텔레그램 Markdown 형식으로 출력 (MarkdownV2 아님, 기본 Markdown)
- 응답은 간결하게 유지
- 만약 DART 공시 데이터가 함께 제공되면, 그 수치를 우선 사용하고 "(DART 공시 기준)"이라고 명시`;

async function lookupCompany(companyName) {
  // Claude 웹 검색과 DART API 동시 호출
  const [claudeResponse, dartData] = await Promise.all([
    anthropic.messages.create({
      model: "claude-sonnet-4-6-20250514",
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
    }),
    getDartFinancials(companyName),
  ]);

  // Extract text from Claude response
  const textBlocks = claudeResponse.content.filter(
    (block) => block.type === "text"
  );
  let result = textBlocks.map((block) => block.text).join("\n");

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
    { parse_mode: "Markdown" }
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
    { parse_mode: "Markdown" }
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
      await ctx.reply(result, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(result);
    }
  } catch (error) {
    console.error("Error:", error.message);
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

// Start bot
bot.launch();
console.log("✅ 기업정보 조회 봇이 시작되었습니다! (Claude + DART 연동)");

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
