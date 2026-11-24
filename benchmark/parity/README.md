# Parity benchmark: Neorion vs Graphify vs GitNexus

Across three apps, **Neorion scored 25/30, Graphify 17.5/30, and GitNexus 14/30** after the impact and call path rerun. On the two held-out apps alone, Neorion scored 16/20, Graphify 11/20, and GitNexus 8.5/20. Neorion 0.5.2 scored 21/30 in the original run. All 90 question cells ran (2026-11-24).

## Method

- **Apps.** Three lesser-known Next.js App Router apps, each with fewer than 100 stars when selected and shallow-cloned at a fixed commit.

  | App | Repo | Commit | Notes |
  | --- | --- | --- | --- |
  | slugy | [slugylink/slugy](https://github.com/slugylink/slugy) | `793df11` | URL shortener. Host-based rewrites, server actions, REST routes. |
  | rep-deck | [rudra-xi/rep-deck](https://github.com/rudra-xi/rep-deck) | `2a0dbea` | Strength-training tracker. Path aliases to barrel files, server actions reached through hooks. |
  | sharetab | [sw-carlos-cristobal/sharetab](https://github.com/sw-carlos-cristobal/sharetab) | `b802d71` | Bill splitting. Every route under `[locale]`, tRPC instead of server actions. |

- **Tools.** Neorion 0.5.2, Graphify 0.9.115 (`GRAPHIFY_BACKEND=none`, AST extraction only), GitNexus 1.6.12 (`gitnexus analyze --index-only`, `GITNEXUS_LBUG_EXTENSION_INSTALL=load-only`).
- **Native mode.** Only each tool's shipped CLI commands. No LLM calls, API keys, hand-written Cypher, or source-search commands. At most three commands per question cell.
- **Questions.** 10 per app, 2 in each of 5 categories:
  - **W** wrappers: the ordered layouts and providers around a route.
  - **R** which routes render a component.
  - **S** callers of a server action, or consumers of an API route or tRPC procedure.
  - **I** transitive impact: which routes are affected if X changes.
  - **P** path or relationship: a call chain, or what X calls.
- **Ground truth.** Every item was checked by reading the cited source lines at the pinned commit.
- **Scoring.** Correct = 1, partial = 0.5, wrong = 0. Unless a question specifies its own rubric, correct needs all required items and no wrong items. Partial needs at least half the required items and at most one wrong item. For wrapper questions, full credit requires the correct order, and partial credit requires every layout even if a provider is missing or the order is wrong. Asserting a listed trap item makes the answer wrong.

## Scores by app, tool and category

Each app has two questions per category. The all-app maximum is six points per category.

| App | Tool | W | R | S | I | P | Total |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| slugy | Neorion | 2 | 2 | 1 | 1.5 | 1 | 7.5/10 |
| slugy | Graphify | 0 | 2 | 1 | 2 | 1.5 | 6.5/10 |
| slugy | GitNexus | 0 | 2 | 0.5 | 2 | 1 | 5.5/10 |
| rep-deck | Neorion | 2 | 2 | 2 | 0.5 | 1 | 7.5/10 |
| rep-deck | Graphify | 0 | 2 | 2 | 2 | 1.5 | 7.5/10 |
| rep-deck | GitNexus | 0 | 1 | 1.5 | 0.5 | 1.5 | 4.5/10 |
| sharetab | Neorion | 2 | 2 | 1 | 1 | 0 | 6/10 |
| sharetab | Graphify | 0 | 2 | 0 | 1 | 0.5 | 3.5/10 |
| sharetab | GitNexus | 0 | 2 | 0 | 1.5 | 0.5 | 4/10 |
| **All apps** | **Neorion** | **6** | **6** | **4** | **3** | **2** | **21/30** |
| **All apps** | **Graphify** | **0** | **6** | **3** | **5** | **3.5** | **17.5/30** |
| **All apps** | **GitNexus** | **0** | **5** | **2** | **4** | **3** | **14/30** |

Where Neorion wins: wrappers (6/6, the other two 0/6) and server or API callers. Where it ties: renderers. In the original 0.5.2 run it lost on transitive impact (I) and call paths or callees (P), behind both other tools. See the rerun below.

## Rerun of impact and call path questions (`a70c2a6`)

After the original run, Neorion gained `impact`, `callees` and `path` queries. The 12 Neorion I and P cells were rerun with a CLI built from commit `a70c2a6`, using the same rubric and reviewed ground truth. The W, R and S scores and the Graphify and GitNexus scores are unchanged from the original run. slugy questions were used during development of the new queries, so rep-deck and sharetab are the held-out apps.

| App or cohort | Neorion, 0.5.2 → `a70c2a6` | Graphify | GitNexus |
| --- | ---: | ---: | ---: |
| rep-deck | 7.5/10 → 10/10 | 7.5/10 | 4.5/10 |
| sharetab | 6/10 → 6/10 | 3.5/10 | 4/10 |
| slugy (development checks) | 7.5/10 → 9/10 | 6.5/10 | 5.5/10 |
| **All apps** | **21/30 → 25/30** | **17.5/30** | **14/30** |

| Tool | W /6 | R /6 | S /6 | I /6 | P /6 | Overall /30 | Held-out /20 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Neorion `a70c2a6` | 6 | 6 | 4 | 5 | 4 | **25** | **16** |
| Graphify | 0 | 6 | 3 | 5 | 3.5 | **17.5** | **11** |
| GitNexus | 0 | 5 | 2 | 4 | 3 | **14** | **8.5** |

The three sharetab I and P cells that still score 0 involve tRPC procedures, which the rerun build did not trace.

## Index build times

Wall time includes process startup. All nine builds exited 0. Builds overlapped across tools, so these are observations from one run.

| App | Neorion 0.5.2 | Graphify 0.9.115 | GitNexus 1.6.12 |
| --- | ---: | ---: | ---: |
| slugy | 10.581 s | 6.596 s | 26.241 s |
| rep-deck | 4.954 s | 2.914 s | 12.095 s |
| sharetab | 10.629 s | 6.409 s | 18.296 s |
| **Sum** | **26.164 s** | **15.919 s** | **56.632 s** |

Graphify builds faster than Neorion on every app.

## Caveats

- **n = 1.** One run per cell, three apps, 30 questions. There is no variance estimate.
- **Automated reviewer.** An automated reviewer chose each tool's commands and follow-up targets within the three-command cap, and scored the answers. A different choice of commands can change how many candidates a tool verifies.
- **The questions lean toward Next.js features.** All three apps use the App Router. The six wrapper questions directly exercise Neorion's `wrappers` query, and literal HTTP questions line up with its `api_consumers` query. Graphify's transitive reverse-call traversal fits the impact questions. GitNexus's symbol content can expose calls that graph edges miss, subject to truncation.
- **Reduced modes.** Graphify ran without its LLM semantic pass. GitNexus's full-text (FTS/BM25) search was unavailable, and its index reported capped process coverage on all three apps. Empty or incomplete results reflect these settings.
- **Broad candidate sets.** rep-deck's alias barrels and sharetab's shared tRPC transport produce broad candidate sets. Scored answers had to narrow them to the requested renderer, caller or procedure.
- **Strict readings.** In slugy S2, Neorion's two production cache-key rows were counted as extra senders, as the tool labeled them, which made the answer wrong. In sharetab S2, Neorion's extra rows were tests outside the UI scope.
- No tool established either client mutation for sharetab S1.
