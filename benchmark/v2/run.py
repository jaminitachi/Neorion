"""Run the frozen v2 experiment with a Claude Code subscription."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import uuid

from benchmark import DIRECTORY, checked_questions, read_lines

REPOS = DIRECTORY.parents[2] / "bench-repos"
MAX_RETRIES = 4


def invoke(row, attempt, question, contexts, run, env):
    key = f'{row["condition"]}-{row["id"]}-{attempt}'
    agent = row["condition"] in {"E0", "E1"}
    with_workspace = run / "workspaces" / key
    with_workspace.mkdir(parents=True)
    if agent:
        repo = question["repo"].rsplit("/", 1)[1]
        # checked_questions verifies these repository HEADs against the pinned commits.
        tracked = subprocess.Popen(["git", "-C", REPOS / repo, "archive", "HEAD"], stdout=subprocess.PIPE)
        with tracked.stdout, tarfile.open(fileobj=tracked.stdout, mode="r|") as archive:
            archive.extractall(with_workspace, filter="data")
        if tracked.wait():
            raise RuntimeError(f"git archive failed for {repo}")
        graph = with_workspace / ".neorion/graph"
        overview = with_workspace / "codebase_graph.md"
        if graph.exists() or overview.exists():
            raise RuntimeError("Pinned source already contains graph files")
        if row["condition"] == "E1":
            shutil.copy2(contexts / repo / overview.name, overview)
            shutil.copytree(contexts / repo / ".neorion/graph", graph)

    session = str(uuid.uuid4())
    command = [
        "claude", "-p", "--model", "opus", "--output-format", "json",
        "--safe-mode", "--restricted", "--strict-mcp-config", "--no-chrome",
        "--tools", "Read,Grep,Glob" if agent else "",
        "--permission-mode", "dontAsk", "--permission-prompts", "none",
        "--session-id", session,
        "--system-prompt", "Answer the user’s repository question.",
    ]
    if agent:
        command += ["--allowed-tools", "Read,Grep,Glob"]
    else:
        command += ["--no-session-persistence"]

    raw = run / "attempts" / f"{key}.json"
    out = run / "attempts" / f"{key}.stdout"
    err = run / "attempts" / f"{key}.stderr"
    timeout = False
    try:
        with out.open("x") as stdout, err.open("x") as stderr:
            result = subprocess.run(command, cwd=with_workspace, env=env, input=row["prompt"],
                                    text=True, stdout=stdout, stderr=stderr, timeout=600)
        returncode = result.returncode
    except subprocess.TimeoutExpired:
        timeout = True
        returncode = None

    try:
        payload = json.loads(out.read_text())
    except ValueError:
        payload = None
    record = {"id": row["id"], "condition": row["condition"], "attempt": attempt,
              "returncode": returncode, "timeout": timeout, "payload": payload}
    raw.write_text(json.dumps(record, ensure_ascii=False) + "\n")
    if agent and payload and payload.get("session_id") == session:
        project = str(with_workspace).replace("/", "-").replace(".", "-")
        transcript = Path(env.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))) / "projects" / project / f"{session}.jsonl"
        if transcript.is_file():
            shutil.copy2(transcript, run / "attempts" / f"{key}.transcript.jsonl")

    shutil.rmtree(with_workspace)
    error = payload is None or payload.get("is_error") or returncode != 0
    print(f'{key} {"failed" if error else "finished"}', flush=True)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contexts", type=Path)
    parser.add_argument("run", type=Path)
    args = parser.parse_args()
    run = args.run.resolve()
    contexts = args.contexts.resolve()
    subprocess.run(["sha256sum", "-c", "prompts.sha256"], cwd=DIRECTORY, check=True)
    questions = {item["id"]: item for item in checked_questions()}
    schedule = read_lines(DIRECTORY / "prompts.jsonl")
    if len(schedule) != 80 or len({(x["id"], x["condition"]) for x in schedule}) != 80:
        raise ValueError("Expected 80 distinct frozen prompts")
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("ANTHROPIC_") and key not in {
               "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
               "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_USE_ANTHROPIC",
           }}
    auth = json.loads(subprocess.check_output(["claude", "auth", "status"], env=env))
    if not auth.get("loggedIn") or auth.get("authMethod") != "claude.ai" or auth.get("apiProvider") != "firstParty":
        raise RuntimeError("Claude Code needs a logged-in first-party subscription")
    (run / "attempts").mkdir(parents=True)
    retries = 0
    for conditions in ({"A"}, {"B", "D"}, {"E0", "E1"}):
        rows = [row for row in schedule if row["condition"] in conditions]
        with ThreadPoolExecutor(max_workers=8) as pool:
            pending = [(row, pool.submit(invoke, row, 1, questions[row["id"]], contexts, run, env))
                       for row in rows]
            for row, future in pending:
                result = future.result()
                crashed = result["timeout"] or (
                    result["payload"] is None and result["returncode"] != 0
                )
                if crashed and retries < MAX_RETRIES:
                    retries += 1
                    invoke(row, 2, questions[row["id"]], contexts, run, env)


if __name__ == "__main__":
    main()
