# 동결 기록 v7

| 항목 | 값 |
|:--|:--|
| 동결 시각 | 2026-11-19T19:26:36Z (2026-11-20T04:26:36+09:00) |
| 저장소 후보 목록 작성 | `review/repo_candidates.json` (시드 선택 전, 해시 `review/repo_candidates.sha256`) |
| 과제 문구 확정 시각 | 2026-11-19T19:20:39Z (`review/tasks_pre_runplan.sha256`, v6 실행기 설정과 Neorion 정보를 읽기 전) |
| rallly 커밋 | `9ab01952cebd8db5165d0df1acaeeb5ea084b790`, 커밋 시각 2026-11-19T18:19:45Z |
| Neorion 커밋(실행에 쓸 것) | `5d5cb82291d10d02ca6a07557d6e5c10e44d2090` (`fix/graph-quality-and-packaging` HEAD), 커밋 시각 2026-11-20T03:56:49+09:00, 동결 시각보다 앞섬 |
| Claude Code | 2.1.327 |
| 시드 | `neorion-bench-v7-20261120` (저장소, 과제 선택, 실행 순서) |
| `SHA256SUMS` 자체 해시 | `b6948fac4563dad55a007f1e82021bee9632051eabea92546a40b1b26c7d118a` |

## 핵심 파일 해시

| 파일 | sha256 |
|:--|:--|
| `tasks.jsonl` | `ada72dd0ed6c088f6ad1fc83d0f3a5dac87d2179b295540d8013ff59d125299e` |
| `oracle.jsonl` | `b17fbb2e1ed3746f878256ff194491c48a0a42dca399342ea5ea0d2083913e53` |
| `prompts.jsonl` | `92b6bb828fd6872b64de5d3cc2b2db2ec065d01b62b03e86a068d89fab096355` |
| `run_order.json` | `12d478d41c8e8f39e4904d34c1f9e6c1dd163fdc5e0e826b20bd210c0fbc4abc` |
| `score.py` (v4, v5, v6와 같음) | `561f19ea217c60525eddbb9a87ef73f923ea8a580c5cfb06efc670f6e9cc4638` |
| `RUN_PLAN.md` (사전 등록 기준 포함) | `c5a33905697d1e53741266eac357fa6f088e5f010ed0dd87480d78f031c3aa47` |

전체 목록은 `SHA256SUMS`(23개 파일, `gen/node_modules` 제외)에 있습니다. 확인: `sha256sum -c SHA256SUMS`.

## 동결 전 확인

* 생성 파이프라인 전체를 처음부터 다시 돌려 `tasks.jsonl`, `oracle.jsonl`, `review/selection.json`, `gen/out/rallly.handwritten.json`이 바이트 단위로 같게 나옴을 확인했습니다.
* `python3 score.py --self-test` 통과. 정답을 그대로 넣으면 14/14 정확 일치, 평균 F1 1.000.
* `prepare_prompts.py`가 `SYSTEM_BASE`와 v6 `SYSTEM_BASE`가 같음을 assert로 확인합니다. E0와 E2의 시스템 프롬프트는 같습니다(실행기 힌트 없음).
* rallly 클론의 추적 파일 수정 없음, 추적 안 된 파일 없음. Neorion 작업 트리 깨끗함, 수정하지 않음.
* 모델 실행, API 키(`ANTHROPIC_API_KEY` 미설정), 유료 API 사용 없음. rallly에 대한 Neorion 출력 생성 없음.

## 동결 뒤 규칙

동결 뒤 과제, 정답, 채점기, 프롬프트, 실행 순서, 기준을 바꾸면 v8로 새로 동결하고 바뀐 점을 적습니다. 실행 중 생기는 `graph_manifest.json`, `run.py`, `neorion_oracle.jsonl`, 결과 파일은 `RUN_SHA256SUMS`에 따로 기록하고 `SHA256SUMS`는 건드리지 않습니다.
