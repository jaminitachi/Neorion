const { cachePath } = require('./workspace-cache.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getEncoding } = require('js-tiktoken');

// Measure emitted bytes outside the extension bundle, using the public tokenizer API.
const tokenizer = getEncoding('o200k_base');
const count = value => tokenizer.encode(value, [], []).length;
const overviewBudget = listing => Math.min(6000, Math.max(1500, Math.floor(count(listing) / 4)));

function assertOverviewLinks(project, overview) {
  const pending = [{ directory: cachePath(project), markdown: overview }];
  const reached = new Set();
  while (pending.length) {
    const { directory, markdown } = pending.pop();
    for (const [, angled, plain] of markdown.matchAll(/\]\((?:<([^>]+)>|([^\n)]+))\)/g)) {
      const target = angled ?? plain;
      const resolved = path.join(directory, target);
      const stat = fs.statSync(resolved, { throwIfNoEntry: false });
      assert.ok(target.endsWith('/') ? stat?.isDirectory() : stat?.isFile(), target);
      if (resolved.endsWith('.md') && !reached.has(resolved)) {
        reached.add(resolved);
        if (/^\+areas(?:\+\d+)?\.md$/.test(path.basename(resolved))) {
          pending.push({ directory: path.dirname(resolved), markdown: fs.readFileSync(resolved, 'utf8') });
        }
      }
    }
  }
  const root = cachePath(project, 'neorion/graph');
  const files = fs.readdirSync(root).filter(file => file.endsWith('.md'));
  assert.ok(reached.size);
  for (const file of files) {
    const firstPart = file.replace(/\+\d+\.md$/, '.md');
    assert.ok(reached.has(path.join(root, firstPart)), `Unreachable area: ${file}`);
  }
}
module.exports = { count, overviewBudget, assertOverviewLinks };
