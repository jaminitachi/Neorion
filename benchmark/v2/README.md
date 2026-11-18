# Neorion benchmark v2

The original pilot remains in `benchmark/pilot`. V2 has ten frozen questions,
one per diagnosis template, with five each for ai-chatbot and papermark.
`questions.cjs` derives candidate answers directly from pinned, clean Git
checkouts in the sibling `bench-repos/` directory. It uses TypeScript syntax
for JSX, hook calls, directives, and props, and static checks for route methods
and URL matching. JSX questions resolve named and default imports through
relative paths and the repositories' `@/` alias.

Selection favors cross-directory answers for file-list questions and ranks
ties by SHA-256 of the question with fixed seed `20261119`. It excludes file
answers that contain the target name. Directory-scoped questions and questions
whose answers are methods, props, component names or URLs follow their own
template scope. The concrete-route question has one matching file by design.
The action question targets the known component-free caller regression. Its
pinned export has one call site. Question selection uses source checks only.

## Prepare prompts

From the repository root, with the extension dependencies installed:

```sh
npm --prefix extension run compile
node benchmark/v2/questions.cjs verify
node benchmark/v2/contexts.cjs /tmp/neorion-v2-contexts /path/to/fixtures
python3 benchmark/v2/benchmark.py prompts /tmp/neorion-v2-contexts /tmp/neorion-v2-prompts.jsonl
```

The optional last argument to `contexts.cjs` adds the taxonomy, commerce,
and create-next-app fixture measurements. Contexts are generated from fresh
copies and the script prints `o200k_base` sizes. `verify` re-derives the
questions and verifies the SHA-256 before any prompts are emitted.

- **A** supplies the question, repository name, and answer-format instructions.
- **B** adds the overview and exactly one generated detail file.
- **D** adds the complete tracked file list.

For B, the selector uses the question text and generated detail files.
It lowercases alphanumeric words of at least two characters and splits camel
case. It prefers area paths explicitly mentioned in the question, then ranks
by distinct matching words in the area name, then by matching words across the
file weighted inversely by their frequency across detail files. Lexical
filename order breaks ties. Dependencies are excluded from this ranking.
The chooser receives the question string and context directory, without
access to reference answers. The chosen path is recorded for each B prompt.
The prepared prompts are self-contained for future tool-free model runs.

## Score saved answers

```sh
python3 benchmark/v2/benchmark.py grade responses.jsonl graded.jsonl
(cd benchmark/v2 && python3 -m unittest -v)
```

Each response row needs `id`, `condition`, and `response`. The grader uses the
last JSON object with an `answer` list, including objects in prose or fences.
It reports strict JSON formatting independently of normalized exact set
accuracy, precision, recall, and F1. Differing answer objects set the
ambiguity flag. The summary groups content accuracy, mean F1, and format
violations by condition.

There is no model runner in v2. No model calls were made to generate,
verify, or measure this benchmark.
