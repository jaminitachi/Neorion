# 실행 계획 v7 (held-out, E0, E2 × sonnet, haiku)

이 문서는 실행 방법과 사전 등록 성공 기준만 정합니다. 이 문서를 쓴 시점까지 어떤 모델도 실행하지 않았고, rallly에 대한 Neorion 출력(그래프, 인덱스, MCP 응답)도 만든 적이나 본 적이 없습니다. 과제와 정답은 `FREEZE.md`의 해시로 동결되어 있습니다.

## 1. 왜 v7인가

`../claude_analysis13.md`의 제안 1 ~ 4(고정 비용 축소, 그래프와 인덱스를 작업 트리 밖으로, rename과 api 정확성, 완전성 표시)가 Neorion `fix/graph-quality-and-packaging`에 들어갔습니다. 그 효과를 dub 과제(개발 과정에서 본 과제)가 아니라 처음 쓰는 저장소의 새 과제로 확인합니다. v6와 달리 실행기가 시스템 힌트를 넣지 않습니다. 모델이 받는 Neorion 안내는 제품 자체가 설치하는 것(Connect가 쓴 CLAUDE.md 블록, MCP 도구 설명)뿐입니다.

## 2. 실행 행렬

| 축 | 값 |
|:--|:--|
| 과제 | `tasks.jsonl` 14개 (v7-rallly-01 ~ 12 구조 과제, v7-rallly-13, 14 대조군) |
| 모델 | `--model sonnet`, `--model haiku` |
| 변형 | E0, E2 |
| 반복 | 과제, 모델, 변형마다 1회 |
| 실행 수 | 14 × 2 × 2 = 56 |

`prompts.jsonl`(56행)과 `run_order.json`은 `python3 prepare_prompts.py`가 시드 `neorion-bench-v7-20261120`로 만듭니다. 같은 (모델, 과제)의 두 변형은 연달아 실행하고 순서는 시드로 정합니다. E0도 이번 배치에서 새로 실행합니다.

## 3. 고정 입력

| 항목 | 값 |
|:--|:--|
| 대상 저장소 | `../bench-repos/rallly` (https://github.com/lukevella/rallly, `--depth 1`) |
| 대상 커밋 | `9ab01952cebd8db5165d0df1acaeeb5ea084b790` (2026-11-19T18:19:45Z) |
| 앱 폴더 | `apps/web` (실행 사본의 루트) |
| Neorion | `../Neorion`, 브랜치 `fix/graph-quality-and-packaging`, 고정 커밋 `5d5cb82291d10d02ca6a07557d6e5c10e44d2090` (2026-11-20T03:56:49+09:00, 이 계획 작성 시점의 HEAD), 작업 트리 깨끗함 |
| Claude Code | `2.1.327` (v5, v6와 같음) |
| 인증 | Claude.ai 구독 로그인만. `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_*` 환경 변수를 지우고 실행(v6 `run.py`와 같음). API 키와 유료 API 금지 |

브랜치 HEAD가 실행 시점에 바뀌었으면 위 커밋을 체크아웃해서 씁니다. Neorion 코드는 고치지 않습니다. CLI 버전이 2.1.327이 아니면 56회 모두를 같은 다른 버전으로 실행하고 결과에 적습니다.

## 4. 변형

두 변형 모두 `git -C ../bench-repos/rallly archive 9ab01952cebd8db5165d0df1acaeeb5ea084b790:apps/web | tar -x`로 앱 폴더의 추적 파일만 풉니다. rallly `apps/web`에는 원래 `CLAUDE.md`(`@AGENTS.md` 한 줄)와 `AGENTS.md`가 있고, 두 변형 모두 그대로 둡니다.

| 변형 | 사본 위치 | 사본에 더하는 것 | 시스템 프롬프트 | MCP |
|:--|:--|:--|:--|:--|
| **E0** | `/tmp/neorion-bench-v7/E0/app` | 없음 | `SYSTEM_BASE` (v4, v6와 같음) | 없음 |
| **E2** | `/tmp/neorion-bench-v7/E2/app` | 고정 커밋의 실제 Connect 경로가 쓴 것만: CLAUDE.md의 neorion 블록, Claude Code용 프로젝트 MCP 등록 파일. 그래프와 인덱스, 번들은 제품 기본값대로 작업 트리 밖 로컬 사용자 캐시 | `SYSTEM_BASE` (E0와 바이트 단위로 같음, 실행기 힌트 없음) | neorion stdio 서버 |

제품 캐시가 프로젝트 경로로 찾아지므로 E2는 준비한 경로 하나에서 모든 E2 실행을 합니다. 모델 도구가 Read, Grep, Glob뿐이라 사본은 바뀌지 않습니다. 대신 준비 직후, 첫 E2 실행 전, 마지막 E2 실행 뒤에 사본 전체의 파일 목록과 해시(`tree.sha256`)를 기록해 같은지 확인합니다. E0도 같은 방식으로 한 경로를 씁니다.

### CLI 명령 (v6와 같은 플래그, 힌트만 없음)

작업 디렉터리는 위 사본, 사용자 프롬프트는 표준 입력, 세션마다 새 `uuid4`, `--append-system-prompt`는 두 변형 모두 `SYSTEM_BASE`입니다.

* E2: `claude -p --model <m> --output-format json --setting-sources project --strict-mcp-config --mcp-config <Connect가 쓴 프로젝트 MCP 파일> --disable-slash-commands --tools Read,Grep,Glob --allowedTools Read,Grep,Glob,<고정 서버가 노출하는 mcp__neorion__* 도구 전부> --session-id <uuid> --append-system-prompt <SYSTEM_BASE>`
* E0: `claude -p --model <m> --output-format json --setting-sources project --strict-mcp-config --disable-slash-commands --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --session-id <uuid> --append-system-prompt <SYSTEM_BASE>`

`--allowedTools`의 MCP 도구 이름은 예비 실행에서 본 도구 목록을 그대로 나열하고 `graph_manifest.json`에 적습니다. MCP 등록 파일은 Connect가 쓴 바이트 그대로 쓰고 해시를 기록합니다.

시간 제한 600초, 동시 실행 최대 3, 재시도는 v6 규칙(출력 0바이트 시간 초과 또는 CLI 오류만, 실행당 최대 2회, 전체 최대 4회). 오답은 재시도하지 않습니다. 버린 시도도 `runs/`에 모두 보관합니다.

## 5. 준비 순서

1. `sha256sum -c SHA256SUMS` 통과. `git -C ../bench-repos/rallly rev-parse HEAD`가 위 커밋이고 `git status --porcelain --untracked-files=no`가 비어 있어야 합니다. `env | grep -i anthropic`이 비어 있어야 합니다.
2. Neorion을 고정 커밋으로 두고 `extension`에서 그 커밋의 패키징 스크립트로 MCP 번들을 만듭니다.
3. E2 사본을 4절 방법으로 풀고, v5 `bench-v5/prepare.cjs`와 같은 방법(테스트 호스트에서 `neo.generateGraph`, `neo.connectAITools`, 선택은 CLAUDE.md, Register Neorion query tools (MCP), Claude Code, Use bundled server)으로 그래프, 인덱스, 등록을 만듭니다. 고정 커밋의 선택 항목 이름이 다르면 같은 뜻의 항목을 고르는 부분만 맞추고 그 차이를 `graph_manifest.json`에 적습니다. 그래프는 이 실행 하나로만 만들고 손으로 고치지 않습니다.
4. 측정 전에 `graph_manifest.json`을 씁니다: Neorion 커밋, rallly 커밋, 생성 시각, CLAUDE.md 전후 diff, MCP 등록 파일과 해시, 캐시 위치와 그 안의 파일 목록과 해시, 번들 해시, 노출 도구 이름과 스키마 문자 수, 사본 `tree.sha256`. 이 파일과 `run.py`의 해시를 `RUN_SHA256SUMS`에 적습니다. `SHA256SUMS`의 파일은 바꾸지 않습니다.

## 6. 예비 실행 (결과에서 제외, `preflight/`에 보관)

과제 대상과 겹치지 않는 대상만 씁니다. 모델마다 변형마다 1회 이상, 아래를 모두 확인해야 측정을 시작합니다.

| 검사 | 방법 | 통과 조건 |
|:--|:--|:--|
| CLAUDE.md 로드 | 측정과 같은 명령에 "프로젝트 지침에서 'NOT the Next.js' 문장과, 있으면 Neorion 문장을 그대로 인용하라"는 프롬프트 | E0, E2 모두 AGENTS.md 문장 인용. E2만 neorion 블록 문장 인용, E0는 없음 |
| MCP 연결 | 같은 명령에 `--output-format stream-json --verbose`를 더한 1회로 init 이벤트 기록. 이어 고정 서버의 질의 종류마다 1회 호출: 렌더 `src/features/poll/components/poll-footer.tsx#PollFooter`, 감싸기 `/[locale]/settings/webhooks`, 이름 변경 `src/lib/datetime/use-hydrated.ts#useHydrated`, API `/api/updates`, 검색 `webhook` | E2 init에 neorion 서버 `connected`, 모든 호출이 오류 없이 응답, 해석된 모델 ID가 `claude-<m>-`로 시작. E0 init에 MCP 서버 없음 |
| 작업 트리에 그래프 없음 | E2 사본에서 `rg --files -uu`, `rg -l -uu -i neorion`, 과제 식별자(`VoteShortcut`, `usePoll`, `formatDateTimeRange`, `pollClosedDescription`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `/api/storage`)마다 `rg -l -uu` | 추적 파일 밖의 파일은 Connect가 쓴 MCP 등록 파일 하나뿐. `codebase_graph.md`, `neorion/`, `.neorion/`, 인덱스 JSON이 사본 안에 0개. neorion 문자열은 CLAUDE.md와 등록 파일에만 |
| 결과가 최신 | 사본 `tree.sha256`이 그래프 생성 시점과 같음. MCP 응답에 stale, outdated, partial(최신성 사유) 표시가 없음. 캐시 생성 시각이 사본 생성 뒤 | 모두 만족 |

예비 실행에서 본 도구 출력 때문에 과제, 정답, 프롬프트, 기준, Neorion을 바꾸는 것은 금지합니다. 실패하면 측정하지 말고 보고합니다. 원하면 측정 전에 과제마다 MCP를 직접 불러 `neorion_oracle.jsonl`에 기록할 수 있습니다(기록일 뿐, 정답은 바꾸지 않음. 다르면 Neorion 오류로 보고).

## 7. 측정과 기록

* 실행마다 CLI 최종 JSON(`runs/<id>.<model>.<variant>.json`), 세션 transcript(`.jsonl`), stderr, meta를 보관합니다.
* `responses.jsonl` 행은 `{"id","model","variant","text"}`, `text`는 CLI JSON의 `result`입니다.
* 채점: `python3 score.py tasks.jsonl responses.jsonl --out scores.jsonl`. `score.py`는 v4, v5, v6 채점기와 바이트 단위로 같습니다(sha256 `561f19ea217c60525eddbb9a87ef73f923ea8a580c5cfb06efc670f6e9cc4638`).
* **입력 토큰** = CLI JSON `usage`의 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (v6와 같은 정의). 출력 토큰, 가중 토큰, 턴, 요청 수, 도구 호출 수, MCP 호출 수, 첫 요청 입력 토큰, 경과 시간, 해석된 모델 ID도 기록합니다.
* 재시도 뒤에도 실패한 실행은 정답 실패(F1 0, 정확 일치 아님)입니다. 그 실행에 `usage`가 없으면 그 모델의 토큰 기준(P1, P3)은 "판정 불가"이고 통과로 치지 않습니다.

## 8. 사전 등록 성공 기준

동결 시점에 정한 기준이며 실행 뒤 바꾸지 않습니다. 모델마다 따로 판정하고 두 모델을 합치지 않습니다. 쌍은 같은 모델, 같은 과제의 E0와 E2입니다. 구조 과제 집합 S = v7-rallly-01 ~ 12(12개), 대조군 C = v7-rallly-13, 14.

| ID | 비교 | 기준 (모두 만족해야 통과) |
|:--|:--|:--|
| **P1 비용** | E2 대 E0, S | (a) S의 E2 입력 토큰 합(캐시 포함) ≤ E0 합 × 0.80. (b) E2 입력 토큰이 E0보다 적은 과제가 12개 중 8개 이상 |
| **P2 정확도** | E2 대 E0, S | E2 정확 일치 수 ≥ E0 정확 일치 수 |
| **P3 대조군** | E2 대 E0, C | C 두 과제의 E2 입력 토큰 합 ≤ E0 합 × 1.15 |

결론 규칙:

* "held-out 저장소에서 입력 토큰 절감이 재현됨"은 그 모델에서 P1, P2가 모두 통과할 때만 씁니다. 절감률은 S 합계로 적고 부호 수(적음, 많음, 같음)를 함께 적습니다.
* P3 실패는 따로 보고하고 "그래프가 도움이 안 되는 질문에서 도구가 비용을 늘린다"는 한계로 적습니다.
* 두 모델 모두 P1이 실패하면 "v7 변경의 절감은 held-out 저장소에서 확인되지 않았다"고 씁니다.
* 결과와 상관없이 보고: 변형별 합계 표, 과제별 입력 토큰과 정답 표, S에서의 부호 수와 양측 정확 부호 검정 p값(동률 제외), 쌍별 차이 중앙값, 평균 F1(설명용), 대조군 과제별 비율(설명용), E0 정답이었는데 E2가 틀린 과제(회귀) 목록, 절감이 가장 큰 3개 과제가 전체 절감에서 차지하는 비율, 유형별(T1, T2, T3, T4, T7) 합계.
* 모델당 쌍이 12개뿐이라 유의성을 주장하지 않습니다. p값은 적되 "통계적으로 유의" 같은 표현은 쓰지 않습니다.

## 9. 금지

* 실행 뒤 과제, 정답, 채점기, 프롬프트, 기준 변경. 바꾸려면 v8로 새로 동결합니다.
* 오답 재시도, 결과를 보고 고른 재실행.
* 측정 전이나 중에 Neorion 코드 변경, 그래프 손편집, 실행기 시스템 힌트 추가.
* API 키, 유료 API.
