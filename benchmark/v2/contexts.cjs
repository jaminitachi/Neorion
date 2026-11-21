const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generate } = require('../../extension/test/run.cjs');
const { count, overviewBudget, assertOverviewLinks } = require('../../extension/test/graph-output.cjs');

const repos = path.resolve(__dirname, '../../../bench-repos');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const heldOut = ['ai-chatbot', 'papermark'];

async function prepare(name, source, scratch, output) {
  const root = path.join(scratch, name);
  const hasIndex = fs.existsSync(path.join(source, '.git'));
  if (hasIndex) {
    git(scratch, 'clone', '--quiet', '--shared', '--no-checkout', source, root);
    git(root, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', git(source, 'rev-parse', 'HEAD').trim());
  } else {
    fs.cpSync(source, root, { recursive: true, filter: file =>
      !['node_modules', '.next', '.neorion', 'codebase_graph.md'].includes(path.basename(file)) });
  }
  const tracked = hasIndex ? git(root, 'ls-files', '-z').split('\0').filter(Boolean)
    : fs.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => !entry.isDirectory())
      .map(entry => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name))).sort();
  const listing = tracked.join('\n') + '\n';
  const overview = await generate(root);
  assertOverviewLinks(root, overview);
  const directory = path.join(root, '.neorion/graph');
  const detailSizes = fs.readdirSync(directory).filter(file => file.endsWith('.md'))
    .map(file => ({ file, tokens: count(fs.readFileSync(path.join(directory, file), 'utf8')) }))
    .sort((a, b) => b.tokens - a.tokens || a.file.localeCompare(b.file));
  const budget = overviewBudget(listing);
  assert.ok(count(overview) <= budget && detailSizes.every(detail => detail.tokens <= 3000), name);
  if (output && heldOut.includes(name)) {
    const context = path.join(output, name);
    fs.mkdirSync(context);
    fs.writeFileSync(path.join(context, 'file-list.txt'), listing);
    fs.writeFileSync(path.join(context, 'codebase_graph.md'), overview);
    fs.cpSync(directory, path.join(context, '.neorion/graph'), { recursive: true });
  }
  return {
    fileList: count(listing), overviewBudget: budget, overview: count(overview),
    largestDetail: detailSizes[0], detailsTotal: detailSizes.reduce((total, detail) => total + detail.tokens, 0)
  };
}

async function main() {
  const output = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const fixtures = process.argv[3] ? path.resolve(process.argv[3]) : null;
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    for (const repo of heldOut) {
      assert.ok(!fs.existsSync(path.join(output, repo)), `Use a fresh context destination for ${repo}`);
    }
  }
  const sources = heldOut.map(name => [name, path.join(repos, name)]);
  if (fixtures) {
    for (const name of ['taxonomy', 'commerce', 'create-next-app']) sources.push([name, path.join(fixtures, name)]);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-v2-'));
  const sizes = {};
  try {
    for (const [name, source] of sources) sizes[name] = await prepare(name, source, scratch, output);
    console.log(JSON.stringify(sizes, null, 2));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
