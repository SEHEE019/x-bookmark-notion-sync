/**
 * backfill.js
 * -------------------------------------------------------------
 * 이미 Notion 에 올라간 기존 row 들의 '분류'(처리분류) 컬럼을
 * 한 번만 훑어서 채워 넣는 일회성 스크립트.
 *
 *  - 제목/내용 등 다른 값은 건드리지 않음 (분류만 채움)
 *  - 이미 분류가 채워진 row 는 건너뜀 (수동 지정 보호)
 *  - 각 row 의 '내용'(원문 텍스트)을 Claude 에 보내 처리분류만 판정
 *
 * 필요 환경변수 (.env):
 *   NOTION_API_KEY, NOTION_DATABASE_ID, ANTHROPIC_API_KEY
 *
 * 실행: node backfill.js
 * -------------------------------------------------------------
 */

require("dotenv").config();
const { Client } = require("@notionhq/client");

const { NOTION_API_KEY, NOTION_DATABASE_ID, ANTHROPIC_API_KEY } = process.env;

if (!NOTION_API_KEY || !NOTION_DATABASE_ID || !ANTHROPIC_API_KEY) {
  console.error("❌ NOTION_API_KEY, NOTION_DATABASE_ID, ANTHROPIC_API_KEY 가 .env 에 필요합니다.");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });

const VALID_ACTIONS = ["테스트(개발자)", "테스트(비개발자)", "조사", "코멘트"];

// main.js 와 동일한 처리분류 판정 기준 (분류만 판정하도록 축소)
const ACTION_PROMPT = `너는 우리 회사 AI TF의 북마크 정리 담당이다.
우리 팀 목적: 전체 AI 동향·시장 흐름을 파악하고, 그중 "우리가 직접 개발해서 업무에 쓸 수 있는 것"을 골라 테스트한다.
아래 X(트위터) 원문을 읽고, 처리분류 하나만 JSON 으로 출력하라.

[출력: 아래 JSON 형식만. 다른 텍스트·설명·마크다운 금지]
{"action":"처리분류"}

[action 처리분류 — 아래 순서대로 판정, 첫 매칭 채택]
1) 디자인·영상·이미지·3D·CAD·모델링 등 시각/모델링 계열이면 → "조사"
   (우리 회사엔 직접 필요 없으므로 테스트 안 함. 시각 도구인데 API로 개발에 붙일 수 있어 애매하면 "조사".)
2) 우리가 직접 개발/적용해 업무에 쓸 수 있을 법한 것이면 → "테스트"
   - 코딩·개발 환경이 필요한 라이브러리·API·CLI·SDK·MCP·코드 → "테스트(개발자)"
   - 코딩 없이 바로 써볼 수 있는 앱·서비스·프롬프트·자동화 도구 → "테스트(비개발자)"
3) 시장 흐름·업계 동향·기업 전략·투자·모델 릴리즈 등 "흐름 파악"용이면 → "조사"
4) 위 어디에도 안 맞고 읽고 의견만 남기면 되는 개인 관점·에세이·전망 → "코멘트"
- 애매하면 "조사".

원문:
`;

// 지정 시간(ms) 대기
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function judgeAction(text) {
  const content = (text || "").trim();
  if (content.length < 3) return "조사";

  const MAX_RETRY = 5;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 60,
          messages: [{ role: "user", content: ACTION_PROMPT + content }],
        }),
      });

      // 429(속도제한)면 대기 후 재시도
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "15", 10);
        const wait = (isNaN(retryAfter) ? 15 : retryAfter) * 1000;
        console.log(`    · 속도제한(429). ${wait / 1000}초 대기 후 재시도...`);
        await sleep(wait);
        continue;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(`Claude ${res.status}: ${JSON.stringify(data)}`);

      let raw = "";
      if (Array.isArray(data.content)) {
        raw = data.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      }
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const s = cleaned.indexOf("{");
      const e = cleaned.lastIndexOf("}");
      const obj = JSON.parse(s >= 0 && e > s ? cleaned.slice(s, e + 1) : cleaned);
      const action = (obj.action || "").toString().trim();
      return VALID_ACTIONS.includes(action) ? action : "조사";
    } catch (err) {
      // 마지막 시도까지 실패하면 null 반환(=비워둠)
      if (attempt === MAX_RETRY) {
        console.error("  ! 판정 실패(재시도 소진), 비워둠:", err.message);
        return null;
      }
      await sleep(3000);
    }
  }
  return null;
}

// row 에서 '내용'(rich_text) 텍스트 추출
function getContent(page) {
  const prop = page.properties["내용"];
  if (prop && prop.rich_text && prop.rich_text.length) {
    return prop.rich_text.map((t) => t.plain_text).join("");
  }
  return "";
}

// row 의 '분류'가 이미 채워졌는지
function hasAction(page) {
  const prop = page.properties["분류"];
  return !!(prop && prop.select && prop.select.name);
}

async function main() {
  console.log("▶ 기존 row 조회 중...");

  // 페이지네이션으로 전체 row 수집
  const pages = [];
  let cursor = undefined;
  do {
    const res = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  console.log(`  - 총 ${pages.length}건 발견`);

  let filled = 0;
  let skipped = 0;
  let blank = 0;

  // 처리할 대상(분류 비어있는 것)만 추림
  const targets = pages.filter((p) => !hasAction(p));
  console.log(`  - 분류 채울 대상: ${targets.length}건`);
  skipped = pages.length - targets.length;

  // 분당 5요청 제한 → 요청 간 13초 간격
  const GAP_MS = 13000;

  for (let i = 0; i < targets.length; i++) {
    const page = targets[i];
    const content = getContent(page);
    const action = await judgeAction(content);

    if (action === null) {
      // 판정 실패 → 분류 비워둠 (업데이트 안 함)
      blank++;
      console.log(`  · (비움) ${content.slice(0, 30)}`);
    } else {
      try {
        await notion.pages.update({
          page_id: page.id,
          properties: {
            분류: { select: { name: action } },
          },
        });
        filled++;
        console.log(`  ✓ [${action}] ${content.slice(0, 30)}`);
      } catch (e) {
        console.error(`  ! 업데이트 실패 (${page.id}):`, e.message);
      }
    }

    // 다음 요청 전 대기 (마지막 건 제외)
    if (i < targets.length - 1) {
      await sleep(GAP_MS);
    }
  }

  console.log("\n=============================================");
  console.log(` 완료: ${filled}건 채움, ${blank}건 비움(판정실패), ${skipped}건 건너뜀(이미 있음)`);
  console.log("=============================================");
}

main().catch((e) => {
  console.error("\n❌ 오류:", e.message);
  process.exit(1);
});
