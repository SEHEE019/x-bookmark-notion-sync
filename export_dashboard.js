/**
 * export_dashboard.js
 * -------------------------------------------------------------
 * Notion Bookmark DB 전체를 읽어 대시보드용 data.json 을 생성.
 * main.js 실행 직후 같은 GitHub Action 에서 이어 실행한다.
 *
 * 실행: node export_dashboard.js
 * 출력: ./docs/data.json  (GitHub Pages 가 docs/ 를 서빙)
 *
 * 필요 환경변수: NOTION_API_KEY, NOTION_DATABASE_ID (main.js 와 동일)
 * -------------------------------------------------------------
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("@notionhq/client");

const { NOTION_API_KEY, NOTION_DATABASE_ID } = process.env;
if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error("❌ NOTION_API_KEY / NOTION_DATABASE_ID 가 필요합니다.");
  process.exit(1);
}
const notion = new Client({ auth: NOTION_API_KEY });

// ─────────────────────────────────────────────
// 담당자 매핑: 노션 표시 이름으로 자동 인식 (손댈 것 없음)
// 이름에 아래 글자가 포함되면 해당 팀원으로 매핑된다.
// 동명이인 등으로 자동 인식이 틀릴 때만 MEMBER_MAP 에 ID를 직접 박아 우선 적용.
// ─────────────────────────────────────────────
const NAME_HINTS = { 세희: "sehee", 지숙: "jisuk", 나현: "nahyun", 준우: "junwoo" };
const MEMBER_MAP = {
  "c959bd3f-af09-4d58-9901-f4e2becf27d6": "jisuk", // 김지숙 팀장 (노션 표시명: 홍길동)
};

function resolveMember(person) {
  if (MEMBER_MAP[person.id]) return MEMBER_MAP[person.id]; // 수동 지정 우선
  const name = person.name || "";
  for (const [hint, id] of Object.entries(NAME_HINTS)) {
    if (name.includes(hint)) return id;
  }
  return null;
}

const STATUS_MAP = { 미확인: "unread", 진행: "active", 완료: "done", 제외: "out" };

const text = (prop) =>
  (prop?.rich_text || prop?.title || []).map((x) => x.plain_text).join("");
const dateOf = (prop) => prop?.date?.start || null;
const selectOf = (prop) => prop?.select?.name || null;

const unknownUsers = new Set();

function mapPage(page) {
  const P = page.properties;

  // 담당자: person 배열의 첫 번째만 사용 (설계상 1인 배정)
  let who = null;
  const people = P["담당자"]?.people || [];
  if (people.length) {
    who = resolveMember(people[0]);
    if (!who) unknownUsers.add(`"${people[0].id}": "여기에 sehee/jisuk/nahyun/junwoo 중 하나",  // ${people[0].name || "이름 미확인"}`);
  }

  // 상태: 노션 값 → 대시보드 값. '미확인 + 담당자 있음' 은 파생 상태 '배정됨'
  let st = STATUS_MAP[selectOf(P["확인상태"])] || "unread";
  if (st === "unread" && who) st = "assigned";

  return {
    id: page.id,
    t: text(P["제목"]),
    d: text(P["내용"]).slice(0, 160),
    cat: selectOf(P["분류"]) || "조사",
    th: selectOf(P["테마"]) || "기타",
    acc: text(P["계정"]),
    pub: dateOf(P["게시일"]) || dateOf(P["수집일"]),
    sel: dateOf(P["선택일"]),
    fin: dateOf(P["완료일"]),
    st,
    who,
    url: P["원문"]?.url || "#",
    notionUrl: page.url, // 카드에서 노션으로 바로 이동해 상태를 바꾸는 용도
  };
}

async function main() {
  console.log("▶ Notion 에서 전체 항목 읽는 중...");
  const items = [];
  let cursor = undefined;

  do {
    const res = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) items.push(mapPage(page));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  if (unknownUsers.size) {
    console.warn("\n⚠️ 이름으로 인식하지 못한 담당자가 있습니다.");
    console.warn("   아래 줄을 그대로 복사해 MEMBER_MAP 안에 붙여넣고 팀원 이름만 고르세요:");
    for (const u of unknownUsers) console.warn("   " + u);
    console.warn("   처리 전까지 해당 건은 '미배정'으로 표시됩니다.\n");
  }

  const out = {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };

  const outDir = path.resolve(process.cwd(), "docs");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "data.json"), JSON.stringify(out), "utf8");

  console.log(`✅ docs/data.json 생성 완료 — ${items.length}건`);
}

main().catch((e) => {
  console.error("❌ 내보내기 실패:", e.message);
  process.exit(1);
});
