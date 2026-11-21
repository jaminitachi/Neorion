"""Report measured results from a frozen v2 run."""
import argparse
import json
from pathlib import Path
import re
from statistics import mean

from benchmark import DIRECTORY, grade, normalize, read_lines

CONDITIONS = ("A", "B", "D", "E0", "E1")
SELECTOR_ADJUSTED = {"q18", "q19"}


def load_measurement(record, path):
    result = record["payload"]
    if record["returncode"] != 0 or not result or result.get("is_error") or not isinstance(result.get("result"), str):
        return None
    usage = result["usage"]
    measurement = {
        "response": result["result"],
        "input": sum(usage[field] for field in (
            "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"
        )),
        "output": usage["output_tokens"],
        "seconds": result["duration_ms"] / 1000,
        "models": sorted(result.get("modelUsage", {})),
    }
    if record["condition"] in {"E0", "E1"}:
        transcript = path.with_suffix(".transcript.jsonl")
        calls = {block["id"]: block["name"]
                 for entry in read_lines(transcript) if entry.get("type") == "assistant"
                 for block in entry["message"]["content"] if block.get("type") == "tool_use"}
        if set(calls.values()) - {"Read", "Grep", "Glob"}:
            raise ValueError(f"Unexpected tool in {transcript}")
        measurement["tools"] = len(calls)
    return measurement


def failure_reason(question, result):
    if result["grade"]["content_exact"]:
        return "Exact content with a JSON format violation."
    answer = None
    for match in re.finditer(r"\{", result["response"]):
        try:
            candidate, _ = json.JSONDecoder().raw_decode(result["response"], match.start())
        except ValueError:
            continue
        if isinstance(candidate, dict) and isinstance(candidate.get("answer"), list):
            answer = candidate["answer"]
    if answer is None or any(not isinstance(item, str) for item in answer):
        return "No parseable JSON answer list of strings."
    expected, predicted = (
        {normalize(item, question["repo"], question["template"]) for item in items}
        for items in (question["answer"], answer)
    )
    differences = []
    for label, values in (("Missing", expected - predicted), ("Extra", predicted - expected)):
        if values:
            differences.append(f"{label} " + ", ".join(
                "`" + item.replace("`", "'").replace("|", "\\|").replace("\n", " ") + "`"
                for item in sorted(values)
            ))
    if not result["grade"]["format_ok"]:
        differences.append("JSON format violation")
    return ". ".join(differences) + "."


def table(schedule, results, excluded):
    lines = [
        "| Condition | Scored / planned | Strict | Content | Avg input | Avg output | Avg total | Avg tools | Avg wall s |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for condition in CONDITIONS:
        keys = [key for key in schedule if key[0] == condition and key[1] not in excluded]
        subset = [results[key] for key in keys if key in results]
        count = len(subset)
        if count:
            exact = sum(row["grade"]["content_exact"] for row in subset)
            strict = sum(row["grade"]["content_exact"] and row["grade"]["format_ok"] for row in subset)
            input_avg = mean(row["input"] for row in subset)
            output_avg = mean(row["output"] for row in subset)
            scores = [f"{hits}/{count}" for hits in (strict, exact)]
            if count < len(keys):
                scores = [f"{score} [{hits}/{len(keys)}]" for score, hits in zip(scores, (strict, exact))]
            metrics = [*scores, f"{input_avg:,.1f}", f"{output_avg:,.1f}", f"{input_avg + output_avg:,.1f}"]
            metrics.extend(
                [f'{mean(row["tools"] for row in subset):.1f}', f'{mean(row["seconds"] for row in subset):.1f}']
                if condition.startswith("E") else ["—", "—"]
            )
        else:
            metrics = ["—"] * 7
        lines.append("| " + " | ".join([condition, f"{count}/{len(keys)}", *metrics]) + " |")
    return "\n".join(lines)


def report(run, output):
    questions = {item["id"]: item for item in read_lines(DIRECTORY / "questions.jsonl")}
    schedule = sorted((row["condition"], row["id"]) for row in read_lines(DIRECTORY / "prompts.jsonl"))
    results = {}
    attempts = {}
    for path in sorted((run / "attempts").glob("*.json")):
        record = json.loads(path.read_text())
        key = (record["condition"], record["id"])
        measurement = load_measurement(record, path)
        attempts.setdefault(key, []).append(record)
        if measurement:
            question = questions[key[1]]
            measurement["grade"] = grade(measurement["response"], question["answer"],
                                         question["repo"], question["template"])
            results[key] = measurement

    guessable = {qid for (condition, qid), result in results.items()
                 if condition == "A" and result["grade"]["content_exact"]}
    screened = sum(condition == "A" for condition, _ in results)
    models = sorted({model for row in results.values() for model in row["models"]})
    attempted = sum(map(len, attempts.values()))
    timeouts = sum(record["timeout"] for records in attempts.values() for record in records)
    model_summary = ", ".join(f"`{model}`" for model in models)
    guessable_summary = ", ".join(sorted(guessable))
    lines = [
        "# Neorion benchmark v2 results", "",
        f"Claude Code returned {len(results)} scored answers across {attempted} recorded invocations "
        f"({attempted - len(attempts)} crash retries, {timeouts} timed-out invocations).",
        f"The CLI reported {model_summary}." if models else "The CLI supplied no model identifiers.",
        "", f"The A screen scored {screened}/20 questions. "
        + (f"Exact answers identified {guessable_summary} as guessable." if guessable
           else "The screen observed zero exact answers."), "",
        "Strict requires exact content and the requested JSON format. Input includes uncached tokens, "
        "cache writes and cache reads. E tool calls count transcript tool-use blocks, and wall time comes "
        "from CLI `duration_ms`. A, B and D have up to 20 questions each. E0 and E1 use the same ten "
        "seeded questions, including q18. The runner uses up to eight workers and a ten-minute "
        "timeout per invocation. Accuracy and averages use scored answers. Where any answer is missing, "
        "brackets show the observed exact-answer rate across all planned questions in the row.", "",
        "B coverage rose from 17/20 to 19/20 after the selector was adjusted following question freeze. "
        "The ground truth and analyzer compute the same relations, which structurally favors B. "
        "E0 and E1 compare source inspection with and without the graph for this paired sample.", "",
    ]
    for title, excluded in (
        ("Full scheduled sets", set()),
        ("Excluding q18 and q19", SELECTOR_ADJUSTED),
        ("Excluding A-guessable questions", guessable),
        ("Excluding q18, q19 and A-guessable questions", SELECTOR_ADJUSTED | guessable),
    ):
        lines.extend([f"## {title}", "", table(schedule, results, excluded), ""])
    lines.extend(["## Failed answers", ""])
    failures = 0
    for condition, qid in schedule:
        row = results.get((condition, qid))
        if row and not (row["grade"]["content_exact"] and row["grade"]["format_ok"]):
            lines.append(f"- {condition} {qid}. {failure_reason(questions[qid], row)}")
            failures += 1
    if not failures:
        lines.append("No scored answers failed.")
    missing = [(condition, qid) for condition, qid in schedule if (condition, qid) not in results]
    if missing:
        lines.extend(["", "## Invocations without a scored answer", ""])
        for condition, qid in missing:
            records = attempts.get((condition, qid), [])
            if records:
                record = records[-1]
                error = (record["payload"] or {}).get("result") or (
                    "Timed out" if record["timeout"] else f'CLI exit code {record["returncode"]}'
                )
                reason = " ".join(error.split())
            else:
                reason = "No invocation recorded"
            lines.append(f"- {condition} {qid}. {reason}")
    output.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    report(args.run, args.output)
