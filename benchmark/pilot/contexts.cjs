const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Tiktoken } = require('../../extension/node_modules/js-tiktoken');
const o200kBase = require('../../extension/node_modules/js-tiktoken/dist/ranks/o200k_base.cjs');

const tokenizer = new Tiktoken(o200kBase);
const count = value => tokenizer.encode(value, [], []).length;
const sizes = {};

for (const repo of ['ai-chatbot', 'papermark']) {
  const root = path.resolve(__dirname, '../../../bench-repos', repo);
  const graph = fs.readFileSync(path.join(root, 'codebase_graph.md'), 'utf8');
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const graphTokens = count(graph);
  let listing = paths.join('\n') + '\n';
  while (count(listing) > graphTokens) {
    paths.pop();
    listing = paths.join('\n') + '\n';
  }
  fs.writeFileSync(path.join(root, 'file-list.txt'), listing);
  sizes[repo] = { B: graphTokens, D: count(listing) };
}

fs.writeFileSync(path.join(__dirname, 'contexts.json'), JSON.stringify(sizes, null, 2) + '\n');
