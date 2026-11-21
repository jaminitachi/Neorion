#!/usr/bin/env python3
"""Benchmark v4 scorer (v3 scorer, unchanged metrics). Standard library only.

v4 changes: file paths also lose an "apps/web/" or "<repo>/apps/web/" prefix (task field app_subdir),
rows may carry "model", and the summary groups by (model, variant).

Usage:
  python3 score.py tasks.jsonl responses.jsonl [--out scores.jsonl]
  python3 score.py --self-test

responses.jsonl rows: {"id": "v4-fb-01", "model": "sonnet", "variant": "E0", "text": "<final model text>"}
or {"id": ..., "variant": ..., "answer": <already parsed answer>}.
"""
import json
import re
import sys


def extract_answer(text):
    """Return the value of "answer" from the last parseable JSON object in text, else None."""
    if text is None:
        return None
    dec = json.JSONDecoder()
    # scan every "{" from the last one backwards; the last complete object carrying "answer" wins
    for m in reversed(list(re.finditer(r"\{", text))):
        try:
            obj, _ = dec.raw_decode(text[m.start():])
        except ValueError:
            continue
        if isinstance(obj, dict) and "answer" in obj:
            return obj["answer"]
    return None


def norm_file(p, repo, app_subdir=None):
    p = str(p).strip().strip("`'\"").replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    prefixes = (repo + "/" + app_subdir + "/", app_subdir + "/") if app_subdir else ()
    for prefix in prefixes + (repo + "/", "/"):
        if p.startswith(prefix):
            p = p[len(prefix):]
    return p


def norm_route(r):
    r = str(r).strip().strip("`'\"")
    r = r.split("?")[0]
    if not r.startswith("/"):
        r = "/" + r
    r = re.sub(r"/+", "/", r)
    if len(r) > 1:
        r = r.rstrip("/")
    return r


def prf(pred, gold):
    pred, gold = set(pred), set(gold)
    tp = len(pred & gold)
    p = tp / len(pred) if pred else 0.0
    r = tp / len(gold) if gold else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return {"precision": p, "recall": r, "f1": f, "exact": pred == gold, "tp": tp,
            "false_positives": sorted(pred - gold), "false_negatives": sorted(gold - pred)}


def kendall_tau(pred_order, gold_order):
    """Tau over items present in both lists (each list deduplicated, first occurrence kept)."""
    def dedupe(xs):
        out = []
        for x in xs:
            if x not in out:
                out.append(x)
        return out
    pred_order, gold_order = dedupe(pred_order), dedupe(gold_order)
    common = [x for x in gold_order if x in pred_order]
    if len(common) < 2:
        return None
    pos = {x: pred_order.index(x) for x in common}
    conc = disc = 0
    for i in range(len(common)):
        for j in range(i + 1, len(common)):
            if pos[common[i]] < pos[common[j]]:
                conc += 1
            else:
                disc += 1
    return (conc - disc) / (conc + disc)


def score_task(task, answer):
    kind = task["answer_kind"]
    repo = task["repo"]
    sub = task.get("app_subdir")
    res = {"id": task["id"], "type": task["type"], "parsed": answer is not None}
    if kind == "placement":
        new_file, templates = None, []
        if isinstance(answer, dict):
            new_file = answer.get("new_file")
            templates = answer.get("templates") or []
        path_ok = bool(new_file) and re.match(task["answer"]["allowed_new_file_regex"], norm_file(new_file, repo, sub)) is not None
        cands = set(task["answer"]["template_candidates"])
        tnorm = []
        for t in templates if isinstance(templates, list) else []:
            n = norm_file(t, repo, sub)
            if n not in tnorm:
                tnorm.append(n)
        tnorm = tnorm[:2]
        template_score = sum(1 for t in tnorm if t in cands) / 2
        res.update({"path_ok": path_ok, "template_score": template_score,
                    "f1": (float(path_ok) + template_score) / 2,
                    "precision": None, "recall": None,
                    "exact": path_ok and template_score == 1.0})
        return res
    items = answer if isinstance(answer, list) else []
    if kind == "route_set":
        pred = [norm_route(x) for x in items]
        gold = [norm_route(x) for x in task["answer"]]
    else:
        pred = [norm_file(x, repo, sub) for x in items]
        gold = list(task["answer"])
    res.update(prf(pred, gold))
    if kind == "ordered_file_list":
        res["kendall_tau"] = kendall_tau(pred, gold)
    return res


def load_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def main(argv):
    if argv[1:2] == ["--self-test"]:
        return self_test()
    tasks = {t["id"]: t for t in load_jsonl(argv[1])}
    rows = load_jsonl(argv[2])
    out = []
    for r in rows:
        ans = r["answer"] if "answer" in r else extract_answer(r.get("text"))
        s = score_task(tasks[r["id"]], ans)
        s["variant"] = r.get("variant")
        s["model"] = r.get("model")
        out.append(s)
    dest = argv[argv.index("--out") + 1] if "--out" in argv else None
    text = "\n".join(json.dumps(s, ensure_ascii=False) for s in out) + "\n"
    if dest:
        open(dest, "w", encoding="utf-8").write(text)
    else:
        sys.stdout.write(text)
    by = {}
    for s in out:
        by.setdefault(f'{s.get("model")}/{s["variant"]}', []).append(s)
    for v, ss in sorted(by.items(), key=lambda kv: str(kv[0])):
        n = len(ss)
        mf1 = sum(s["f1"] for s in ss) / n
        ex = sum(1 for s in ss if s["exact"])
        print(f"# {v}: n={n} mean_f1={mf1:.3f} exact={ex}/{n}", file=sys.stderr)
    return 0


def self_test():
    t_set = {"id": "x", "type": "T3", "repo": "r", "answer_kind": "file_set", "answer": ["a.ts", "b.ts"]}
    s = score_task(t_set, ["./a.ts", "r/b.ts"])
    assert s["exact"] and s["f1"] == 1.0, s
    s = score_task(t_set, ["a.ts", "c.ts"])
    assert abs(s["f1"] - 0.5) < 1e-9 and s["recall"] == 0.5, s
    s = score_task(t_set, None)
    assert s["f1"] == 0 and not s["exact"]
    t_route = {"id": "y", "type": "T1", "repo": "r", "answer_kind": "route_set", "answer": ["/", "/chat/[id]"]}
    s = score_task(t_route, ["/chat/[id]/", "/"])
    assert s["exact"], s
    t_ord = {"id": "z", "type": "T2", "repo": "r", "answer_kind": "ordered_file_list", "answer": ["a", "b", "c"]}
    s = score_task(t_ord, ["c", "b", "a"])
    assert s["exact"] and s["kendall_tau"] == -1.0, s
    s = score_task(t_ord, ["a", "b", "c"])
    assert s["kendall_tau"] == 1.0
    t_pl = {"id": "w", "type": "T5", "repo": "r", "answer_kind": "placement",
            "answer": {"allowed_new_file_regex": r"^api/(?!old/)[a-z]+/route\.ts$", "template_candidates": ["api/old/route.ts", "api/b/route.ts"]}}
    s = score_task(t_pl, {"new_file": "api/new/route.ts", "templates": ["api/old/route.ts", "api/zzz/route.ts"]})
    assert s["path_ok"] and s["template_score"] == 0.5 and s["f1"] == 0.75 and not s["exact"], s
    s = score_task(t_pl, {"new_file": "api/old/route.ts", "templates": ["api/old/route.ts", "api/b/route.ts"]})
    assert not s["path_ok"] and s["f1"] == 0.5
    t_sub = {"id": "v", "type": "T3", "repo": "formbricks", "app_subdir": "apps/web", "answer_kind": "file_set", "answer": ["lib/a.ts", "modules/b.ts"]}
    s = score_task(t_sub, ["apps/web/lib/a.ts", "formbricks/apps/web/modules/b.ts"])
    assert s["exact"], s
    assert norm_file("./lib/a.ts", "formbricks", "apps/web") == "lib/a.ts"
    assert extract_answer('blah {"answer": ["a"]} trailing') == ["a"]
    assert extract_answer('```json\n{"answer": {"new_file": "x"}}\n```') == {"new_file": "x"}
    assert extract_answer("no json") is None
    print("self-test ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
