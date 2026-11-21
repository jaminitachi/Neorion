import concurrent.futures as cf
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess as sp
import sys
import tempfile
import time
import uuid

base = Path('/tmp/neorion-bench-v6')
app = base / 'app'
repo = Path('../bench-repos/dub').resolve()
commit = '6b463b4bdd9ed2fd9aa416f67b5b77d317b1471e'
def git(*args):
    return sp.check_output(['git','-C',str(repo),*args])
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def key(row):
    return tuple(row[k] for k in ('id','model','variant'))
def load(path):
    return list(map(json.loads,Path(path).read_text().splitlines()))
def dump(path,obj):
    Path(path).write_text(json.dumps(obj,indent=2,ensure_ascii=False)+'\n')
env={k:v for k,v in os.environ.items() if not k.startswith(('ANTHROPIC_','CLAUDE_','CLAUDECODE','AWS_','GOOGLE_APPLICATION_CREDENTIALS','VERTEX_'))}
env.update(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',CLAUDE_CODE_DISABLE_AUTO_MEMORY='1')
prompts={key(r):r for r in load('prompts.jsonl')}
order=list(map(key,json.loads(Path('run_order.json').read_text())))
TOOLS='Read,Grep,Glob,'+','.join('mcp__neorion__neorion_'+n for n in ('who_renders','wrappers','rename_impact','api_consumers','search'))

def run(k, logs, attempt=0, preflight=False):
    row=prompts[k]
    stem=logs/('.'.join(k)+(f'.retry{attempt}' if attempt else ''))
    with tempfile.TemporaryDirectory(prefix='neorion-v6-run-') as directory:
        root=Path(directory)
        sp.run(['tar','-x','-C',directory],input=archive,check=True)
        if k[2] in ('E2','E3'):
            for p in manifest['files'] if k[2]=='E2' else manifest['e3_files']:
                dest=root/p
                dest.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(app/p,dest)
        session=str(uuid.uuid4())
        command=['claude','-p','--model',k[1],'--output-format','json','--setting-sources','project',
                 '--strict-mcp-config',*(['--mcp-config','.mcp.json'] if k[2]=='E2' else []),'--disable-slash-commands','--tools','Read,Grep,Glob',
                 '--allowedTools',TOOLS if k[2]=='E2' else 'Read,Grep,Glob','--session-id',session,
                 '--append-system-prompt',row['append_system_prompt']]
        prompt=row['user_prompt']
        if preflight:
            if k[2]=='E2':
                prompt = ('Call all five Neorion tools once each. Use who_renders with component '
                          'ui/folders/add-folder-form.tsx#AddFolderForm, wrappers with route '
                          '/app.dub.co/[slug]/settings/domains, rename_impact with symbol '
                          'lib/swr/use-folder-users.ts#useFolderUsers, api_consumers with route '
                          '/api/tags, and search with text folder. Reply with a short summary.')
            else:
                prompt = 'Reply with OK.'
            if k[2]=='E0':
                assert not any((root/p).exists() for p in ('CLAUDE.md','codebase_graph.md','neorion','.neorion','.mcp.json'))
        print('START',*k,attempt,flush=True)
        started=time.monotonic()
        timeout=False
        with open(f'{stem}.json','wb') as out,open(f'{stem}.stderr','wb') as err:
            proc=sp.Popen(command,cwd=root,env=env,stdin=sp.PIPE,stdout=out,stderr=err,start_new_session=True)
            try:
                proc.communicate(prompt.encode(),timeout=600)
            except sp.TimeoutExpired:
                timeout=True
                os.killpg(proc.pid,signal.SIGKILL)
                proc.wait()
        elapsed=time.monotonic()-started
        transcript=projects/directory.replace('/','-').replace('_','-')/(session+'.jsonl')
        if transcript.is_file():
            shutil.copyfile(transcript,f'{stem}.jsonl')
        output=Path(f'{stem}.json').read_bytes()
        try:
            result=json.loads(output)
        except ValueError:
            result={}
        meta=dict(id=k[0],model=k[1],variant=k[2],attempt=attempt,cwd=directory,session_id=session,
                  wall_seconds=elapsed,timeout=timeout,exit_code=proc.returncode,output_bytes=len(output),
                  is_error=result.get('is_error'),transcript=transcript.is_file())
        dump(f'{stem}.meta',meta)
        print('DONE',*k,attempt,round(elapsed,2),proc.returncode,result.get('is_error'),flush=True)
        return meta

if __name__ == '__main__':
    sp.run(['sha256sum','-c','SHA256SUMS'],check=True)
    manifest=json.loads(Path('graph_manifest.json').read_text())
    assert all(digest(app/p)==info['sha256'] for p,info in manifest['files'].items())
    auth=json.loads(sp.check_output(['claude','auth','status'],env=env))
    assert auth['loggedIn'] and auth['authMethod']=='claude.ai' and auth['apiProvider']=='firstParty' and auth['storedClaudeAiLogin']
    projects=Path(auth['projectsDirectory'])
    archive=git('archive',commit+':apps/web')
    version=sp.check_output(['claude','--version'],env=env,text=True).strip()
    if sys.argv[1]=='preflight':
        logs=Path('preflight')
        logs.mkdir(exist_ok=True)
        results=[]
        for model in ('sonnet','haiku'):
            for variant in ('E2','E3','E0'):
                k=next(k for k in order if k[1:]==(model,variant))
                meta=run(k,logs,preflight=True)
                assert meta['exit_code']==0 and not meta['is_error'] and meta['transcript'],meta
                events=load(logs/('.'.join(k)+'.jsonl'))
                context='\n'.join(json.dumps(e,ensure_ascii=False) for e in events if e.get('type')=='api-request-blob')
                shapes=[e['shape'] for e in events if e['type']=='api-request-shape']
                assert shapes and all(isinstance(shape.get('tools'),list) for shape in shapes)
                offered={t['name'] for shape in shapes for t in shape['tools'] if t.get('name','').startswith('mcp__neorion__')}
                ids={e['message']['model'] for e in events if e['type']=='assistant' and e.get('message',{}).get('model') not in (None,'<synthetic>')}
                assert len(ids)==1 and next(iter(ids)).startswith(f'claude-{model}-'),ids
                loaded='/CLAUDE.md (project instructions' in context and 'call the neorion_* tools first' in context
                assert loaded == (variant!='E0'), (model,variant,loaded)
                if variant=='E2':
                    expected=set(TOOLS.split(',')[3:])
                    calls=[b for e in events if e['type']=='assistant' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use' and b.get('name') in expected]
                    replies=[b for e in events if e['type']=='user' and isinstance(e.get('message',{}).get('content'),list) for b in e['message']['content'] if b.get('type')=='tool_result' and b.get('tool_use_id') in {c['id'] for c in calls}]
                    assert offered==expected and {c['name'] for c in calls}==expected and len(calls)==len(replies)==5, (offered,calls)
                    assert all(not r.get('is_error') and '[stale]' not in json.dumps(r) for r in replies),replies
                else:
                    assert not offered,offered
                results.append(dict(model=model,variant=variant,model_id=next(iter(ids)),tools=sorted(offered),claude_md_loaded=loaded))
        dump(logs/'verified.json',results)
    else:
        assert Path('preflight/verified.json').is_file() and Path('oracle.jsonl').is_file()
        logs=Path('runs')
        logs.mkdir(exist_ok=True)
        assert not list(logs.iterdir())
        with cf.ThreadPoolExecutor(max_workers=3) as pool:
            def run_group(group):
                return [run(k,logs) for k in group]
            groups=[order[i:i+3] for i in range(0,len(order),3)]
            records=[r for group in pool.map(run_group,groups) for r in group]
        for _ in range(4):
            eligible=[r for r in records if r['attempt'] < 2 and
                      ((r['timeout'] and not r['output_bytes']) or (not r['timeout'] and (r['exit_code'] or r['is_error'])))]
            if not eligible:
                break
            selected=min(eligible,key=lambda r:r['attempt'])
            records[records.index(selected)]=run(key(selected),logs,selected['attempt']+1)
        dump('attempts.json',records)
