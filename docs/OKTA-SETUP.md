# 대시보드 Okta 로그인 설정

신원 선택 화면("누구로 접속하시나요?")을 회사 Okta SSO 로그인으로 교체한다.
로그인하면 계정 이메일/이름으로 팀원이 자동 인식되고, 사칭이 불가능해진다.

## 1. Okta 관리자 콘솔에서 앱 만들기 (최초 1회)

Okta Admin → Applications → **Create App Integration**

| 항목 | 값 |
|---|---|
| Sign-in method | **OIDC — OpenID Connect** |
| Application type | **Single-Page Application (SPA)** |
| Grant type | Authorization Code (+ PKCE 는 SPA 에서 자동) |
| Sign-in redirect URIs | `https://sehee019.github.io/x-bookmark-notion-sync/` |
| Sign-out redirect URIs | (동일 주소, 선택) |
| Assignments | AITF 팀원 4명 (또는 해당 그룹) |

추가로 **Security → API → Trusted Origins** 에
`https://sehee019.github.io` 를 **CORS + Redirect** 로 등록해야 한다
(토큰 교환이 브라우저에서 일어나므로 필수).

## 2. 값 두 개를 index.html 에 넣기

앱 만들면 나오는 값:

- **Client ID** — 앱 General 탭
- **Issuer** — Security → API → Authorization Servers 의 default 서버 Issuer URI
  (보통 `https://회사도메인.okta.com/oauth2/default`)

`docs/index.html` 의 설정 두 줄을 채우고 커밋·푸시:

```js
const OKTA_ISSUER    = 'https://회사도메인.okta.com/oauth2/default';
const OKTA_CLIENT_ID = '0oa………';
```

## 3. 팀원 매칭

로그인한 Okta 계정은 아래 순서로 팀원과 매칭된다:

1. `MEMBERS` 배열의 `email` 과 계정 이메일이 일치
2. (이메일 미등록 시) Okta 프로필 이름에 세희/지숙/나현/준우 포함 여부

정확한 매칭을 위해 `MEMBERS` 의 `email` 필드에 팀원 회사 이메일을
채워두는 것을 권장한다. 목록에 없는 계정은 입장이 거부된다.

## 알아둘 것

- Client ID 와 Issuer 는 비밀이 아니다(SPA 공개 설계값) — 페이지에 넣어도 안전.
- 이 로그인은 **신원 확인**(사칭 방지·자동 인식)용이다. 페이지와 data.json 자체는
  여전히 공개 URL 이므로, 외부 접근 완전 차단이 필요해지면 Cloudflare Access 등을
  앞단에 붙이는 다음 단계가 필요하다.
- `OKTA_ISSUER`/`OKTA_CLIENT_ID` 를 비워두면 기존 신원 선택 화면으로 동작한다.
