# Neorion benchmark v3

Claude Code 2.1.327 resolved `opus` to `claude-opus-5-5`. All 40 measured sessions completed with Claude.ai subscription authentication. Each session used a fresh archive, the frozen prompt, and Read, Grep and Glob. The measured batch used three concurrent slots, a 10-minute timeout, and zero retries. The initial preflight batch was excluded because restricted mode skipped project instructions. All measured E1 transcripts contain the `CLAUDE.md` instructions written by the real Connect AI tools command.

Neorion commit `e425cbc77d510a2f471efa9b2e3002896aca0192` emitted `codebase_graph.md` and `neorion/graph/`. The frozen E1 system prompt still references `.neorion/graph/`. The graph manifest was written before the first CLI run. CLI JSON results and native JSONL session transcripts are stored locally in `runs/`. API calls count distinct transcript request IDs. API turns use the CLI `num_turns` field. USD values are CLI list-price estimates. Wall time measures the CLI process and includes startup.

## Variant and task-type results

| Scope | Variant | Runs | Mean F1 | Exact | Avg input tokens | Avg output tokens | Avg total tokens | Avg API turns | Avg API calls | Avg tools | Avg seconds | Avg weighted tokens | Avg CLI USD | Graph open | Avg graph bytes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| All | E0 | 20 | 0.988 | 19/20 | 29998.9 | 737.0 | 30735.9 | 5.40 | 4.25 | 4.40 | 11.36 | 14167.8 | 0.0515 | 0/20 | 0.0 |
| All | E1 | 20 | 0.975 | 18/20 | 32217.7 | 744.1 | 32961.8 | 5.45 | 4.35 | 4.45 | 14.88 | 15431.5 | 0.0562 | 11/20 | 843.9 |
| T1–T5 | E0 | 18 | 0.986 | 17/18 | 31976.7 | 794.2 | 32770.9 | 5.72 | 4.44 | 4.72 | 12.09 | 15178.0 | 0.0552 | 0/18 | 0.0 |
| T1–T5 | E1 | 18 | 0.972 | 16/18 | 34251.8 | 801.5 | 35053.3 | 5.78 | 4.56 | 4.78 | 15.96 | 16437.5 | 0.0599 | 10/18 | 851.8 |
| T1 | E0 | 5 | 1.000 | 5/5 | 59571.6 | 1450.6 | 61022.2 | 9.20 | 7.00 | 8.20 | 20.93 | 26814.6 | 0.0968 | 0/5 | 0.0 |
| T1 | E1 | 5 | 1.000 | 5/5 | 61906.0 | 1235.4 | 63141.4 | 8.40 | 6.80 | 7.40 | 17.71 | 28204.2 | 0.1021 | 4/5 | 2679.6 |
| T2 | E0 | 2 | 1.000 | 2/2 | 46487.0 | 1109.5 | 47596.5 | 9.00 | 5.50 | 8.00 | 14.81 | 24282.2 | 0.0893 | 0/2 | 0.0 |
| T2 | E1 | 2 | 1.000 | 2/2 | 45727.0 | 1430.0 | 47157.0 | 9.50 | 5.50 | 8.50 | 54.34 | 25984.5 | 0.0964 | 0/2 | 0.0 |
| T3 | E0 | 5 | 1.000 | 5/5 | 13617.4 | 412.4 | 14029.8 | 3.00 | 2.60 | 2.00 | 6.91 | 7294.9 | 0.0269 | 0/5 | 0.0 |
| T3 | E1 | 5 | 1.000 | 5/5 | 18476.8 | 437.2 | 18914.0 | 3.60 | 3.20 | 2.60 | 7.53 | 8626.8 | 0.0313 | 2/5 | 272.2 |
| T4 | E0 | 4 | 1.000 | 4/4 | 16333.0 | 287.2 | 16620.2 | 3.25 | 3.25 | 2.25 | 6.37 | 6108.8 | 0.0215 | 0/4 | 0.0 |
| T4 | E1 | 4 | 1.000 | 4/4 | 17789.8 | 373.8 | 18163.5 | 3.25 | 3.25 | 2.25 | 7.33 | 7238.4 | 0.0258 | 4/4 | 143.5 |
| T5 | E0 | 2 | 0.875 | 1/2 | 25664.5 | 806.5 | 26471.0 | 5.50 | 4.00 | 4.50 | 11.68 | 14828.4 | 0.0550 | 0/2 | 0.0 |
| T5 | E1 | 2 | 0.750 | 0/2 | 26002.5 | 854.5 | 26857.0 | 6.00 | 4.00 | 5.00 | 11.55 | 15398.6 | 0.0573 | 0/2 | 0.0 |

## Controls

| Scope | Variant | Runs | Mean F1 | Exact | Avg input tokens | Avg output tokens | Avg total tokens | Avg API turns | Avg API calls | Avg tools | Avg seconds | Avg weighted tokens | Avg CLI USD | Graph open | Avg graph bytes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| T6 | E0 | 2 | 1.000 | 2/2 | 12199.0 | 222.0 | 12421.0 | 2.50 | 2.50 | 1.50 | 4.75 | 5076.1 | 0.0182 | 0/2 | 0.0 |
| T6 | E1 | 2 | 1.000 | 2/2 | 13911.0 | 228.0 | 14139.0 | 2.50 | 2.50 | 1.50 | 5.15 | 6377.4 | 0.0231 | 1/2 | 772.5 |

## Task-specific scores

| Task | Variant | Metric | Score |
|---|---|---|---:|
| v3-ac-03 | E0 | Kendall tau | 1.000 |
| v3-ac-03 | E1 | Kendall tau | 1.000 |
| v3-ac-04 | E0 | Rename recall | 1.000 |
| v3-ac-04 | E1 | Rename recall | 1.000 |
| v3-ac-05 | E0 | Rename recall | 1.000 |
| v3-ac-05 | E1 | Rename recall | 1.000 |
| v3-ac-06 | E0 | Rename recall | 1.000 |
| v3-ac-06 | E1 | Rename recall | 1.000 |
| v3-ac-09 | E0 | Placement path | 1.000 |
| v3-ac-09 | E0 | Placement templates | 0.500 |
| v3-ac-09 | E1 | Placement path | 1.000 |
| v3-ac-09 | E1 | Placement templates | 0.500 |
| v3-pm-04 | E0 | Kendall tau | 1.000 |
| v3-pm-04 | E1 | Kendall tau | 1.000 |
| v3-pm-05 | E0 | Rename recall | 1.000 |
| v3-pm-05 | E1 | Rename recall | 1.000 |
| v3-pm-06 | E0 | Rename recall | 1.000 |
| v3-pm-06 | E1 | Rename recall | 1.000 |
| v3-pm-09 | E0 | Placement path | 1.000 |
| v3-pm-09 | E0 | Placement templates | 1.000 |
| v3-pm-09 | E1 | Placement path | 1.000 |
| v3-pm-09 | E1 | Placement templates | 0.500 |

## Paired differences (E1 minus E0)

| Task | Type | Δ F1 | Δ exact | Δ input tokens | Δ output tokens | Δ API turns | Δ API calls | Δ tools | Δ seconds | E1 graph open |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| v3-ac-01 | T1 | +0.000 | +0 | +14860 | +142 | +3 | +2 | +3 | +2.91 | yes |
| v3-ac-02 | T1 | +0.000 | +0 | -2546 | +259 | +0 | +0 | +0 | +2.11 | no |
| v3-ac-03 | T2 | +0.000 | +0 | +6926 | +440 | +2 | +1 | +2 | +78.12 | no |
| v3-ac-04 | T3 | +0.000 | +0 | +666 | -141 | +0 | +0 | +0 | -1.86 | no |
| v3-ac-05 | T3 | +0.000 | +0 | +7142 | -136 | +1 | +1 | +1 | -0.75 | no |
| v3-ac-06 | T3 | +0.000 | +0 | +8676 | +330 | +1 | +1 | +1 | +4.60 | yes |
| v3-ac-07 | T4 | +0.000 | +0 | +7481 | +356 | +1 | +1 | +1 | +4.16 | yes |
| v3-ac-08 | T4 | +0.000 | +0 | +1068 | -3 | +0 | +0 | +0 | -0.10 | yes |
| v3-ac-09 | T5 | +0.000 | +0 | +1550 | +136 | +1 | +0 | +1 | +1.00 | no |
| v3-ac-10 | T6 | +0.000 | +0 | +2744 | +12 | +0 | +0 | +0 | +0.29 | yes |
| v3-pm-01 | T1 | +0.000 | +0 | +4709 | +212 | +1 | +0 | +1 | +0.40 | yes |
| v3-pm-02 | T1 | +0.000 | +0 | -65668 | -1346 | -7 | -4 | -7 | -14.76 | yes |
| v3-pm-03 | T1 | +0.000 | +0 | +60317 | -343 | -1 | +1 | -1 | -6.78 | yes |
| v3-pm-04 | T2 | +0.000 | +0 | -8446 | +201 | -1 | -1 | -1 | +0.95 | no |
| v3-pm-05 | T3 | +0.000 | +0 | +623 | -18 | +0 | +0 | +0 | -0.15 | yes |
| v3-pm-06 | T3 | +0.000 | +0 | +7190 | +89 | +1 | +1 | +1 | +1.30 | no |
| v3-pm-07 | T4 | +0.000 | +0 | -4157 | -47 | -1 | -1 | -1 | -0.85 | yes |
| v3-pm-08 | T4 | +0.000 | +0 | +1435 | +40 | +0 | +0 | +0 | +0.65 | yes |
| v3-pm-09 | T5 | -0.250 | -1 | -874 | -40 | +0 | +0 | +0 | -1.26 | no |
| v3-pm-10 | T6 | +0.000 | +0 | +680 | +0 | +0 | +0 | +0 | +0.50 | no |

## Paired sign tests and confidence intervals

Two-sided exact sign tests exclude ties. Intervals are percentile 95% confidence intervals from 20,000 seeded bootstrap resamples of task pairs. Deltas use E1 minus E0.

| Scope | Metric | Positive / negative / tied | Median Δ | 95% CI | Sign-test p |
|---|---|---:|---:|---:|---:|
| All | f1 | 0 / 1 / 19 | 0.000 | [0.000, 0.000] | 1.0000 |
| All | exact | 0 / 1 / 19 | 0.000 | [0.000, 0.000] | 1.0000 |
| All | input_tokens | 15 / 5 / 0 | 1492.500 | [644.500, 7034.000] | 0.0414 |
| All | output_tokens | 11 / 8 / 1 | 26.000 | [-29.000, 171.500] | 0.6476 |
| All | api_turns | 8 / 4 / 8 | 0.000 | [0.000, 1.000] | 0.3877 |
| All | api_calls | 7 / 3 / 10 | 0.000 | [0.000, 1.000] | 0.3438 |
| All | tool_calls | 8 / 4 / 8 | 0.000 | [0.000, 1.000] | 0.3877 |
| All | wall_seconds | 12 / 8 / 0 | 0.451 | [-0.453, 1.153] | 0.5034 |
| All | weighted_tokens | 14 / 6 / 0 | 1451.750 | [-3.250, 2035.800] | 0.1153 |
| All | cli_list_cost_usd | 14 / 6 / 0 | 0.005 | [0.000, 0.008] | 0.1153 |
| T1–T5 | f1 | 0 / 1 / 17 | 0.000 | [0.000, 0.000] | 1.0000 |
| T1–T5 | exact | 0 / 1 / 17 | 0.000 | [0.000, 0.000] | 1.0000 |
| T1–T5 | input_tokens | 13 / 5 / 0 | 1492.500 | [-125.500, 7142.000] | 0.0963 |
| T1–T5 | output_tokens | 10 / 8 / 0 | 64.500 | [-43.500, 201.000] | 0.8145 |
| T1–T5 | api_turns | 8 / 4 / 6 | 0.000 | [0.000, 1.000] | 0.3877 |
| T1–T5 | api_calls | 7 / 3 / 8 | 0.000 | [0.000, 1.000] | 0.3438 |
| T1–T5 | tool_calls | 8 / 4 / 6 | 0.000 | [0.000, 1.000] | 0.3877 |
| T1–T5 | wall_seconds | 10 / 8 / 0 | 0.528 | [-0.754, 1.557] | 0.8145 |
| T1–T5 | weighted_tokens | 12 / 6 / 0 | 1451.750 | [-237.500, 2139.800] | 0.2379 |
| T1–T5 | cli_list_cost_usd | 12 / 6 / 0 | 0.005 | [-0.001, 0.009] | 0.2379 |
| T1 | f1 | 0 / 0 / 5 | 0.000 | [0.000, 0.000] | 1.0000 |
| T1 | exact | 0 / 0 / 5 | 0.000 | [0.000, 0.000] | 1.0000 |
| T1 | input_tokens | 3 / 2 / 0 | 4709.000 | [-65668.000, 60317.000] | 1.0000 |
| T1 | output_tokens | 3 / 2 / 0 | 142.000 | [-1346.000, 259.000] | 1.0000 |
| T1 | api_turns | 2 / 2 / 1 | 0.000 | [-7.000, 3.000] | 1.0000 |
| T1 | api_calls | 2 / 1 / 2 | 0.000 | [-4.000, 2.000] | 1.0000 |
| T1 | tool_calls | 2 / 2 / 1 | 0.000 | [-7.000, 3.000] | 1.0000 |
| T1 | wall_seconds | 3 / 2 / 0 | 0.405 | [-14.762, 2.912] | 1.0000 |
| T1 | weighted_tokens | 3 / 2 / 0 | 231.000 | [-19897.000, 21268.400] | 1.0000 |
| T1 | cli_list_cost_usd | 3 / 2 / 0 | 0.001 | [-0.067, 0.075] | 1.0000 |
| T2 | f1 | 0 / 0 / 2 | 0.000 | [0.000, 0.000] | 1.0000 |
| T2 | exact | 0 / 0 / 2 | 0.000 | [0.000, 0.000] | 1.0000 |
| T2 | input_tokens | 1 / 1 / 0 | -760.000 | [-8446.000, 6926.000] | 1.0000 |
| T2 | output_tokens | 2 / 0 / 0 | 320.500 | [201.000, 440.000] | 0.5000 |
| T2 | api_turns | 1 / 1 / 0 | 0.500 | [-1.000, 2.000] | 1.0000 |
| T2 | api_calls | 1 / 1 / 0 | 0.000 | [-1.000, 1.000] | 1.0000 |
| T2 | tool_calls | 1 / 1 / 0 | 0.500 | [-1.000, 2.000] | 1.0000 |
| T2 | wall_seconds | 2 / 0 / 0 | 39.533 | [0.947, 78.118] | 0.5000 |
| T2 | weighted_tokens | 2 / 0 / 0 | 1702.250 | [1695.500, 1709.000] | 0.5000 |
| T2 | cli_list_cost_usd | 2 / 0 / 0 | 0.007 | [0.005, 0.009] | 0.5000 |
| T3 | f1 | 0 / 0 / 5 | 0.000 | [0.000, 0.000] | 1.0000 |
| T3 | exact | 0 / 0 / 5 | 0.000 | [0.000, 0.000] | 1.0000 |
| T3 | input_tokens | 5 / 0 / 0 | 7142.000 | [623.000, 8676.000] | 0.0625 |
| T3 | output_tokens | 2 / 3 / 0 | -18.000 | [-141.000, 330.000] | 1.0000 |
| T3 | api_turns | 3 / 0 / 2 | 1.000 | [0.000, 1.000] | 0.2500 |
| T3 | api_calls | 3 / 0 / 2 | 1.000 | [0.000, 1.000] | 0.2500 |
| T3 | tool_calls | 3 / 0 / 2 | 1.000 | [0.000, 1.000] | 0.2500 |
| T3 | wall_seconds | 2 / 3 / 0 | -0.152 | [-1.859, 4.601] | 1.0000 |
| T3 | weighted_tokens | 3 / 2 / 0 | 1929.600 | [-1105.000, 4104.000] | 1.0000 |
| T3 | cli_list_cost_usd | 3 / 2 / 0 | 0.006 | [-0.005, 0.015] | 1.0000 |
| T3 | recall | 0 / 0 / 5 | 0.000 | [0.000, 0.000] | 1.0000 |
| T4 | f1 | 0 / 0 / 4 | 0.000 | [0.000, 0.000] | 1.0000 |
| T4 | exact | 0 / 0 / 4 | 0.000 | [0.000, 0.000] | 1.0000 |
| T4 | input_tokens | 3 / 1 / 0 | 1251.500 | [-4157.000, 7481.000] | 0.6250 |
| T4 | output_tokens | 2 / 2 / 0 | 18.500 | [-47.000, 356.000] | 1.0000 |
| T4 | api_turns | 1 / 1 / 2 | 0.000 | [-1.000, 1.000] | 1.0000 |
| T4 | api_calls | 1 / 1 / 2 | 0.000 | [-1.000, 1.000] | 1.0000 |
| T4 | tool_calls | 1 / 1 / 2 | 0.000 | [-1.000, 1.000] | 1.0000 |
| T4 | wall_seconds | 2 / 2 / 0 | 0.275 | [-0.854, 4.158] | 1.0000 |
| T4 | weighted_tokens | 3 / 1 / 0 | 888.350 | [-624.000, 3365.900] | 0.6250 |
| T4 | cli_list_cost_usd | 3 / 1 / 0 | 0.003 | [-0.002, 0.012] | 0.6250 |
| T5 | f1 | 0 / 1 / 1 | -0.125 | [-0.250, 0.000] | 1.0000 |
| T5 | exact | 0 / 1 / 1 | -0.500 | [-1.000, 0.000] | 1.0000 |
| T5 | input_tokens | 1 / 1 / 0 | 338.000 | [-874.000, 1550.000] | 1.0000 |
| T5 | output_tokens | 1 / 1 / 0 | 48.000 | [-40.000, 136.000] | 1.0000 |
| T5 | api_turns | 1 / 0 / 1 | 0.500 | [0.000, 1.000] | 1.0000 |
| T5 | api_calls | 0 / 0 / 2 | 0.000 | [0.000, 0.000] | 1.0000 |
| T5 | tool_calls | 1 / 0 / 1 | 0.500 | [0.000, 1.000] | 1.0000 |
| T5 | wall_seconds | 1 / 1 / 0 | -0.130 | [-1.265, 1.005] | 1.0000 |
| T5 | weighted_tokens | 1 / 1 / 0 | 570.200 | [-1170.900, 2311.300] | 1.0000 |
| T5 | cli_list_cost_usd | 1 / 1 / 0 | 0.002 | [-0.005, 0.009] | 1.0000 |
| T6 | f1 | 0 / 0 / 2 | 0.000 | [0.000, 0.000] | 1.0000 |
| T6 | exact | 0 / 0 / 2 | 0.000 | [0.000, 0.000] | 1.0000 |
| T6 | input_tokens | 2 / 0 / 0 | 1712.000 | [680.000, 2744.000] | 0.5000 |
| T6 | output_tokens | 1 / 0 / 1 | 6.000 | [0.000, 12.000] | 1.0000 |
| T6 | api_turns | 0 / 0 / 2 | 0.000 | [0.000, 0.000] | 1.0000 |
| T6 | api_calls | 0 / 0 / 2 | 0.000 | [0.000, 0.000] | 1.0000 |
| T6 | tool_calls | 0 / 0 / 2 | 0.000 | [0.000, 0.000] | 1.0000 |
| T6 | wall_seconds | 2 / 0 / 0 | 0.391 | [0.286, 0.497] | 0.5000 |
| T6 | weighted_tokens | 2 / 0 / 0 | 1301.300 | [499.300, 2103.300] | 0.5000 |
| T6 | cli_list_cost_usd | 2 / 0 / 0 | 0.005 | [0.002, 0.008] | 0.5000 |

## Preregistered hypotheses

| Hypothesis | Scope | E0 | E1 | Change | Criterion met |
|---|---|---:|---:|---:|---|
| H1 | T1 | 6 | 6 | +0.0% | no |
| H1 | T3 | 3 | 3 | +0.0% | no |
| H1 | T1 and T3 pooled | 3.0 | 4.0 | +33.3% | no |
| H2 | T3 mean recall | 1.000 | 1.000 | +0.000 | yes |
| H3 | T4 mean weighted_tokens | 6108.7500 | 7238.4000 | +18.5% | no |
| H3 | T4 mean cli_list_cost_usd | 0.0215 | 0.0258 | +19.9% | no |
| H3 | T6 mean weighted_tokens | 5076.1000 | 6377.4000 | +25.6% | no |
| H3 | T6 mean cli_list_cost_usd | 0.0182 | 0.0231 | +27.4% | no |
| H3 | T4 and T6 pooled mean weighted_tokens | 5764.5333 | 6951.4000 | +20.6% | no |
| H3 | T4 and T6 pooled mean cli_list_cost_usd | 0.0204 | 0.0249 | +22.2% | no |

H1 is evaluated for each task type. H3 reports both cost measures.

The preregistered decision rule returns **“no value for agents”** for this benchmark.

## Misses

- **v3-ac-09 E0** (F1 0.750). Templates outside the frozen candidate set `lib/db/queries.ts`.
- **v3-ac-09 E1** (F1 0.750). Templates outside the frozen candidate set `lib/db/queries.ts`.
- **v3-pm-09 E1** (F1 0.750). Templates outside the frozen candidate set `pages/api/teams/[teamId]/datarooms/[id]/stats.ts`.

## Graph error propagation

The E1 runs returned zero false-positive set items. Both E1 misses were T5 template choices made in sessions with zero graph opens.

The byte count measures returned graph text. A Grep result that only identifies a graph filename counts toward graph-open rate and contributes zero file-content bytes.
