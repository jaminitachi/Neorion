"""Prepare v2 prompts and grade saved responses offline."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import statistics
import subprocess

DIRECTORY = Path(__file__).resolve().parent
METHODS = {"GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"}


def normalize(item, repo, template=None):
    item = item.strip().replace("\\", "/")
    prefix = repo.rsplit("/", 1)[-1] + "/"
    item = item.removeprefix("./").removeprefix(prefix).removeprefix("./")
    if template == 7:
        return item.rsplit("#", 1)[-1].strip()
    if template == 10:
        return "/" + item.lstrip("/")
    parts = item.split(maxsplit=1)
    if parts and parts[0].upper() in METHODS:
        return parts[0].upper() + (" " + " ".join(parts[1].split()) if len(parts) == 2 else "")
    return item


def grade(response, expected, repo, template=None):
    decoder = json.JSONDecoder()
    candidates = []
    for match in re.finditer(r"\{", response):
        try:
            obj, end = decoder.raw_decode(response, match.start())
        except ValueError:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("answer"), list):
            candidates.append((match.start(), end, obj))
    start, end, obj = candidates[-1] if candidates else (0, 0, {})
    items = obj.get("answer")
    valid = items is not None and all(isinstance(item, str) for item in items)
    predicted = {normalize(item, repo, template) for item in items} if valid else set()
    truth = {normalize(item, repo, template) for item in expected}
    hits = len(truth & predicted)
    return {
        "format_ok": valid and set(obj) == {"answer"} and response.strip() == response[start:end],
        "content_exact": valid and predicted == truth,
        "ambiguous": len({json.dumps(item["answer"], sort_keys=True) for _, _, item in candidates}) > 1,
        "precision": hits / len(predicted) if predicted else 0.0,
        "recall": hits / len(truth) if truth else 0.0,
        "f1": 2 * hits / (len(predicted) + len(truth)) if predicted or truth else float(valid),
    }


def words(text):
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    return set(re.findall(r"[a-z0-9]{2,}", text.lower()))


def select_details(question, repository, limit=3):
    """Rank details using only affirmative question text and generated Markdown."""
    positive = re.sub(r"\b(?:exclude|excluding|omit|except|without|ignore|do not include)\b[^.!?;,]*",
                      " ", question, flags=re.IGNORECASE)
    symbols = set(re.findall(r"\b[A-Za-z][A-Za-z0-9]*[a-z0-9][A-Z][A-Za-z0-9]*\b", positive))
    question_words = words(positive)
    scopes = re.findall(r"\bunder\s+((?:[\w.-]+/)+)", positive, flags=re.IGNORECASE)
    page_urls = set(re.findall(r"(?<![\w/])(/[^\s,!?;]+)\s+page file\b", positive))

    def has_page_file(text):
        directory = ""
        for line in text.splitlines():
            if line.startswith(("pages/", "src/pages/")) and line.endswith("/"):
                directory = line.removeprefix("src/").removeprefix("pages")
            match = re.match(r"  ([^ :]+)\.[jt]sx?(?: \(c\))?: .*\broute ", line)
            if match and directory:
                url = directory.rstrip("/") if match[1] == "index" else directory + match[1]
                if (url or "/") in page_urls:
                    return True
        return False

    files = [(file, file.read_text()) for file in sorted((repository / ".neorion/graph").glob("*.md"))
             if not file.name.startswith("+dependencies")]

    def render_rows(text):
        directory = ""
        for line in text.splitlines():
            if line.endswith("/") and not line.startswith(" "):
                directory = line.removeprefix("./")
            row = re.match(r"  ([^:]+): (.*)", line)
            if not row:
                continue
            segments = row[2].split(" | ")
            definition = re.match(r"[A-Za-z_$][\w$]*", segments[0])
            for segment in segments:
                if ">" not in segment:
                    continue
                source, targets = segment.split(">", 1)
                source = source.strip() or (definition[0] if definition else "")
                yield directory + row[1].removesuffix(" (c)"), source, {
                    token.removesuffix("[render]") for token in targets.split()
                    if not token.endswith(("[import]", "[action]"))
                }, " | route " in row[2]

    page_lookup = "page URLs" in positive and bool(symbols)
    bridges = set()
    if page_lookup:
        for _, text in files:
            for source_file, source, targets, is_route in render_rows(text):
                if source and not is_route and any(token.rsplit("#", 1)[-1] in symbols for token in targets):
                    bridges.update((source, f"{source_file}#{source}"))
    candidates = []
    frequencies = Counter()
    for file, text in files:
        heading = text.splitlines()[1].removeprefix("# ")
        hits = question_words & words(text)
        frequencies.update(hits)
        explicit = re.search(rf"(?<![\w/]){re.escape(heading)}(?=/)", positive, re.IGNORECASE)
        exact = {symbol for symbol in symbols if re.search(rf"\b{re.escape(symbol)}\b", text)}
        indexed = sum(bool(re.search(rf"^(?:[^ \n]+#)?{re.escape(symbol)} \(\d+\)$", text, re.MULTILINE))
                      for symbol in exact) if file.name.startswith("+reverse-") else 0
        relationships = sum(len(re.findall(
            rf"^  .*(?:\bh:[^|]*\b{re.escape(symbol)}\b|>[^|]*\b{re.escape(symbol)}\b(?!\[import\]))",
            text, re.MULTILINE
        )) for symbol in exact)
        scope_rank = 2 if any((heading + "/").casefold().startswith(scope.casefold()) for scope in scopes) else bool(explicit)
        page_hits = sum(is_route and any(
            token in bridges or token.rsplit("#", 1)[-1] in symbols for token in targets
        ) for _, _, targets, is_route in render_rows(text)) if page_lookup else 0
        candidates.append((file, text, scope_rank, bool(page_urls and has_page_file(text)),
                           indexed, page_hits, len(exact), relationships, hits))
    if not candidates:
        raise ValueError(f"No graph details in {repository}")

    def rank(entry):
        _, _, explicit, route, indexed, page_hits, exact, relationships, hits = entry
        return explicit, route, indexed, page_hits, exact, relationships, sum(1 / frequencies[term] for term in sorted(hits))

    return [(file.relative_to(repository).as_posix(), text)
            for file, text, *_ in sorted(candidates, key=rank, reverse=True)[:limit]]


def read_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def checked_questions():
    subprocess.run(["node", DIRECTORY / "questions.cjs", "verify"], check=True)
    return read_lines(DIRECTORY / "questions.jsonl")


AGENT_INSTRUCTION = "Inspect the repository using only the available read-only tools."
GRAPH_INSTRUCTION = "The repository also contains codebase_graph.md and detail files under .neorion/graph/."
E_SEED = "20261119"


def agent_sample(questions):
    selected = set()
    for repo in sorted({item["repo"] for item in questions}):
        pool = [item["id"] for item in questions if item["repo"] == repo]
        selected.update(sorted(pool, key=lambda id: hashlib.sha256(f"{E_SEED}:{id}".encode()).digest())[:5])
    return selected


def prompts(questions, contexts, output, include_agents=False):
    selected_ids = agent_sample(questions) if include_agents else set()
    with output.open("w") as stream:
        for item in questions:
            repo = item["repo"]
            question = item["question"]
            repository = contexts / repo.rsplit("/", 1)[-1]
            details = select_details(question, repository)
            instruction = (
                f"Repository: {repo}\n{question}\n"
                'Return only a JSON object of the form {"answer":["item"]}. '
                "Use repository-relative paths when asked for files."
            )
            overview = (repository / "codebase_graph.md").read_text()
            listing = (repository / "file-list.txt").read_text()
            selected = "\n".join(f"Detail file {name}\n{text}" for name, text in details)
            for condition, context in (
                ("A", ""), ("B", f"Overview\n{overview}\n{selected}"),
                ("D", f"Tracked file list\n{listing}")
            ):
                row = {"id": item["id"], "condition": condition,
                       "prompt": f"{context}\n\n{instruction}" if context else instruction}
                if condition == "B":
                    row["details"] = [name for name, _ in details]
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
            if item["id"] in selected_ids:
                for condition, context in (
                    ("E0", AGENT_INSTRUCTION), ("E1", f"{AGENT_INSTRUCTION} {GRAPH_INSTRUCTION}")
                ):
                    row = {"id": item["id"], "condition": condition, "prompt": f"{context}\n\n{instruction}"}
                    stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def precheck(questions, responses, output):
    """Flag questions answered exactly by the single scored A run."""
    expected = {item["id"]: item for item in questions}
    exact = {}
    for row in read_lines(responses):
        question_id = row["id"]
        if row.get("condition") != "A" or question_id in exact:
            raise ValueError("Expected one A response per question")
        item = expected[question_id]
        exact[question_id] = grade(row["response"], item["answer"], item["repo"], item.get("template"))["content_exact"]
    if exact.keys() != expected.keys():
        raise ValueError("Each question needs one A response")
    with output.open("w") as stream:
        for question_id, correct in exact.items():
            stream.write(json.dumps({"id": question_id, "exact": correct, "drop": correct}) + "\n")


def score(questions, responses, output, coverage=None):
    lookup = {item["id"]: item for item in questions}
    audit = {}
    if coverage:
        for row in read_lines(coverage):
            key = row["id"]
            if (key not in lookup or key in audit or row["coverage"] not in {"complete", "partial", "absent"}
                    or not row["evidence"].strip()):
                raise ValueError(f"Invalid B coverage audit row for {key}")
            audit[key] = row
        if audit.keys() != lookup.keys():
            raise ValueError("B coverage audit must include each question")
    seen = set()
    coverage_groups = Counter()
    groups = {condition: [] for condition in "ABD"}
    with output.open("w") as stream:
        for row in read_lines(responses):
            key = (row["id"], row["condition"])
            if key in seen or key[1] not in groups:
                raise ValueError(f"Duplicate or invalid response {key}")
            seen.add(key)
            item = lookup[key[0]]
            result = grade(row["response"], item["answer"], item["repo"], item.get("template"))
            groups[key[1]].append(result)
            record = {**row, "grade": result}
            if key[1] == "B" and audit:
                record["context_audit"] = audit[key[0]]
                coverage_groups[(audit[key[0]]["coverage"], result["content_exact"])] += 1
            stream.write(json.dumps(record) + "\n")
    print("| Condition | Scored | Exact content | Mean F1 | Format violations | Ambiguous |")
    print("| --- | ---: | ---: | ---: | ---: | ---: |")
    for condition, results in groups.items():
        if not results:
            print(f"| {condition} | 0/{len(questions)} | — | — | — | — |")
            continue
        exact = sum(item["content_exact"] for item in results)
        mean = statistics.mean(item["f1"] for item in results)
        violations = sum(not item["format_ok"] for item in results)
        ambiguous = sum(item["ambiguous"] for item in results)
        print(f"| {condition} | {len(results)}/{len(questions)} | {exact}/{len(results)} | {mean:.3f} | {violations} | {ambiguous} |")

    if audit:
        print("\n| B answer coverage | Scored | Exact content |")
        print("| --- | ---: | ---: |")
        for status in ("complete", "partial", "absent"):
            exact = coverage_groups[(status, True)]
            print(f"| {status} | {exact + coverage_groups[(status, False)]} | {exact} |")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prompts")
    prepare.add_argument("contexts", type=Path)
    prepare.add_argument("output", type=Path)
    prepare.add_argument("--include-agents", action="store_true")
    grading = commands.add_parser("grade")
    grading.add_argument("responses", type=Path)
    grading.add_argument("output", type=Path)
    grading.add_argument("--coverage", type=Path)
    screen = commands.add_parser("precheck")
    screen.add_argument("responses", type=Path)
    screen.add_argument("output", type=Path)
    args = parser.parse_args()
    questions = checked_questions()
    if args.command == "prompts":
        prompts(questions, args.contexts, args.output, args.include_agents)
    elif args.command == "precheck":
        precheck(questions, args.responses, args.output)
    else:
        score(questions, args.responses, args.output, args.coverage)


if __name__ == "__main__":
    main()
