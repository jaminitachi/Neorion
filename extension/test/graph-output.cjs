const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getEncoding } = require('js-tiktoken');

// Measure emitted bytes outside the extension bundle, using the public tokenizer API.
const tokenizer = getEncoding('o200k_base');
const count = value => tokenizer.encode(value, [], []).length;
const overviewBudget = listing => Math.min(6000, Math.max(1500, Math.floor(count(listing) / 4)));

function assertOverviewLinks(project, overview) {
  const targets = [...overview.matchAll(/\]\((?:<([^>]+)>|([^\n)]+))\)/g)]
    .map(([, angled, plain]) => angled ?? plain);
  assert.ok(targets.some(target => target.endsWith('.md')), 'overview must link to detail files');
  for (const target of targets) {
    const stat = fs.statSync(path.join(project, target), { throwIfNoEntry: false });
    assert.ok(target.endsWith('/') ? stat?.isDirectory() : stat?.isFile(), target);
  }
  if (overview.startsWith('Overview abbreviates ') && overview.split('\n')[0].includes('Areas')) return;
  const files = fs.readdirSync(path.join(project, 'neorion/graph')).filter(file => file.endsWith('.md'));
  assert.deepEqual(targets.filter(target => target.endsWith('.md')).map(file => path.basename(file)).sort(), files.sort());
}
module.exports = { count, overviewBudget, assertOverviewLinks };
