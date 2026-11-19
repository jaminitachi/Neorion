# Neorion benchmark v4

40 of 40 measured sessions completed with Claude.ai subscription authentication. The runner queued the frozen order with three concurrent slots, a 10-minute timeout per attempt, and 0 retries. Concurrent archive extraction could change CLI start order within those slots. Both excluded preflight variants confirmed in request transcripts that 2.1.327 (Claude Code) loaded CLAUDE.md and its AGENTS.md import. E1 also loaded the real Connect AI tools instructions. Two additional unmeasured E0 checks preceded the verified pair while the transcript check was corrected. The account used subscription authentication with the API-key environment variables removed.

Neorion 3543df5391aefa3ffacb832f9eedf9c36c833a4f generated 104 graph files (907,972 bytes) in 51.87 seconds. The manifest was written before preflight.

The requested JSON flag produced final results. Native session JSONL records requests and tool activity. Original CLI outputs and JSONL transcripts are retained in the benchmark workspace under runs/. API requests count distinct request IDs. Input includes cache reads and writes. Maximum context is the largest recorded per-message input including cache. CLI USD reports list-price estimates. Graph opens count successful Read and Grep results identifying a graph file. Graph bytes count returned text, so filename-only Grep matches count as opens with zero bytes.

## Model and variant summary

| Model | Resolved ID | Variant | Completed | Mean F1 | Exact | Mean input | Mean output | Mean turns | Mean API requests | Mean tools | Mean seconds | Graph opens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | claude-sonnet-5-5 | E0 | 10 | 0.995 | 9/10 | 45477.7 | 931.4 | 7.1 | 4.7 | 6.1 | 10.3 | 0/10 |
| sonnet | claude-sonnet-5-5 | E1 | 10 | 1.000 | 10/10 | 63222.6 | 866.9 | 5.9 | 4.2 | 4.9 | 10.3 | 5/10 |
| haiku | claude-haiku-5-5 | E0 | 10 | 0.955 | 7/10 | 101832.7 | 3872.0 | 12.9 | 7.6 | 11.9 | 17.6 | 0/10 |
| haiku | claude-haiku-5-5 | E1 | 10 | 0.991 | 9/10 | 179575.5 | 4610.5 | 13.9 | 7.1 | 12.9 | 20.4 | 6/10 |

## sonnet E0

| Task | F1 | Exact | T2 τ / T3 recall | Input | Output | Weighted | Turns | API requests | Tools | Graph opened | Graph bytes | Max context | Seconds | CLI USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v4-fb-01 | 1.000 | True | — | 44657 | 1315 | 24760.0 | 9 | 6 | 8 | False | 0 | 10994 | 14.27 | 0.04578 |
| v4-fb-02 | 1.000 | True | — | 105459 | 1599 | 57628.9 | 9 | 7 | 8 | False | 0 | 24345 | 14.00 | 0.10677 |
| v4-fb-03 | 1.000 | True | — | 101775 | 1666 | 45294.7 | 14 | 9 | 13 | False | 0 | 17869 | 18.63 | 0.08182 |
| v4-fb-04 | 0.952 | False | 1.000 | 82382 | 2330 | 47030.9 | 18 | 7 | 17 | False | 0 | 18058 | 19.74 | 0.08725 |
| v4-fb-05 | 1.000 | True | 1.000 | 11041 | 280 | 6896.7 | 2 | 2 | 1 | False | 0 | 6089 | 4.79 | 0.01292 |
| v4-fb-06 | 1.000 | True | 1.000 | 17794 | 504 | 11817.4 | 4 | 3 | 3 | False | 0 | 6966 | 6.43 | 0.02225 |
| v4-fb-07 | 1.000 | True | 1.000 | 10467 | 215 | 5414.2 | 2 | 2 | 1 | False | 0 | 5510 | 4.03 | 0.00996 |
| v4-fb-08 | 1.000 | True | — | 17224 | 351 | 8911.1 | 4 | 3 | 3 | False | 0 | 6636 | 5.48 | 0.01639 |
| v4-fb-09 | 1.000 | True | — | 53633 | 886 | 24379.0 | 7 | 6 | 6 | False | 0 | 11450 | 11.65 | 0.04416 |
| v4-fb-10 | 1.000 | True | — | 10345 | 168 | 4994.1 | 2 | 2 | 1 | False | 0 | 5419 | 3.67 | 0.00912 |

## sonnet E1

| Task | F1 | Exact | T2 τ / T3 recall | Input | Output | Weighted | Turns | API requests | Tools | Graph opened | Graph bytes | Max context | Seconds | CLI USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v4-fb-01 | 1.000 | True | — | 61644 | 878 | 40631.0 | 5 | 4 | 4 | True | 26179 | 19717 | 13.22 | 0.07668 |
| v4-fb-02 | 1.000 | True | — | 119547 | 1369 | 61174.8 | 7 | 6 | 6 | True | 35520 | 26188 | 14.60 | 0.11263 |
| v4-fb-03 | 1.000 | True | — | 204047 | 2038 | 85976.9 | 11 | 9 | 10 | True | 23556 | 33031 | 22.63 | 0.15446 |
| v4-fb-04 | 1.000 | True | 1.000 | 102870 | 1855 | 67376.9 | 14 | 5 | 13 | True | 23439 | 29052 | 14.53 | 0.12698 |
| v4-fb-05 | 1.000 | True | 1.000 | 12493 | 197 | 8515.5 | 2 | 2 | 1 | False | 0 | 7195 | 4.34 | 0.01611 |
| v4-fb-06 | 1.000 | True | 1.000 | 18884 | 505 | 12642.0 | 4 | 3 | 3 | False | 0 | 7340 | 7.68 | 0.02383 |
| v4-fb-07 | 1.000 | True | 1.000 | 11183 | 182 | 5816.7 | 2 | 2 | 1 | False | 0 | 5883 | 3.72 | 0.01071 |
| v4-fb-08 | 1.000 | True | — | 18396 | 410 | 9931.3 | 4 | 3 | 3 | True | 78 | 7068 | 6.58 | 0.01834 |
| v4-fb-09 | 1.000 | True | — | 72101 | 1037 | 35356.0 | 8 | 6 | 7 | False | 0 | 15970 | 11.64 | 0.06471 |
| v4-fb-10 | 1.000 | True | — | 11061 | 198 | 5711.6 | 2 | 2 | 1 | False | 0 | 5792 | 3.97 | 0.01051 |

## haiku E0

| Task | F1 | Exact | T2 τ / T3 recall | Input | Output | Weighted | Turns | API requests | Tools | Graph opened | Graph bytes | Max context | Seconds | CLI USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v4-fb-01 | 1.000 | True | — | 144850 | 5388 | 83246.7 | 19 | 11 | 18 | False | 0 | 26583 | 23.37 | 0.00832 |
| v4-fb-02 | 1.000 | True | — | 218127 | 6171 | 120574.7 | 19 | 9 | 18 | False | 0 | 40314 | 26.89 | 0.01206 |
| v4-fb-03 | 1.000 | True | — | 156804 | 5092 | 85238.3 | 16 | 11 | 15 | False | 0 | 27781 | 23.02 | 0.00852 |
| v4-fb-04 | 0.952 | False | 1.000 | 146630 | 9551 | 111638.5 | 23 | 9 | 22 | False | 0 | 30479 | 39.44 | 0.01116 |
| v4-fb-05 | 1.000 | True | 1.000 | 40355 | 2028 | 24733.3 | 8 | 5 | 7 | False | 0 | 10134 | 10.34 | 0.00247 |
| v4-fb-06 | 1.000 | True | 1.000 | 28679 | 1877 | 20751.2 | 8 | 4 | 7 | False | 0 | 9051 | 9.14 | 0.00208 |
| v4-fb-07 | 1.000 | True | 1.000 | 21321 | 1800 | 19326.5 | 5 | 3 | 4 | False | 0 | 8892 | 9.24 | 0.00193 |
| v4-fb-08 | 0.800 | False | — | 76779 | 2044 | 33479.0 | 12 | 8 | 11 | False | 0 | 12775 | 10.45 | 0.00335 |
| v4-fb-09 | 0.800 | False | — | 159749 | 4086 | 73873.6 | 15 | 12 | 14 | False | 0 | 24291 | 20.28 | 0.00739 |
| v4-fb-10 | 1.000 | True | — | 25033 | 683 | 10544.4 | 4 | 4 | 3 | False | 0 | 7013 | 4.28 | 0.00105 |

## haiku E1

| Task | F1 | Exact | T2 τ / T3 recall | Input | Output | Weighted | Turns | API requests | Tools | Graph opened | Graph bytes | Max context | Seconds | CLI USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v4-fb-01 | 1.000 | True | — | 371884 | 7500 | 144715.3 | 29 | 14 | 28 | True | 26160 | 41537 | 34.06 | 0.01447 |
| v4-fb-02 | 1.000 | True | — | 293602 | 6170 | 152296.7 | 14 | 8 | 13 | True | 23439 | 53153 | 25.79 | 0.01523 |
| v4-fb-03 | 1.000 | True | — | 513907 | 10141 | 217760.7 | 28 | 13 | 27 | True | 23732 | 65558 | 43.69 | 0.02178 |
| v4-fb-04 | 0.909 | False | 1.000 | 351760 | 10764 | 169676.6 | 28 | 10 | 27 | True | 23439 | 47148 | 46.54 | 0.01697 |
| v4-fb-05 | 1.000 | True | 1.000 | 40002 | 1883 | 29234.2 | 6 | 4 | 5 | False | 0 | 13016 | 9.13 | 0.00292 |
| v4-fb-06 | 1.000 | True | 1.000 | 51054 | 2939 | 39050.7 | 9 | 5 | 8 | False | 0 | 14821 | 12.81 | 0.00391 |
| v4-fb-07 | 1.000 | True | 1.000 | 28234 | 1353 | 16785.2 | 7 | 4 | 6 | False | 0 | 8478 | 6.78 | 0.00168 |
| v4-fb-08 | 1.000 | True | — | 32441 | 1328 | 19708.6 | 6 | 4 | 5 | True | 436 | 9861 | 6.38 | 0.00197 |
| v4-fb-09 | 1.000 | True | — | 93298 | 3250 | 69180.4 | 8 | 6 | 7 | True | 0 | 27636 | 14.65 | 0.00692 |
| v4-fb-10 | 1.000 | True | — | 19573 | 777 | 10510.3 | 4 | 3 | 3 | False | 0 | 7148 | 4.52 | 0.00105 |

## Paired differences, E1 minus E0

| Model | Task | Type | Δ F1 | Δ exact | Δ input | Δ output | Δ turns | Δ API requests | Δ tools | Δ seconds | Δ weighted | E1 graph opened |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | v4-fb-01 | T1 | +0.000 | +0 | +16987 | -437 | -4 | -2 | -4 | -1.05 | +15871.0 | True |
| sonnet | v4-fb-02 | T1 | +0.000 | +0 | +14088 | -230 | -2 | -1 | -2 | +0.60 | +3545.9 | True |
| sonnet | v4-fb-03 | T1 | +0.000 | +0 | +102272 | +372 | -3 | +0 | -3 | +4.01 | +40682.2 | True |
| sonnet | v4-fb-04 | T2 | +0.048 | +1 | +20488 | -475 | -4 | -2 | -4 | -5.21 | +20346.0 | True |
| sonnet | v4-fb-05 | T3 | +0.000 | +0 | +1452 | -83 | +0 | +0 | +0 | -0.45 | +1618.8 | False |
| sonnet | v4-fb-06 | T3 | +0.000 | +0 | +1090 | +1 | +0 | +0 | +0 | +1.25 | +824.6 | False |
| sonnet | v4-fb-07 | T3 | +0.000 | +0 | +716 | -33 | +0 | +0 | +0 | -0.30 | +402.5 | False |
| sonnet | v4-fb-08 | T4 | +0.000 | +0 | +1172 | +59 | +0 | +0 | +0 | +1.10 | +1020.2 | True |
| sonnet | v4-fb-09 | T4 | +0.000 | +0 | +18468 | +151 | +1 | +0 | +1 | -0.01 | +10977.0 | False |
| sonnet | v4-fb-10 | T6 | +0.000 | +0 | +716 | +30 | +0 | +0 | +0 | +0.30 | +717.5 | False |
| haiku | v4-fb-01 | T1 | +0.000 | +0 | +227034 | +2112 | +10 | +3 | +10 | +10.69 | +61468.6 | True |
| haiku | v4-fb-02 | T1 | +0.000 | +0 | +75475 | -1 | -5 | -1 | -5 | -1.09 | +31722.0 | True |
| haiku | v4-fb-03 | T1 | +0.000 | +0 | +357103 | +5049 | +12 | +2 | +12 | +20.67 | +132522.4 | True |
| haiku | v4-fb-04 | T2 | -0.043 | +0 | +205130 | +1213 | +5 | +1 | +5 | +7.10 | +58038.1 | True |
| haiku | v4-fb-05 | T3 | +0.000 | +0 | -353 | -145 | -2 | -1 | -2 | -1.21 | +4500.9 | False |
| haiku | v4-fb-06 | T3 | +0.000 | +0 | +22375 | +1062 | +1 | +1 | +1 | +3.67 | +18299.5 | False |
| haiku | v4-fb-07 | T3 | +0.000 | +0 | +6913 | -447 | +2 | +1 | +2 | -2.46 | -2541.3 | False |
| haiku | v4-fb-08 | T4 | +0.200 | +1 | -44338 | -716 | -6 | -4 | -6 | -4.07 | -13770.4 | True |
| haiku | v4-fb-09 | T4 | +0.200 | +1 | -66451 | -836 | -7 | -6 | -7 | -5.63 | -4693.2 | True |
| haiku | v4-fb-10 | T6 | +0.000 | +0 | -5460 | +94 | +0 | -1 | +0 | +0.25 | -34.1 | False |

## Paired statistics

Two-sided exact sign tests exclude ties. The 95% percentile intervals for median differences use 20,000 task-pair resamples with seed 20261119. The small number of pairs limits inference.

| Model | Scope | Metric | Positive / negative / tied | Median Δ | 95% interval | Sign-test p |
| --- | --- | --- | --- | --- | --- | --- |
| sonnet | All | f1 | 1 / 0 / 9 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | All | exact | 1 / 0 / 9 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | All | input_tokens | 10 / 0 / 0 | 7770.000 | [944.000, 18737.500] | 0.0020 |
| sonnet | All | output_tokens | 5 / 5 / 0 | -16.000 | [-260.000, 90.500] | 1.0000 |
| sonnet | All | api_turns | 1 / 4 / 5 | 0.000 | [-3.000, 0.000] | 0.3750 |
| sonnet | All | api_calls | 0 / 3 / 7 | 0.000 | [-1.000, 0.000] | 0.2500 |
| sonnet | All | tool_calls | 1 / 4 / 5 | 0.000 | [-3.000, 0.000] | 0.3750 |
| sonnet | All | wall_seconds | 5 / 5 / 0 | 0.146 | [-0.677, 1.104] | 1.0000 |
| sonnet | All | weighted_tokens | 10 / 0 / 0 | 2582.350 | [824.600, 15871.000] | 0.0020 |
| sonnet | T1–T4 | f1 | 1 / 0 / 8 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | T1–T4 | exact | 1 / 0 / 8 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | T1 and T3 | api_calls | 0 / 2 / 4 | 0.000 | [-1.500, 0.000] | 0.5000 |
| haiku | All | f1 | 2 / 1 / 7 | 0.000 | [0.000, 0.100] | 1.0000 |
| haiku | All | exact | 2 / 0 / 8 | 0.000 | [0.000, 0.500] | 0.5000 |
| haiku | All | input_tokens | 6 / 4 / 0 | 14644.000 | [-22345.500, 205130.000] | 0.7539 |
| haiku | All | output_tokens | 5 / 5 / 0 | 46.500 | [-447.000, 1213.000] | 1.0000 |
| haiku | All | api_turns | 5 / 4 / 1 | 0.500 | [-5.000, 6.000] | 1.0000 |
| haiku | All | api_calls | 5 / 5 / 0 | 0.000 | [-2.500, 1.500] | 1.0000 |
| haiku | All | tool_calls | 5 / 4 / 1 | 0.500 | [-5.000, 6.000] | 1.0000 |
| haiku | All | wall_seconds | 5 / 5 / 0 | -0.423 | [-2.641, 7.178] | 1.0000 |
| haiku | All | weighted_tokens | 6 / 4 / 0 | 11400.200 | [-2541.300, 58038.100] | 0.7539 |
| haiku | T1–T4 | f1 | 2 / 1 / 6 | 0.000 | [0.000, 0.200] | 1.0000 |
| haiku | T1–T4 | exact | 2 / 0 / 7 | 0.000 | [0.000, 1.000] | 0.5000 |
| haiku | T1 and T3 | api_calls | 4 / 2 / 0 | 1.000 | [-1.000, 2.500] | 0.6875 |

## Preregistered hypotheses

| Model | Hypothesis | Measure | E0 | E1 | Criterion met |
| --- | --- | --- | --- | --- | --- |
| sonnet | H1 | T1–T4 mean F1 | 0.995 | 1.000 | False |
| sonnet | H2 | T1–T4 exact matches (1 wins, 0 losses) | 8 | 9 | True |
| sonnet | H3 | T1 and T3 pooled median API requests | 4.5 | 3.5 | False |
| sonnet | H3 | T1 median API requests | 7 | 6 | False |
| sonnet | H3 | T3 median API requests | 2 | 2 | False |
| sonnet | H4 | T6 F1 and weighted tokens | 1.000, 4994.1 | 1.000, 5711.6 | True |
| haiku | H1 | T1–T4 mean F1 | 0.950 | 0.990 | False |
| haiku | H2 | T1–T4 exact matches (2 wins, 0 losses) | 6 | 8 | True |
| haiku | H3 | T1 and T3 pooled median API requests | 7.0 | 6.5 | False |
| haiku | H3 | T1 median API requests | 11 | 13 | False |
| haiku | H3 | T3 median API requests | 4 | 4 | False |
| haiku | H4 | T6 F1 and weighted tokens | 1.000, 10544.4 | 1.000, 10510.3 | True |

The preregistered criteria for benefit were met by sonnet (H2) and haiku (H2).

## Misses

- **v4-fb-04 haiku E0** (F1 0.952). Extra `modules/ui/components/page-content-wrapper/index.tsx`. The leaf page renders this component around its own content, outside the requested layout and provider chain.
- **v4-fb-04 haiku E1** (F1 0.909). Extra `app/error.tsx`, `modules/ui/components/page-content-wrapper/index.tsx`. The first is an error boundary file. The second wraps content inside the leaf page.
- **v4-fb-04 sonnet E0** (F1 0.952). Extra `modules/ui/components/page-content-wrapper/index.tsx`. The leaf page renders this component around its own content, outside the requested layout and provider chain.
- **v4-fb-08 haiku E0** (F1 0.800). Omitted `modules/ee/unify-feedback/sources/csv-import-client.ts`. The answer included both immediate callers and left out the client that sends the fetch request at line 43.
- **v4-fb-09 haiku E0** (F1 0.800). Omitted `modules/survey/list/lib/v3-surveys-client.ts`. The answer included both hooks and left out the client that sends the requests at lines 215 and 232.

## Graph error propagation

A match in returned graph text establishes exposure. The miss list records disagreements with the frozen answer.

- **v4-fb-04 haiku** supplied `app/error.tsx`. No literal match in returned graph text. The predicted source path exists.
- **v4-fb-04 haiku** supplied `modules/ui/components/page-content-wrapper/index.tsx`. No literal match in returned graph text. The predicted source path exists.

E1 produced 2 false-positive items. 0 were literal graph mentions of paths absent from source. Both extras appear in generated detail files. The session returned only the root graph index, where neither path matched literally.
