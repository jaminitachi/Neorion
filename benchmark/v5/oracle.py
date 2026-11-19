import json
from pathlib import Path
import re
import subprocess

from score import score_task

APP = Path('/tmp/neorion-bench-v5/app')
QUERIES = [
    ('who_renders', 'component', 'modules/ui/components/sheet/index.tsx#SheetDescription'),
    ('who_renders', 'component', 'modules/ui/components/progress-bar/index.tsx#ProgressBar'),
    ('who_renders', 'component', 'modules/ui/components/chart/index.tsx#ChartTooltip'),
    ('wrappers', 'route', '/workspaces/[workspaceId]/contacts/[contactId]'),
    ('rename_impact', 'symbol', 'lib/googleSheet/service.ts#writeData'),
    ('rename_impact', 'symbol', 'lib/survey/visibility/outbound.ts#SURVEY_NOT_WORKSPACE_VISIBLE_MESSAGE'),
    ('rename_impact', 'symbol', 'lib/organization/auth.ts#canUserAccessOrganization'),
    ('api_consumers', 'route', '/api/unify-feedback/sources/csv/import'),
    ('api_consumers', 'route', '/api/v3/surveys/[surveyId]/visibility'),
    ('rename_impact', 'symbol', 'modules/ee/data-retention/sweep/due-targets.ts#surveySkips'),
]

def collect(tool, text, control):
    if tool == 'who_renders':
        return [line.split()[0] for line in text.splitlines() if line.startswith('/')]
    patterns = {'wrappers':r'\d+', 'rename_impact': r'use' if control else r'decl|use',
                'api_consumers':r'send|call1'}
    files = re.findall(rf'^(?:{patterns[tool]})\s+(\S+?):\d+',text,re.M)
    return list(dict.fromkeys(files))

def main():
    config = json.loads((APP/'.mcp.json').read_text())['mcpServers']['neorion']
    tasks = [json.loads(line) for line in Path('tasks.jsonl').read_text().splitlines()]
    with subprocess.Popen([config['command'],*config['args']],cwd=APP,stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE,text=True) as server:
        def send(method, params=None, ident=None):
            request = dict(jsonrpc='2.0',method=method)
            if params is not None:
                request['params'] = params
            if ident is not None:
                request['id'] = ident
            server.stdin.write(json.dumps(request)+'\n')
            server.stdin.flush()
            if ident is not None:
                response = json.loads(server.stdout.readline())
                assert response['id'] == ident
                return response['result']
        send('initialize',dict(protocolVersion='2024-11-05',capabilities={},clientInfo={'name':'v5-oracle','version':'1'}),0)
        send('notifications/initialized')
        rows=[]
        for i,(task,(tool,key,value)) in enumerate(zip(tasks,QUERIES,strict=True),1):
            args = {key:value}
            reply = send('tools/call',dict(name='neorion_'+tool,arguments=args),i)
            assert not reply.get('isError'), reply
            text = reply['content'][0]['text']
            assert '[stale]' not in text and not re.search(r'\bstale \d+ files',text),text
            answer = collect(tool,text,i==10)
            rows.append(dict(tool=tool,args=args,text=text,bytes=len(text.encode()),answer=answer,**score_task(task,answer)))
        Path('oracle.jsonl').write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in rows))
        server.stdin.close()

if __name__ == '__main__':
    main()
