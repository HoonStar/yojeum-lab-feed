# 리뷰 공방 서버 (Cloudflare Worker)

아내 폰 앱과 아내의 피클(Claude 앱 커넥터)이 들어오는 단 하나의 문입니다. GitHub 토큰은 이 서버 안에만 있고, 사람에게는 **서비스 열쇠**만 나갑니다. 열쇠가 없으면 401.

## 배포 (대시보드만으로, 10분)

1. https://dash.cloudflare.com 가입(무료) → **Workers & Pages → Create → Create Worker** → 이름 `review-lab` → Deploy.
2. 방금 만든 Worker → **Edit code** → 기본 코드를 지우고 이 폴더의 `worker.js` 전체를 붙여 넣기 → **Deploy**.
   - 원본: https://github.com/HoonStar/yojeum-lab-feed/blob/main/review/server/worker.js (Raw 버튼 → 전체 선택 → 복사)
3. Worker → **Settings → Variables and Secrets** 에 추가 (타입은 괄호):
   | 이름 | 값 | 타입 |
   |---|---|---|
   | `GH_TOKEN` | GitHub fine-grained PAT. 대상 저장소 `review-lab-inbox` 하나만, 권한 Contents **Read and write**, Issues **Read and write**, Pull requests **Read and write** | Secret |
   | `KEY_WIFE` | 32자 이상 무작위 문자열(비밀번호 생성기). 아내의 열쇠 | Secret |
   | `KEY_HUSBAND` | 32자 이상 무작위 문자열. 남편의 열쇠 | Secret |
   | `GH_REPO` | `HoonStar/review-lab-inbox` | Text |
   | `GH_BRANCH` | `main` | Text |
   | `APP_URL` | `https://hoonstar.github.io/yojeum-lab-feed/review/` | Text |
   | `APP_NAME` | `리뷰 공방` | Text |
   | `WAKE_PR` | 알림 PR 번호(예: `1`). 아직 없으면 비워 두고 나중에 채움 | Text |
   저장 후 **Deploy**.
4. Worker 주소 확인: `https://review-lab.<계정이름>.workers.dev` (Settings → Domains & Routes).
5. 동작 확인: 브라우저에서 `https://review-lab.<계정>.workers.dev/api/config?k=<KEY_HUSBAND>` → `{"name":"리뷰 공방","account":"husband",...}` 가 보이면 성공. 열쇠 없이 열면 `{"error":"열쇠가 맞지 않아요."}`.

## 아내에게 주는 것 두 가지

- **폰 앱 링크** (카톡으로 보내고 홈 화면에 추가):
  `https://hoonstar.github.io/yojeum-lab-feed/review/#s=https://review-lab.<계정>.workers.dev&k=<KEY_WIFE>`
  (또는 짧게 `https://review-lab.<계정>.workers.dev/app?k=<KEY_WIFE>` — 위 링크로 넘겨 줍니다)
- **피클 커넥터 주소** (Claude 앱 → 설정 → 커넥터 → 사용자 지정 커넥터 추가 → URL):
  `https://review-lab.<계정>.workers.dev/mcp/<KEY_WIFE>`
  인증은 "없음"으로 두면 됩니다. 주소 자체가 열쇠입니다. 추가되면 피클에게 "리뷰 공방에 뭐 남았어?", "에어팟 케이스 접수하고 메모 받아 줘", "완성된 리뷰 보여 줘"처럼 말하면 됩니다.
  - 사용자 지정 커넥터는 Claude 유료 요금제(Pro 이상)에서 쓸 수 있습니다. 무료 요금제면 폰 앱만 사용합니다.

## 열쇠 관리

- 열쇠는 사람마다 하나(`KEY_WIFE`, `KEY_HUSBAND`). 새면 그 값만 바꿔 Deploy하고 새 링크를 보냅니다. GitHub 토큰은 바뀌지 않습니다.
- GitHub 토큰(`GH_TOKEN`)이 만료되면(최대 1년) 새로 만들어 교체합니다.

## 엔드포인트 요약

- `GET /api/config`, `GET /api/items`, `POST /api/items`, `GET|PATCH /api/items/:id`, `POST /api/items/:id/photos?tag=…`, `DELETE /api/items/:id/photos/NN.jpg`, `GET /api/photo?path=…`, `GET /api/reviews/:id`, `GET|PUT /api/rules`, `POST /api/reindex` — 모두 헤더 `X-Key` 또는 `?k=`.
- `POST /mcp/<열쇠>` — MCP(Streamable HTTP, JSON-RPC). 도구: list_items, get_item, create_item, update_notes, photo_link, request_review, get_review, mark_posted, skip_item, get_rules.
- 리뷰 요청(`status: ready`) 시 서버가 저장소의 알림 PR에 `ready <id>` 댓글을 달아 남편 Claude 세션을 깨웁니다.
