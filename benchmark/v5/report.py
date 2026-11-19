import json,sys,subprocess,re,random,hashlib
from collections import Counter
from pathlib import Path
from statistics import mean,median
from math import comb
sys.path.insert(0,str(Path.cwd()))
import score

base=Path(__file__).parent
runs=Path('runs')
tasks={t['id']:t for t in score.load_jsonl('tasks.jsonl')}
manifest=json.loads(Path('graph_manifest.json').read_text())
order=json.loads(Path('attempts.json').read_text())
def write(name,rows):
    Path(name).write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in rows))
responses=[]
metrics={}
evidence={}
from run import TOOLS
for row in order:
    ident,m,v=row['id'],row['model'],row['variant']
    t=tasks[ident]
    suffix=f'.retry{row["attempt"]}' if row['attempt'] else ''
    stem=runs/f'{ident}.{m}.{v}{suffix}'
    meta=json.loads(Path(f'{stem}.meta').read_text())
    result=json.loads(Path(f'{stem}.json').read_text() or '{}')
    if meta['exit_code']!=0 or result.get('is_error'):
        metrics[ident,m,v]={**row,'failed':True}
        continue
    responses.append({'id':ident,'model':m,'variant':v,'text':result['result']})
    raw=Path(f'{stem}.jsonl').read_text()

    events=[json.loads(line) for line in raw.splitlines()]
    shapes=[{tool['name'] for tool in e['shape']['tools']} for e in events if e['type']=='api-request-shape']
    assert shapes and all(names==set(TOOLS.split(','))|{'DeferredToolPlaceholder'} for names in shapes),stem
    root=Path(meta['cwd'])
    context=[b.get('text','') for e in events if e['type']=='api-request-blob' and isinstance(e.get('content',e.get('message',{}).get('content')),list) for b in e.get('content',e.get('message',{}).get('content')) if isinstance(b,dict)]
    assert any(f'{root}/CLAUDE.md (project instructions' in x and 'call the neorion_* tools first' in x for x in context),stem
    model_ids=sorted({e['message']['model'] for e in events if e['type']=='assistant' and e.get('message',{}).get('model') not in (None,'<synthetic>')})
    assert model_ids,stem
    ctx=[sum(e['message']['usage'].get(f,0) for f in ('input_tokens','cache_creation_input_tokens','cache_read_input_tokens')) for e in events if e['type']=='assistant' and e.get('message',{}).get('usage')]
    graph=set(manifest['graph_files'])
    excerpts=[]
    calls={}
    replies={}
    for event in events:
        if event['type'] not in {'assistant','user'}:continue
        content=event.get('message',{}).get('content',[])
        if not isinstance(content,list):continue
        for block in content:
            if block['type']=='tool_use': calls[block['id']]=block
            if block['type']=='tool_result':
                replies[block['tool_use_id']]=(block,event.get('toolUseResult') or {})
    assert all(c['name'] in TOOLS.split(',') for c in calls.values()),calls
    def relative(name):
        p=Path(name)
        return str(p.relative_to(root)) if p.is_absolute() and p.is_relative_to(root) else str(p)
    opened=set()
    graph_bytes=0
    graph_per_tool={}
    mcp_calls=Counter()
    mcp_results={}
    mcp_errors=0
    for tool_id,call in calls.items():
        if call['name'].startswith('mcp__neorion__'):
            mcp_calls[call['name'].removeprefix('mcp__neorion__neorion_')]+=1
        if tool_id not in replies:
            continue
        reply,details=replies[tool_id]
        if call['name'].startswith('mcp__neorion__'):
            content=reply['content']
            if not isinstance(content,str):
                content=''.join(block['text'] for block in content if block['type']=='text')
            mcp_results[tool_id]=content
            mcp_errors+=bool(reply.get('is_error'))
            continue
        if reply.get('is_error') or not isinstance(details,dict):
            continue
        if call['name']=='Read':
            file=details.get('file',{})
            name=relative(call['input']['file_path'])
            if name in graph and 'content' in file:
                opened.add(name)
                graph_per_tool[tool_id]=len(file['content'].encode())
                excerpts.append((name,file['content']))
        if call['name']=='Grep':
            names={relative(n) for n in details.get('filenames',[])} & graph
            search_path=relative(call['input'].get('path','.'))
            matches=[]
            for line in details.get('content','').splitlines(keepends=True):
                matched={name for name in graph if re.match(r'^'+re.escape(name)+r'[:\-]',line.removeprefix(str(root)+'/'))}
                if not matched and search_path in graph:
                    matched={search_path}
                if matched:
                    matches.append(line)
                    names.update(matched)
                    excerpts.extend((n,line) for n in matched)
            opened.update(names)
            if names:
                graph_per_tool[tool_id]=sum(len(line.encode()) for line in matches)
    u=result['usage']
    weighted=u['input_tokens']+u['cache_read_input_tokens']*.1+u['output_tokens']*5
    cache=u['cache_creation']
    assert sum(cache.values())==u['cache_creation_input_tokens']
    weighted+=1.25*cache['ephemeral_5m_input_tokens']+2*cache['ephemeral_1h_input_tokens']
    blobs={e['hash']:e['message'] for e in events if e['type']=='api-request-blob'}
    for event in events:
        if event['type']=='user' and isinstance(event.get('message'),dict):
            message=event['message']
            encoded=json.dumps(message,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
            blobs.setdefault(hashlib.sha256(encoded).hexdigest(),message)
    request_history={}
    exposures=Counter()
    for event in events:
        if event['type']!='api-request' or event['id'] in request_history:
            continue
        prior=request_history[event['base']] if event.get('base') else []
        hashes=prior[:event['keep']]+event['tail']
        request_history[event['id']]=hashes
        for tag in hashes:
            blocks=blobs.get(tag,{}).get('content',[])
            if isinstance(blocks,list):
                exposures.update(b['tool_use_id'] for b in blocks if b['type']=='tool_result')
    request_count=len(request_history)
    missing_blobs=len({tag for history in request_history.values() for tag in history if tag not in blobs})
    evidence[ident,m,v]=list(mcp_results.values())
    mcp_sizes={tool_id:len(result.encode()) for tool_id,result in mcp_results.items()}
    graph_bytes=sum(graph_per_tool.values())
    metrics[ident,m,v]={**row,'type':t['type'],'repo':t['repo'],
                  'uncached_input_tokens':u['input_tokens'],
                  'cache_creation_input_tokens':u['cache_creation_input_tokens'],
                  'cache_read_input_tokens':u['cache_read_input_tokens'],
                  'input_tokens':sum(u[k] for k in ('input_tokens','cache_creation_input_tokens','cache_read_input_tokens')),
                  'output_tokens':u['output_tokens'],'weighted_tokens':round(weighted,2),
                  'cli_list_cost_usd':result['total_cost_usd'],'api_turns':result['num_turns'],
                  'api_calls':request_count,'tool_calls':len(calls),
                  'graph_open':bool(opened),'graph_files':sorted(opened),'graph_bytes':graph_bytes,
                  'graph_calls':len(graph_per_tool), 'mcp_calls':sum(mcp_calls.values()),
                  'builtin_tool_errors':sum(bool(reply.get('is_error')) and not calls[id]['name'].startswith('mcp__')
                                            for id,(reply,_) in replies.items()),
                  'mcp_by_tool':dict(mcp_calls),'mcp_result_count':len(mcp_sizes),'mcp_errors':mcp_errors,
                  'mcp_bytes':sum(mcp_sizes.values()),'mcp_max_bytes':max(mcp_sizes.values(),default=0),
                  'mcp_stale_results':sum(bool(re.search(r'\[stale\]|\bstale \d+ files',t)) for t in mcp_results.values()),
                  'graph_sent_bytes':sum(exposures[id]*n for id,n in graph_per_tool.items()),
                  'graph_resent_bytes':sum(max(exposures[id]-1,0)*n for id,n in graph_per_tool.items()),
                  'mcp_sent_bytes':sum(exposures[id]*n for id,n in mcp_sizes.items()),
                  'mcp_resent_bytes':sum(max(exposures[id]-1,0)*n for id,n in mcp_sizes.items()),
                  'first_request_input_tokens':ctx[0],
                  'missing_request_blobs':missing_blobs,
                  'wall_seconds':meta['wall_seconds'],'model_ids':model_ids,'max_context_input_tokens':max(ctx,default=None)}
write('responses.jsonl',responses)
subprocess.run([sys.executable,'score.py','tasks.jsonl','responses.jsonl','--out','scores.jsonl'],check=True)
for s in score.load_jsonl('scores.jsonl'):
    k=s['id'],s['model'],s['variant']
    literal=[x for x in s.get('false_positives',[]) if any(
        re.search(r'(?<![\w/.-])'+re.escape(x)+r'(?![\w/.-])',payload) for payload in evidence[k])]
    metrics[k].update(s,mcp_false_positives=literal)
write('run_metrics.jsonl',metrics.values())


v4=Path('../bench-v4')
reference={(r['id'],r['model'],r['variant']):r for r in score.load_jsonl(v4/'run_metrics.jsonl')}
reference_scores={(r['id'],r['model'],r['variant']):r for r in score.load_jsonl(v4/'scores.jsonl')}
assert all(all(row.get(f)==reference[k].get(f) for f in ('f1','exact','false_positives','false_negatives'))
           for k,row in reference_scores.items())
all_metrics={**reference,**metrics}
oracle={r['id']:r for r in score.load_jsonl('oracle.jsonl')}
models=('sonnet','haiku')
variants=('E0','E1','E2')
core={'T1','T2','T3','T4'}
out=[]

def p(text=''):
    out.append(text)

def line(*values):
    p('| '+' | '.join('—' if value is None else str(value) for value in values)+' |')

def table(*columns):
    line(*columns)
    line(*['---']*len(columns))

def group(model,variant,types=None):
    return [r for r in all_metrics.values() if r['model']==model and r['variant']==variant
            and (types is None or r.get('type') in types) and not r.get('failed')]

def total(rows,field):
    return sum(r[field] for r in rows)

def display(value, format_spec):
    return None if value is None else format(value,format_spec)

version=subprocess.check_output(['claude','--version'],text=True).strip()
ok=[r for r in metrics.values() if not r.get('failed')]
comparable=(version.startswith('2.1.327 ') and all(
    r['model_ids']==[f'claude-{r["model"]}-5-5'] for r in [*reference.values(),*ok]))
p('# Neorion benchmark v5')
p()
p(f'{len(ok)}/{len(metrics)} E2 sessions completed with Claude.ai subscription authentication and '
  f'{len(list(runs.glob("*.retry*.meta")))} retries. Both excluded preflights used the measured JSON mode and '
  'confirmed that Claude Code loaded the Connect AI tools instructions and successfully queried all five MCP tools. '
  'All five results per preflight were fresh.')
p()
p(f'{version} resolved sonnet to `claude-sonnet-5-5` and haiku to `claude-haiku-5-5`.'
  if comparable else f'{version} or the resolved model IDs differ from v4. Direct comparisons are unavailable. ')
p(f'The benchmark used Neorion `{manifest["neorion_commit"]}` and index SHA-256 '
  f'`{manifest["index_sha256"]}`. The real Connect AI tools command registered the local bundle at '
  '`.neorion/mcp/server.cjs`; no runtime package installation was required. The v4 E1 overview was preserved '
  'byte for byte. Section 4.3 calls for regenerating the detail files and index at the frozen commit. '
  f'The manifest records {len(manifest["graph_delta_from_e1"])} added, removed, or changed detail files.')
p()
p('Input totals include cache reads and writes. Weighted tokens use the v4 weights. CLI USD is the CLI’s list-price estimate. '
  'API requests count distinct request IDs. Both models used rename_impact for the T6 reference-list control. E0 and E1 come from v4. Sessions were run at different times, with one run per task, model, and variant.')
p()
p('## Model and variant summary')
p()
table('Model','Variant','Runs','Mean F1','Exact','Input tokens','Output tokens','Weighted tokens',
      'Turns','API requests','Tool calls','Elapsed seconds','Peak context','CLI USD')
for m in models:
    for v in variants:
        rows=group(m,v)
        line(m,v,len(rows),f'{mean(r["f1"] for r in rows):.3f}',f'{total(rows,"exact")}/{len(rows)}',
             *[f'{total(rows,f):,}' for f in ('input_tokens','output_tokens')],f'{total(rows,"weighted_tokens"):,.1f}',
             *[total(rows,f) for f in ('api_turns','api_calls','tool_calls')],f'{total(rows,"wall_seconds"):.2f}',
             f'{max(r["max_context_input_tokens"] for r in rows):,}',f'{total(rows,"cli_list_cost_usd"):.5f}')

p()
p('## Criteria')
p()
table('Criterion','Sonnet measurement','Sonnet','Haiku measurement','Haiku')
verdicts={}
measurements={}
for m in models:
    e0,e1,e2=[group(m,v) for v in variants]
    if not comparable or len(e2)!=10:
        continue
    scopes=[group(m,v,core) for v in variants]
    first_scope=[group(m,v,{'T1','T2'}) for v in variants]
    a0,a2=[median(r['api_calls'] for r in group(m,v,{'T1','T3'})) for v in ('E0','E2')]
    t0,t2=[group(m,v,{'T6'})[0] for v in ('E0','E2')]
    cheaper=sum(r['input_tokens']<reference[r['id'],m,'E1']['input_tokens'] for r in e2)
    adopted=sum(r['mcp_calls']>0 for r in scopes[2])
    s1=total(e2,'input_tokens')
    s2=total(first_scope[2],'input_tokens')
    s3_exact=total(scopes[2],'exact')
    s3_f1=mean(r['f1'] for r in scopes[2])
    max_bytes=max(r['mcp_max_bytes'] for r in e2)
    false_positives=sum(len(r['mcp_false_positives']) for r in e2)
    cap_ok=max_bytes<=6000 and total(e2,'mcp_result_count')==total(e2,'mcp_calls')
    all_results=total(e2,'mcp_result_count')
    limits=(total(e0,'input_tokens')*.9,total(first_scope[1],'input_tokens')*.5,
            total(scopes[1],'exact')-1,mean(r['f1'] for r in scopes[1])-.02,a0*.7,t0['weighted_tokens']*1.25)
    verdicts[m]=[s1<=limits[0],s2<=limits[1] and cheaper>=8,s3_exact>=limits[2] and s3_f1>=limits[3],
                 a2<=limits[4],t2['f1']==t0['f1'] and t2['weighted_tokens']<=limits[5],
                 adopted>=7 and cap_ok and false_positives==0]
    measurements[m]=[
        f'{s1:,} / ≤ {limits[0]:,.1f} input',
        f'{s2:,} / ≤ {limits[1]:,.1f} T1+T2 input; {cheaper}/10 cheaper (≥ 8)',
        f'{s3_exact}/9 exact (≥ {limits[2]}); F1 {s3_f1:.3f} (≥ {limits[3]:.3f})',
        f'{a2:g} / ≤ {limits[4]:g} median requests',
        f'F1 {t2["f1"]:.3f} vs {t0["f1"]:.3f}; {t2["weighted_tokens"]:,.1f} / ≤ {limits[5]:,.1f} weighted',
        f'{adopted}/9 adopted (≥ 7); max {max_bytes:,} B across {all_results} results (≤ 6,000 B); {false_positives} literal false positives',
    ]
for i,label in enumerate(('Cost vs E0','Cost vs E1','Accuracy','API requests','T6 control','Adoption and cap')):
    line(f'S{i+1} {label}',*(entry for m in models for entry in
         (measurements[m][i],'Pass' if verdicts[m][i] else 'Fail')) if len(verdicts)==2 else ('—','Undetermined','—','Undetermined'))
p()
if len(verdicts)==2:
    s,h=(verdicts[m] for m in models)
    if all(v[0] and v[2] and v[5] for v in (s,h)):
        p('**Preregistered verdict: effective.** Both models passed S1 and S3 and met the S6 adoption requirement.')
    elif any(not v[2] for v in (s,h)) or all(not v[1] for v in (s,h)):
        p('**Preregistered verdict: failure.**')
    elif all(v[2] for v in (s,h)) and any(v[1] and v[5] for v in (s,h)) and sum(v[0] and v[5] for v in (s,h))==1:
        p('**Preregistered verdict: partially effective.** Cost evidence is limited to the model meeting S1 and S6.')
    else:
        p('**Preregistered verdict: undetermined under the registered rules.**')

p()
p('## MCP and Markdown use')
p()
table('Model','Who renders','Wrappers','Rename impact','API consumers','Search','MCP result bytes',
      'Largest result bytes','Stale results','Graph Reads or Greps','Graph result bytes')
for m in models:
    rows=group(m,'E2')
    counters=Counter()
    for r in rows:
        counters.update(r['mcp_by_tool'])
    line(m,*[counters[n] for n in ('who_renders','wrappers','rename_impact','api_consumers','search')],
         total(rows,'mcp_bytes'),max(r['mcp_max_bytes'] for r in rows),total(rows,'mcp_stale_results'),
         total(rows,'graph_calls'),total(rows,'graph_bytes'))

p()
p('### Input decomposition')
p()
p('The first-request token sum measures the initial context, including the task prompt, tool schemas and instructions. '
  'Subtracting it from total input gives the measured later-request input. The trace gives byte counts for graph and MCP '
  'results carried into subsequent requests. All request message hashes were resolved against the transcript. '
  'Claude Code reports aggregate input usage, so separate Claude token counts for graph replay, MCP replay, and other later-request '
  'context are unavailable.')
p()
table('Model','E0 initial tokens','E1 initial tokens','E2 initial tokens','E2 initial Δ vs E0','E2 later tokens',
      'Graph bytes in requests','Repeated graph bytes','MCP bytes in requests','Repeated MCP bytes')
v4_initial=score.load_jsonl('v4_initial_input.jsonl')
for m in models:
    rows=group(m,'E2')
    first=total(rows,'first_request_input_tokens')
    e0,e1=[total([r for r in v4_initial if r['model']==m and r['variant']==v],'first_request_input_tokens')
           for v in ('E0','E1')]
    assert not total(rows,'missing_request_blobs')
    line(m,e0,e1,first,f'{first-e0:+d}',total(rows,'input_tokens')-first,
         *[total(rows,f) for f in ('graph_sent_bytes','graph_resent_bytes','mcp_sent_bytes','mcp_resent_bytes')])

for m in models:
    p()
    p(f'## {m} per-task results')
    p()
    table('Task','Type','E0 input','E1 input','E2 input','E0 F1','E1 F1','E2 F1','Exact',
          'τ / T3 recall','Output','Weighted','Turns','Requests','Calls','MCP calls','MCP bytes',
          'MCP max bytes','Graph calls','Graph bytes','Max context','Seconds','CLI USD','Oracle F1')
    for i in sorted(tasks):
        a,b,r=[all_metrics[i,m,v] for v in variants]
        aux=r.get('kendall_tau') if r['type']=='T2' else r.get('recall') if r['type']=='T3' else None
        line(i,r['type'],a['input_tokens'],b['input_tokens'],r['input_tokens'],
             *[f'{q["f1"]:.3f}' for q in (a,b,r)],r['exact'],display(aux,'.3f'),r['output_tokens'],
             f'{r["weighted_tokens"]:.1f}',*[r[f] for f in ('api_turns','api_calls','tool_calls','mcp_calls','mcp_bytes',
                 'mcp_max_bytes','graph_calls','graph_bytes','max_context_input_tokens')],
             f'{r["wall_seconds"]:.2f}',f'{r["cli_list_cost_usd"]:.5f}',f'{oracle[i]["f1"]:.3f}')

p()
p('## Paired differences')
p()
p('Differences are E2 minus the indicated v4 baseline. Two-sided exact sign tests exclude ties. '
  'The 95% percentile intervals use 20,000 resamples of task pairs with seed 20261119.')
p()
table('Model','Baseline','Scope','Measure','Positive / negative / tied','Median difference','95% interval','Sign-test p')
rng=random.Random(20261119)
for m in models:
    for baseline in ('E0','E1'):
        for label,types,fields in (
            ('All',None,('input_tokens','output_tokens','weighted_tokens','f1','exact','api_turns','api_calls','tool_calls','wall_seconds')),
            ('T1–T4',core,('f1','exact')),
            ('T1+T2',{'T1','T2'},('input_tokens',)),
            ('T1+T3',{'T1','T3'},('api_calls',)),
        ):
            for field in fields:
                ds=[r[field]-reference[r['id'],m,baseline][field] for r in group(m,'E2',types)]
                positive=sum(x>0 for x in ds)
                negative=sum(x<0 for x in ds)
                n=positive+negative
                prob=min(1,2*sum(comb(n,i) for i in range(min(positive,negative)+1))/2**n)
                boot=sorted(median(rng.choices(ds,k=len(ds))) for _ in range(20000))
                line(m,baseline,label,field,f'{positive} / {negative} / {len(ds)-n}',
                     f'{median(ds):,.3f}',f'[{boot[499]:,.3f}, {boot[19499]:,.3f}]',f'{prob:.4f}')

p()
p('## Misses')
p()
misses=[(m,i,r) for (i,m,v),r in sorted(metrics.items()) if r.get('failed') or not r.get('exact')]
if not misses:
    p('All 20 E2 answers were exact. T2 order matched the scorer’s reference on both models. '
      'All ten frozen oracle answers were exact, with zero model F1 shortfalls relative to the oracle.')
    p()
for m,i,r in misses:
    p(f'- {m} {i} — {json.dumps({k:r.get(k) for k in ("failed","parsed","false_positives","false_negatives","kendall_tau","mcp_false_positives")})}')
for m in models:
    for r in sorted(group(m,'E2'),key=lambda row:row['id']):
        if r['builtin_tool_errors']:
            p(f'- {m} {r["id"]} — {r["builtin_tool_errors"]} built-in tool errors. The final answer was exact.')
    slower=[r for r in group(m,'E2') if r['input_tokens']>=reference[r['id'],m,'E1']['input_tokens']]
    if slower:
        p(f'- {m} tasks where E2 input did not improve over E1 (E2 vs E1) — '+', '.join(
            f'{r["id"]} ({r["input_tokens"]:,} vs {reference[r["id"],m,"E1"]["input_tokens"]:,})'
            for r in sorted(slower,key=lambda row:row['id']))+'.')
    for i,passed in enumerate(verdicts.get(m,[]),1):
        if not passed:
            p(f'- {m} S{i} — {measurements[m][i-1]}.')
p()
Path('RESULTS.md').write_text('\n'.join(out))
