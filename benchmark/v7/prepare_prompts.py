#!/usr/bin/env python3
"""Build prompts.jsonl (56 rows: 14 tasks x 2 models x E0/E2) and the seeded run order for benchmark v7.

This script never calls a model. It only writes files.
Usage: python3 prepare_prompts.py   -> prompts.jsonl, run_order.json

SYSTEM_BASE is the v4 base system prompt, byte for byte (asserted against bench-v6/prepare_prompts.py).
v7 has no runner hint: E0 and E2 get exactly the same system prompt. Anything Neorion tells the model
comes from what the product itself installs (CLAUDE.md block written by Connect, MCP tool descriptions).
"""
import hashlib
import itertools
import json
import re

SEED = "neorion-bench-v7-20261120"
MODELS = ("sonnet", "haiku")
VARIANTS = ("E0", "E2")

SYSTEM_BASE = (
    "You are working in a read-only copy of a TypeScript repository at a pinned commit. "
    "Use the Read, Grep and Glob tools to inspect it. Do not modify files. "
    "When you are done, reply with only the JSON object the question asks for."
)


def h(*parts):
    return hashlib.sha256("|".join((SEED,) + parts).encode()).hexdigest()


def main():
    v6 = open("../bench-v6/prepare_prompts.py", encoding="utf-8").read()
    m = re.search(r"SYSTEM_BASE = \((.*?)\n\)", v6, re.S)
    assert m and eval("(" + m.group(1) + ")") == SYSTEM_BASE, "SYSTEM_BASE must equal the v4/v6 base prompt"
    tasks = [json.loads(l) for l in open("tasks.jsonl", encoding="utf-8") if l.strip()]
    assert len(tasks) == 14
    rows = []
    for t in tasks:
        for mdl in MODELS:
            for v in VARIANTS:
                rows.append({
                    "id": t["id"], "model": mdl, "variant": v, "repo": t["repo"], "app_subdir": t["app_subdir"],
                    "commit": t["commit"], "type": t["type"],
                    "append_system_prompt": SYSTEM_BASE, "user_prompt": t["question"],
                })
    # Seeded order over (model, task) blocks; inside a block the two variants run back to back
    # in a seeded order.
    perms = list(itertools.permutations(VARIANTS))
    blocks = sorted(((mdl, t["id"]) for mdl in MODELS for t in tasks), key=lambda b: h("order", b[0], b[1]))
    run_order = []
    for mdl, tid in blocks:
        perm = perms[int(h("perm", mdl, tid)[:8], 16) % len(perms)]
        run_order += [{"id": tid, "model": mdl, "variant": v} for v in perm]
    with open("prompts.jsonl", "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open("run_order.json", "w", encoding="utf-8") as f:
        json.dump(run_order, f, indent=1)
    print(f"{len(rows)} prompts, {len(run_order)} runs in order")


if __name__ == "__main__":
    main()
