"""Prepare, run, and grade the ten-question Neorion pilot."""
import hashlib
import json
import os
from pathlib import Path
import random
import re
import statistics
import subprocess
import sys
import time

PILOT = Path(__file__).resolve().parent
PROJECT = PILOT.parents[1]
REPOS = PROJECT.parent / "bench-repos"
REPO_INFO = {
    "ai-chatbot": ("vercel/ai-chatbot", "a8989b522fa3672a2ae52f053105e40993b36ca1"),
    "papermark": ("mfts/papermark", "ed19717ec02a1ac79aecf5569159aa9d2d869312"),
}
QUESTIONS = PILOT / "questions.jsonl"
FREEZE = PILOT / "questions.sha256"
RESULTS = PILOT / "results.jsonl"
STATUS = PILOT / "status.json"
METHODS = r"^export (?:async )?function (GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)\("


def git(repo, *args):
    return subprocess.check_output(["git", "-C", REPOS / repo, *args], text=True)


def tracked(repo):
    return git(repo, "ls-files", "-z").rstrip("\0").split("\0")


def source(repo, path):
    return git(repo, "show", f"HEAD:{path}")


def matches(repo, pattern, paths):
    return [
        path for path in paths
        if re.search(pattern, source(repo, path), re.MULTILINE)
    ]


def routes(repo, paths):
    return [
        f"{method} /{path.removeprefix('app/').removesuffix('/route.ts')}"
        for path in paths
        for method in re.findall(METHODS, source(repo, path), re.MULTILINE)
    ]


def layouts(page, files):
    assert page in files
    return [
        str(parent / "layout.tsx")
        for parent in Path(page).parents
        if str(parent / "layout.tsx") in files
    ]


def derive():
    ai, pm = REPO_INFO
    for repo, (_, sha) in REPO_INFO.items():
        assert git(repo, "rev-parse", "HEAD").strip() == sha
        assert not git(repo, "status", "--porcelain", "--untracked-files=no")
    ai_files, pm_files = tracked(ai), tracked(pm)
    ai_tsx = [p for p in ai_files if p.endswith(".tsx")]
    pm_auth = [p for p in pm_files if p.startswith("app/(auth)/") and p.endswith(".tsx")]
    document = "app/(chat)/api/document/route.ts"
    assert document in ai_files
    cron = [p for p in pm_files if p.startswith("app/api/cron/") and p.endswith("/route.ts")]
    ai_actions = source(ai, "app/(chat)/actions.ts")
    assert re.match(r'["\']use server["\']', ai_actions)
    assert "export async function deleteTrailingMessages(" in ai_actions
    specs = [
        (ai, "Which TSX files directly render the AppSidebar component?",
         matches(ai, r"<AppSidebar(?=\s|/?>)", ai_tsx)),
        (ai, "Which HTTP methods are explicitly exported by the App Router endpoint /api/document? Return method names.",
         re.findall(METHODS, source(ai, document), re.MULTILINE)),
        (ai, "Which layout.tsx files wrap the /chat/[id] App Router page, including the root layout?",
         layouts("app/(chat)/chat/[id]/page.tsx", ai_files)),
        (ai, "Which TSX files directly call the deleteTrailingMessages server action?",
         matches(ai, r"\bdeleteTrailingMessages\(", ai_tsx)),
        (ai, "Which TSX files directly call the useAutoResume hook?",
         matches(ai, r"\buseAutoResume\(", ai_tsx)),
        (pm, "Which App Router page files under app/(auth) directly render LoginClient or RegisterClient?",
         matches(pm, r"<(?:LoginClient|RegisterClient)(?=\s|/?>)", [p for p in pm_auth if p.endswith("/page.tsx")])),
        (pm, "Which App Router endpoints under /api/cron explicitly export an HTTP method? Return each method and URL path as one string, with a single space between them.",
         routes(pm, cron)),
        (pm, "Which layout.tsx files wrap the /login App Router page, including the root layout?",
         layouts("app/(auth)/login/page.tsx", pm_files)),
        (pm, "Which TSX files within app/(auth) directly call the useLastUsed hook?",
         matches(pm, r"\buseLastUsed\(", pm_auth)),
        (pm, "What file defines the Pages Router custom App entry point?",
         [p for p in pm_files if re.fullmatch(r"pages/_app\.(?:tsx?|jsx?)", p)
          and re.search(r"\bexport default\b", source(pm, p))]),
    ]
    assert all(answers for _, _, answers in specs)
    return [
        {"id": f"q{i:02}", "repo": REPO_INFO[repo][0], "question": question, "answer": sorted(answers)}
        for i, (repo, question, answers) in enumerate(specs, 1)
    ]


def json_lines(rows):
    return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)


def freeze():
    content = json_lines(derive()).encode()
    with QUESTIONS.open("xb") as file:
        file.write(content)
    with FREEZE.open("x") as file:
        file.write(f"{hashlib.sha256(content).hexdigest()}  questions.jsonl\n")


def verified():
    content = QUESTIONS.read_bytes()
    assert hashlib.sha256(content).hexdigest() == FREEZE.read_text().split()[0]
    questions = [json.loads(line) for line in content.splitlines()]
    assert questions == derive(), "Frozen answers differ from pinned sources"
    return questions


def grade(answer, expected):
    try:
        raw = answer.strip()
        fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", raw, re.DOTALL)
        parsed = json.loads(fence[1] if fence else raw)
        items = parsed["answer"]
        if not isinstance(items, list) or any(not isinstance(item, str) for item in items):
            raise ValueError("expected an array of strings")
    except (TypeError, KeyError, ValueError) as error:
        return {"exact": False, "precision": 0, "recall": 0, "format_error": str(error)}
    predicted = {item.strip().removeprefix("./") for item in items}
    truth = set(expected)
    hits = len(truth & predicted)
    return {
        "exact": predicted == truth,
        "precision": hits / len(predicted) if predicted else 0,
        "recall": hits / len(truth),
    }


def read_results():
    if not RESULTS.exists():
        return []
    return [json.loads(line) for line in RESULTS.read_text().splitlines()]


def run():
    questions = verified()
    context_info = json.loads((PILOT / "contexts.json").read_text())
    env = {key: value for key, value in os.environ.items() if not (
        key.startswith(("ANTHROPIC_", "CLAUDE_CODE_USE_", "CLAUDE_CODE_OAUTH_"))
        or key in {"CLAUDECODE", "CLAUDE_CODE_SIMPLE"}
    )}
    empty = REPOS / "claude-pilot-empty"
    empty.mkdir(exist_ok=True)
    assert not any(empty.iterdir())
    auth = subprocess.run(["claude", "auth", "status"], cwd=empty, env=env, capture_output=True, text=True)
    if auth.returncode or json.loads(auth.stdout).get("authMethod") != "claude.ai" or not json.loads(auth.stdout).get("loggedIn"):
        error = auth.stderr.strip() or "Claude CLI has no active claude.ai login"
        STATUS.write_text(json.dumps({"error": error}) + "\n")
        raise SystemExit(error)
    version = subprocess.check_output(["claude", "--version"], cwd=empty, env=env, text=True).strip()
    matrix = [(question, condition) for question in questions for condition in "ABD"]
    random.Random(20261119).shuffle(matrix)
    previous = read_results()
    if any(row.get("error") for row in previous):
        raise SystemExit("Pilot stopped on a previous CLI failure. See results.jsonl.")
    completed = {(row["id"], row["condition"]) for row in previous}
    assert len(completed) == len(previous) <= len(matrix)
    RESULTS.touch(exist_ok=True)
    for question, condition in matrix:
        if (question["id"], condition) in completed:
            continue
        repo = question["repo"].split("/")[-1]
        prompt = (
            f"Repository: {question['repo']} at commit {REPO_INFO[repo][1]}.\n"
            f"{question['question']}\n"
            'Return only a JSON object of the form {"answer":["item"]}. '
            "Use exact repository-relative file paths when asked for files.\n"
        )
        if condition != "A":
            name = "codebase_graph.md" if condition == "B" else "file-list.txt"
            context = (REPOS / repo / name).read_text()
            kind = "Graph" if condition == "B" else "Tracked file list"
            prompt += f"\n{kind}:\n{context}"
        command = [
            "claude", "-p", "--model", "opus", "--output-format", "json",
            "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--setting-sources", "project", "--disable-slash-commands",
            "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false}',
            "--system-prompt", "Answer the question using the supplied prompt.",
            "--no-session-persistence", "--max-turns", "1",
        ]
        start = time.monotonic()
        try:
            process = subprocess.run(command, input=prompt, cwd=empty, env=env, capture_output=True,
                                     text=True, timeout=600)
        except (OSError, subprocess.TimeoutExpired) as error:
            row = {"id": question["id"], "repo": question["repo"], "condition": condition,
                   "wall_seconds": time.monotonic() - start, "cli_version": version, "error": str(error)}
            with RESULTS.open("a") as file:
                file.write(json_lines([row]))
            raise SystemExit(str(error))
        row = {
            "id": question["id"], "repo": question["repo"], "condition": condition,
            "wall_seconds": time.monotonic() - start, "cli_version": version,
        }
        if condition != "A":
            row["context_o200k_tokens"] = context_info[repo][condition]
        try:
            result = json.loads(process.stdout)
        except ValueError:
            result = {}
        usage = result.get("usage") or {}
        if "input_tokens" in usage:
            row["input_tokens"] = sum(usage.get(key, 0) for key in (
                "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        row["output_tokens"] = usage.get("output_tokens")
        row["usage"] = usage
        row["model_usage"] = result.get("modelUsage")
        row["answer"] = result.get("result")
        if process.returncode or result.get("is_error") or result.get("subtype") != "success":
            row["error"] = process.stderr.strip() or process.stdout.strip() or f"CLI exit {process.returncode}"
        else:
            row["grade"] = grade(row["answer"] or "", question["answer"])
        with RESULTS.open("a") as file:
            file.write(json_lines([row]))
        if "error" in row:
            raise SystemExit(row["error"])
        print(f"{question['id']} {condition} complete", flush=True)


def summarize():
    rows = read_results()
    graded = [row for row in rows if "grade" in row]
    lines = [
        "# Neorion 10-question pilot", "",
        "| Condition | Graded / planned | Strict accuracy | Average input tokens |",
        "| --- | ---: | ---: | ---: |",
    ]
    for condition, label in [("A", "Question only"), ("B", "Graph"), ("D", "File list")]:
        sample = [row for row in graded if row["condition"] == condition]
        accuracy = f'{sum(row["grade"]["exact"] for row in sample)}/{len(sample)} ({statistics.mean(row["grade"]["exact"] for row in sample):.0%})' if sample else "—"
        tokens = [row["input_tokens"] for row in sample if "input_tokens" in row]
        average = f"{statistics.mean(tokens):,.1f} ({len(tokens)} reported)" if tokens else "—"
        lines.append(f"| {condition} · {label} | {len(sample)} / 10 | {accuracy} | {average} |")
    lines += ["", "Input tokens include cache creation and cache reads where reported by Claude Code.",
              "Accuracy uses exact set equality against the source-derived answers.", ""]
    contexts = json.loads((PILOT / "contexts.json").read_text())
    lines += ["| Repository | Graph tokens | File-list tokens |", "| --- | ---: | ---: |"]
    for repo, sizes in contexts.items():
        lines.append(f"| {REPO_INFO[repo][0]} | {sizes['B']:,} | {sizes['D']:,} |")
    lines += ["", "Context sizes use o200k_base. Both complete tracked file lists fall short of the graph size. B and D differ in both representation and length.",
              "", "## Grading issues", ""]
    expected = {question["id"]: question["answer"] for question in verified()}
    issues = []
    for row in graded:
        if "format_error" not in row["grade"]:
            continue
        issue = f'- {row["id"]} ({row["condition"]}) failed JSON grading.'
        raw = row["answer"] or ""
        candidates = []
        for match in re.finditer(r"\{", raw):
            fragment = raw[match.start():]
            try:
                parsed, end = json.JSONDecoder().raw_decode(fragment)
            except ValueError:
                continue
            if isinstance(parsed, dict) and "answer" in parsed:
                candidates.append(fragment[:end])
        if len(candidates) == 1 and grade(candidates[0], expected[row["id"]])["exact"]:
            issue += " The embedded JSON contains the exact answer. Extra text caused the strict score of zero."
        issues.append(issue)
    lines += issues or (["No answer-format issues detected."] if graded else ["No answers were available to grade."])
    errors = [row["error"] for row in rows if "error" in row]
    if STATUS.exists():
        errors.append(json.loads(STATUS.read_text())["error"])
    if errors:
        lines += ["", "## CLI failure", "", *[f"```text\n{error}\n```" for error in errors]]
    (PILOT / "SUMMARY.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    {"freeze": freeze, "verify": verified, "run": run, "summary": summarize}[sys.argv[1]]()
