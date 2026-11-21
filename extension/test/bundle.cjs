const { build, context } = require('esbuild');
const fs = require('node:fs');

const options = {
  bundle: true, platform: 'node', alias: { 'jsonc-parser': './node_modules/jsonc-parser/lib/esm/main.js' }, minify: true, legalComments: 'external', metafile: true
};
const extensionBuilds = [
  { ...options, entryPoints: ['src/extension.ts'], target: 'node16', external: ['vscode'], outfile: 'out/extension.js' },
  { ...options, entryPoints: ['src/mcp/main.ts'], target: 'node18', outfile: 'out/mcp.cjs' }
];
const cliBuilds = [
  { ...options, entryPoints: ['src/cli/main.ts'], target: 'node18', outfile: '../neorion/dist/neorion.cjs', external: ['./graph.cjs'] },
  { ...options, entryPoints: ['src/cli/graph.ts'], target: 'node18', outfile: '../neorion/dist/graph.cjs' }
];
async function main() {
  if (process.argv.includes('--watch')) {
    for (const entry of extensionBuilds) await (await context(entry)).watch();
    return;
  }
  const cliOnly = process.argv.includes('--cli');
  const builds = cliOnly ? cliBuilds : [...extensionBuilds, ...cliBuilds];
  const results = await Promise.all(builds.map(entry => build(entry)));
  const outputs = Object.assign({}, ...results.map(result => result.metafile.outputs));
  fs.chmodSync('../neorion/dist/neorion.cjs', 0o755);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.txt']) fs.copyFileSync(file, '../neorion/' + file);
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(cliOnly ? 'out/cli-bundle-meta.json' : 'out/bundle-meta.json', JSON.stringify({ outputs }));
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
