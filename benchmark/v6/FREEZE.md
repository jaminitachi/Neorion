# 동결 기록 v6

| 항목 | 값 |
|:--|:--|
| 동결 시각 | 2026-11-19T08:58:28Z (2026-11-19T17:58:28+09:00) |
| 과제 문구 확정 시각 | 2026-11-19T08:54:29Z (`review/tasks_pre_runplan.sha256`, v5 E2 설정을 읽기 전) |
| dub 커밋 | `6b463b4bdd9ed2fd9aa416f67b5b77d317b1471e`, 커밋 시각 2026-10-26T09:39:24-07:00 |
| Neorion 커밋(실행에 쓸 것) | `4a9e3fcf5265cb43d1c7ae908b9d4324b206275c` (`fix/graph-quality-and-packaging` HEAD), 커밋 시각 2026-11-19T17:43:31+09:00, 동결 시각보다 앞섬 |
| Claude Code | 2.1.327 |
| `SHA256SUMS` 자체 해시 | `2a02bc7e43041980c7211526a8b51e6f6ce3246099b312d57347ef474e11bd7f` |

## 핵심 파일 해시

| 파일 | sha256 |
|:--|:--|
| `tasks.jsonl` | `482a095f1c4a68c29db64affc0054b270c07ab784f700c24350ae29ede1d71a4` |
| `oracle.jsonl` | `66bfcfa1a5d112f36afa8e7deaef369479a187f8f1fb2556a42a9309f86280e8` |
| `prompts.jsonl` | `5c21db604b99ca9d91d6949e9ca4247b4064fec058fadccdc5eabce1fe6098f0` |
| `run_order.json` | `347f2a1bf41d8571ff2a6cae1076ae18569e25a2925bc0fdd15095e482d871f1` |
| `score.py` (v4, v5와 같음) | `561f19ea217c60525eddbb9a87ef73f923ea8a580c5cfb06efc670f6e9cc4638` |
| `RUN_PLAN.md` (사전 등록 기준 포함) | `ffa4734179471e08f34292b8a63c56ed9a522e291ce11c827164c42d3b97695c` |

전체 목록은 `SHA256SUMS`(19개 파일, `gen/node_modules` 제외)에 있습니다. 확인: `sha256sum -c SHA256SUMS`.

## 동결 전 확인

* 생성 파이프라인 전체를 처음부터 다시 돌려 `tasks.jsonl`, `oracle.jsonl`, `prompts.jsonl`, `run_order.json`, `review/selection.json`, `gen/out/dub.handwritten.json`이 바이트 단위로 같게 나옴을 확인했습니다.
* `python3 score.py --self-test` 통과. 정답을 그대로 넣으면 11/11 정확 일치, 평균 F1 1.000.
* `prepare_prompts.py`가 E2 시스템 프롬프트와 v5 E2 시스템 프롬프트가 같음을 assert로 확인합니다.
* dub 클론의 추적 파일 수정 없음. Neorion 작업 트리 깨끗함, 수정하지 않음.
* 모델 실행, API 키, 유료 API 사용 없음. dub에 대한 Neorion 출력 생성 없음.

## 동결 뒤 규칙

동결 뒤 과제, 정답, 채점기, 프롬프트, 실행 순서, 기준을 바꾸면 v7로 새로 동결하고 바뀐 점을 적습니다. 실행 중 생기는 `graph_manifest.json`, `run.py`, `neorion_oracle.jsonl`, 결과 파일은 `RUN_SHA256SUMS`에 따로 기록하고 `SHA256SUMS`는 건드리지 않습니다.
