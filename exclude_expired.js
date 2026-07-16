/**
 * exclude_expired.js
 * -------------------------------------------------------------
 * 게시일이 기준 일수를 지난 '미선택' 건의 확인상태를 '제외'로 변경.
 * (미선택 = 확인상태가 '미확인'인 건. 담당자 배정 여부와 무관하게
 *  아직 아무도 선택하지 않았다면 대상. 진행/완료 건은 절대 건드리지 않음)
 *
 * ★ 삭제가 아님 — 상태만 바뀌므로 노션에서 언제든 되돌릴 수 있다.
 *
 * 실행:
 *   DRY_RUN=true node exclude_expired.js   # 미리보기 (첫 실행은 반드시 이걸로)
 *   node exclude_expired.js                # 실제 반영
 *
 * 기준 일수 변경 (기본: 코멘트 7 / 조사 21 / 테스트 21):
 *   DAYS_COMMENT=10 DAYS_RESEARCH=30 node exclude_expired.js
 *
 * 필요 환경변수: NOTION_API_KEY, NOTION_DATABASE_ID (main.js 와 동일)
 * GitHub Actions 에는 main.js 실행 뒤, export_dashboard.js 앞에 넣는다
 * (제외 반영된 상태가 그날 data.json 에 바로 실리도록).
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
const DELAY_MS = 400;

// 기준 일수 — 팀 리듬(겸직) 반영 기본값. 코멘트는 뉴스성이라 짧게.
const DAYS = {
  코멘트: parseInt(process.env.DAYS_COMMENT || "7", 10),
  조사: parseInt(process.env.DAYS_RESEARCH || "21", 10),
  테스트: parseInt(process.env.DAYS_TEST || "21", 10), // 테스트(개발자)/(비개발자) 공통
};

const limitOf = (cat) =>
  cat === "코멘트" ? DAYS.코멘트 : cat === "조사" ? DAYS.조사 : DAYS.테스트;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daysSince = (iso) =>
  Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

async function main() {
  console.log(
    `▶ 자동 제외 ${DRY_RUN ? "미리보기" : "실행"} — 기준: 코멘트 ${DAYS.코멘트}일 / 조사 ${DAYS.조사}일 / 테스트 ${DAYS.테스트}일`
  );

  const targets = [];
  const noDate = [];
  let cursor = undefined;

  do {
    const res = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
      filter: {
        or: [
          { property: "확인상태", select: { equals: "미확인" } },
          { property: "확인상태", select: { is_empty: true } }, // 초기 마이그레이션 건 (상태 미입력)
        ],
      },
    });

    for (const page of res.results) {
      const P = page.properties;
      const title = (P["제목"]?.title || []).map((x) => x.plain_text).join("");
      const cat = P["분류"]?.select?.name || "조사";
      const pub = P["게시일"]?.date?.start || P["수집일"]?.date?.start;
      if (!pub) { noDate.push(title); continue; } // 날짜 없으면 자동 판단 불가 → 수동 처리 목록으로

      const age = daysSince(pub);
      if (age > limitOf(cat)) targets.push({ id: page.id, title, cat, age });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  if (noDate.length) {
    console.warn(`\n⚠️ 게시일·수집일이 모두 비어 자동 판단이 불가한 건 ${noDate.length}건 — 노션에서 직접 확인 필요:`);
    for (const t of noDate) console.warn("   · " + t.slice(0, 50));
  }

  if (!targets.length) {
    console.log("✅ 현재 기준으로 제외할 항목이 없습니다.");
    return;
  }

  console.log(`\n대상 ${targets.length}건:`);
  for (const t of targets) {
    console.log(
      `  ${DRY_RUN ? "[예정]" : "[제외]"} ${String(t.age).padStart(3)}일 경과 · ${t.cat.padEnd(9)} · ${t.title.slice(0, 46)}`
    );
    if (!DRY_RUN) {
      await notion.pages.update({
        page_id: t.id,
        properties: { 확인상태: { select: { name: "제외" } } },
      });
      await sleep(DELAY_MS);
    }
  }

  console.log("=============================================");
  console.log(
    DRY_RUN
      ? ` 미리보기 완료 — 실제 반영은 DRY_RUN 없이 다시 실행`
      : ` ${targets.length}건 제외 처리 완료 (노션에서 되돌리기 가능)`
  );
  console.log("=============================================");
}

main().catch((e) => {
  console.error("❌ 실행 중 오류:", e.message);
  process.exit(1);
});
