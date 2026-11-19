# Amendment 1 (written before any preflight or measured run)

Problem: RUN_PLAN.md section 6 "결과가 최신" requires the copy tree.sha256 to equal the tree at graph generation time, but section 5 runs Connect after generateGraph, which edits CLAUDE.md and adds the MCP registration file. The two can never match.

Clarification (intent of section 6 is that the indexed SOURCE did not change after indexing):
* tree.sha256 is computed over all files EXCEPT the files Connect writes (CLAUDE.md, AGENTS.md, .cursor/rules/neorion.mdc, .mcp.json, .cursor/mcp.json, .vscode/mcp.json). This source-only tree.sha256 must be equal at graph generation time, after Connect, and before and after every measured run.
* The Connect-written files are recorded separately in graph_manifest.json with their hashes (CLAUDE.md before/after diff as section 5.4 already says), and must also be unchanged before and after every run.
* Section 4 copy reuse stands; the runner verifies both checks around every run.

Nothing in tasks, oracle, prompts, scorer or criteria changes. Disclose this amendment in RESULTS.md.
