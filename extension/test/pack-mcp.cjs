const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const bundle = path.resolve('out/npm');
fs.mkdirSync(bundle, { recursive: true });
const extension = require('../package.json');
fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({
  name: 'neorion-mcp', version: extension.version, license: extension.license, repository: extension.repository,
  description: 'Read-only stdio MCP tools for the Neorion architecture index',
  files: ['THIRD_PARTY_NOTICES.txt', 'server.cjs', 'server.cjs.LEGAL.txt'],
  bin: { 'neorion-mcp': 'server.cjs' }, engines: { node: '>=18' }
}, null, 2) + '\n');
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'out/mcp.cjs',
  ...(fs.existsSync('out/mcp.cjs.LEGAL.txt') ? ['out/mcp.cjs.LEGAL.txt'] : [])]) {
  fs.copyFileSync(file, path.join(bundle, path.basename(file).replace(/^mcp\.cjs/, 'server.cjs')));
}
fs.chmodSync(path.join(bundle, 'server.cjs'), 0o755);
execFileSync(process.env.npm_execpath ? process.execPath : 'npm', [
  ...(process.env.npm_execpath ? [process.env.npm_execpath] : []), 'pack', bundle, '--pack-destination', 'out'
], { stdio: 'inherit' });
