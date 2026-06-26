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
//  5) Notion 에 새 row 추가
// ============================================================
async function addToNotion(bookmark) {
  const today = new Date().toISOString().split("T")[0];
  const tweetUrl = `https://twitter.com/${
    bookmark.username || "i"
  }/status/${bookmark.postId}`;

  const titleText =
    (bookmark.text || "").slice(0, 80) || `(제목 없음) ${bookmark.postId}`;

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
      확인상태: { select: { name: "미확인" } },
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
