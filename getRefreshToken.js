/**
 * getRefreshToken.js
 * -------------------------------------------------------------
 * X(트위터) OAuth 2.0 PKCE 인증을 로컬에서 한 번 수행해
 * refresh_token을 발급받는 스크립트입니다.
 *
 * 사용법:
 *   1) 아래 CONFIG 값을 본인 값으로 채운다
 *   2) 터미널에서:  node getRefreshToken.js
 *   3) 콘솔에 뜬 인증 URL을 브라우저에서 열고 로그인 + 승인
 *   4) 콘솔에 출력된 refresh_token 을 복사해서 보관
 *
 * 추가 설치 필요 없음 (Node.js 내장 모듈만 사용).
 * Node.js 18 이상 권장 (내장 fetch 사용).
 * -------------------------------------------------------------
 */

const http = require("http");
const crypto = require("crypto");

// ============================================================
//  CONFIG : 여기 3개를 본인 값으로 채우세요
// ============================================================
const CONFIG = {
  // X 개발자 포털 > App > Keys and tokens 에서 확인
  CLIENT_ID: "V0RHeXROcEs0VDdMRUJzTmRTTTQ6MTpjaQ",
  CLIENT_SECRET: "Vs4btxg-rjqx84-0B9DOc2LNLI46aUWUOVWnXQLLKBtTXdsr6U",

  // X App 설정에 등록한 Callback URL 과 글자까지 똑같아야 함
  REDIRECT_URI: "http://localhost:3000/callback",

  // 북마크 읽기 + refresh token 발급에 필요한 스코프
  SCOPES: ["tweet.read", "users.read", "bookmark.read", "offline.access"],
};
// ============================================================

const PORT = 3000;

// --- PKCE 값 생성 ------------------------------------------------
// code_verifier: 무작위 문자열
// code_challenge: code_verifier 를 SHA256 해시 후 base64url 인코딩
function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const codeVerifier = base64url(crypto.randomBytes(32));
const codeChallenge = base64url(
  crypto.createHash("sha256").update(codeVerifier).digest()
);
const state = base64url(crypto.randomBytes(16)); // CSRF 방지용 무작위 값

// --- 인증 URL 만들기 --------------------------------------------
function buildAuthUrl() {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CONFIG.CLIENT_ID,
    redirect_uri: CONFIG.REDIRECT_URI,
    scope: CONFIG.SCOPES.join(" "),
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
}

// --- code 를 토큰으로 교환 --------------------------------------
async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    redirect_uri: CONFIG.REDIRECT_URI,
    code_verifier: codeVerifier,
    client_id: CONFIG.CLIENT_ID,
  });

  // Confidential client(Web App / client secret 있음)는
  // Basic 인증 헤더로 client_id:client_secret 을 보냄
  const basicAuth = Buffer.from(
    `${CONFIG.CLIENT_ID}:${CONFIG.CLIENT_SECRET}`
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
      `토큰 교환 실패 (HTTP ${res.status}): ${JSON.stringify(data, null, 2)}`
    );
  }
  return data;
}

// --- 메인 흐름 --------------------------------------------------
function main() {
  if (CONFIG.CLIENT_ID.startsWith("여기에")) {
    console.error(
      "\n❌ 먼저 스크립트 상단 CONFIG 의 CLIENT_ID / CLIENT_SECRET 을 채우세요.\n"
    );
    process.exit(1);
  }

  const authUrl = buildAuthUrl();

  console.log("\n=============================================");
  console.log(" X OAuth 2.0 인증을 시작합니다.");
  console.log("=============================================\n");
  console.log("1) 아래 URL 을 복사해 브라우저에서 여세요:\n");
  console.log(authUrl + "\n");
  console.log("2) X 로그인 후 'Authorize app' 을 누르면");
  console.log("   자동으로 이 스크립트가 토큰을 받아옵니다.\n");
  console.log(`(로컬 서버가 http://localhost:${PORT} 에서 대기 중...)\n`);

  const server = http.createServer(async (req, res) => {
    // 콜백 경로가 아니면 무시
    if (!req.url.startsWith("/callback")) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h2>인증 거부됨: ${error}</h2>`);
      console.error("\n❌ 사용자가 인증을 거부했거나 오류 발생:", error);
      server.close();
      return;
    }

    if (returnedState !== state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h2>state 불일치 (보안 오류)</h2>");
      console.error("\n❌ state 값이 일치하지 않습니다. 다시 시도하세요.");
      server.close();
      return;
    }

    try {
      const token = await exchangeCodeForToken(code);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h2>인증 성공! 이 창은 닫아도 됩니다.</h2><p>터미널을 확인하세요.</p>"
      );

      console.log("\n=============================================");
      console.log(" ✅ 인증 성공!");
      console.log("=============================================\n");
      console.log("아래 REFRESH TOKEN 을 복사해서 보관하세요.");
      console.log("(GitHub Secret  X_REFRESH_TOKEN  에 넣을 값)\n");
      console.log("-------- REFRESH TOKEN --------");
      console.log(token.refresh_token);
      console.log("-------------------------------\n");
      console.log("(참고) access_token 은 단기용이라 따로 저장 안 해도 됩니다.");
      console.log("(참고) 발급된 scope:", token.scope, "\n");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h2>토큰 교환 실패. 터미널을 확인하세요.</h2>");
      console.error("\n❌", e.message);
    } finally {
      server.close(); // 한 번 받으면 서버 종료
    }
  });

  server.listen(PORT);
}

main();
