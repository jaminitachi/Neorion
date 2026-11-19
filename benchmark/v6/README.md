# Neorion 벤치마크 v6 (held-out 과제 세트)

v5의 10개 과제는 MCP 도구 설계에 쓰인 개발용 과제였습니다(`../claude_audit11.md`). v6는 Neorion이 한 번도 다루지 않은 저장소에서 새로 만든 held-out 과제 11개입니다. 실행 방법과 사전 등록 기준은 `RUN_PLAN.md`, 동결 기록은 `FREEZE.md`에 있습니다.

## held-out 조건

* 대상 저장소 dub는 이전 벤치마크(ai-chatbot, papermark, formbricks, taxonomy, commerce)에 쓰지 않았습니다.
* 과제와 정답을 만드는 동안 Neorion MCP 서버 코드, 그 테스트, `mcp_design.md`, dub에 대한 Neorion 출력을 열거나 실행하지 않았습니다. dub에 대한 Neorion 그래프나 인덱스는 아직 존재하지 않습니다.
* 과제 문구를 정하고 `tasks.jsonl` 해시(`review/tasks_pre_runplan.sha256`, 2026-11-19T08:54:29Z)를 남긴 뒤에야 v5 E2 설정(`bench-v5/e2_prompts.jsonl`의 힌트, `frozen/CLAUDE.md`, `prepare.cjs`, `freeze.py`)을 `RUN_PLAN.md` 작성용으로 읽었습니다.
* 정답은 Neorion과 독립인 TypeScript 5.6.3 컴파일러 API(`gen/`)로 계산했고, 11개 모두 소스에서 손으로 확인했습니다(`oracle.jsonl`의 `manual_verification`).
* 예외: 과제 유형 다섯 가지(전이 렌더, 감싸기 체인, 이름 변경, API 소비처, 개념 위치)는 사용자가 지정한 것이고 v5 도구 이름과도 겹칩니다. 개념 위치(T7)와 환경 변수 대조군(T6)은 v5에 없던 유형입니다.

## 대상

| 항목 | 값 |
|:--|:--|
| 저장소 | https://github.com/dubinc/dub (링크 관리 SaaS, Next.js App Router) |
| 고정 커밋 | `6b463b4bdd9ed2fd9aa416f67b5b77d317b1471e` (2026-10-26T09:39:24-07:00) |
| 클론 | `../bench-repos/dub` (`--depth 1`) |
| 앱 폴더 | `apps/web` (추적 코드 파일 1,549개, page.tsx 77개, route.ts 204개, `@/lib/*`, `@/ui/*` 별칭) |

## 과제 (11개)

| ID | 유형 | 난이도 | 대상 | 정답 수 | 함정 |
|:--|:--|:--|:--|--:|:--|
| v6-dub-01 | T1 누가 렌더하나 | 쉬움 | `CountryCombobox` | 1 | 레이아웃을 거쳐서만 닿는 라우트, 모달 두 단계 |
| v6-dub-02 | T1 | 중간 | `LineItem` (`ui/analytics/bar-list.tsx`) | 3 | 흔한 이름, placeholders의 다른 `Analytics` |
| v6-dub-03 | T1 | 어려움 | `UserAvatarWithTooltip` | 3 | 9단계 체인, catch-all 라우트, 같은 이름 지역 `LinkCard` |
| v6-dub-04 | T2 무엇이 감싸나 | 중간 | `/app.dub.co/workspaces` | 4 | 옆에 렌더되는 `SignedInHint`, `Toolbar` |
| v6-dub-05 | T2 | 어려움 | `/app.dub.co/[slug]/settings/webhooks/new` | 11 | 레이아웃 5개, 형제 컴포넌트 다수, 적용 안 되는 `[webhookId]` 레이아웃 |
| v6-dub-06 | T3 이름 바꾸면 | 쉬움 | 훅 `useOnboardingProgress` | 9 | 없음(grep 한 번) |
| v6-dub-07 | T3 | 어려움 | `createLink` (`lib/api/links/create-link.ts`) | 8 | `export *` 배럴, 같은 이름 OpenAPI 객체 |
| v6-dub-08 | T4 API 소비처 | 중간 | `/api/workspaces/[idOrSlug]/billing/usage` | 3 | SWR 훅 뒤의 컴포넌트 |
| v6-dub-09 | T4 | 어려움 | `/api/webhooks/[webhookId]/folders` | 8 | 요청 함수 3개, `lib/` 아래 통합 설정 UI, 접두사 같은 `/api/folders` |
| v6-dub-10 | T7 개념 위치 | 중간 | 나가는 웹훅 서명 경로 | 5 | 파일, 기호 이름 없이 개념만 줌, 다른 HMAC 코드 |
| v6-dub-11 | T6 대조군 | 대조군 | `VERCEL_API_KEY` 읽는 파일 | 7 | 환경 변수 읽기는 그래프 간선이 아님 |

T1 ~ T4 문구는 v4와 같고 앱 범위만 dub로 바꿨습니다. T1 라우트 형식에 `app.dub.co` 같은 폴더 이름을 그대로 쓰라는 문장 하나를 더했습니다. T7과 T6 문구는 v6에서 새로 썼습니다.

## 파일

| 파일 | 내용 |
|:--|:--|
| `tasks.jsonl` | 과제 11개(질문, 정답, 근거). 형식은 v4, v5와 같고 `difficulty` 필드만 더함 |
| `oracle.jsonl` | 독립 정답, 손 검증 기록, 함정 |
| `score.py` | v4, v5 채점기와 바이트 단위로 같음 |
| `prepare_prompts.py`, `prompts.jsonl`, `run_order.json` | 66개 프롬프트(11 × 2 모델 × E0, E2, E3)와 시드 실행 순서 |
| `make_oracle.py` | `oracle.jsonl` 생성 |
| `gen/` | 정답 생성기. `lib.cjs`, `candidates.cjs`는 v4 복사본(대상 상수만 바꿈), `select.cjs`는 난이도 구간 선택, `handwritten.cjs`는 T7, T6 정답, `build_tasks.cjs`는 과제 생성 |
| `review/selection.json` | 시드 선택 기록(구간, 후보 수, 순위) |
| `RUN_PLAN.md` | 실행 방법, 변형 정의, 사전 등록 기준 |
| `FREEZE.md`, `SHA256SUMS` | 동결 기록 |

## 재현

```
cd gen && npm ci && node candidates.cjs dub && node select.cjs && node handwritten.cjs && node build_tasks.cjs
cd .. && python3 make_oracle.py && python3 prepare_prompts.py && sha256sum -c SHA256SUMS
python3 score.py --self-test
```

## 선택 규칙

시드 `neorion-bench-v6-20261119`. 구간마다 후보를 `sha256(시드|저장소|유형|구간|대상)` 순으로 정렬해 첫 후보를 씁니다(`gen/select.cjs`).

* T1: 쉬움은 라우트 1 ~ 2개, 최장 3 ~ 4단계. 중간은 라우트 3 ~ 6개, 최장 4 ~ 6단계. 어려움은 라우트 3개 이상, 최장 7단계 이상. 모두 값 참조로만 닿는 라우트가 없어야 함.
* T2: 중간은 4 ~ 6개 파일, 어려움은 11개 이상. 모호 표시 없음.
* T3: 쉬움은 훅, 5 ~ 12개 파일. 계산된 훅 후보 중 별칭, 배럴, grep 함정이 있는 것은 없었습니다. 어려움은 훅이 아니고 배럴이나 별칭과 grep 함정이 함께 있는 것.
* T4: v4 필터에 더해 cron, auth 라우트 제외, 정답이 API 코드 밖이고 `.tsx` 2개 이상(UI 소비처 질문이므로). 중간 3 ~ 4개, 어려움 5 ~ 12개. 처음 고른 어려움 후보 `/api/google-ads/upload-conversion`은 서버 코드만 소비처라 이 조건을 넣고 다시 골랐습니다. 정답 내용이 아니라 소비처가 UI인지라는 성질로 정한 규칙입니다.
* T7, T6: 손으로 골랐고 정답은 컴파일러 API(`findReferences`, AST)로 계산했습니다.

## 한계

* 과제 11개, 모델당 구조 과제 쌍 10개뿐이라 검정력이 낮습니다.
* T1, T2는 JSX로 렌더되는 경로만 셉니다. 값으로 넘기는 컴포넌트는 정답에 없습니다.
* `node_modules`가 없어 `@dub/ui` 같은 워크스페이스 패키지는 외부로 취급합니다. 앱 내부 기호 해석에는 영향이 없습니다.
* T6 대조군은 grep 한 번이면 풀립니다. 그래프가 도움이 안 되는 질문에서 도구와 안내가 비용을 늘리는지 보는 용도입니다.
