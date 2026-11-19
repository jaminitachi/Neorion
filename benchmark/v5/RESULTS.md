# Neorion benchmark v5

20/20 E2 sessions completed with Claude.ai subscription authentication and 0 retries. Both excluded preflights used the measured JSON mode and confirmed that Claude Code loaded the Connect AI tools instructions and successfully queried all five MCP tools. All five results per preflight were fresh.

2.1.327 (Claude Code) resolved sonnet to `claude-sonnet-5-5` and haiku to `claude-haiku-5-5`.
The benchmark used Neorion `fd70e62b8b4ad59035da690f7af5f899b0e55f6c` and index SHA-256 `c22479a5abe3954e5ed819e2bad9f0a84f24f22b59b309d984275d38d9acb51c`. The real Connect AI tools command registered the local bundle at `.neorion/mcp/server.cjs`; no runtime package installation was required. The v4 E1 overview was preserved byte for byte. Section 4.3 calls for regenerating the detail files and index at the frozen commit. The manifest records 143 added, removed, or changed detail files.

Input totals include cache reads and writes. Weighted tokens use the v4 weights. CLI USD is the CLI’s list-price estimate. API requests count distinct request IDs. Both models used rename_impact for the T6 reference-list control. E0 and E1 come from v4. Sessions were run at different times, with one run per task, model, and variant.

## Model and variant summary

| Model | Variant | Runs | Mean F1 | Exact | Input tokens | Output tokens | Weighted tokens | Turns | API requests | Tool calls | Elapsed seconds | Peak context | CLI USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | E0 | 10 | 0.995 | 9/10 | 454,777 | 9,314 | 237,127.0 | 71 | 47 | 61 | 102.68 | 24,345 | 0.43642 |
| sonnet | E1 | 10 | 1.000 | 10/10 | 632,226 | 8,669 | 333,132.7 | 59 | 42 | 49 | 102.92 | 33,031 | 0.61497 |
| sonnet | E2 | 10 | 1.000 | 10/10 | 147,957 | 2,842 | 75,221.1 | 23 | 21 | 13 | 43.06 | 12,834 | 0.13808 |
| haiku | E0 | 10 | 0.955 | 7/10 | 1,018,327 | 38,720 | 583,406.2 | 129 | 76 | 119 | 176.46 | 40,314 | 0.05834 |
| haiku | E1 | 10 | 0.991 | 9/10 | 1,795,755 | 46,105 | 868,918.7 | 139 | 71 | 129 | 204.36 | 65,558 | 0.08689 |
| haiku | E2 | 10 | 1.000 | 10/10 | 343,770 | 13,491 | 194,037.3 | 61 | 36 | 51 | 70.21 | 24,043 | 0.01940 |

## Criteria

| Criterion | Sonnet measurement | Sonnet | Haiku measurement | Haiku |
| --- | --- | --- | --- | --- |
| S1 Cost vs E0 | 147,957 / ≤ 409,299.3 input | Pass | 343,770 / ≤ 916,494.3 input | Pass |
| S2 Cost vs E1 | 68,081 / ≤ 244,054.0 T1+T2 input; 7/10 cheaper (≥ 8) | Fail | 181,792 / ≤ 765,576.5 T1+T2 input; 9/10 cheaper (≥ 8) | Pass |
| S3 Accuracy | 9/9 exact (≥ 8); F1 1.000 (≥ 0.980) | Pass | 9/9 exact (≥ 7); F1 1.000 (≥ 0.970) | Pass |
| S4 API requests | 2 / ≤ 3.15 median requests | Pass | 2.5 / ≤ 4.9 median requests | Pass |
| S5 T6 control | F1 1.000 vs 1.000; 5,139.6 / ≤ 6,242.6 weighted | Pass | F1 1.000 vs 1.000; 11,409.2 / ≤ 13,180.5 weighted | Pass |
| S6 Adoption and cap | 9/9 adopted (≥ 7); max 2,145 B across 10 results (≤ 6,000 B); 0 literal false positives | Pass | 9/9 adopted (≥ 7); max 2,145 B across 16 results (≤ 6,000 B); 0 literal false positives | Pass |

**Preregistered verdict: effective.** Both models passed S1 and S3 and met the S6 adoption requirement.

## MCP and Markdown use

| Model | Who renders | Wrappers | Rename impact | API consumers | Search | MCP result bytes | Largest result bytes | Stale results | Graph Reads or Greps | Graph result bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | 3 | 1 | 4 | 2 | 0 | 8136 | 2145 | 0 | 0 | 0 |
| haiku | 8 | 2 | 4 | 2 | 0 | 11855 | 2145 | 0 | 2 | 1129 |

### Input decomposition

The first-request token sum measures the initial context, including the task prompt, tool schemas and instructions. Subtracting it from total input gives the measured later-request input. The trace gives byte counts for graph and MCP results carried into subsequent requests. All request message hashes were resolved against the transcript. Claude Code reports aggregate input usage, so separate Claude token counts for graph replay, MCP replay, and other later-request context are unavailable.

| Model | E0 initial tokens | E1 initial tokens | E2 initial tokens | E2 initial Δ vs E0 | E2 later tokens | Graph bytes in requests | Repeated graph bytes | MCP bytes in requests | Repeated MCP bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | 50321 | 53733 | 65022 | +14701 | 82935 | 0 | 0 | 9300 | 1164 |
| haiku | 58564 | 61961 | 73250 | +14686 | 270520 | 1129 | 0 | 33242 | 21387 |

## sonnet per-task results

| Task | Type | E0 input | E1 input | E2 input | E0 F1 | E1 F1 | E2 F1 | Exact | τ / T3 recall | Output | Weighted | Turns | Requests | Calls | MCP calls | MCP bytes | MCP max bytes | Graph calls | Graph bytes | Max context | Seconds | CLI USD | Oracle F1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v4-fb-01 | T1 | 44657 | 61644 | 13700 | 1.000 | 1.000 | 1.000 | True | — | 248 | 6495.3 | 2 | 2 | 1 | 1 | 1037 | 1037 | 0 | 0 | 7179 | 4.02 | 0.01183 | 1.000 |
| v4-fb-02 | T1 | 105459 | 119547 | 14244 | 1.000 | 1.000 | 1.000 | True | — | 291 | 7794.5 | 2 | 2 | 1 | 1 | 2145 | 2145 | 0 | 0 | 7721 | 3.32 | 0.01442 | 1.000 |
| v4-fb-03 | T1 | 101775 | 204047 | 13447 | 1.000 | 1.000 | 1.000 | True | — | 168 | 5598.8 | 2 | 2 | 1 | 1 | 634 | 634 | 0 | 0 | 6931 | 2.67 | 0.01003 | 1.000 |
| v4-fb-04 | T2 | 82382 | 102870 | 26690 | 0.952 | 1.000 | 1.000 | True | 1.000 | 938 | 21990.6 | 5 | 3 | 4 | 1 | 1164 | 1164 | 0 | 0 | 12834 | 9.99 | 0.04208 | 1.000 |
| v4-fb-05 | T3 | 11041 | 12493 | 13224 | 1.000 | 1.000 | 1.000 | True | 1.000 | 253 | 5748.8 | 2 | 2 | 1 | 1 | 634 | 634 | 0 | 0 | 6798 | 5.18 | 0.01034 | 1.000 |
| v4-fb-06 | T3 | 17794 | 18884 | 13290 | 1.000 | 1.000 | 1.000 | True | 1.000 | 238 | 5752.6 | 2 | 2 | 1 | 1 | 484 | 484 | 0 | 0 | 6836 | 3.92 | 0.01035 | 1.000 |
| v4-fb-07 | T3 | 10467 | 11183 | 13182 | 1.000 | 1.000 | 1.000 | True | 1.000 | 154 | 5166.0 | 2 | 2 | 1 | 1 | 503 | 503 | 0 | 0 | 6754 | 3.82 | 0.00918 | 1.000 |
| v4-fb-08 | T4 | 17224 | 18396 | 13473 | 1.000 | 1.000 | 1.000 | True | — | 179 | 5570.9 | 2 | 2 | 1 | 1 | 461 | 461 | 0 | 0 | 6886 | 4.14 | 0.00997 | 1.000 |
| v4-fb-09 | T4 | 53633 | 72101 | 13638 | 1.000 | 1.000 | 1.000 | True | — | 192 | 5964.0 | 2 | 2 | 1 | 1 | 704 | 704 | 0 | 0 | 7050 | 2.67 | 0.01076 | 1.000 |
| v4-fb-10 | T6 | 10345 | 11061 | 13069 | 1.000 | 1.000 | 1.000 | True | — | 181 | 5139.6 | 2 | 2 | 1 | 1 | 370 | 370 | 0 | 0 | 6675 | 3.32 | 0.00913 | 1.000 |

## haiku per-task results

| Task | Type | E0 input | E1 input | E2 input | E0 F1 | E1 F1 | E2 F1 | Exact | τ / T3 recall | Output | Weighted | Turns | Requests | Calls | MCP calls | MCP bytes | MCP max bytes | Graph calls | Graph bytes | Max context | Seconds | CLI USD | Oracle F1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v4-fb-01 | T1 | 144850 | 371884 | 34381 | 1.000 | 1.000 | 1.000 | True | — | 1259 | 16918.5 | 7 | 4 | 6 | 1 | 1328 | 1328 | 0 | 0 | 9717 | 6.48 | 0.00169 | 1.000 |
| v4-fb-02 | T1 | 218127 | 293602 | 25884 | 1.000 | 1.000 | 1.000 | True | — | 1167 | 16083.9 | 5 | 3 | 4 | 4 | 3173 | 2145 | 0 | 0 | 9968 | 6.68 | 0.00161 | 1.000 |
| v4-fb-03 | T1 | 156804 | 513907 | 24212 | 1.000 | 1.000 | 1.000 | True | — | 734 | 11771.9 | 4 | 3 | 3 | 3 | 1870 | 929 | 0 | 0 | 8926 | 4.17 | 0.00118 | 1.000 |
| v4-fb-04 | T2 | 146630 | 351760 | 97315 | 0.952 | 0.909 | 1.000 | True | 1.000 | 5762 | 72951.7 | 22 | 7 | 21 | 2 | 2328 | 1164 | 0 | 0 | 24043 | 23.70 | 0.00730 | 1.000 |
| v4-fb-05 | T3 | 40355 | 40002 | 14920 | 1.000 | 1.000 | 1.000 | True | 1.000 | 341 | 6489.5 | 2 | 2 | 1 | 1 | 634 | 634 | 0 | 0 | 7670 | 2.84 | 0.00065 | 1.000 |
| v4-fb-06 | T3 | 28679 | 51054 | 14986 | 1.000 | 1.000 | 1.000 | True | 1.000 | 372 | 6723.3 | 2 | 2 | 1 | 1 | 484 | 484 | 0 | 0 | 7708 | 2.91 | 0.00067 | 1.000 |
| v4-fb-07 | T3 | 21321 | 28234 | 14900 | 1.000 | 1.000 | 1.000 | True | 1.000 | 275 | 6115.7 | 2 | 2 | 1 | 1 | 503 | 503 | 0 | 0 | 7648 | 2.62 | 0.00061 | 1.000 |
| v4-fb-08 | T4 | 76779 | 32441 | 24119 | 0.800 | 1.000 | 1.000 | True | — | 680 | 11542.0 | 3 | 3 | 2 | 1 | 461 | 461 | 0 | 0 | 8952 | 5.03 | 0.00115 | 1.000 |
| v4-fb-09 | T4 | 159749 | 93298 | 61355 | 0.800 | 1.000 | 1.000 | True | — | 2257 | 34031.6 | 10 | 6 | 9 | 1 | 704 | 704 | 2 | 1129 | 14676 | 11.35 | 0.00340 | 1.000 |
| v4-fb-10 | T6 | 25033 | 19573 | 31698 | 1.000 | 1.000 | 1.000 | True | — | 644 | 11409.2 | 4 | 4 | 3 | 1 | 370 | 370 | 0 | 0 | 8577 | 4.42 | 0.00114 | 1.000 |

## Paired differences

Differences are E2 minus the indicated v4 baseline. Two-sided exact sign tests exclude ties. The 95% percentile intervals use 20,000 resamples of task pairs with seed 20261119.

| Model | Baseline | Scope | Measure | Positive / negative / tied | Median difference | 95% interval | Sign-test p |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | E0 | All | input_tokens | 3 / 7 / 0 | -17,730.500 | [-64,161.500, 2,183.000] | 0.3438 |
| sonnet | E0 | All | output_tokens | 1 / 9 / 0 | -480.000 | [-1,308.000, -61.000] | 0.0215 |
| sonnet | E0 | All | weighted_tokens | 1 / 9 / 0 | -12,164.750 | [-29,055.450, -1,147.900] | 0.0215 |
| sonnet | E0 | All | f1 | 1 / 0 / 9 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | E0 | All | exact | 1 / 0 / 9 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | E0 | All | api_turns | 0 / 7 / 3 | -3.500 | [-9.500, 0.000] | 0.0156 |
| sonnet | E0 | All | api_calls | 0 / 7 / 3 | -2.500 | [-4.500, 0.000] | 0.0156 |
| sonnet | E0 | All | tool_calls | 0 / 7 / 3 | -3.500 | [-9.500, 0.000] | 0.0156 |
| sonnet | E0 | All | wall_seconds | 1 / 9 / 0 | -5.740 | [-10.244, -0.350] | 0.0215 |
| sonnet | E0 | T1–T4 | f1 | 1 / 0 / 8 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | E0 | T1–T4 | exact | 1 / 0 / 8 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | E0 | T1+T2 | input_tokens | 0 / 4 / 0 | -72,010.000 | [-91,215.000, -30,957.000] | 0.1250 |
| sonnet | E0 | T1+T3 | api_calls | 0 / 4 / 2 | -2.500 | [-6.000, 0.000] | 0.1250 |
| sonnet | E1 | All | input_tokens | 3 / 7 / 0 | -26,769.000 | [-81,883.000, 731.000] | 0.3438 |
| sonnet | E1 | All | output_tokens | 1 / 9 / 0 | -448.500 | [-961.500, -28.000] | 0.0215 |
| sonnet | E1 | All | weighted_tokens | 0 / 10 / 0 | -18,140.700 | [-45,386.300, -2,505.550] | 0.0020 |
| sonnet | E1 | All | f1 | 0 / 0 / 10 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | E1 | All | exact | 0 / 0 / 10 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | E1 | All | api_turns | 0 / 7 / 3 | -2.500 | [-7.000, 0.000] | 0.0156 |
| sonnet | E1 | All | api_calls | 0 / 7 / 3 | -1.500 | [-4.000, 0.000] | 0.0156 |
| sonnet | E1 | All | tool_calls | 0 / 7 / 3 | -2.500 | [-7.000, 0.000] | 0.0156 |
| sonnet | E1 | All | wall_seconds | 2 / 8 / 0 | -4.149 | [-10.123, -0.649] | 0.1094 |
| sonnet | E1 | T1–T4 | f1 | 0 / 0 / 9 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | E1 | T1–T4 | exact | 0 / 0 / 9 | 0.000 | [0.000, 0.000] | 1.0000 |
| sonnet | E1 | T1+T2 | input_tokens | 0 / 4 / 0 | -90,741.500 | [-190,600.000, -47,944.000] | 0.1250 |
| sonnet | E1 | T1+T3 | api_calls | 0 / 4 / 2 | -1.500 | [-5.500, 0.000] | 0.1250 |
| haiku | E0 | All | input_tokens | 1 / 9 / 0 | -50,987.500 | [-115,493.000, -13,693.000] | 0.0215 |
| haiku | E0 | All | output_tokens | 0 / 10 / 0 | -1,758.000 | [-4,129.000, -1,444.500] | 0.0020 |
| haiku | E0 | All | weighted_tokens | 1 / 9 / 0 | -30,311.900 | [-66,328.200, -14,027.900] | 0.0215 |
| haiku | E0 | All | f1 | 3 / 0 / 7 | 0.000 | [0.000, 0.100] | 0.2500 |
| haiku | E0 | All | exact | 3 / 0 / 7 | 0.000 | [0.000, 1.000] | 0.2500 |
| haiku | E0 | All | api_turns | 0 / 9 / 1 | -6.000 | [-12.000, -3.000] | 0.0039 |
| haiku | E0 | All | api_calls | 0 / 9 / 1 | -4.000 | [-6.500, -1.500] | 0.0039 |
| haiku | E0 | All | tool_calls | 0 / 9 / 1 | -6.000 | [-12.000, -3.000] | 0.0039 |
| haiku | E0 | All | wall_seconds | 1 / 9 / 0 | -8.215 | [-17.295, -6.024] | 0.0215 |
| haiku | E0 | T1–T4 | f1 | 3 / 0 / 6 | 0.000 | [0.000, 0.200] | 0.2500 |
| haiku | E0 | T1–T4 | exact | 3 / 0 / 6 | 0.000 | [0.000, 1.000] | 0.2500 |
| haiku | E0 | T1+T2 | input_tokens | 0 / 4 / 0 | -121,530.500 | [-192,243.000, -49,315.000] | 0.1250 |
| haiku | E0 | T1+T3 | api_calls | 0 / 6 / 0 | -4.500 | [-7.500, -1.500] | 0.0312 |
| haiku | E1 | All | input_tokens | 1 / 9 / 0 | -34,005.500 | [-295,974.000, -13,334.000] | 0.0215 |
| haiku | E1 | All | output_tokens | 0 / 10 / 0 | -2,054.500 | [-5,621.500, -863.000] | 0.0020 |
| haiku | E1 | All | weighted_tokens | 1 / 9 / 0 | -33,738.100 | [-127,796.800, -10,669.500] | 0.0215 |
| haiku | E1 | All | f1 | 1 / 0 / 9 | 0.000 | [0.000, 0.000] | 1.0000 |
| haiku | E1 | All | exact | 1 / 0 / 9 | 0.000 | [0.000, 0.000] | 1.0000 |
| haiku | E1 | All | api_turns | 1 / 8 / 1 | -5.500 | [-14.500, -2.000] | 0.0391 |
| haiku | E1 | All | api_calls | 1 / 8 / 1 | -2.500 | [-6.500, -1.000] | 0.0391 |
| haiku | E1 | All | tool_calls | 1 / 8 / 1 | -5.500 | [-14.500, -2.000] | 0.0391 |
| haiku | E1 | All | wall_seconds | 0 / 10 / 0 | -8.096 | [-23.346, -2.758] | 0.0020 |
| haiku | E1 | T1–T4 | f1 | 1 / 0 / 8 | 0.000 | [0.000, 0.000] | 1.0000 |
| haiku | E1 | T1–T4 | exact | 1 / 0 / 8 | 0.000 | [0.000, 0.000] | 1.0000 |
| haiku | E1 | T1+T2 | input_tokens | 0 / 4 / 0 | -302,610.500 | [-489,695.000, -254,445.000] | 0.1250 |
| haiku | E1 | T1+T3 | api_calls | 0 / 6 / 0 | -4.000 | [-10.000, -2.000] | 0.0312 |

## Misses

All 20 E2 answers were exact. T2 order matched the scorer’s reference on both models. All ten frozen oracle answers were exact, with zero model F1 shortfalls relative to the oracle.

- sonnet tasks where E2 input did not improve over E1 (E2 vs E1) — v4-fb-05 (13,224 vs 12,493), v4-fb-07 (13,182 vs 11,183), v4-fb-10 (13,069 vs 11,061).
- sonnet S2 — 68,081 / ≤ 244,054.0 T1+T2 input; 7/10 cheaper (≥ 8).
- haiku v4-fb-04 — 5 built-in tool errors. The final answer was exact.
- haiku v4-fb-09 — 3 built-in tool errors. The final answer was exact.
- haiku tasks where E2 input did not improve over E1 (E2 vs E1) — v4-fb-10 (31,698 vs 19,573).
