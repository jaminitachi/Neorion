# Neorion 벤치마크 v7 (held-out 과제 세트)

`../claude_analysis13.md`의 v7 계획에 따라 Neorion이 한 번도 다루지 않은 저장소에서 새로 만든 과제 14개(구조 12, 대조군 2)입니다. 방법은 v6를 따르고 `score.py`는 v6와 바이트 단위로 같습니다. 실행 방법과 사전 등록 기준은 `RUN_PLAN.md`, 동결 기록은 `FREEZE.md`에 있습니다.

## held-out 조건

* 저장소는 후보 12개를 먼저 적고(`review/repo_candidates.json`, 해시 `review/repo_candidates.sha256`) 시드 `neorion-bench-v7-20261120`의 `sha256(시드|저장소)` 순으로 첫 적격 후보를 골랐습니다(`review/repo_selection.json`). plane(React Router와 Vite), documenso(주 앱이 React Router)는 적격 조건에서 빠졌고 세 번째 rallly가 뽑혔습니다. 이전 벤치마크 저장소 6개는 후보에서 제외했습니다.
* 과제와 정답을 만드는 동안 Neorion MCP 서버 코드, 그 테스트, 설계 문서, rallly에 대한 Neorion 출력을 열거나 실행하지 않았습니다. rallly에 대한 Neorion 그래프나 인덱스는 아직 존재하지 않습니다.
* `tasks.jsonl`, `oracle.jsonl` 해시(`review/tasks_pre_runplan.sha256`, 2026-11-19T19:20:39Z)를 남긴 뒤에야 v6 실행기 설정(`bench-v6/prepare_prompts.py`, `run.py`), Neorion 브랜치 로그, 확장 README의 등록 설명을 `RUN_PLAN.md` 작성용으로 읽었습니다.
* 정답은 Neorion과 독립인 TypeScript 5.6.3 컴파일러 API(`gen/`)로 계산했고 14개 모두 소스에서 손으로 확인했습니다(`oracle.jsonl`의 `manual_verification`).
* 예외: 과제 유형 다섯 가지는 사용자가 지정한 것이고 Neorion 질의 종류와 겹칩니다.

## 대상

| 항목 | 값 |
|:--|:--|
| 저장소 | https://github.com/lukevella/rallly (일정 투표 앱, AGPL-3.0, Next.js 16 App Router) |
| 고정 커밋 | `9ab01952cebd8db5165d0df1acaeeb5ea084b790` (2026-11-19T18:19:45Z) |
| 클론 | `../bench-repos/rallly` (해당 커밋만 `--depth 1`로 fetch) |
| 앱 폴더 | `apps/web` (추적 코드 파일 935개, `src/app/**/page.tsx` 54개, API route 16개, `@/*` 별칭, `[locale]` 세그먼트) |

## 과제 (14개)

| ID | 유형 | 난이도 | 대상 | 정답 수 | 함정 |
|:--|:--|:--|:--|--:|:--|
| v7-rallly-01 | T1 누가 렌더하나 | 쉬움 | `VerifyEmailChangeForm` | 1 | 내보내지 않은 컴포넌트 |
| v7-rallly-02 | T1 | 중간 | `ImageUploadControl` | 3 | 배럴 import, 같은 이름 타입 |
| v7-rallly-03 | T1 | 어려움 | `VoteShortcut` | 6 | 레이아웃으로만 닿는 8단계, prop으로 넘긴 JSX, 두 라우트 트리 |
| v7-rallly-04 | T2 무엇이 감싸나 | 중간 | `/[locale]/quick-create` | 8 | 워크스페이스 패키지 재수출 ThemeProvider, 형제 컴포넌트 |
| v7-rallly-05 | T2 | 어려움 | `/[locale]/members` | 16 | 레이아웃 3개, 형제 다수, 다른 파일의 Context.Provider |
| v7-rallly-06 | T3 이름 바꾸면 | 쉬움(규칙상) | 훅 `usePoll` (poll-context.tsx) | 5 | 같은 이름 다른 훅, grep 오탐 23개 |
| v7-rallly-07 | T3 | 중간 | `getDeviceDateTimeConfig` | 9 | 주석 언급 |
| v7-rallly-08 | T3 | 어려움 | `formatDateTimeRange` | 6 | 별칭 import, 같은 이름 context 멤버, 테스트 파일 포함 |
| v7-rallly-09 | T4 API 소비처 | 중간 | `/api/event/[...route]` | 3 | fetch가 아닌 href, 주석 언급 |
| v7-rallly-10 | T4 | 어려움 | `/api/storage/[...key]` | 9 | absoluteUrl, 이미지 src, server action 호출처 |
| v7-rallly-11 | T7 개념 위치 | 중간 | API 키 해시와 검증 경로 | 4 | 이름 없이 개념만, 다른 randomToken |
| v7-rallly-12 | T7 | 어려움 | 원클릭 구독 해지 토큰 경로 | 9 | 같은 서명 헬퍼를 쓰는 업로드 토큰, 두 단계 떨어진 폼 |
| v7-rallly-13 | T6 대조군 | 대조군 | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` 읽는 파일 | 5 | 환경 변수는 그래프 간선이 아님 |
| v7-rallly-14 | T8 대조군 | 대조군 | 번역 키 `pollClosedDescription` 쓰는 파일 | 4 | 문자열 리터럴은 그래프 간선이 아님 |

T1, T3 문구는 v6와 같고 앱 범위와 `[locale]` 안내만 바꿨습니다. T2는 워크스페이스 패키지와 `X.Provider` 처리 문장을 더했습니다. T4는 rallly UI가 REST 라우트를 링크와 `absoluteUrl()`로 부르므로 "URL 문자열을 담은 파일"로 다시 썼습니다. T7 두 개와 T6, T8 대조군은 v7에서 새로 썼습니다.

## 선택 규칙

`gen/select.cjs`. 구간마다 후보를 `sha256(시드|저장소|유형|구간|대상)` 순으로 정렬해 첫 후보를 씁니다. 모두 순위 0이 뽑혔습니다.

* T1: v6와 같은 구간(쉬움 라우트 1 ~ 2개 최장 3 ~ 4단계, 중간 3 ~ 6개 최장 4 ~ 6단계, 어려움 3개 이상 최장 7단계 이상).
* T2: rallly는 모든 페이지가 8개 이상 파일에 감싸여 v6 구간(4 ~ 6, 11 이상)을 쓸 수 없어 중간 8 ~ 12, 어려움 16 이상으로 옮겼습니다. 분포만 보고 정한 규칙입니다.
* T3: v6 쉬움(훅), 어려움(구조 함정과 grep 함정 둘 다)에 중간(훅 아님, 6 ~ 15개, 함정 하나만)을 더했습니다.
* T4: v6 규칙 그대로. 적격 후보가 구간마다 하나씩뿐이었습니다(대부분 UI 호출이 tRPC와 server action이라 URL 리터럴이 적음).
* T7, T6, T8: 손으로 골랐고 정답은 컴파일러 API(`findReferences`, AST)로 계산했습니다(`gen/handwritten.cjs`).

## 파일

| 파일 | 내용 |
|:--|:--|
| `tasks.jsonl`, `oracle.jsonl` | 과제 14개와 독립 정답, 손 검증 기록, 함정 |
| `score.py` | v6 채점기와 바이트 단위로 같음 |
| `make_oracle.py`, `prepare_prompts.py`, `prompts.jsonl`, `run_order.json` | 정답 기록 생성, 56개 프롬프트(14 × 2 모델 × E0, E2)와 시드 실행 순서 |
| `gen/` | 정답 생성기. v6 복사본에서 대상 상수, tsconfig 처리, `src/app` 인식, 구간, 문구를 바꿈 |
| `review/` | 저장소 후보와 선택, 과제 선택, 계획 작성 전 해시 |
| `RUN_PLAN.md`, `FREEZE.md`, `SHA256SUMS` | 실행 계획과 사전 등록 기준, 동결 기록 |

## 재현

```
cd gen && npm ci && node candidates.cjs rallly && node select.cjs && node handwritten.cjs && node build_tasks.cjs
cd .. && python3 make_oracle.py && python3 prepare_prompts.py && sha256sum -c SHA256SUMS
python3 score.py --self-test
```

## 한계

* 구조 과제 12개, 모델당 쌍 12개뿐이라 검정력이 낮습니다.
* T1, T2는 JSX로 렌더되는 경로만 셉니다. `node_modules`가 없어 `@rallly/ui` 등 워크스페이스 패키지는 외부로 취급합니다.
* T4 후보가 구간마다 하나뿐이라 시드가 실질적으로 고른 것이 없습니다.
* v7-rallly-06은 규칙상 쉬움 구간이지만 grep 함정이 커서 실제로는 쉽지 않을 수 있습니다.
* 대조군 두 개는 grep 한 번이면 풀립니다. 도구와 안내가 비용을 늘리는지 보는 용도입니다.
