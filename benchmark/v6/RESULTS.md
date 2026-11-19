# Benchmark v6

Neorion build SHA `458532dee1522cb1a3098b128b57f348018f8485`. Dub SHA `6b463b4bdd9ed2fd9aa416f67b5b77d317b1471e`.

Amendment 1 replaced the original Neorion pin `4a9e3fc` after the initial `who_renders` preflight probe on dub exposed a bug. The tasks remained held-out. The fix means the evaluation was only partially blind with respect to the repository. The graph and index were generated with the amended commit and its source unchanged.

Claude Code 2.1.327 ran with Claude.ai subscription authentication and credential environment variables stripped. Each model, task, and variant used a fresh git archive and a new session. Both models passed preflight, which was excluded from measurement. All tables draw from the final measured attempts. Input includes uncached input, cache creation, and cache reads.

66 measured cells, 0 retries, and 0 final CLI failures.

## Totals

MCP attempts count distinct tool-use IDs emitted by the model. E3 exposed no MCP tools. Its MCP attempts returned unavailable-tool errors.

| Model | Variant | Scope | Exact | Mean F1 | Input | Output | Weighted | Turns | Requests | Tools | MCP attempts | MCP successes | Graph reads | Graph bytes | First-request input | Seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | E0 | All | 10/11 | 0.990 | 282,328 | 7,942 | 146,053.20 | 64 | 44 | 53 | 0 | 0 | 0 | 0 | 51,367 | 199.90 |
| sonnet | E0 | Structural | 9/10 | 0.989 | 272,676 | 7,668 | 141,198.80 | 62 | 42 | 52 | 0 | 0 | 0 | 0 | 46,818 | 195.68 |
| sonnet | E2 | All | 10/11 | 0.959 | 255,435 | 4,899 | 104,868.90 | 41 | 36 | 30 | 10 | 10 | 0 | 0 | 68,942 | 60.64 |
| sonnet | E2 | Structural | 9/10 | 0.955 | 242,591 | 4,625 | 99,241.20 | 39 | 34 | 29 | 10 | 10 | 0 | 0 | 62,797 | 57.97 |
| sonnet | E3 | All | 11/11 | 1.000 | 358,215 | 9,063 | 175,964.20 | 74 | 51 | 63 | 9 | 0 | 0 | 0 | 55,606 | 89.26 |
| sonnet | E3 | Structural | 10/10 | 1.000 | 347,795 | 8,789 | 170,578.90 | 72 | 49 | 62 | 9 | 0 | 0 | 0 | 50,673 | 86.39 |
| haiku | E0 | All | 10/11 | 0.996 | 716,410 | 36,665 | 472,065.20 | 131 | 62 | 120 | 0 | 0 | 0 | 0 | 60,434 | 208.41 |
| haiku | E0 | Structural | 9/10 | 0.996 | 698,952 | 36,112 | 464,106.20 | 128 | 59 | 118 | 0 | 0 | 0 | 0 | 55,061 | 205.08 |
| haiku | E2 | All | 10/11 | 0.995 | 435,804 | 20,130 | 264,736.90 | 83 | 48 | 72 | 10 | 10 | 0 | 0 | 78,002 | 101.80 |
| haiku | E2 | Structural | 9/10 | 0.994 | 405,461 | 19,285 | 252,796.40 | 79 | 44 | 69 | 10 | 10 | 0 | 0 | 71,029 | 96.51 |
| haiku | E3 | All | 11/11 | 1.000 | 858,956 | 36,751 | 489,839.80 | 134 | 76 | 123 | 7 | 0 | 0 | 0 | 64,676 | 353.21 |
| haiku | E3 | Structural | 10/10 | 1.000 | 840,080 | 35,742 | 478,649.60 | 130 | 73 | 120 | 7 | 0 | 0 | 0 | 58,917 | 347.99 |

| Alias | Resolved model IDs |
| --- | --- |
| sonnet | claude-sonnet-5-5 |
| haiku | claude-haiku-5-5 |

## Per task

Each cell gives input tokens, exact match, and F1. Task 11 is the control.

### sonnet

| Task | E0 | E2 | E3 |
| --- | --- | --- | --- |
| v6-dub-01 | 35,118 / yes / 1.000 | 26,941 / yes / 1.000 | 38,746 / yes / 1.000 |
| v6-dub-02 | 22,444 / yes / 1.000 | 20,176 / yes / 1.000 | 30,033 / yes / 1.000 |
| v6-dub-03 | 31,225 / yes / 1.000 | 20,170 / yes / 1.000 | 42,128 / yes / 1.000 |
| v6-dub-04 | 38,351 / no / 0.889 | 38,155 / yes / 1.000 | 45,668 / yes / 1.000 |
| v6-dub-05 | 55,285 / yes / 1.000 | 13,225 / yes / 1.000 | 75,544 / yes / 1.000 |
| v6-dub-06 | 10,390 / yes / 1.000 | 12,934 / yes / 1.000 | 12,903 / yes / 1.000 |
| v6-dub-07 | 15,461 / yes / 1.000 | 26,280 / yes / 1.000 | 22,454 / yes / 1.000 |
| v6-dub-08 | 16,724 / yes / 1.000 | 20,527 / yes / 1.000 | 22,636 / yes / 1.000 |
| v6-dub-09 | 22,259 / yes / 1.000 | 21,303 / no / 0.545 | 30,163 / yes / 1.000 |
| v6-dub-10 | 25,419 / yes / 1.000 | 42,880 / yes / 1.000 | 27,520 / yes / 1.000 |
| v6-dub-11 | 9,652 / yes / 1.000 | 12,844 / yes / 1.000 | 10,420 / yes / 1.000 |

### haiku

| Task | E0 | E2 | E3 |
| --- | --- | --- | --- |
| v6-dub-01 | 53,846 / yes / 1.000 | 22,413 / yes / 1.000 | 62,656 / yes / 1.000 |
| v6-dub-02 | 52,813 / yes / 1.000 | 24,428 / yes / 1.000 | 205,731 / yes / 1.000 |
| v6-dub-03 | 100,816 / yes / 1.000 | 27,506 / yes / 1.000 | 114,099 / yes / 1.000 |
| v6-dub-04 | 90,048 / yes / 1.000 | 46,382 / yes / 1.000 | 86,823 / yes / 1.000 |
| v6-dub-05 | 169,833 / no / 0.957 | 56,428 / yes / 1.000 | 117,813 / yes / 1.000 |
| v6-dub-06 | 20,181 / yes / 1.000 | 14,644 / yes / 1.000 | 40,625 / yes / 1.000 |
| v6-dub-07 | 20,431 / yes / 1.000 | 30,783 / no / 0.941 | 42,889 / yes / 1.000 |
| v6-dub-08 | 19,707 / yes / 1.000 | 51,254 / yes / 1.000 | 44,108 / yes / 1.000 |
| v6-dub-09 | 129,692 / yes / 1.000 | 58,558 / yes / 1.000 | 59,507 / yes / 1.000 |
| v6-dub-10 | 41,585 / yes / 1.000 | 73,065 / yes / 1.000 | 65,829 / yes / 1.000 |
| v6-dub-11 | 17,458 / yes / 1.000 | 30,343 / yes / 1.000 | 18,876 / yes / 1.000 |

## Paired comparisons on structural tasks

Lower, higher, and tied refer to the first variant’s input. The median is second minus first in input tokens. The two-sided exact sign test excludes ties. The top-three share uses net savings and is undefined when net savings are zero or negative.

| Model | Comparison | Lower | Higher | Tied | Exact p | Median difference | Net savings | Savings rate | Top three differences | Top-three share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | E2 vs E0 | 6 | 4 | 0 | 0.753906 | 576.0 | 30,085 | 11.03% | 05 (+42,060), 03 (+11,055), 01 (+8,177) | 203.73% |
| sonnet | E2 vs E3 | 7 | 3 | 0 | 0.343750 | 8,186.5 | 105,204 | 30.25% | 05 (+62,319), 03 (+21,958), 01 (+11,805) | 91.33% |
| sonnet | E3 vs E0 | 0 | 10 | 0 | 0.001953 | -7,155.0 | -75,119 | -27.55% | 10 (-2,101), 06 (-2,513), 01 (-3,628) | — |
| haiku | E2 vs E0 | 7 | 3 | 0 | 0.343750 | 29,909.0 | 293,491 | 41.99% | 05 (+113,405), 03 (+73,310), 09 (+71,134) | 87.86% |
| haiku | E2 vs E3 | 8 | 2 | 0 | 0.109375 | 33,112.0 | 434,619 | 51.74% | 02 (+181,303), 03 (+86,593), 05 (+61,385) | 75.76% |
| haiku | E3 vs E0 | 3 | 7 | 0 | 0.343750 | -16,863.5 | -141,128 | -20.19% | 09 (+70,185), 05 (+52,020), 04 (+3,225) | — |

## Preregistered verdicts

| Model | Criterion | Verdict | Measured components |
| --- | --- | --- | --- |
| sonnet | P1 | Fail | E2/E0 input 88.97%, 6/10 lower |
| sonnet | P2 | Fail | E2/E0 exact 9/9, mean F1 0.955/0.989 |
| sonnet | P3 | Fail | E2/E3 input 69.75%, 7/10 lower, exact 9/10 |
| sonnet | P4 | Fail | E2/E0 input 133.07%, exact 1/1 |
| haiku | P1 | Fail | E2/E0 input 58.01%, 7/10 lower |
| haiku | P2 | Pass | E2/E0 exact 9/9, mean F1 0.994/0.996 |
| haiku | P3 | Fail | E2/E3 input 48.26%, 8/10 lower, exact 9/10 |
| haiku | P4 | Fail | E2/E0 input 173.81%, exact 1/1 |

- **sonnet** failed P4. E2 increased control-task input by 3,192 tokens.
- **haiku** failed P4. E2 increased control-task input by 12,885 tokens.
- The v5 input-token savings did not reproduce on the held-out tasks under the preregistered rule.

## Exact-match regressions

| Model | Transition | Tasks |
| --- | --- | --- |
| sonnet | E0 → E2 | v6-dub-09 |
| sonnet | E3 → E2 | v6-dub-09 |
| sonnet | E0 → E3 | None |
| haiku | E0 → E2 | v6-dub-07 |
| haiku | E3 → E2 | v6-dub-07 |
| haiku | E0 → E3 | None |

## All misses

### sonnet

- **v6-dub-04 E0** (F1 0.889). Missing —. Extra `app/app.dub.co/(onboarding)/workspaces/page.tsx`. Expected order `app/layout.tsx`, `app/providers.tsx`, `app/app.dub.co/layout.tsx`, `app/app.dub.co/(onboarding)/layout.tsx`. Submitted order `app/layout.tsx`, `app/providers.tsx`, `app/app.dub.co/layout.tsx`, `app/app.dub.co/(onboarding)/layout.tsx`, `app/app.dub.co/(onboarding)/workspaces/page.tsx`.
- **v6-dub-09 E2** (F1 0.545). Missing `app/app.dub.co/(dashboard)/[slug]/(ee)/settings/webhooks/[webhookId]/edit/page-client.tsx`, `app/app.dub.co/(dashboard)/[slug]/(ee)/settings/webhooks/new/page-client.tsx`, `lib/integrations/segment/ui/settings.tsx`, `lib/integrations/slack/ui/settings.tsx`, `lib/integrations/zapier/ui/settings.tsx`. Extra —.

### haiku

- **v6-dub-05 E0** (F1 0.957). Missing —. Extra `app/app.dub.co/(dashboard)/loading.tsx`. Expected order `app/layout.tsx`, `app/providers.tsx`, `app/app.dub.co/layout.tsx`, `app/app.dub.co/(dashboard)/layout.tsx`, `ui/modals/modal-provider.tsx`, `ui/layout/main-nav.tsx`, `app/app.dub.co/(dashboard)/[slug]/layout.tsx`, `app/app.dub.co/(dashboard)/[slug]/auth.tsx`, `app/app.dub.co/(dashboard)/[slug]/(ee)/settings/webhooks/layout.tsx`, `ui/layout/page-content/index.tsx`, `ui/layout/page-width-wrapper.tsx`. Submitted order `app/layout.tsx`, `app/providers.tsx`, `app/app.dub.co/layout.tsx`, `app/app.dub.co/(dashboard)/layout.tsx`, `ui/modals/modal-provider.tsx`, `ui/layout/main-nav.tsx`, `app/app.dub.co/(dashboard)/loading.tsx`, `app/app.dub.co/(dashboard)/[slug]/layout.tsx`, `app/app.dub.co/(dashboard)/[slug]/auth.tsx`, `app/app.dub.co/(dashboard)/[slug]/(ee)/settings/webhooks/layout.tsx`, `ui/layout/page-content/index.tsx`, `ui/layout/page-width-wrapper.tsx`.
- **v6-dub-07 E2** (F1 0.941). Missing —. Extra `lib/api/links/index.ts`.

Per-run metrics, model responses, and scorer output are recorded in `run_metrics.jsonl`, `responses.jsonl`, and `scores.jsonl`. Raw CLI logs and transcripts are retained in the local benchmark workspace.
