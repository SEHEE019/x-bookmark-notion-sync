/**
 * main.js
 * -------------------------------------------------------------
 * 매일 실행되어 X(트위터) 북마크를 읽어와
 * Notion 데이터베이스에 중복 없이 추가하는 스크립트입니다.
 *
 * ★ refresh_token 자동 갱신 포함 ★
 *   - GitHub Actions 환경: 새 refresh_token 을 GitHub Secret 에 자동 저장
 *   - 로컬 환경: 새 refresh_token 을 .env 파일에 자동 저장
 *
 * 흐름:
 *   1) X_REFRESH_TOKEN 으로 새 access_token 발급 (+ 새 refresh_token)
 *   2) 새 refresh_token 을 저장 (GitHub Secret 또는 .env)
 *   3) 내 북마크 목록 조회 (페이지네이션 포함)
 *   4) 각 북마크의 postId 가 Notion DB 에 이미 있는지 확인
 *   5) 없는 것만 새 row 로 추가 (수집일=오늘, 게시일=작성일)
 *
 * 필요 환경변수:
 *   X_CLIENT_ID, X_CLIENT_SECRET, X_REFRESH_TOKEN, X_USER_ID
 *   NOTION_API_KEY, NOTION_DATABASE_ID
 *   ANTHROPIC_API_KEY   (제목/분류 자동 생성용)
 *
 * GitHub Actions 에서 토큰 자동저장에 추가로 필요:
 *   GH_PAT            (repo secrets 쓰기 권한 있는 Personal Access Token)
 *   GITHUB_REPOSITORY (owner/repo 형식, Actions 가 자동 주입)
 *
 * 설치: npm install @notionhq/client@2.2.15 dotenv libsodium-wrappers
 * 실행: node main.js
 * Node.js 18+ 권장 (내장 fetch 사용)
 * -------------------------------------------------------------
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("@notionhq/client");

const {
  X_CLIENT_ID,
  X_CLIENT_SECRET,
  X_REFRESH_TOKEN,
  X_USER_ID,
  NOTION_API_KEY,
  NOTION_DATABASE_ID,
  // Claude 제목 생성용
  ANTHROPIC_API_KEY,
  // GitHub Actions 자동저장용
  GH_PAT,
  GITHUB_REPOSITORY,
  GITHUB_ACTIONS, // Actions 환경이면 "true" 로 자동 설정됨
} = process.env;

function assertEnv() {
  const required = {
    X_CLIENT_ID,
    X_CLIENT_SECRET,
    X_REFRESH_TOKEN,
    X_USER_ID,
    NOTION_API_KEY,
    NOTION_DATABASE_ID,
    ANTHROPIC_API_KEY,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error("❌ 다음 환경변수가 없습니다:", missing.join(", "));
    process.exit(1);
  }
}

const notion = new Client({ auth: NOTION_API_KEY });
const isGitHubActions = GITHUB_ACTIONS === "true";

// ============================================================
//  1) refresh_token 으로 새 access_token 발급
// ============================================================
async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: X_REFRESH_TOKEN,
    client_id: X_CLIENT_ID,
  });

  const basicAuth = Buffer.from(
    `${X_CLIENT_ID}:${X_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `access_token 발급 실패 (HTTP ${res.status}): ${JSON.stringify(data)}`
    );
  }

  return {
    accessToken: data.access_token,
    newRefreshToken: data.refresh_token,
  };
}

// ============================================================
//  2) 새 refresh_token 저장
// ============================================================
async function saveRefreshToken(newToken) {
  if (!newToken || newToken === X_REFRESH_TOKEN) {
    return; // 바뀐 게 없으면 아무것도 안 함
  }

  if (isGitHubActions) {
    await updateGitHubSecret("X_REFRESH_TOKEN", newToken);
  } else {
    updateEnvFile("X_REFRESH_TOKEN", newToken);
  }
}

// --- 로컬: .env 파일의 X_REFRESH_TOKEN 줄을 교체 ---------------
function updateEnvFile(key, value) {
  const envPath = path.resolve(process.cwd(), ".env");
  try {
    let content = fs.readFileSync(envPath, "utf8");
    const line = `${key}=${value}`;
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content += `\n${line}\n`;
    }
    fs.writeFileSync(envPath, content, "utf8");
    console.log(`✅ .env 의 ${key} 를 새 값으로 갱신했습니다.`);
  } catch (e) {
    console.error(`⚠️ .env 갱신 실패: ${e.message}`);
    console.error(`   수동으로 ${key} 를 아래 값으로 바꾸세요:\n   ${value}`);
  }
}

// --- GitHub Actions: GitHub Secret 을 API 로 업데이트 ----------
async function updateGitHubSecret(secretName, secretValue) {
  if (!GH_PAT || !GITHUB_REPOSITORY) {
    console.error(
      "⚠️ GH_PAT 또는 GITHUB_REPOSITORY 가 없어 Secret 자동갱신을 건너뜁니다."
    );
    console.error("   이대로면 다음 실행이 실패할 수 있습니다!");
    return;
  }

  const sodium = require("libsodium-wrappers");
  await sodium.ready;

  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/actions/secrets`;
  const headers = {
    Authorization: `Bearer ${GH_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "x-bookmark-notion-sync",
  };

  // (a) repo 의 public key 가져오기 (Secret 암호화에 필요)
  const keyRes = await fetch(`${apiBase}/public-key`, { headers });
  if (!keyRes.ok) {
    const t = await keyRes.text();
    throw new Error(`GitHub public key 조회 실패 (${keyRes.status}): ${t}`);
  }
  const { key, key_id } = await keyRes.json();

  // (b) secret 값을 public key 로 암호화
  const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const binSecret = sodium.from_string(secretValue);
  const encrypted = sodium.crypto_box_seal(binSecret, binKey);
  const encryptedValue = sodium.to_base64(
    encrypted,
    sodium.base64_variants.ORIGINAL
  );

  // (c) Secret 업데이트(PUT)
  const putRes = await fetch(`${apiBase}/${secretName}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      encrypted_value: encryptedValue,
      key_id: key_id,
    }),
  });

  if (!putRes.ok) {
    const t = await putRes.text();
    throw new Error(`GitHub Secret 갱신 실패 (${putRes.status}): ${t}`);
  }
  console.log(`✅ GitHub Secret ${secretName} 를 새 값으로 갱신했습니다.`);
}

// ============================================================
//  3) 내 북마크 목록 조회 (페이지네이션)
// ============================================================
async function fetchAllBookmarks(accessToken) {
  const bookmarks = [];
  const usersById = {};
  let paginationToken = undefined;

  do {
    const params = new URLSearchParams({
      max_results: "100",
      "tweet.fields": "created_at,author_id,text",
      expansions: "author_id",
      "user.fields": "username",
    });
    if (paginationToken) params.set("pagination_token", paginationToken);

    const url = `https://api.twitter.com/2/users/${X_USER_ID}/bookmarks?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(
        `북마크 조회 실패 (HTTP ${res.status}): ${JSON.stringify(data)}`
      );
    }

    if (data.includes && data.includes.users) {
      for (const u of data.includes.users) {
        usersById[u.id] = u.username;
      }
    }

    if (data.data) {
      for (const t of data.data) {
        bookmarks.push({
          postId: t.id,
          text: t.text || "",
          createdAt: t.created_at || null,
          username: usersById[t.author_id] || "",
        });
      }
    }

    paginationToken = data.meta && data.meta.next_token;
  } while (paginationToken);

  return bookmarks;
}

// ============================================================
//  4) Notion 에 해당 postId 가 이미 있는지 확인
// ============================================================
async function existsInNotion(postId) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      property: "postId",
      rich_text: { equals: postId },
    },
    page_size: 1,
  });
  return res.results.length > 0;
}

// ============================================================
//  4-b) Claude 로 제목 + 콘텐츠태그 + 처리분류 생성
// ============================================================

// 콘텐츠 태그 (제목 [ ] 안에 들어가는 것)
const VALID_TAGS = [
  "모델", "제품", "기능", "도구", "오픈소스", "에이전트", "벤치마크",
  "논문", "가이드", "프롬프트", "강의", "투자", "업계", "관점",
  "윤리", "사례", "자료",
];

// 처리분류 (Notion '분류' Select 값과 일치해야 함)
const VALID_ACTIONS = [
  "테스트(개발자)", "테스트(비개발자)", "조사", "코멘트",
];

const TITLE_PROMPT = `너는 우리 회사 AI TF의 북마크 정리 담당이다.
우리 팀 목적: 전체 AI 동향·시장 흐름을 파악하고, 그중 "우리가 직접 개발해서 업무에 쓸 수 있는 것"을 골라 테스트한다.
아래 X(트위터) 원문을 읽고 JSON 하나만 출력하라.

[출력: 반드시 아래 JSON 형식만. 다른 텍스트·설명·마크다운 금지]
{"title":"[콘텐츠태그] 핵심요약","action":"처리분류","warn":true|false}

[title 규칙]
- 형식: "[콘텐츠태그] 핵심"  (예: "[모델] Claude Fable 5 공개 (추론 85%↑)")
- 핵심은 한국어, 40자 이내, 명사구 중심. 서술형 문장 금지.
- 제품/모델/도구명은 원문 표기 그대로. 그 외는 한국어.
- 부가정보는 괄호로 압축. 이모지/해시태그/URL 제거(수치강조 ⭐ 정도만 예외).

[콘텐츠태그 — 위에서부터 우선순위, 첫 매칭]
모델 / 제품 / 기능 / 도구 / 오픈소스 / 에이전트 / 벤치마크 / 논문 /
가이드 / 프롬프트 / 강의 / 투자 / 업계 / 관점 / 윤리 / 사례 / 자료
- 출시인데 모델/제품 애매 → 아키텍처·가중치 중심이면 모델, 쓰는 앱 중심이면 제품.
- 오픈소스 도구는 오픈소스 우선, 오픈 여부 불명이면 도구.
- 개인 발언·전망은 관점, 실제로 만든 것·써본 것은 사례.

[action 처리분류 — 아래 순서대로 판정, 첫 매칭 채택]
1) 디자인·영상·이미지·3D·CAD·모델링 등 시각/모델링 계열이면 → "조사"
   (우리 회사엔 직접 필요 없으므로 테스트 안 함. 시각 도구인데 API로 개발에 붙일 수 있어 애매하면 "조사"로 두어라 — 사람이 나중에 수정.)
2) 우리가 직접 개발/적용해 업무에 쓸 수 있을 법한 것이면 → "테스트"
   - 코딩·개발 환경이 필요한 라이브러리·API·CLI·SDK·MCP·코드 → "테스트(개발자)"
   - 코딩 없이 바로 써볼 수 있는 앱·서비스·프롬프트·자동화 도구 → "테스트(비개발자)"
3) 시장 흐름·업계 동향·기업 전략·투자·모델 릴리즈 등 "흐름 파악"용이면 → "조사"
4) 위 어디에도 안 맞고 읽고 의견만 남기면 되는 개인 관점·에세이·전망 → "코멘트"
- 애매하면 "조사"로 두어라(사람이 수정하기 쉽게).

[warn 렉카 판정 — 톤 아님, 아래 행동 신호만 true]
1) 저장·클릭 유도가 본체("북마크해라","안 보면 손해","$숫자 강의보다")
2) 유료·셀스 유도(결제/DM 리드 파밍/"팔로우하면 무료로")
위 중 하나라도 명확하면 true. 애매하면 false.

원문:
`;

async function generateTitle(text) {
  const content = (text || "").trim();
  // 본문이 거의 없으면 API 호출 없이 폴백
  if (content.length < 3) {
    return { title: "[자료] (내용 없음)", tag: "자료", action: "조사", warn: false };
  }

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
        max_tokens: 200,
        messages: [{ role: "user", content: TITLE_PROMPT + content }],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Claude API ${res.status}: ${JSON.stringify(data)}`);
    }

    // 응답 텍스트 추출
    let raw = "";
    if (Array.isArray(data.content)) {
      raw = data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    }

    return parseResult(raw, content);
  } catch (e) {
    console.error(`  ! 제목 생성 실패, 폴백 사용:`, e.message);
    return {
      title: `[자료] ${content.slice(0, 40)}`,
      tag: "자료",
      action: "조사",
      warn: false,
    };
  }
}

// Claude JSON 응답을 파싱해서 title / tag / action / warn 으로 분해
function parseResult(raw, fallbackText) {
  let title, action, warn;

  try {
    // 혹시 ```json 펜스가 붙어 오면 제거
    const cleaned = raw.replace(/```json|```/g, "").trim();
    // 첫 { 부터 마지막 } 까지만 추출 (앞뒤 잡텍스트 방어)
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const jsonStr =
      start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
    const obj = JSON.parse(jsonStr);
    title = (obj.title || "").toString().replace(/\n/g, " ").trim();
    action = (obj.action || "").toString().trim();
    warn = obj.warn === true;
  } catch (e) {
    // JSON 파싱 실패 시 폴백
    return {
      title: `[자료] ${(fallbackText || "").slice(0, 40)}`,
      tag: "자료",
      action: "조사",
      warn: false,
    };
  }

  // 콘텐츠 태그 추출 ([ ] 안)
  const m = title.match(/\[([^\]]+)\]/);
  let tag = m ? m[1].trim() : null;
  if (!tag || !VALID_TAGS.includes(tag)) {
    tag = "자료";
  }

  // 처리분류 보정: 허용 목록에 없으면 '조사'
  if (!VALID_ACTIONS.includes(action)) {
    action = "조사";
  }

  // 제목 안전장치
  if (!title || title.length < 2) {
    title = `[${tag}] ${(fallbackText || "").slice(0, 40)}`;
  }
  // warn 이면 제목 맨 앞에 ⚠️
  if (warn && !title.startsWith("⚠️")) {
    title = `⚠️ ${title}`;
  }

  return { title, tag, action, warn };
}

// ============================================================
//  5) Notion 에 새 row 추가
// ============================================================
async function addToNotion(bookmark) {
  const today = new Date().toISOString().split("T")[0];
  const tweetUrl = `https://twitter.com/${
    bookmark.username || "i"
  }/status/${bookmark.postId}`;

  // Claude 로 제목 + 콘텐츠태그 + 처리분류 생성
  // tag(모델/제품 등)는 제목 [ ] 안에만 쓰이고, 분류 컬럼엔 action 을 넣는다.
  const { title: titleText, action } = await generateTitle(bookmark.text);

  await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      제목: { title: [{ text: { content: titleText } }] },
      수집일: { date: { start: today } },
      게시일: bookmark.createdAt
        ? { date: { start: bookmark.createdAt } }
        : { date: null },
      계정: { rich_text: [{ text: { content: bookmark.username } }] },
      원문: { url: tweetUrl },
      postId: { rich_text: [{ text: { content: bookmark.postId } }] },
      내용: {
        rich_text: [{ text: { content: (bookmark.text || "").slice(0, 1900) } }],
      },
      분류: { select: { name: action } },
      확인상태: { select: { name: "미확인" } },
      // 담당자(Person) 는 자동추가 시 비워둠 → 코드에서 건드리지 않음
    },
  });
}

// ============================================================
//  메인
// ============================================================
async function main() {
  assertEnv();

  console.log("▶ access_token 발급 중...");
  const { accessToken, newRefreshToken } = await getAccessToken();

  // 토큰을 받자마자 새 refresh_token 부터 저장 (이후 단계에서 실패해도 토큰은 보존)
  console.log("▶ refresh_token 저장 확인 중...");
  await saveRefreshToken(newRefreshToken);

  console.log("▶ 북마크 조회 중...");
  const bookmarks = await fetchAllBookmarks(accessToken);
  console.log(`  - 가져온 북마크: ${bookmarks.length}건`);

  let added = 0;
  let skipped = 0;

  for (const b of bookmarks) {
    const exists = await existsInNotion(b.postId);
    if (exists) {
      skipped++;
      continue;
    }
    try {
      await addToNotion(b);
      added++;
      console.log(`  + 추가: ${b.postId} (${b.username})`);
    } catch (e) {
      console.error(`  ! 추가 실패 ${b.postId}:`, e.message);
    }
  }

  console.log("\n=============================================");
  console.log(` 완료: 신규 ${added}건 추가, ${skipped}건 중복 건너뜀`);
  console.log("=============================================");
}

main().catch((e) => {
  console.error("\n❌ 실행 중 오류:", e.message);
  process.exit(1);
});
