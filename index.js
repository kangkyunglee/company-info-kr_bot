require("dotenv").config();
const { Telegraf } = require("telegraf");
const Anthropic = require("@anthropic-ai/sdk").default;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
- 응답은 간결하게 유지`;

async function lookupCompany(companyName) {
  const response = await anthropic.messages.create({
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
  });

  // Extract text from response content blocks
  const textBlocks = response.content.filter((block) => block.type === "text");
  return textBlocks.map((block) => block.text).join("\n");
}

// /start command
bot.start((ctx) => {
  ctx.reply(
    "🏢 *기업정보 조회 봇*\n\n" +
      "기업명을 입력하면 다음 정보를 조회합니다:\n" +
      "• 사업내용\n" +
      "• 주요제품/서비스\n" +
      "• 주요고객사\n" +
      "• 최근 매출액/영업이익\n\n" +
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
console.log("✅ 기업정보 조회 봇이 시작되었습니다!");

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
