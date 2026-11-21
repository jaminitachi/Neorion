"""Score the final v6 attempts and produce the preregistered report."""
import json
import subprocess
import sys
from math import comb
from pathlib import Path
from statistics import mean, median

import score


MODELS = ('sonnet', 'haiku')
VARIANTS = ('E0', 'E2', 'E3')
TOKEN_FIELDS = ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')


def write_jsonl(path, rows):
    Path(path).write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))


def key(row):
    return row['id'], row['model'], row['variant']


def attempt_stem(row):
    suffix = f'.retry{row["attempt"]}' if row['attempt'] else ''
    return Path('runs') / ('.'.join(key(row)) + suffix)


def events_and_result(row):
    stem = attempt_stem(row)
    try:
        result = json.loads(Path(f'{stem}.json').read_text())
    except ValueError:
        result = {}
    transcript = Path(f'{stem}.jsonl')
    events = score.load_jsonl(transcript) if transcript.is_file() else []
    return events, result


def run_metrics(row, events, result, graph_files):
    messages = [event['message'] for event in events if event.get('type') == 'assistant']
    first_usage = next((m['usage'] for m in messages if m.get('usage')), None)
    model_ids = sorted({m['model'] for m in messages if m.get('model') not in (None, '<synthetic>')})
    calls = {}
    reads = {}
    successful_mcp = set()
    root = Path(row['cwd'])
    for event in events:
        if event.get('type') not in ('assistant', 'user'):
            continue
        blocks = event.get('message', {}).get('content')
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            if block['type'] == 'tool_use':
                calls[block['id']] = block
            if block['type'] == 'tool_result' and not block.get('is_error'):
                call = calls.get(block['tool_use_id'])
                if call and call['name'].startswith('mcp__'):
                    successful_mcp.add(block['tool_use_id'])
                if not call or call['name'] != 'Read':
                    continue
                path = Path(call['input']['file_path'])
                if path.is_absolute() and path.is_relative_to(root):
                    path = path.relative_to(root)
                detail = event.get('toolUseResult')
                file = detail.get('file', {}) if isinstance(detail, dict) else {}
                if str(path) in graph_files and isinstance(file.get('content'), str):
                    reads[block['tool_use_id']] = len(file['content'].encode())
    usage = result.get('usage')
    weighted = None
    if usage:
        cache = usage['cache_creation']
        assert sum(cache.values()) == usage['cache_creation_input_tokens']
        weighted = (usage['input_tokens'] + .1 * usage['cache_read_input_tokens']
                    + 1.25 * cache['ephemeral_5m_input_tokens']
                    + 2 * cache['ephemeral_1h_input_tokens'] + 5 * usage['output_tokens'])
    return {
        **row, 'failed': bool(row['exit_code'] or row['timeout'] or result.get('is_error') or not isinstance(result.get('result'), str)),
        'input_tokens': sum(usage[f] for f in TOKEN_FIELDS) if usage else None,
        'output_tokens': usage['output_tokens'] if usage else None,
        'weighted_tokens': round(weighted, 2) if weighted is not None else None,
        'turns': result.get('num_turns'),
        'requests': len({e['id'] for e in events if e.get('type') == 'api-request'}) if events else None,
        'tool_calls': len(calls) if events else None,
        'mcp_calls': sum(b['name'].startswith('mcp__') for b in calls.values()) if events else None,
        'mcp_successes': len(successful_mcp) if events else None,
        'graph_reads': len(reads) if events else None,
        'graph_bytes': sum(reads.values()) if events else None,
        'first_request_input_tokens': sum(first_usage.get(f, 0) for f in TOKEN_FIELDS) if first_usage else None,
        'model_ids': model_ids,
    }


def total(rows, field):
    values = [row[field] for row in rows]
    return sum(values) if all(v is not None for v in values) else None


def count_exact(rows):
    return sum(row['exact'] for row in rows)


def fmt(value, digits=0):
    return '—' if value is None else f'{value:,.{digits}f}'


def table(lines, headers, rows):
    lines.append('| ' + ' | '.join(headers) + ' |')
    lines.append('| ' + ' | '.join('---' for _ in headers) + ' |')
    lines.extend('| ' + ' | '.join(map(str, row)) + ' |' for row in rows)
    lines.append('')


def compare(left, right):
    if any(row['input_tokens'] is None for row in left + right):
        return None
    differences = [b['input_tokens'] - a['input_tokens'] for a, b in zip(left, right, strict=True)]
    lower = sum(d > 0 for d in differences)
    higher = sum(d < 0 for d in differences)
    n = lower + higher
    p = min(1, 2 * sum(comb(n, k) for k in range(min(lower, higher) + 1)) / 2**n)
    savings = sum(differences)
    top = sorted(zip(differences, (r['id'] for r in left)), reverse=True)[:3]
    return dict(lower=lower, higher=higher, ties=len(differences) - n, p=p,
                median=median(differences), savings=savings,
                fraction=savings / total(right, 'input_tokens'),
                top=top, concentration=sum(d for d, _ in top) / savings if savings > 0 else None)


def verdict(value):
    if value is None:
        return 'Indeterminate'
    return 'Pass' if value else 'Fail'


def miss_detail(task, text):
    answer = score.extract_answer(text)
    gold = task['answer']
    if task['answer_kind'] == 'placement':
        return f'Expected {json.dumps(gold, ensure_ascii=False)}. Submitted {json.dumps(answer, ensure_ascii=False)}.'
    norm = score.norm_route if task['answer_kind'] == 'route_set' else (
        lambda value: score.norm_file(value, task['repo'], task.get('app_subdir')))
    predicted = [norm(item) for item in answer] if isinstance(answer, list) else []
    expected = [norm(item) for item in gold]
    missing = sorted(set(expected) - set(predicted))
    extra = sorted(set(predicted) - set(expected))
    display = lambda items: ', '.join(f'`{item}`' for item in items) or '—'
    detail = f'Missing {display(missing)}. Extra {display(extra)}.'
    if task['answer_kind'] == 'ordered_file_list':
        detail += f' Expected order {display(expected)}. Submitted order {display(predicted)}.'
    if answer is None:
        detail += ' The scorer found no parseable answer.'
    return detail


def main():
    manifest = json.loads(Path('graph_manifest.json').read_text())
    runs = json.loads(Path('attempts.json').read_text())
    tasks = {t['id']: t for t in score.load_jsonl('tasks.jsonl')}
    ids = sorted(tasks)
    structural, control = ids[:-1], ids[-1]
    assert len(runs) == 66 and {key(r) for r in runs} == {(i, m, v) for i in ids for m in MODELS for v in VARIANTS}
    assert sum(r['attempt'] for r in runs) <= 4 and all(r['attempt'] <= 2 for r in runs)
    metrics, responses, texts = {}, [], {}
    for row in runs:
        events, result = events_and_result(row)
        k = key(row)
        metrics[k] = run_metrics(row, events, result, set(manifest['graph_files']))
        text = '' if metrics[k]['failed'] else result['result']
        texts[k] = text
        responses.append(dict(id=k[0], model=k[1], variant=k[2], text=text))
    write_jsonl('responses.jsonl', responses)
    subprocess.run([sys.executable, 'score.py', 'tasks.jsonl', 'responses.jsonl', '--out', 'scores.jsonl'], check=True)
    for row in score.load_jsonl('scores.jsonl'):
        target = metrics[key(row)]
        target.update(row)
        if target['failed']:
            target.update(exact=False, f1=0)
    write_jsonl('run_metrics.jsonl', metrics.values())

    lines = [
        '# Benchmark v6',
        '',
        f'Neorion build SHA `{manifest["neorion_commit"]}`. Dub SHA `{manifest["dub_commit"]}`.',
        '',
        'Amendment 1 replaced the original Neorion pin `4a9e3fc` after the initial `who_renders` preflight probe on dub exposed a bug. The tasks remained held-out. The fix means the evaluation was only partially blind with respect to the repository. The graph and index were generated with the amended commit and its source unchanged.',
        '',
        'Claude Code 2.1.327 ran with Claude.ai subscription authentication and credential environment variables stripped. Each model, task, and variant used a fresh git archive and a new session. Both models passed preflight, which was excluded from measurement. All tables draw from the final measured attempts. Input includes uncached input, cache creation, and cache reads.',
        '',
        f'{len(runs)} measured cells, {sum(r["attempt"] for r in runs)} retries, and {sum(r["failed"] for r in metrics.values())} final CLI failures.',
        '',
        '## Totals',
        '',
        'MCP attempts count distinct tool-use IDs emitted by the model. E3 exposed no MCP tools. Its MCP attempts returned unavailable-tool errors.',
        '',
    ]
    summaries = []
    for model in MODELS:
        for variant in VARIANTS:
            for label, subset in [('All', ids), ('Structural', structural)]:
                rows = [metrics[i, model, variant] for i in subset]
                summaries.append([model, variant, label, f'{count_exact(rows)}/{len(rows)}', fmt(mean(r['f1'] for r in rows), 3),
                                  fmt(total(rows, 'input_tokens')), fmt(total(rows, 'output_tokens')),
                                  fmt(total(rows, 'weighted_tokens'), 2), fmt(total(rows, 'turns')), fmt(total(rows, 'requests')),
                                  fmt(total(rows, 'tool_calls')), fmt(total(rows, 'mcp_calls')), fmt(total(rows, 'mcp_successes')),
                                  fmt(total(rows, 'graph_reads')),
                                  fmt(total(rows, 'graph_bytes')), fmt(total(rows, 'first_request_input_tokens')),
                                  fmt(total(rows, 'wall_seconds'), 2)])
    table(lines, ['Model', 'Variant', 'Scope', 'Exact', 'Mean F1', 'Input', 'Output', 'Weighted', 'Turns', 'Requests',
                  'Tools', 'MCP attempts', 'MCP successes', 'Graph reads', 'Graph bytes', 'First-request input', 'Seconds'], summaries)
    model_ids = [(m, ', '.join(sorted({mid for row in metrics.values() if row['model'] == m for mid in row['model_ids']}))) for m in MODELS]
    table(lines, ['Alias', 'Resolved model IDs'], model_ids)
    lines.extend(['## Per task', '', 'Each cell gives input tokens, exact match, and F1. Task 11 is the control.', ''])
    for model in MODELS:
        lines.extend([f'### {model}', ''])
        def cell(row):
            return f'{fmt(row["input_tokens"])} / {"yes" if row["exact"] else "no"} / {row["f1"]:.3f}'
        table(lines, ['Task', *VARIANTS],
              [[i, *(cell(metrics[i, model, v]) for v in VARIANTS)] for i in ids])

    lines.extend(['## Paired comparisons on structural tasks', '',
                  'Lower, higher, and tied refer to the first variant’s input. The median is second minus first in input tokens. The two-sided exact sign test excludes ties. The top-three share uses net savings and is undefined when net savings are zero or negative.', ''])
    comparisons = {}
    paired = []
    for model in MODELS:
        for first, second in [('E2', 'E0'), ('E2', 'E3'), ('E3', 'E0')]:
            result = compare([metrics[i, model, first] for i in structural], [metrics[i, model, second] for i in structural])
            comparisons[model, first, second] = result
            if result is None:
                paired.append([model, f'{first} vs {second}', *(['—'] * 9)])
                continue
            top = ', '.join(f'{i.removeprefix("v6-dub-")} ({d:+,})' for d, i in result['top'])
            concentration = result['concentration']
            paired.append([model, f'{first} vs {second}', result['lower'], result['higher'], result['ties'], f'{result["p"]:.6f}',
                           fmt(result['median'], 1), fmt(result['savings']), f'{result["fraction"]:.2%}',
                           top, '—' if concentration is None else f'{concentration:.2%}'])
    table(lines, ['Model', 'Comparison', 'Lower', 'Higher', 'Tied', 'Exact p', 'Median difference', 'Net savings',
                  'Savings rate', 'Top three differences', 'Top-three share'], paired)

    lines.extend(['## Preregistered verdicts', ''])
    criteria, conclusions, p1_results = [], [], []
    for model in MODELS:
        s = {v: [metrics[i, model, v] for i in structural] for v in VARIANTS}
        exact = {v: count_exact(rows) for v, rows in s.items()}
        f1 = {v: mean(row['f1'] for row in rows) for v, rows in s.items()}
        first = comparisons[model, 'E2', 'E0']
        mcp = comparisons[model, 'E2', 'E3']
        tokens = {v: total(rows, 'input_tokens') for v, rows in s.items()}
        c0, c2 = (metrics[control, model, v] for v in ('E0', 'E2'))
        control_inputs = c0['input_tokens'], c2['input_tokens']
        p1 = None if first is None else (tokens['E2'] * 100 <= tokens['E0'] * 70 and first['lower'] >= 8)
        p2 = exact['E2'] >= exact['E0'] and f1['E2'] >= f1['E0'] - .02
        p3 = None if mcp is None else (tokens['E2'] * 100 <= tokens['E3'] * 80 and mcp['lower'] >= 8 and exact['E2'] >= exact['E3'])
        p4 = None if None in control_inputs else ((not c0['exact'] or c2['exact']) and control_inputs[1] * 100 <= control_inputs[0] * 125)
        if any(row['failed'] and row['input_tokens'] is None for row in metrics.values() if row['model'] == model):
            p1 = p3 = p4 = None
        p1_results.append(p1)
        criteria.extend([
            [model, 'P1', verdict(p1), '—' if first is None else f'E2/E0 input {tokens["E2"]/tokens["E0"]:.2%}, {first["lower"]}/10 lower'],
            [model, 'P2', verdict(p2), f'E2/E0 exact {exact["E2"]}/{exact["E0"]}, mean F1 {f1["E2"]:.3f}/{f1["E0"]:.3f}'],
            [model, 'P3', verdict(p3), '—' if mcp is None else f'E2/E3 input {tokens["E2"]/tokens["E3"]:.2%}, {mcp["lower"]}/10 lower, exact {exact["E2"]}/{exact["E3"]}'],
            [model, 'P4', verdict(p4), '—' if None in control_inputs else f'E2/E0 input {control_inputs[1]/control_inputs[0]:.2%}, exact {int(c2["exact"])}/{int(c0["exact"])}'],
        ])
        if p1 and p2:
            conclusions.append(f'- **{model}** reproduced input-token savings on the held-out structural tasks. E2 saved {first["fraction"]:.2%} relative to E0, with {first["lower"]} lower, {first["higher"]} higher, and {first["ties"]} tied.')
        if p1 and p2 and p3:
            conclusions.append(f'- **{model}** met the preregistered criterion for the MCP server’s own effect.')
        if p1 and p3 is False:
            conclusions.append(f'- **{model}** savings came mainly from the guidance and graph files under the preregistered conclusion rule.')
        if p4 is False:
            if control_inputs[1] > control_inputs[0]:
                conclusions.append(f'- **{model}** failed P4. E2 increased control-task input by {control_inputs[1] - control_inputs[0]:,} tokens.')
            else:
                conclusions.append(f'- **{model}** failed P4 because E2 lost the control task’s exact match.')
    table(lines, ['Model', 'Criterion', 'Verdict', 'Measured components'], criteria)
    if p1_results == [False, False]:
        conclusions.append('- The v5 input-token savings did not reproduce on the held-out tasks under the preregistered rule.')
    if conclusions:
        lines.extend(conclusions + [''])

    lines.extend(['## Exact-match regressions', ''])
    regressions = []
    for model in MODELS:
        for first, second in [('E2', 'E0'), ('E2', 'E3'), ('E3', 'E0')]:
            regressed = [i for i in ids if metrics[i, model, second]['exact'] and not metrics[i, model, first]['exact']]
            regressions.append([model, f'{second} → {first}', ', '.join(regressed) or 'None'])
    table(lines, ['Model', 'Transition', 'Tasks'], regressions)
    lines.extend(['## All misses', ''])
    for model in MODELS:
        lines.extend([f'### {model}', ''])
        for variant in VARIANTS:
            for i in ids:
                row = metrics[i, model, variant]
                if row['exact']:
                    continue
                reason = 'CLI failure on the final attempt. ' if row['failed'] else ''
                lines.append(f'- **{i} {variant}** (F1 {row["f1"]:.3f}). {reason}{miss_detail(tasks[i], texts[i, model, variant])}')
        lines.append('')
    lines.extend(['Per-run metrics, model responses, and scorer output are recorded in `run_metrics.jsonl`, `responses.jsonl`, and `scores.jsonl`. Raw CLI logs and transcripts are retained in the local benchmark workspace.', ''])
    Path('RESULTS.md').write_text('\n'.join(lines))


if __name__ == '__main__':
    main()
