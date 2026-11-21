# Benchmark v7

Neorion build SHA `5d5cb82291d10d02ca6a07557d6e5c10e44d2090`. Rallly SHA `9ab01952cebd8db5165d0df1acaeeb5ea084b790`.

Amendment 1 defines the source-only tree checksum by excluding the specified Connect paths. The source hashes matched the archive at graph generation and after Connect. The runner separately verified the hashes or absence of each excluded path before and after every attempt. The two variants used their fixed section 4 paths and fresh session IDs.

Claude Code 2.1.327 ran with Claude.ai subscription authentication and credential environment variables stripped. Both variants used the same base system prompt. Preflight is excluded from all measured tables. Input tokens include uncached input, cache creation, and cache reads.

56 measured cells, 0 retries, and 0 final CLI failures.

## Totals

MCP attempts count distinct tool-use IDs emitted by the model.

| Model | Variant | Scope | Exact | Mean F1 | Input | Output | Weighted | Turns | Requests | Tools | MCP attempts | MCP successes | First-request input | Seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | E0 | All | 11/14 | 0.986 | 601,404 | 13,273 | 279,546.10 | 90 | 64 | 76 | 0 | 0 | 87,542 | 285.85 |
| sonnet | E0 | Structural | 9/12 | 0.984 | 575,692 | 12,724 | 267,753.20 | 86 | 60 | 74 | 0 | 0 | 75,203 | 278.26 |
| sonnet | E2 | All | 12/14 | 0.994 | 442,084 | 9,532 | 191,999.10 | 68 | 50 | 54 | 9 | 9 | 92,624 | 107.78 |
| sonnet | E2 | Structural | 10/12 | 0.993 | 414,923 | 9,028 | 180,155.20 | 64 | 46 | 52 | 9 | 9 | 79,559 | 100.88 |
| haiku | E0 | All | 11/14 | 0.975 | 996,644 | 45,516 | 677,603.00 | 149 | 71 | 135 | 0 | 0 | 99,078 | 208.03 |
| haiku | E0 | Structural | 9/12 | 0.971 | 952,102 | 44,186 | 658,122.30 | 143 | 65 | 131 | 0 | 0 | 85,091 | 199.28 |
| haiku | E2 | All | 13/14 | 0.992 | 869,698 | 36,269 | 530,173.40 | 132 | 71 | 118 | 12 | 7 | 104,160 | 244.76 |
| haiku | E2 | Structural | 11/12 | 0.991 | 813,804 | 34,448 | 504,704.80 | 125 | 64 | 113 | 12 | 7 | 89,447 | 233.55 |

| Alias | Resolved model IDs |
| --- | --- |
| sonnet | claude-sonnet-5-5 |
| haiku | claude-haiku-5-5 |

## Per task

Each cell gives input tokens, exact match, and F1. Tasks 13 and 14 are controls.

### sonnet

| Task | E0 | E2 |
| --- | --- | --- |
| v7-rallly-01 | 27,446 / yes / 1.000 | 13,609 / yes / 1.000 |
| v7-rallly-02 | 40,101 / yes / 1.000 | 47,999 / yes / 1.000 |
| v7-rallly-03 | 42,497 / yes / 1.000 | 13,993 / yes / 1.000 |
| v7-rallly-04 | 131,099 / no / 0.889 | 59,460 / no / 0.941 |
| v7-rallly-05 | 57,038 / no / 0.970 | 57,842 / no / 0.970 |
| v7-rallly-06 | 51,053 / yes / 1.000 | 13,390 / yes / 1.000 |
| v7-rallly-07 | 20,551 / yes / 1.000 | 14,555 / yes / 1.000 |
| v7-rallly-08 | 29,760 / yes / 1.000 | 14,381 / yes / 1.000 |
| v7-rallly-09 | 20,757 / yes / 1.000 | 30,377 / yes / 1.000 |
| v7-rallly-10 | 45,631 / yes / 1.000 | 14,622 / yes / 1.000 |
| v7-rallly-11 | 62,387 / yes / 1.000 | 66,827 / yes / 1.000 |
| v7-rallly-12 | 47,372 / no / 0.947 | 67,868 / yes / 1.000 |
| v7-rallly-13 | 13,104 / yes / 1.000 | 13,849 / yes / 1.000 |
| v7-rallly-14 | 12,608 / yes / 1.000 | 13,312 / yes / 1.000 |

### haiku

| Task | E0 | E2 |
| --- | --- | --- |
| v7-rallly-01 | 50,368 / yes / 1.000 | 34,673 / yes / 1.000 |
| v7-rallly-02 | 99,259 / yes / 1.000 | 46,772 / yes / 1.000 |
| v7-rallly-03 | 114,789 / yes / 1.000 | 58,332 / yes / 1.000 |
| v7-rallly-04 | 129,053 / no / 0.889 | 120,205 / no / 0.889 |
| v7-rallly-05 | 205,642 / no / 0.889 | 194,668 / yes / 1.000 |
| v7-rallly-06 | 72,719 / yes / 1.000 | 33,798 / yes / 1.000 |
| v7-rallly-07 | 25,546 / yes / 1.000 | 15,239 / yes / 1.000 |
| v7-rallly-08 | 34,966 / yes / 1.000 | 41,852 / yes / 1.000 |
| v7-rallly-09 | 53,577 / yes / 1.000 | 48,579 / yes / 1.000 |
| v7-rallly-10 | 47,996 / no / 0.875 | 62,898 / yes / 1.000 |
| v7-rallly-11 | 48,107 / yes / 1.000 | 72,820 / yes / 1.000 |
| v7-rallly-12 | 70,080 / yes / 1.000 | 83,968 / yes / 1.000 |
| v7-rallly-13 | 22,590 / yes / 1.000 | 32,072 / yes / 1.000 |
| v7-rallly-14 | 21,952 / yes / 1.000 | 23,822 / yes / 1.000 |

## Paired comparisons on structural tasks

Lower, higher, and tied refer to the first variant’s input. The median is second minus first in input tokens. The two-sided exact sign test excludes ties. The top-three share uses net savings and is undefined when net savings are zero or negative.

| Model | Comparison | Lower | Higher | Tied | Exact p | Median difference | Net savings | Savings rate | Top three differences | Top-three share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | E2 vs E0 | 7 | 5 | 0 | 0.774414 | 9,916.5 | 160,769 | 27.93% | 04 (+71,639), 06 (+37,663), 10 (+31,009) | 87.27% |
| haiku | E2 vs E0 | 8 | 4 | 0 | 0.387695 | 9,577.5 | 138,298 | 14.53% | 03 (+56,457), 02 (+52,487), 06 (+38,921) | 106.92% |

## Preregistered verdicts

| Model | Criterion | Verdict | Measured components |
| --- | --- | --- | --- |
| sonnet | P1 | Fail | E2/E0 input 72.07%, 7/12 lower |
| sonnet | P2 | Pass | E2/E0 exact 10/9, mean F1 0.993/0.984 |
| sonnet | P3 | Pass | E2/E0 input 105.64% |
| haiku | P1 | Fail | E2/E0 input 85.47%, 8/12 lower |
| haiku | P2 | Pass | E2/E0 exact 11/9, mean F1 0.991/0.971 |
| haiku | P3 | Fail | E2/E0 input 125.49% |

- **haiku** failed P3. The tools increased input-token cost on questions where the graph does not help.
- The v7 changes did not demonstrate input-token savings on the held-out repository under the preregistered rule.

## Control ratios

| Model | Task | E0 input | E2 input | E2/E0 |
| --- | --- | --- | --- | --- |
| sonnet | v7-rallly-13 | 13,104 | 13,849 | 105.69% |
| sonnet | v7-rallly-14 | 12,608 | 13,312 | 105.58% |
| haiku | v7-rallly-13 | 22,590 | 32,072 | 141.97% |
| haiku | v7-rallly-14 | 21,952 | 23,822 | 108.52% |

## Totals by task type

| Model | Variant | Type | Exact | Input | Output |
| --- | --- | --- | --- | --- | --- |
| sonnet | E0 | T1 | 3/3 | 110,044 | 2,216 |
| sonnet | E0 | T2 | 0/2 | 188,137 | 4,827 |
| sonnet | E0 | T3 | 3/3 | 101,364 | 2,028 |
| sonnet | E0 | T4 | 2/2 | 66,388 | 1,473 |
| sonnet | E0 | T7 | 1/2 | 109,759 | 2,180 |
| sonnet | E2 | T1 | 3/3 | 75,601 | 1,031 |
| sonnet | E2 | T2 | 0/2 | 117,302 | 3,598 |
| sonnet | E2 | T3 | 3/3 | 42,326 | 968 |
| sonnet | E2 | T4 | 2/2 | 44,999 | 945 |
| sonnet | E2 | T7 | 2/2 | 134,695 | 2,486 |
| haiku | E0 | T1 | 3/3 | 264,416 | 8,432 |
| haiku | E0 | T2 | 0/2 | 334,695 | 18,388 |
| haiku | E0 | T3 | 3/3 | 133,231 | 7,129 |
| haiku | E0 | T4 | 1/2 | 101,573 | 5,795 |
| haiku | E0 | T7 | 2/2 | 118,187 | 4,442 |
| haiku | E2 | T1 | 3/3 | 139,777 | 4,942 |
| haiku | E2 | T2 | 1/2 | 314,873 | 16,358 |
| haiku | E2 | T3 | 3/3 | 90,889 | 2,939 |
| haiku | E2 | T4 | 2/2 | 111,477 | 5,585 |
| haiku | E2 | T7 | 2/2 | 156,788 | 4,624 |

## Copy verification

| Variant | Verified attempts | Source tree SHA-256 |
| --- | --- | --- |
| E0 | 28 | 4eaecb5a93826baddec24f849714aefa4075df8c5100e851fc1d31ca3d5ede7a |
| E2 | 28 | 4eaecb5a93826baddec24f849714aefa4075df8c5100e851fc1d31ca3d5ede7a |

## Exact-match regressions

| Model | Transition | Tasks |
| --- | --- | --- |
| sonnet | E0 → E2 | None |
| haiku | E0 → E2 | None |

## All misses

### sonnet

- **v7-rallly-04 E0** (F1 0.889). Missing —. Extra `src/lib/datetime/client.tsx`, `src/lib/datetime/device.tsx`. Expected order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`. Submitted order `src/app/[locale]/layout.tsx`, `src/features/branding/client.tsx`, `src/features/instance-policy/client.tsx`, `src/lib/feature-flags/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`, `src/lib/datetime/device.tsx`, `src/lib/datetime/client.tsx`.
- **v7-rallly-05 E0** (F1 0.970). Missing —. Extra `src/app/[locale]/(space)/(dashboard)/loading.tsx`. Expected order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`, `src/app/[locale]/(space)/layout.tsx`, `src/features/user/client.tsx`, `src/lib/datetime/client.tsx`, `src/features/billing/client.tsx`, `src/features/space/client.tsx`, `src/app/[locale]/(space)/(dashboard)/layout.tsx`, `src/app/[locale]/(space)/(dashboard)/components/space-sidebar-provider.tsx`, `src/features/navigation/components/command-menu/command-menu.tsx`. Submitted order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`, `src/app/[locale]/(space)/layout.tsx`, `src/features/user/client.tsx`, `src/lib/datetime/client.tsx`, `src/features/billing/client.tsx`, `src/features/space/client.tsx`, `src/app/[locale]/(space)/(dashboard)/layout.tsx`, `src/app/[locale]/(space)/(dashboard)/components/space-sidebar-provider.tsx`, `src/features/navigation/components/command-menu/command-menu.tsx`, `src/app/[locale]/(space)/(dashboard)/loading.tsx`.
- **v7-rallly-12 E0** (F1 0.947). Missing —. Extra `src/app/[locale]/(space)/settings/notifications/page.tsx`.
- **v7-rallly-04 E2** (F1 0.941). Missing —. Extra `src/lib/datetime/device.tsx`. Expected order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`. Submitted order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`, `src/lib/datetime/device.tsx`.
- **v7-rallly-05 E2** (F1 0.970). Missing —. Extra `src/components/list-view.tsx`. Expected order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`, `src/app/[locale]/(space)/layout.tsx`, `src/features/user/client.tsx`, `src/lib/datetime/client.tsx`, `src/features/billing/client.tsx`, `src/features/space/client.tsx`, `src/app/[locale]/(space)/(dashboard)/layout.tsx`, `src/app/[locale]/(space)/(dashboard)/components/space-sidebar-provider.tsx`, `src/features/navigation/components/command-menu/command-menu.tsx`. Submitted order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`, `src/app/[locale]/(space)/layout.tsx`, `src/features/user/client.tsx`, `src/lib/datetime/client.tsx`, `src/features/billing/client.tsx`, `src/features/space/client.tsx`, `src/app/[locale]/(space)/(dashboard)/layout.tsx`, `src/app/[locale]/(space)/(dashboard)/components/space-sidebar-provider.tsx`, `src/features/navigation/components/command-menu/command-menu.tsx`, `src/components/list-view.tsx`.

### haiku

- **v7-rallly-04 E0** (F1 0.889). Missing —. Extra `src/lib/datetime/client.tsx`, `src/lib/datetime/device.tsx`. Expected order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`. Submitted order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`, `src/lib/datetime/device.tsx`, `src/lib/datetime/client.tsx`.
- **v7-rallly-05 E0** (F1 0.889). Missing —. Extra `src/app/[locale]/(space)/(dashboard)/loading.tsx`, `src/app/[locale]/error.tsx`, `src/app/[locale]/not-found.tsx`, `src/app/global-error.tsx`. Expected order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`, `src/app/[locale]/(space)/layout.tsx`, `src/features/user/client.tsx`, `src/lib/datetime/client.tsx`, `src/features/billing/client.tsx`, `src/features/space/client.tsx`, `src/app/[locale]/(space)/(dashboard)/layout.tsx`, `src/app/[locale]/(space)/(dashboard)/components/space-sidebar-provider.tsx`, `src/features/navigation/components/command-menu/command-menu.tsx`. Submitted order `src/app/global-error.tsx`, `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`, `src/app/[locale]/error.tsx`, `src/app/[locale]/not-found.tsx`, `src/app/[locale]/(space)/layout.tsx`, `src/features/user/client.tsx`, `src/lib/datetime/client.tsx`, `src/features/billing/client.tsx`, `src/features/space/client.tsx`, `src/app/[locale]/(space)/(dashboard)/layout.tsx`, `src/app/[locale]/(space)/(dashboard)/components/space-sidebar-provider.tsx`, `src/features/navigation/components/command-menu/command-menu.tsx`, `src/app/[locale]/(space)/(dashboard)/loading.tsx`.
- **v7-rallly-10 E0** (F1 0.875). Missing `src/lib/storage/asset-upload.ts`, `src/lib/storage/resolve-storage-url.ts`. Extra —.
- **v7-rallly-04 E2** (F1 0.889). Missing —. Extra `src/lib/datetime/client.tsx`, `src/lib/datetime/device.tsx`. Expected order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`. Submitted order `src/app/[locale]/layout.tsx`, `src/lib/feature-flags/client.tsx`, `src/features/instance-policy/client.tsx`, `src/features/branding/client.tsx`, `src/i18n/client.tsx`, `src/trpc/client/provider.tsx`, `src/lib/datetime/timezone-sync.tsx`, `src/app/[locale]/components/posthog-init.tsx`, `src/lib/datetime/device.tsx`, `src/lib/datetime/client.tsx`.

Per-run metrics, model responses, and scorer output are recorded in `run_metrics.jsonl`, `responses.jsonl`, and `scores.jsonl`. Raw CLI logs and transcripts are retained in the local benchmark workspace.
