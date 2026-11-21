# Neorion benchmark v5

[RESULTS.md](RESULTS.md) reports the 20 E2 sessions against v4 E0 and E1. The benchmark used Claude Code 2.1.327 in JSON output mode and Claude.ai subscription credentials. The CLI transcript records requests and tool activity. Results use the v4 scorer and task IDs.

## Files

- `SHA256SUMS` records the v4 checksums of the copied task, scorer, prompts, and run order files, plus the frozen E2 prompts, server and graph manifest, and tool-only oracle. These checks passed before measured execution.
- `e2_prompts.jsonl` follows the E0 subset of the frozen v4 order. Each row preserves the v4 user prompt and base system prompt and appends the v5 design's E2 hint.
- `graph_manifest.json` records the graph, index, registration, CLAUDE.md diff, and bundle hashes. The benchmark archived the pinned Formbricks `apps/web` subtree for every session and copied in the frozen files. `frozen/` holds the byte-verified E1 overview and the two instruction and configuration files produced by Connect AI tools.
- `oracle.jsonl` records one local stdio query per task and the unmodified scorer's evaluation of the positive rows. For the reference-only control, the oracle excludes the declaration. Wrapper answers use the numbered wrapper rows.
- `preflight/verified.json` holds the excluded preflight evidence, including actual results and tool schemas. Claude Code exposed a reserved deferred-tool placeholder in its internal schema.
- `run_metrics.jsonl`, `scores.jsonl`, `responses.jsonl`, and `attempts.json` contain the measured results and attempt metadata. `v4_initial_input.jsonl` records the first-request usage read from the v4 transcripts for the input decomposition.
- Full CLI JSON and session transcripts remain in the local workspace's `runs/` and `preflight/` directories. The repository copy retains the derived records and preflight verification.

## Running in the workspace

The scripts expect to run from `/workspace/neorion-work/bench-v5`, with `../Neorion`, `../bench-repos/formbricks`, and `../bench-v4` available. Use the Neorion source commit and FormBricks commit from the manifest. Build and pack from the extension directory with `npm run pack:mcp`. Prepare a fresh archive at `/tmp/neorion-bench-v5/app`, run `node prepare.cjs /tmp/neorion-bench-v5/app`, then copy `frozen/e1-codebase_graph.md` to the archive's `codebase_graph.md`. The preparation script uses the extension test host to exercise the actual graph and Connect AI tools commands.

For a new run, freeze a new manifest and oracle using `freeze.py` and `oracle.py` before updating the checksum file. A rebuilt index contains its own generation timestamp. Run `python3 run.py preflight`, then `python3 run.py measure` with an empty runs directory, and `python3 report.py` to generate the report. The runner allows three concurrent sessions, a 600-second timeout, and four total retries for eligible infrastructure failures.
