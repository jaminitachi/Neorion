# Amendment 1 (written before any measured run)

Preflight with Neorion 4a9e3fc failed: MCP who_renders returned 0 results for a probe target (a component rendered through a hook-returned useCallback component). This was a real Neorion bug.

Codex fixed it in 458532d without opening tasks.jsonl, oracle.jsonl or prompts (only preflight logs). Claude review 12 checked the fix log, confirmed no special casing, and passed it (see /workspace/neorion-work/claude_review12.md).

Decision by the PO bot: the measured runs use Neorion 458532d instead of the pinned 4a9e3fc. No frozen file (tasks, oracle, prompts, scorer, criteria) is changed. This deviation must be disclosed in RESULTS.md: the Neorion build was fixed after seeing one preflight probe failure on this repo, so the result is held-out with respect to the tasks but not fully blind with respect to the repo.
