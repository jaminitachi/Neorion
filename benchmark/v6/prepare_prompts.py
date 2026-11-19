#!/usr/bin/env python3
"""Build prompts.jsonl (66 rows: 11 tasks x 2 models x E0/E2/E3) and the seeded run order for benchmark v6.

This script never calls a model. It only writes files.
Usage: python3 prepare_prompts.py   -> prompts.jsonl, run_order.json

SYSTEM_BASE is the v4 base system prompt, byte for byte. NEORION_HINT is the v5 E2 hint, byte for byte
(bench-v5/freeze.py). E2 and E3 get the same hint; E3 simply has no MCP server behind it.
"""
import hashlib
import itertools
import json

SEED = "neorion-bench-v6-20261119"
MODELS = ("sonnet", "haiku")
VARIANTS = ("E0", "E2", "E3")

SYSTEM_BASE = (
    "You are working in a read-only copy of a TypeScript repository at a pinned commit. "
    "Use the Read, Grep and Glob tools to inspect it. Do not modify files. "
    "When you are done, reply with only the JSON object the question asks for."
)
NEORION_HINT = (
    "This repository has Neorion query tools (mcp__neorion__neorion_who_renders, neorion_wrappers, "
    "neorion_rename_impact, neorion_api_consumers, neorion_search). For structural questions "
    "(which routes render a component, which layouts and providers wrap a route, which files a rename "
    "touches, which files call an API route), call the matching tool first. Results list path:line; "
    "confirm by reading only those lines instead of re-deriving the chain from source."
)


def h(*parts):
    return hashlib.sha256("|".join((SEED,) + parts).encode()).hexdigest()


def main():
    tasks = [json.loads(l) for l in open("tasks.jsonl", encoding="utf-8") if l.strip()]
    v5 = json.loads(open("../bench-v5/e2_prompts.jsonl", encoding="utf-8").readline())["append_system_prompt"]
    assert v5 == SYSTEM_BASE + "\n\n" + NEORION_HINT, "E2 system prompt must equal the v5 E2 system prompt"
    rows = []
    for t in tasks:
        for m in MODELS:
            for v in VARIANTS:
                system = SYSTEM_BASE if v == "E0" else SYSTEM_BASE + "\n\n" + NEORION_HINT
                rows.append({
                    "id": t["id"], "model": m, "variant": v, "repo": t["repo"], "app_subdir": t["app_subdir"],
                    "commit": t["commit"], "type": t["type"],
                    "append_system_prompt": system, "user_prompt": t["question"],
                })
    # Seeded order over (model, task) blocks; inside a block the three variants run back to back
    # in a seeded permutation.
    perms = list(itertools.permutations(VARIANTS))
    blocks = sorted(((m, t["id"]) for m in MODELS for t in tasks), key=lambda b: h("order", b[0], b[1]))
    run_order = []
    for m, tid in blocks:
        perm = perms[int(h("perm", m, tid)[:8], 16) % len(perms)]
        run_order += [{"id": tid, "model": m, "variant": v} for v in perm]
    with open("prompts.jsonl", "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open("run_order.json", "w", encoding="utf-8") as f:
        json.dump(run_order, f, indent=1)
    print(f"{len(rows)} prompts, {len(run_order)} runs in order")


if __name__ == "__main__":
    main()
