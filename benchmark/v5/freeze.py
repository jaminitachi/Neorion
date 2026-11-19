import difflib
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess

def load(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines()]

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

app = Path('/tmp/neorion-bench-v5/app')
hint = ('This repository has Neorion query tools (mcp__neorion__neorion_who_renders, neorion_wrappers, '
        'neorion_rename_impact, neorion_api_consumers, neorion_search). For structural questions '
        '(which routes render a component, which layouts and providers wrap a route, which files a rename '
        'touches, which files call an API route), call the matching tool first. Results list path:line; '
        'confirm by reading only those lines instead of re-deriving the chain from source.')
base = {(r['id'], r['model']):r for r in load('prompts.jsonl') if r['variant'] == 'E0'}
order = json.loads(Path('run_order.json').read_text())
with Path('e2_prompts.jsonl').open('w') as out:
    for r in order:
        if r['variant'] == 'E0':
            row = base[r['id'], r['model']]
            row = {**row, 'variant':'E2', 'append_system_prompt':row['append_system_prompt']+'\n\n'+hint}
            out.write(json.dumps(row,ensure_ascii=False)+'\n')
v4 = json.loads(Path('../bench-v4/graph_manifest.json').read_text())
graph = ['codebase_graph.md'] + sorted(str(p.relative_to(app)) for p in (app/'neorion/graph').rglob('*') if p.is_file())
manifest = {
    'neorion_commit': subprocess.check_output(['git','-C','../Neorion','rev-parse','HEAD'],text=True).strip(),
    'formbricks_commit': next(iter(base.values()))['commit'],
    'generated_utc': datetime.fromtimestamp((app/'.mcp.json').stat().st_mtime,timezone.utc).isoformat(),
    'mcp_config': json.loads((app/'.mcp.json').read_text()),
    'index_sha256': sha(app/'.neorion/index.v1.json'),
    'tarball_sha256': sha(Path('../Neorion/extension/out/neorion-mcp-0.4.0.tgz')),
    'bundled_server_sha256': sha(Path('../Neorion/extension/out/mcp.cjs')),
    'graph_files': graph,
    'overview_origin': 'Byte-identical to verified v4 E1 overview',
    'registration': 'neo.connectAITools with VS Code test host, CLAUDE.md and Claude Code, Use bundled server',
    'claude_md_diff': ''.join(difflib.unified_diff(['@AGENTS.md\n'],(app/'CLAUDE.md').read_text().splitlines(True),'before/CLAUDE.md','after/CLAUDE.md')),
    'graph_delta_from_e1': sorted(p for p in set(graph)|set(v4['graph_files']) if p not in graph or sha(app/p)!=v4['files'].get(p,{}).get('sha256')),
    'files': {p:{'sha256':sha(app/p),'bytes':(app/p).stat().st_size} for p in graph+['.neorion/index.v1.json','CLAUDE.md','.mcp.json','.neorion/mcp/server.cjs']},
    'e2_prompts_sha256':sha(Path('e2_prompts.jsonl')),
}
Path('graph_manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
