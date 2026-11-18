"""Prepare v2 prompts and grade saved responses offline."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import statistics
import subprocess

DIRECTORY = Path(__file__).resolve().parent
METHODS = {"GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"}


def normalize(item, repo):
    item = item.strip().replace("\\", "/")
    prefix = repo.rsplit("/", 1)[-1] + "/"
    item = item.removeprefix("./").removeprefix(prefix).removeprefix("./")
    parts = item.split(maxsplit=1)
    if parts and parts[0].upper() in METHODS:
        return parts[0].upper() + (" " + " ".join(parts[1].split()) if len(parts) == 2 else "")
    return item


def grade(response, expected, repo):
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
    predicted = {normalize(item, repo) for item in items} if valid else set()
    truth = {normalize(item, repo) for item in expected}
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


def choose_detail(question, repository):
    """Rank generated details using the public question and generated Markdown only."""
    question_words = words(question)
    candidates = []
    frequencies = Counter()
    for file in sorted((repository / ".neorion/graph").glob("*.md")):
        text = file.read_text()
        heading = text.splitlines()[1].removeprefix("# ")
        if file.name.startswith("+dependencies"):
            continue
        area_hits = question_words & words(heading)
        body_hits = question_words & words(text)
        frequencies.update(body_hits)
        explicit = "/" in heading and re.search(
            rf"(?<![\w/]){re.escape(heading)}(?=/|\W|$)", question, re.IGNORECASE
        )
        candidates.append((file, text, bool(explicit), area_hits, body_hits))
    if not candidates:
        raise ValueError(f"No graph area details in {repository}")
    rank = lambda entry: (entry[2], len(entry[3]), sum(1 / frequencies[term] for term in sorted(entry[4])))
    file, text, *_ = max(candidates, key=rank)
    return file.relative_to(repository).as_posix(), text


def read_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def checked_questions():
    subprocess.run(["node", DIRECTORY / "questions.cjs", "verify"], check=True)
    return read_lines(DIRECTORY / "questions.jsonl")


def prompts(questions, contexts, output):
    with output.open("w") as stream:
        for item in questions:
            repo = item["repo"]
            question = item["question"]
            repository = contexts / repo.rsplit("/", 1)[-1]
            name, detail = choose_detail(question, repository)
            instruction = (
                f"Repository: {repo}\n{question}\n"
                'Return only a JSON object of the form {"answer":["item"]}. '
                "Use repository-relative paths when asked for files."
            )
            overview = (repository / "codebase_graph.md").read_text()
            listing = (repository / "file-list.txt").read_text()
            for condition, context in (
                ("A", ""), ("B", f"Overview\n{overview}\nDetail file {name}\n{detail}"),
                ("D", f"Tracked file list\n{listing}")
            ):
                row = {"id": item["id"], "condition": condition,
                       "prompt": f"{context}\n\n{instruction}" if context else instruction}
                if condition == "B":
                    row["detail"] = name
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def score(questions, responses, output):
    lookup = {item["id"]: item for item in questions}
    seen = set()
    groups = {condition: [] for condition in "ABD"}
    with output.open("w") as stream:
        for row in read_lines(responses):
            key = (row["id"], row["condition"])
            if key in seen or key[1] not in groups:
                raise ValueError(f"Duplicate or invalid response {key}")
            seen.add(key)
            item = lookup[key[0]]
            result = grade(row["response"], item["answer"], item["repo"])
            groups[key[1]].append(result)
            stream.write(json.dumps({**row, "grade": result}) + "\n")
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prompts")
    prepare.add_argument("contexts", type=Path)
    prepare.add_argument("output", type=Path)
    grading = commands.add_parser("grade")
    grading.add_argument("responses", type=Path)
    grading.add_argument("output", type=Path)
    args = parser.parse_args()
    questions = checked_questions()
    if args.command == "prompts":
        prompts(questions, args.contexts, args.output)
    else:
        score(questions, args.responses, args.output)


if __name__ == "__main__":
    main()
