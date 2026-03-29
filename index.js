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
3. 내용 줄: 다음 줄에 6칸 공백 들여쓰기 후 내용 작성
4. 섹션 사이에 빈 줄 1개

출력 형식 (이 형식을 정확히 복사해서 내용만 바꿔):

🏢 [기업명] ([종목코드] · [시장명])

● 대표자
      [대표이사 이름]

● 소재지
      [본사 주소 - 시/도 단위로 간결하게]

● 사업내용
      [1~2줄 사업 설명]

● 주요제품
      [주요 제품 나열, 비중 있으면 포함]

● 주요고객사
      [주요 고객사 나열]

● 실적 ([연도]년, 연결 또는 개별)
      매출 [금액] / 영업이익 [금액]

● 이슈
      [최근 주요 뉴스 1~2개, 각각 한 줄]

● 홈페이지
      [URL]

문체 규칙:
- 개조식. 서술형 금지
- 조사 최소화. 키워드 나열
- 각 섹션 내용 1줄. 절대 3줄 이상 금지
- 짧고 간결하게. 부연설명·배경설명·역사 넣지 마

절대 규칙:
- "📋 사업내용"처럼 이모지 옆에 반드시 제목을 쓰고, 내용은 반드시 다음 줄에 써
- 이모지 바로 옆에 내용을 쓰지 마 (❌ "📋 반도체 제조업체" → ⭕ "📋 사업내용" 줄바꿈 후 "      반도체 제조업체")
- 같은 섹션 내용 안에서 빈 줄(엔터 2번) 절대 넣지 마. 내용이 여러 줄이면 줄바꿈(엔터 1번)만 사용
- 섹션과 섹션 사이에만 빈 줄 1개
- 첫 글자는 🏢로 시작. 앞에 어떤 텍스트도 금지
- 마지막은 URL로 끝. 뒤에 어떤 텍스트도 금지
- 연간 실적만(분기X)
- 확인 불가 항목은 생략
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

  // 🏢 앞의 모든 텍스트 제거 (서론/인사말 제거)
  const startIdx = result.indexOf("🏢");
  if (startIdx > 0) {
    result = result.substring(startIdx);
  }

  // 홈페이지 URL 뒤의 모든 텍스트 제거
  const lines_raw = result.split("\n");
  let lastUrlIdx = -1;
  for (let i = 0; i < lines_raw.length; i++) {
    if (lines_raw[i].match(/https?:\/\//) || lines_raw[i].match(/\w+\.\w+\.\w+/)) {
      lastUrlIdx = i;
    }
  }
  if (lastUrlIdx > 0 && lastUrlIdx < lines_raw.length - 1) {
    result = lines_raw.slice(0, lastUrlIdx + 1).join("\n");
  }

  // 빈 줄 정리: 줄 단위로 처리
  const sectionKeywords = ["대표자", "소재지", "사업내용", "주요제품", "주요고객사", "실적", "이슈", "홈페이지"];
  const lines = result.split("\n").filter((line) => line.trim() !== "");
  const cleaned = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isSection = sectionKeywords.some((kw) => line.includes(kw));
    const isFirstLine = line.startsWith("🏢");
    if (isSection && cleaned.length > 0) {
      cleaned.push("");  // 섹션 앞에만 빈 줄 1개
      cleaned.push(line);
    } else if (isFirstLine) {
      cleaned.push(line);
    } else if (!isSection && !isFirstLine && !line.startsWith("      ")) {
      cleaned.push("      " + line.trimStart());
    } else {
      cleaned.push(line);
    }
  }
  result = cleaned.join("\n");

  // 🏢 외 모든 이모지를 ●로 강제 교체
  result = result.replace(/^(?!🏢)(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)\s*/gmu, "● ");

  // 단독 / 줄 제거
  result = result.split("\n").filter((l) => l.trim() !== "/").join("\n");

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
    { parse_mode: "Markdown", link_preview: { is_disabled: true } }
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
    { parse_mode: "Markdown", link_preview: { is_disabled: true } }
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
    const buttons = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📊 지분구조", callback_data: `share:${companyName}` },
            { text: "💹 재무상세", callback_data: `finance:${companyName}` },
            { text: "⚔️ 경쟁사", callback_data: `competitor:${companyName}` },
          ],
        ],
      },
      link_preview: { is_disabled: true },
    };
    try {
      await ctx.reply(result, { parse_mode: "Markdown", ...buttons });
    } catch {
      await ctx.reply(result, buttons);
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

// 버튼 클릭 핸들러
const DETAIL_PROMPTS = {
  share: (name) => `"${name}" 기업의 지분구조를 조회해줘. 최대주주, 지분율, 주요주주 현황을 아래 형식으로:

📊 지분구조 - ${name}
      최대주주: [이름] ([지분율]%)
      주요주주: [이름] ([지분율]%), [이름] ([지분율]%)
      소액주주: [비율]%

문체: 개조식, 간결하게, 서론 금지. 📊로 시작, 사족 금지`,

  finance: (name) => `"${name}" 기업의 최근 3개년 재무실적을 조회해줘. 아래 형식으로:

💹 재무상세 - ${name}
      [연도] 매출 [금액] / 영업이익 [금액] / 순이익 [금액]
      [연도] 매출 [금액] / 영업이익 [금액] / 순이익 [금액]
      [연도] 매출 [금액] / 영업이익 [금액] / 순이익 [금액]

문체: 개조식, 간결하게, 서론 금지. 💹로 시작, 사족 금지`,

  competitor: (name) => `"${name}" 기업의 주요 경쟁사를 조회해줘. 아래 형식으로:

⚔️ 경쟁사 - ${name}
      [경쟁사1] - [한줄 설명]
      [경쟁사2] - [한줄 설명]
      [경쟁사3] - [한줄 설명]

문체: 개조식, 간결하게, 서론 금지. ⚔️로 시작, 사족 금지`,
};

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const [type, ...nameParts] = data.split(":");
  const companyName = nameParts.join(":");

  await ctx.answerCbQuery("조회 중...");

  try {
    const prompt = DETAIL_PROMPTS[type](companyName);
    let response;
    try {
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 3,
            user_location: { type: "approximate", country: "KR", timezone: "Asia/Seoul" },
          },
        ],
        messages: [{ role: "user", content: prompt }],
      });
    } catch {
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      });
    }

    const textBlocks = response.content.filter((b) => b.type === "text");
    let result = textBlocks.map((b) => b.text).join("\n");

    // 빈 줄 제거 및 들여쓰기 정리
    const lines = result.split("\n").filter((l) => l.trim() !== "");
    const cleaned = [];
    for (const line of lines) {
      if (line.startsWith("📊") || line.startsWith("💹") || line.startsWith("⚔️")) {
        cleaned.push(line);
      } else if (!line.startsWith("      ")) {
        cleaned.push("      " + line.trimStart());
      } else {
        cleaned.push(line);
      }
    }
    result = cleaned.join("\n");

    try {
      await ctx.reply(result, { parse_mode: "Markdown", link_preview: { is_disabled: true } });
    } catch {
      await ctx.reply(result);
    }
  } catch (error) {
    console.error("Detail error:", error.message);
    await ctx.reply("⚠️ 상세 조회 중 오류가 발생했습니다.");
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
