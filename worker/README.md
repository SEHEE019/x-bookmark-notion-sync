# 대시보드 → 노션 직접 기록 Worker

대시보드에서 "선택 / 완료 / 룰렛 배정"을 누르면 노션에 바로 기록되게 해주는
Cloudflare Worker (무료 플랜으로 충분).

## 배포 (약 10분, 최초 1회)

```bash
cd worker

# 1) Cloudflare 로그인 (브라우저 창이 열림 — 계정 없으면 무료 가입)
npx wrangler login

# 2) 배포 → 출력되는 https://aitf-bookmark-writer.<계정>.workers.dev 주소를 복사
npx wrangler deploy

# 3) 시크릿 등록 (붙여넣기 프롬프트가 뜸)
npx wrangler secret put NOTION_API_KEY   # main.js 가 쓰는 노션 통합 키와 동일
npx wrangler secret put TEAM_TOKEN       # 아무 긴 문자열 (예: 비밀번호 생성기로)
```

## 대시보드 연결

`docs/index.html` 에서 두 값을 채우고 커밋·푸시:

```js
const WORKER_URL  = 'https://aitf-bookmark-writer.<계정>.workers.dev';
const TEAM_TOKEN  = '위에서 등록한 TEAM_TOKEN 과 동일한 값';
```

## 담당자(룰렛 배정) 기록에 필요한 것

노션 통합 설정(notion.so/my-integrations)에서 **사용자 정보 읽기(User information)**
권한을 켜야 워크스페이스 사용자 이름(세희/지숙/나현/준우)으로 담당자를 자동 인식한다.

자동 인식이 안 되면 수동 매핑을 등록:

```bash
npx wrangler secret put MEMBER_IDS_JSON
# 값 예시: {"sehee":"uuid","jisuk":"uuid","nahyun":"uuid","junwoo":"uuid"}
# uuid 는 export_dashboard.js 실행 시 경고 메시지에 출력되는 값을 쓰면 된다
```

## 참고

- TEAM_TOKEN 은 페이지 소스에 노출되므로 "봇/외부인 차단용 간단한 문"이지
  강한 보안이 아니다. 대시보드 자체가 팀 공개용이므로 이 수준으로 운영.
- Worker 없이 (`WORKER_URL = ''`) 두면 기존처럼 노션 링크로 이동하는 방식으로 동작한다.
