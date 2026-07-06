/**
 * backfill_theme.js
 * -------------------------------------------------------------
 * 이미 수집된 Notion Bookmark 항목에 '테마' 속성을 채우는 1회성 스크립트.
 *
 * 원리: 제목의 [콘텐츠태그]를 파싱 → main.js 와 동일한 매핑으로 테마 결정.
 *       Anthropic API 를 전혀 호출하지 않으므로 토큰 소모 0.
 *
 * 안전장치:
 *   - 이미 테마가 채워진 항목은 건너뜀 (재실행 안전)
 *   - BATCH_LIMIT 건까지만 처리 후 종료 → 여러 번 나눠 실행 (API 할당량 보호)
 *   - DRY_RUN=true 면 실제 쓰기 없이 결과만 출력
 *
 * 실행 전 준비:
 *   1) Notion Bookmark DB 에 Select 속성 '테마' 추가
 *      옵션 9개: 모델·제품 / 도구·활용 / 연구·논문 / 사례·적용 /
 *               산업·비즈니스 / 사회·정책 / 교육·학습 / 관점·칼럼 / 기타
 *   2) .env 에 NOTION_API_KEY, NOTION_DATABASE_ID (main.js 와 동일)
 *
 * 실행:
 *   DRY_RUN=true node backfill_theme.js     # 미리보기
 *   node backfill_theme.js                  # 남은 항목 전부 반영 (기본)
 *   BATCH_LIMIT=100 node backfill_theme.js  # 나눠 돌리고 싶을 때만
 * -------------------------------------------------------------
 */

require("dotenv").config();
const { Client } = require("@notionhq/client");

const { NOTION_API_KEY, NOTION_DATABASE_ID } = process.env;
if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error("❌ NOTION_API_KEY / NOTION_DATABASE_ID 가 필요합니다.");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });
const DRY_RUN = process.env.DRY_RUN === "true";
// 기본: 남은 항목 전부 처리. 나눠 돌리고 싶을 때만 BATCH_LIMIT 지정.
const BATCH_LIMIT = process.env.BATCH_LIMIT
  ? parseInt(process.env.BATCH_LIMIT, 10)
  : Infinity;
const DELAY_MS = 400; // Notion API rate limit(초당 3회) 보호

// main.js 와 반드시 동일하게 유지할 것
const THEME_BY_TAG = {
  모델: "모델·제품", 제품: "모델·제품", 기능: "모델·제품",
  도구: "도구·활용", 오픈소스: "도구·활용", 에이전트: "도구·활용", 프롬프트: "도구·활용",
  논문: "연구·논문", 벤치마크: "연구·논문",
  사례: "사례·적용",
  투자: "산업·비즈니스", 업계: "산업·비즈니스",
  윤리: "사회·정책",
  강의: "교육·학습", 가이드: "교육·학습",
  관점: "관점·칼럼",
  자료: "기타",
};
const FALLBACK_THEME = "기타";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function titleOf(page) {
  const t = page.properties["제목"];
  if (!t || !t.title || !t.title.length) return "";
  return t.title.map((x) => x.plain_text).join("");
}

function themeFromTitle(title) {
  // "⚠️ [태그] ..." 형태도 처리
  const m = title.match(/\[([^\]]+)\]/);
  const tag = m ? m[1].trim() : null;
  return THEME_BY_TAG[tag] || FALLBACK_THEME;
}

async function main() {
  let cursor = undefined;
  let updated = 0, skipped = 0, seen = 0;

  console.log(
    `▶ 테마 백필 시작 (${DRY_RUN ? "미리보기" : "실제 반영"}, ${
      Number.isFinite(BATCH_LIMIT) ? `최대 ${BATCH_LIMIT}건` : "남은 항목 전부"
    })`
  );

  do {
    const res = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of res.results) {
      seen++;
      const existing = page.properties["테마"];
      if (existing && existing.select && existing.select.name) {
        skipped++;
        continue; // 이미 채워짐
      }

      const title = titleOf(page);
      const theme = themeFromTitle(title);
      console.log(`  ${DRY_RUN ? "[예정]" : "[반영]"} ${theme.padEnd(7)} ← ${title.slice(0, 44)}`);

      if (!DRY_RUN) {
        await notion.pages.update({
          page_id: page.id,
          properties: { 테마: { select: { name: theme } } },
        });
        await sleep(DELAY_MS);
      }

      updated++;
      if (updated % 50 === 0) console.log(`  … ${updated}건 반영, 계속 진행 중`);
      if (updated >= BATCH_LIMIT) {
        console.log(`\n⏸ 배치 한도(${BATCH_LIMIT}건) 도달 — 다음에 이어서 실행하세요.`);
        report(seen, updated, skipped);
        return;
      }
    }

    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  console.log("\n✅ 전체 항목 처리 완료 — 더 이상 백필할 항목이 없습니다.");
  report(seen, updated, skipped);
}

function report(seen, updated, skipped) {
  console.log("=============================================");
  console.log(` 확인 ${seen}건 / ${DRY_RUN ? "반영 예정" : "반영"} ${updated}건 / 이미 채워짐 ${skipped}건`);
  console.log("=============================================");
}

main().catch((e) => {
  console.error("\n❌ 실행 중 오류:", e.message);
  process.exit(1);
});
