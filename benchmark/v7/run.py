"""Run the frozen v7 matrix against the two fixed app directories."""
import concurrent.futures
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

BASE = Path('/tmp/neorion-bench-v7')
EXCLUDED = {'CLAUDE.md', 'AGENTS.md', '.cursor/rules/neorion.mdc', '.mcp.json',
            '.cursor/mcp.json', '.vscode/mcp.json'}
ENV = {k: v for k, v in os.environ.items() if not k.startswith(
    ('ANTHROPIC_', 'CLAUDE_', 'CLAUDECODE', 'AWS_', 'GOOGLE_APPLICATION_CREDENTIALS', 'VERTEX_'))}
PROMPTS = {tuple(row[k] for k in ('id', 'model', 'variant')): row
           for row in map(json.loads, Path('prompts.jsonl').read_text().splitlines())}
SYSTEM, = {row['append_system_prompt'] for row in PROMPTS.values()}
PROBES = {
    'who_renders': 'src/features/poll/components/poll-footer.tsx#PollFooter',
    'wrappers': '/[locale]/settings/webhooks',
    'rename_impact': 'src/lib/datetime/use-hydrated.ts#useHydrated',
    'api_consumers': '/api/updates',
    'search': 'webhook',
}


def dump(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def app(variant):
    return BASE / variant / 'app'


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory(root):
    return {p.relative_to(root).as_posix(): sha(p)
            for p in sorted(root.rglob('*')) if p.is_file()}


def split(files):
    return {p: h for p, h in files.items() if p not in EXCLUDED}, {
        p: files.get(p) for p in sorted(EXCLUDED)}


def snapshot(variant):
    source, excluded = split(inventory(app(variant)))
    tree = ''.join(f'{h}  {p}\n' for p, h in source.items())
    return dict(tree_sha256=hashlib.sha256(tree.encode()).hexdigest(), connect_files=excluded), tree


def manifest():
    archive = json.loads((BASE / 'archive.json').read_text())['E2']
    source, original_excluded = split(archive)
    cache = Path(subprocess.check_output(
        ['node', '-e', 'console.log(require(process.argv[1]).cachePath(process.argv[2]))',
         str(Path('../Neorion/extension/test/workspace-cache.cjs').resolve()), str(app('E2'))],
        text=True).strip())
    tools = json.loads(Path('preflight/mcp-tools.jsonl').read_text().splitlines()[1])['result']['tools']
    copies = {}
    for variant in ('E0', 'E2'):
        root = app(variant)
        files = inventory(root)
        current_source, excluded = split(files)
        assert current_source == source
        assert set(files) - set(archive) == ({'.mcp.json'} if variant == 'E2' else set())
        assert all(excluded[p] == original_excluded[p] for p in EXCLUDED
                   if variant == 'E0' or p not in {'CLAUDE.md', '.mcp.json'})
        snapshot_data, tree = snapshot(variant)
        tree_path = Path('preflight') / f'{variant}.tree.sha256'
        tree_path.write_text(tree)
        copies[variant] = dict(**snapshot_data, tree_file=str(tree_path))
    e0 = (app('E0') / 'CLAUDE.md').read_text()
    e2 = (app('E2') / 'CLAUDE.md').read_text()
    cache_files = inventory(cache)
    bundle = '.neorion/mcp/server.cjs'
    assert cache_files[bundle] == sha(Path('../Neorion/extension/out/mcp.cjs'))
    dump('graph_manifest.json', dict(
        neorion_commit='5d5cb82291d10d02ca6a07557d6e5c10e44d2090',
        rallly_commit='9ab01952cebd8db5165d0df1acaeeb5ea084b790',
        generated_at=(BASE / 'generated-at').read_text().strip(),
        claude_diff=''.join(difflib.unified_diff(e0.splitlines(True), e2.splitlines(True),
                                               fromfile='archive/CLAUDE.md', tofile='E2/CLAUDE.md')),
        mcp_file='.mcp.json', mcp_sha256=sha(app('E2') / '.mcp.json'),
        cache=str(cache), cache_files=cache_files, bundle_sha256=cache_files[bundle],
        tools=[dict(name='mcp__neorion__' + row['name'],
                    schema_characters=len(json.dumps(row['inputSchema'], separators=(',', ':'))))
               for row in tools],
        copies=copies))
    Path('RUN_SHA256SUMS').write_text(''.join(f'{sha(Path(p))}  {p}\n' for p in
                                           ('graph_manifest.json', 'run.py')))


def execute(model, variant, prompt, stem, baseline, projects, stream=False):
    root = app(variant)
    expected = dict(baseline['copies'][variant])
    del expected['tree_file']
    before, _ = snapshot(variant)
    assert before == expected, f'Copy changed before {stem}'
    session = str(uuid.uuid4())
    tools = 'Read,Grep,Glob'
    mcp = ['--mcp-config', '.mcp.json'] if variant == 'E2' else []
    allowed = ','.join([tools, *(t['name'] for t in baseline['tools'])]) if variant == 'E2' else tools
    command = ['claude', '-p', '--model', model, '--output-format',
               'stream-json' if stream else 'json', '--setting-sources', 'project',
               '--strict-mcp-config', *mcp, '--disable-slash-commands', '--tools', tools,
               '--allowedTools', allowed, '--session-id', session, '--append-system-prompt', SYSTEM]
    if stream:
        command.append('--verbose')
    print('START', stem, flush=True)
    start = time.monotonic()
    timeout = False
    with open(f'{stem}.json', 'wb') as output, open(f'{stem}.stderr', 'wb') as stderr:
        with subprocess.Popen(command, cwd=root, env=ENV, stdin=subprocess.PIPE, stdout=output,
                              stderr=stderr, start_new_session=True) as process:
            try:
                process.communicate(prompt.encode(), timeout=600)
            except subprocess.TimeoutExpired:
                timeout = True
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    elapsed = time.monotonic() - start
    after, _ = snapshot(variant)
    transcript = projects / str(root).replace('/', '-').replace('_', '-') / f'{session}.jsonl'
    if transcript.is_file():
        shutil.copyfile(transcript, f'{stem}.jsonl')
    size = Path(f'{stem}.json').stat().st_size
    meta = dict(model=model, variant=variant, session_id=session, exit_code=process.returncode,
                timeout=timeout, output_bytes=size, wall_seconds=elapsed, before=before, after=after,
                transcript=transcript.is_file(), cwd=str(root))
    dump(f'{stem}.meta', meta)
    assert after == expected, f'Copy changed after {stem}'
    print('DONE', stem, process.returncode, flush=True)
    return meta


def preflight(baseline, projects):
    prompt = ("Quote verbatim the project-instructions line containing 'NOT the Next.js'. "
              'If the project instructions include a Neorion sentence, also quote it verbatim.')
    directory = Path('preflight')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(execute, m, v, prompt, directory / f'{m}.{v}.instructions',
                               baseline, projects)
                   for m in ('sonnet', 'haiku') for v in ('E0', 'E2')]
        for future in futures:
            future.result()
    probe_prompt = ('Call mcp__neorion__neorion_query once for each of these exact kind and target '
                    'pairs, then report the responses: ' + json.dumps(PROBES))
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(execute, 'sonnet', v, probe_prompt if v == 'E2' else 'Reply OK.',
                               directory / f'sonnet.{v}.init', baseline, projects, True)
                   for v in ('E0', 'E2')]
        for future in futures:
            future.result()


def measured(baseline, projects):
    assert Path('preflight/verified.json').is_file()
    logs = Path('runs')
    logs.mkdir(exist_ok=False)
    order = [tuple(row[k] for k in ('id', 'model', 'variant'))
             for row in json.loads(Path('run_order.json').read_text())]
    assert len(order) == len(PROMPTS) == 56 and set(order) == set(PROMPTS)
    pairs = list(zip(order[::2], order[1::2], strict=True))
    assert all(a[:2] == b[:2] and {a[2], b[2]} == {'E0', 'E2'} for a, b in pairs)

    def attempt(key, number=0):
        task, model, variant = key
        suffix = f'.retry{number}' if number else ''
        stem = logs / ('.'.join(key) + suffix)
        row = execute(model, variant, PROMPTS[key]['user_prompt'], stem, baseline, projects)
        try:
            result = json.loads(Path(f'{stem}.json').read_text())
        except ValueError:
            result = {}
        row.update(id=task, attempt=number, is_error=result.get('is_error'))
        dump(f'{stem}.meta', row)
        return row

    def run_pair(pair):
        return [attempt(key) for key in pair]

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records = [row for pair in pool.map(run_pair, pairs) for row in pair]
    for _ in range(4):
        eligible = [row for row in records if row['attempt'] < 2 and (
            (row['timeout'] and not row['output_bytes']) or
            (not row['timeout'] and (row['exit_code'] or row['is_error'])))]
        if not eligible:
            break
        selected = min(eligible, key=lambda row: row['attempt'])
        key = tuple(selected[k] for k in ('id', 'model', 'variant'))
        records[records.index(selected)] = attempt(key, selected['attempt'] + 1)
    dump('attempts.json', records)


if __name__ == '__main__':
    if sys.argv[1] == 'manifest':
        manifest()
        sys.exit()
    auth = json.loads(subprocess.check_output(['claude', 'auth', 'status'], env=ENV))
    assert auth['loggedIn'] and auth['authMethod'] == 'claude.ai'
    assert auth['apiProvider'] == 'firstParty' and auth['storedClaudeAiLogin']
    baseline = json.loads(Path('graph_manifest.json').read_text())
    projects = Path(auth['projectsDirectory'])
    if sys.argv[1] == 'preflight':
        preflight(baseline, projects)
    elif sys.argv[1] == 'measure':
        measured(baseline, projects)
    else:
        raise SystemExit('Expected manifest, preflight, or measure')
