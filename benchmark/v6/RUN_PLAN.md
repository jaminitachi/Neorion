# 실행 계획 v6 (held-out, E0, E2, E3 × sonnet, haiku)

이 문서는 실행 방법과 사전 등록 성공 기준만 정합니다. 이 문서를 쓴 시점까지 어떤 모델도 실행하지 않았고, dub에 대한 Neorion 출력(그래프, 인덱스, MCP 응답)도 만든 적이나 본 적이 없습니다. 과제와 정답은 `FREEZE.md`의 해시로 동결되어 있습니다.

## 1. 왜 v6인가

v5의 10개 과제는 MCP 도구를 설계하고 고칠 때 참고한 개발용 과제라 10/10이 held-out 결과가 아닙니다(`../claude_audit11.md` 1번). 또 E2는 MCP, 시스템 프롬프트 힌트, CLAUDE.md 안내, 그래프 파일을 함께 더해 MCP만의 효과를 분리할 수 없었습니다(같은 문서 2번). v6는 처음 쓰는 저장소(dub)의 새 과제 11개로 같은 측정을 하고, MCP만 뺀 E3를 더해 두 문제를 함께 다룹니다.

## 2. 실행 행렬

| 축 | 값 |
|:--|:--|
| 과제 | `tasks.jsonl` 11개 (v6-dub-01 ~ v6-dub-10 구조 과제, v6-dub-11 대조군) |
| 모델 | `--model sonnet`, `--model haiku` |
| 변형 | E0, E2, E3 |
| 반복 | 과제, 모델, 변형마다 1회 |
| 실행 수 | 11 × 2 × 3 = 66 |

`prompts.jsonl`(66행)과 `run_order.json`은 `python3 prepare_prompts.py`가 시드 `neorion-bench-v6-20261119`로 만듭니다. 같은 (모델, 과제)의 세 변형은 연달아 실행하고 순서는 시드로 섞습니다. E0도 이번 배치에서 새로 실행합니다(v5처럼 다른 시점의 기준선을 가져오지 않습니다).

## 3. 고정 입력

| 항목 | 값 |
|:--|:--|
| 대상 저장소 | `../bench-repos/dub` (https://github.com/dubinc/dub, `--depth 1`) |
| 대상 커밋 | `6b463b4bdd9ed2fd9aa416f67b5b77d317b1471e` |
| 앱 폴더 | `apps/web` (실행 사본의 루트) |
| Neorion | `../Neorion`, 브랜치 `fix/graph-quality-and-packaging`, HEAD `4a9e3fcf5265cb43d1c7ae908b9d4324b206275c` (2026-11-19T17:43:31+09:00), 작업 트리 깨끗함 |
| Claude Code | `2.1.327` (v5와 같음) |
| 인증 | Claude.ai 구독 로그인만. `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_*` 환경 변수를 지우고 실행(v5 `run.py`와 같음). API 키와 유료 API 금지 |

Neorion은 위 커밋으로 고정합니다. 실행 시점에 브랜치 HEAD가 바뀌었으면 위 커밋을 체크아웃해서 씁니다. 과제를 본 뒤의 Neorion 수정이 결과에 섞이지 않게 하기 위해서입니다. Neorion 코드는 고치지 않습니다. CLI 버전이 2.1.327이 아니면 66회 모두를 같은 다른 버전으로 실행하고 그 사실을 결과에 적습니다. 섞어 쓰지 않습니다.

## 4. 변형

세 변형 모두 실행마다 빈 임시 디렉터리에 `git -C ../bench-repos/dub archive 6b463b4bdd9ed2fd9aa416f67b5b77d317b1471e:apps/web | tar -x`로 앱 폴더의 추적 파일만 풉니다. dub `apps/web`에는 원래 `CLAUDE.md`와 `AGENTS.md`가 없습니다.

| 변형 | 사본에 더하는 파일 | 시스템 프롬프트 | MCP |
|:--|:--|:--|:--|
| **E0** | 없음 | `SYSTEM_BASE` (v4와 같음) | 없음 |
| **E2** | v5 E2와 같은 묶음: `codebase_graph.md`, `neorion/graph/**`, Connect AI tools가 쓴 `CLAUDE.md`(neorion 블록), `.mcp.json`, `.neorion/index.v1.json`, `.neorion/mcp/server.cjs` | `SYSTEM_BASE` + v5 E2 힌트 (바이트 단위로 같음, `prepare_prompts.py`가 assert로 확인) | neorion stdio 서버 |
| **E3** | E2와 같은 `codebase_graph.md`, `neorion/graph/**`, `CLAUDE.md`. `.mcp.json`과 `.neorion/**`는 넣지 않음 | E2와 같음 | 없음 |

E3는 E2에서 MCP 서버만 뺀 절제(ablation)입니다. 힌트와 CLAUDE.md 블록이 없는 도구를 가리키는 것도 그대로 둡니다. 그래서 E2 대 E3 차이가 MCP 서버 자체의 효과이고, E3 대 E0 차이가 안내 문구와 그래프 파일의 효과입니다.

### CLI 명령 (v5와 같은 플래그)

작업 디렉터리는 위 사본, 사용자 프롬프트는 표준 입력, 세션마다 새 `uuid4`입니다.

* E2 (v5 `bench-v5/run.py`의 명령 그대로):
  `claude -p --model <m> --output-format json --setting-sources project --strict-mcp-config --mcp-config .mcp.json --disable-slash-commands --tools Read,Grep,Glob --allowedTools Read,Grep,Glob,mcp__neorion__neorion_who_renders,mcp__neorion__neorion_wrappers,mcp__neorion__neorion_rename_impact,mcp__neorion__neorion_api_consumers,mcp__neorion__neorion_search --session-id <uuid> --append-system-prompt <prompt>`
* E0, E3 (v5가 비교한 v4 E0, E1 명령 그대로, MCP 설정 없음):
  `claude -p --model <m> --output-format json --setting-sources project --strict-mcp-config --disable-slash-commands --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --session-id <uuid> --append-system-prompt <prompt>`

시간 제한 600초, 동시 실행 최대 3, 재시도는 v5 규칙(출력 0바이트 시간 초과 또는 CLI 오류만, 실행당 최대 2회, 전체 최대 4회). 오답은 재시도하지 않습니다. 버린 시도도 `runs/`에 모두 보관합니다.

## 5. 준비 순서

1. `sha256sum -c SHA256SUMS`가 통과해야 합니다. `git -C ../bench-repos/dub rev-parse HEAD`가 위 커밋이고 `git status --porcelain --untracked-files=no`가 비어 있어야 합니다.
2. Neorion을 고정 커밋으로 두고 `extension`에서 `npm run pack:mcp`로 번들을 만듭니다.
3. `/tmp/neorion-bench-v6/app`에 4절과 같은 방법으로 사본을 하나 풀고 `node ../bench-v5/prepare.cjs /tmp/neorion-bench-v6/app`을 실행합니다. 이 스크립트는 v5와 같은 방법(테스트 호스트에서 `neo.generateGraph`, `neo.connectAITools`, CLAUDE.md와 Claude Code, Use bundled server)으로 그래프, 인덱스, 등록을 만듭니다. 그래프는 이 실행 하나로만 만들고 손으로 고치지 않습니다.
4. 측정 전에 `graph_manifest.json`을 씁니다. v5 `freeze.py`와 같은 항목(Neorion 커밋, dub 커밋, 생성 시각, `.mcp.json`, 인덱스, 번들 해시, 그래프 파일 목록과 해시, CLAUDE.md 전후 diff)에 E3 파일 목록(E2 목록에서 `.mcp.json`, `.neorion/**`를 뺀 것)을 더합니다. 이 파일과 `run.py`의 해시를 `RUN_SHA256SUMS`에 적습니다. `SHA256SUMS`의 파일은 바꾸지 않습니다.
5. 예비 실행(결과에서 제외, `preflight/`에 보관). 모델마다 변형마다 1회:
   * E2: v5와 같은 검사(CLAUDE.md의 neorion 블록 로드, 다섯 도구 모두 오류 없이 응답, 모델 ID). 과제 대상과 겹치지 않는 대상만 씁니다. who_renders `ui/folders/add-folder-form.tsx#AddFolderForm`, wrappers `/app.dub.co/[slug]/settings/domains`, rename_impact `lib/swr/use-folder-users.ts#useFolderUsers`, api_consumers `/api/tags`, search `folder`.
   * E3: CLAUDE.md 블록이 로드되고 `mcp__neorion__*` 도구가 도구 목록에 없음을 확인.
   * E0: 사본에 `CLAUDE.md`, `codebase_graph.md`, `neorion/`, `.neorion/`, `.mcp.json`이 없음을 확인.
6. 예비 실행에서 본 도구 출력 때문에 과제, 정답, 프롬프트, 기준, Neorion을 바꾸는 것은 금지합니다. 문제가 있으면 측정하지 말고 보고합니다.
7. 원하면 측정 전에 과제마다 MCP 도구를 한 번 직접 불러 `neorion_oracle.jsonl`에 기록할 수 있습니다(v5 `oracle.py` 방식). 이것은 기록일 뿐이고 정답(`oracle.jsonl`)은 바꾸지 않습니다. 도구 출력이 정답과 다르면 Neorion 오류로 보고합니다.

## 6. 측정과 기록

* 실행마다 CLI 최종 JSON(`runs/<id>.<model>.<variant>.json`), 세션 transcript(`.jsonl`), stderr, meta를 보관합니다.
* `responses.jsonl` 행은 `{"id","model","variant","text"}`이고 `text`는 CLI JSON의 `result`입니다.
* 채점: `python3 score.py tasks.jsonl responses.jsonl --out scores.jsonl`. `score.py`는 v4, v5 채점기와 바이트 단위로 같습니다.
* **입력 토큰** = CLI JSON `usage`의 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (v5 `report.py`와 같은 정의). 출력 토큰, 가중 토큰(v4 가중치), 턴, 요청 ID 수, 도구 호출 수, MCP 호출 수, 그래프 파일 Read 수와 바이트, 첫 요청 입력 토큰, 경과 시간, 해석된 모델 ID도 v5처럼 기록합니다.
* 재시도 뒤에도 실패한 실행은 정답 실패(F1 0, 정확 일치 아님)로 셉니다. 그 실행에 `usage`가 없으면 그 모델의 토큰 기준 판정(P1, P3, P4)은 "판정 불가"이고 통과로 치지 않습니다.

## 7. 사전 등록 성공 기준

지금(동결 시점) 정한 기준이며 실행 뒤 바꾸지 않습니다. 모델마다 따로 판정하고 두 모델을 합치지 않습니다. 쌍은 같은 모델, 같은 과제의 두 변형입니다. 구조 과제 집합 S = v6-dub-01 ~ v6-dub-10(10개), 대조군 C = v6-dub-11.

| ID | 비교 | 기준 (모두 만족해야 통과) |
|:--|:--|:--|
| **P1 비용** | E2 대 E0, S | (a) S의 E2 입력 토큰 합 ≤ E0 합 × 0.70. (b) 과제별 부호: E2 입력 토큰이 E0보다 적은 과제가 10개 중 8개 이상 |
| **P2 정확도 비열등** | E2 대 E0, S | (a) E2 정확 일치 수 ≥ E0 정확 일치 수. (b) E2 평균 F1 ≥ E0 평균 F1 − 0.02 |
| **P3 MCP 자체 효과** | E2 대 E3, S | (a) E2 입력 토큰 합 ≤ E3 합 × 0.80. (b) E2가 E3보다 적은 과제 8개 이상. (c) E2 정확 일치 수 ≥ E3 정확 일치 수 |
| **P4 대조군** | E2 대 E0, C | (a) E0이 정확 일치면 E2도 정확 일치. (b) E2 입력 토큰 ≤ E0 × 1.25 |

결론 규칙:

* "held-out 과제에서 입력 토큰 절감이 재현됨"은 그 모델에서 P1과 P2가 모두 통과할 때만 씁니다. 절감률은 S 합계 기준으로 적고, 부호 수(적음, 많음, 같음)를 함께 적습니다.
* "MCP 서버 자체의 효과"는 그 모델에서 P1, P2, P3가 모두 통과할 때만 씁니다. P1은 통과하고 P3가 실패하면 "절감은 주로 안내 문구와 그래프 파일에서 온다"로 씁니다.
* 두 모델 모두 P1이 실패하면 "v5의 절감은 held-out 과제에서 재현되지 않았다"고 씁니다.
* P4 실패는 따로 보고하고, 대조군에서 도구가 비용을 늘린다는 한계로 적습니다.
* 결과와 상관없이 다음을 모두 보고합니다. 변형별 합계 표, 과제별 입력 토큰과 정답 표(E0, E2, E3), 각 비교의 부호 수와 양측 정확 부호 검정 p값(동률 제외), 쌍별 차이의 중앙값, E3 대 E0 비교(설명용, 기준 없음), 정확 일치였다가 틀린 과제(회귀) 목록, 절감이 가장 큰 3개 과제가 전체 절감에서 차지하는 비율.
* 모델당 쌍이 10개뿐이라 유의성을 주장하지 않습니다. "통계적으로 유의" 같은 표현은 쓰지 않습니다.

## 8. 금지

* 실행 뒤 과제, 정답, 채점기, 프롬프트, 기준 변경. 바꾸려면 v7로 새로 동결합니다.
* 오답 재시도, 실행 결과를 보고 고른 재실행.
* 측정 중이나 측정 전에 Neorion 코드 변경, 그래프 손편집.
* API 키, 유료 API.
