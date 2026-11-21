const path = require('node:path');
const { register } = require('../Neorion/extension/test/run.cjs');
const root = path.resolve(process.argv[2]);
const { commands } = register(root, undefined, [path.join(root, 'tsconfig.json')], {
  window: {
    async showQuickPick(items) {
      if (typeof items[0] === 'string') return 'Use bundled server';
      return items.filter(item => ['CLAUDE.md', 'Register Neorion query tools (MCP)', 'Claude Code'].includes(item.label));
    },
  },
});
(async () => {
  await commands.get('neo.generateGraph')();
  await commands.get('neo.connectAITools')();
})().catch(error => { console.error(error); process.exitCode = 1; });
