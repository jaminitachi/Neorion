# Neorion benchmark v2

The original pilot remains in `benchmark/pilot`. V2 freezes 20 questions,
with 10 each for ai-chatbot and papermark. `questions.cjs` derives candidates
from pinned, clean Git checkouts in the sibling `bench-repos/` directory. It
uses TypeScript syntax to find JSX, hook calls, server action calls and client
directives. Callers are resolved through named and default imports using
relative paths and the repositories' `@/` alias.

The generator samples from fixed template quotas. For ai-chatbot, the quotas
are four JSX caller sets, two client-scoped hook caller sets, three project
hook caller sets and one server action caller set. For papermark, they are two
each of JSX caller sets, project hook caller sets, page-to-component render
chains, client-scoped hook caller sets and page URLs linked by render chains.
It favors cross-directory file answers, then ranks candidates by SHA-256 of
the fixed seed `20261119` concatenated with the question. It skips subjects
already selected in that repository and file answers that contain the
normalized target name.

The frozen set was screened by reading the questions and answers for reliance
on repository-specific relationships. It excludes convention-driven concrete
route lookup, method-only answers, simple props and transitive URL sets with
fewer than three answers. The future condition-A screen measures whether
models can still recover those relationships from memory or guessing.

## Prepare prompts

From the repository root, with the extension dependencies installed:

```sh
npm --prefix extension run compile
node benchmark/v2/questions.cjs verify
node benchmark/v2/contexts.cjs /tmp/neorion-v2-contexts /path/to/fixtures
python3 benchmark/v2/benchmark.py prompts /tmp/neorion-v2-contexts /tmp/neorion-v2-prompts.jsonl
```

The optional last argument to `contexts.cjs` adds taxonomy, commerce and
create-next-app fixture measurements. The script generates fresh contexts,
checks literal links on disk and reports `o200k_base` sizes. Verification
re-derives the questions and checks the frozen SHA-256 before emitting prompts.

- **A** supplies the question, repository name and answer-format instructions.
- **B** adds the overview and up to three generated detail files.
- **D** adds the complete tracked file list.

For B, remove negative clauses beginning with words such as “exclude,” “omit,”
or “except” for ranking only. For example, “Exclude layouts” contributes
neither word. Rank all detail parts independently, skipping dependencies.
Prefer explicitly scoped directories and their descendants, then a matching Pages source row
when the question names a page URL, then exact subject headings in a reverse
index. For questions asking for page URLs, favor page rows that render the
named target or a recorded renderer of that target. Next compare whole-symbol
matches and the number of matching hook or
outgoing relationship rows. Break remaining ties by
the sum of inverse document frequencies of matching lowercase words, split at
camel-case boundaries, then by lexical filename order. The selector receives
the public question and generated context. Each B row records its ordered
`details` paths.

## Screen with condition A before the scored comparison

In a future run, send each A prompt in three fresh sessions with no files,
tools, history or other conditions visible. Use the same model and settings
planned for the scored comparison. Save rows with `id`, `condition: "A"`,
`attempt` (1 through 3) and `response`. Apply the same exact-content grading as
the main comparison:

```sh
python3 benchmark/v2/benchmark.py precheck a-screen-responses.jsonl a-screen-results.jsonl
```

Exclude questions answered exactly in all three attempts from the scored
comparison. Publish the original digest, screen results, excluded IDs and
remaining denominators. Collect fresh A responses for scoring alongside B and
D on the retained IDs. Keep the original frozen file unchanged. This
repository contains the offline screen and grader. Future model runs must
supply the responses.

## Score saved answers

```sh
python3 benchmark/v2/benchmark.py grade responses.jsonl graded.jsonl --coverage coverage.jsonl
(cd benchmark/v2 && python3 -m unittest -v)
```

Each response row needs `id`, `condition` and `response`. The grader uses the
last JSON object with an `answer` list, including objects in prose or fences.
It reports strict JSON formatting independently of normalized exact set
accuracy, precision, recall and F1. Differing answer objects set the ambiguity
flag. URL answers use leading slashes. File answers use repo-relative paths.

For the B coverage audit, compare each prepared B prompt with the gold answer
after prompt generation and independently of model responses. Save one row
per frozen question with `id`, `coverage` (`complete`, `partial` or `absent`)
and an `evidence` string citing the supporting file and relationship, or
identifying the missing relationship. For missing facts, check the full
generated graph and record whether the selector missed a supporting detail or
the graph omitted the fact. A render-chain answer requires evidence for both
edges. Coverage is excluded from prompts. The checked-in `coverage.jsonl` records
the audit for the frozen questions and the pinned generated contexts. Use a
fresh audit for different contexts. The optional audit input annotates B
grades and reports exact accuracy by coverage.
