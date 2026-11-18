# Neorion 10-question pilot

| Condition | Graded / planned | Strict accuracy | Average input tokens |
| --- | ---: | ---: | ---: |
| A · Question only | 10 / 10 | 5/10 (50%) | 677.5 (10 reported) |
| B · Graph | 10 / 10 | 9/10 (90%) | 200,386.0 (10 reported) |
| D · File list | 10 / 10 | 7/10 (70%) | 20,187.0 (10 reported) |

Input tokens include cache creation and cache reads where reported by Claude Code.
Accuracy uses exact set equality against the source-derived answers.

| Repository | Graph tokens | File-list tokens |
| --- | ---: | ---: |
| vercel/ai-chatbot | 26,243 | 1,305 |
| mfts/papermark | 209,850 | 20,659 |

Context sizes use o200k_base. Both complete tracked file lists fall short of the graph size. B and D differ in both representation and length.

## Grading issues

- q02 (A) failed JSON grading. The embedded JSON contains the exact answer. Extra text caused the strict score of zero.
- q04 (B) failed JSON grading.
- q07 (D) failed JSON grading. The embedded JSON contains the exact answer. Extra text caused the strict score of zero.
- q04 (D) failed JSON grading. The embedded JSON contains the exact answer. Extra text caused the strict score of zero.
- q07 (A) failed JSON grading.
- q09 (A) failed JSON grading. The embedded JSON contains the exact answer. Extra text caused the strict score of zero.
