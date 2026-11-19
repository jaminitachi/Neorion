const { build, context } = require('esbuild');
const fs = require('node:fs');

const options = {
  bundle: true, platform: 'node', alias: { 'jsonc-parser': './node_modules/jsonc-parser/lib/esm/main.js' }, minify: true, legalComments: 'external', metafile: true
};
const builds = [
  { ...options, entryPoints: ['src/extension.ts'], target: 'node16', external: ['vscode'], outfile: 'out/extension.js' },
  { ...options, entryPoints: ['src/mcp/server.ts'], target: 'node18', outfile: 'out/mcp.cjs' }
];
async function main() {
  if (process.argv.includes('--watch')) {
    for (const entry of builds) await (await context(entry)).watch();
    return;
  }
  const results = await Promise.all(builds.map(entry => build(entry)));
  const outputs = Object.assign({}, ...results.map(result => result.metafile.outputs));
  fs.writeFileSync('out/bundle-meta.json', JSON.stringify({ outputs }));
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
