/**
 * worker.js — 대시보드 → 노션 기록용 Cloudflare Worker
 * -------------------------------------------------------------
 * 정적 대시보드(GitHub Pages)에는 노션 API 키를 둘 수 없으므로,
 * 이 Worker 가 키를 보관하고 페이지의 요청을 노션에 중계한다.
 *
 * 요청: POST { token, pageId, action, who? }
 *   - action "pick"   : 확인상태=진행, 선택일=오늘
 *   - action "finish" : 확인상태=완료, 완료일=오늘
 *   - action "assign" : 담당자=who (sehee/jisuk/nahyun/junwoo)
 *
 * 필요 Secrets (wrangler secret put 으로 등록):
 *   NOTION_API_KEY  — main.js 와 동일한 노션 통합 키
 *   TEAM_TOKEN      — 페이지의 TEAM_TOKEN 과 동일한 임의 문자열
 *
 * 선택 환경변수:
 *   MEMBER_IDS_JSON — {"sehee":"노션유저UUID", ...} 수동 매핑 (미설정 시
 *                     노션 워크스페이스 사용자 이름에서 세희/지숙/나현/준우 자동 인식)
 *
 * 주의: 담당자 자동 인식을 쓰려면 노션 통합 설정에서
 *       "사용자 정보 읽기(User information)" 권한이 켜져 있어야 한다.
 * -------------------------------------------------------------
 */

const NAME_HINTS = { sehee: "세희", jisuk: "지숙", nahyun: "나현", junwoo: "준우" };
const NOTION_VERSION = "2022-06-28";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

async function notionFetch(env, path, init = {}) {
  return fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

/** 팀원 id(sehee 등) → 노션 사용자 UUID */
async function resolveNotionUser(env, who) {
  if (!who || !NAME_HINTS[who]) return null;

  // 1) 수동 매핑 우선
  if (env.MEMBER_IDS_JSON) {
    try {
      const map = JSON.parse(env.MEMBER_IDS_JSON);
      if (map[who]) return map[who];
    } catch (e) { /* 무시하고 자동 인식으로 */ }
  }

  // 2) 워크스페이스 사용자 목록에서 이름으로 자동 인식
  const hint = NAME_HINTS[who];
  let cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const r = await notionFetch(env, `/users${q}`);
    if (!r.ok) return null;
    const d = await r.json();
    const found = (d.results || []).find(
      (u) => u.type === "person" && (u.name || "").includes(hint)
    );
    if (found) return found.id;
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "잘못된 JSON" }, 400);
    }

    const { token, pageId, action, who } = body || {};
    if (!token || token !== env.TEAM_TOKEN) return json({ error: "unauthorized" }, 401);
    if (!pageId || !/^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i.test(pageId))
      return json({ error: "잘못된 pageId" }, 400);

    const today = new Date().toISOString().slice(0, 10);
    let properties;

    if (action === "pick") {
      properties = {
        확인상태: { select: { name: "진행" } },
        선택일: { date: { start: today } },
      };
    } else if (action === "finish") {
      properties = {
        확인상태: { select: { name: "완료" } },
        완료일: { date: { start: today } },
      };
    } else if (action === "assign") {
      const userId = await resolveNotionUser(env, who);
      if (!userId)
        return json({ error: `담당자 인식 실패: ${who} — MEMBER_IDS_JSON 설정 또는 통합의 사용자 정보 권한을 확인하세요` }, 400);
      properties = { 담당자: { people: [{ id: userId }] } };
    } else {
      return json({ error: "지원하지 않는 action" }, 400);
    }

    const r = await notionFetch(env, `/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      return json({ error: `notion ${r.status}: ${d.message || ""}` }, 502);
    }
    return json({ ok: true, action });
  },
};
