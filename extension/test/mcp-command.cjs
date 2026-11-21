const path = require('node:path');
const { buildSync } = require('esbuild');

const { outputFiles } = buildSync({
  entryPoints: [path.join(__dirname, '../src/core/McpCommand.ts')],
  bundle: true,
  platform: 'node',
  write: false
});
new Function('module', outputFiles[0].text)(module);
