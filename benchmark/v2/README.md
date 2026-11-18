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
fewer than three answers. Condition A also measures whether models can recover those relationships from memory or guessing.

## Prepare prompts

From the repository root, with the extension dependencies installed:

```sh
npm --prefix extension run compile
node benchmark/v2/questions.cjs verify
node benchmark/v2/contexts.cjs /tmp/neorion-v2-contexts /path/to/fixtures
python3 benchmark/v2/benchmark.py prompts /tmp/neorion-v2-contexts benchmark/v2/prompts.jsonl --include-agents
(cd benchmark/v2 && sha256sum -c prompts.sha256)
```

The optional last argument to `contexts.cjs` adds taxonomy, commerce and
create-next-app fixture measurements. The script generates fresh contexts,
checks literal links on disk and reports `o200k_base` sizes. Verification
re-derives the questions and checks the frozen SHA-256 before emitting prompts.

- **A** supplies the question, repository name and answer-format instructions.
- **B** adds the overview and up to three generated detail files.
- **D** adds the complete tracked file list.
- **E0** gives Claude Code a fresh copy of the pinned repository and the Read,
  Grep and Glob tools.
- **E1** uses the same tools in a separate fresh copy with the full
  `codebase_graph.md` and `.neorion/graph/` details. Its prompt mentions both.

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

The question set froze at `16fcabb`. The B selector gained scope ranking and
render-chain matching at `25170c9` after selected details had been compared
with frozen answers. Complete B coverage increased from 17/20 at freeze to
19/20 after the adjustment. q18 and q19 account for the increase. Always report
the full set and the subset excluding q18 and q19.

The ground-truth generator and graph analyzer compute the same imported JSX
and call relations. This structurally favors B, which measures how well a
model reads supplied graph facts. E measures the effect of making the graph
available to an agent that can independently inspect the same source.

## Run protocol

Freeze all 80 user prompts in `prompts.jsonl` together with the grader and
runner in `prompts.sha256` before sending any prompt. Run the logged-in
Claude Code CLI with `--model opus --output-format json` and subscription
authentication. A, B and D use fresh sessions in empty working directories
with tools disabled. Run A first, then B and D, then E. The 20 scored A
responses double as the guessability screen. A question is flagged when A
returns the exact answer set after normalization. Report both with and
without those IDs, including the combination with the selector exclusion.
The single A response is a screen for observed guessability in this run.

E selects five questions per repo by ascending SHA-256 of
`20261119:<question ID>`. The paired IDs are q04, q05, q06, q07 and q10 for
ai-chatbot and q11, q12, q13, q15 and q18 for papermark. Each E run starts
in its own clean snapshot of the pinned commit. E0 has neither graph artifact.
E1 adds only the graph overview and all generated Markdown detail files.

The runner caps the schedule at 80 planned calls plus four crash retries.
Use a fresh scratch directory for the run and preserve the per-attempt JSON,
including CLI failures. Session transcripts supply tool-use blocks keyed by
the JSON result's session ID. CLI `duration_ms` supplies wall time. Input
tokens sum uncached input, cache creation and cache reads. Strict accuracy
requires exact content and the requested JSON format. Content accuracy uses
the grader's normalized set comparison.

```sh
python3 benchmark/v2/run.py /tmp/neorion-v2-contexts /tmp/neorion-v2-run
```

## Score saved answers

```sh
python3 benchmark/v2/benchmark.py grade responses.jsonl graded.jsonl --coverage coverage.jsonl
(cd benchmark/v2 && python3 -m unittest -v)
```

Each response row needs `id`, `condition` and `response`. The grader uses the
last JSON object with an `answer` list, including objects in prose or fences.
It reports strict JSON formatting independently of normalized exact set
accuracy, precision, recall and F1. Differing answer objects set the ambiguity
flag. Component-name answers accept `path#Name` and `Name`. URL answers
accept an optional leading slash. File answers use repo-relative paths.

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
