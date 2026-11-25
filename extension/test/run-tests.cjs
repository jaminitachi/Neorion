const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = { ...process.env };
let temporaryFixtures;
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-test-cache-'));
env[process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_CACHE_HOME'] = cache;
try {
  if (env.CI && !env.NEORION_FIXTURES) {
    temporaryFixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-ci-'));
    env.NEORION_FIXTURES = temporaryFixtures;
    const fetch = spawnSync(process.execPath, [path.join(__dirname, 'fetch-fixtures.cjs'), temporaryFixtures],
      { stdio: 'inherit', env });
    if (fetch.error) throw fetch.error;
    if (fetch.status !== 0) throw new Error('Failed to provision integration fixtures');
  }
  // Graph-heavy files compete for CPU and memory when Node runs them in parallel.
  const files = ['graph.test.cjs', 'mcp.test.cjs', 'mcp-protocol.test.cjs', 'mcp-command.test.cjs', 'connect.test.cjs',
    'cli.test.cjs', 'graph-kinds.test.cjs', 'token-counter.test.cjs'];
  const tests = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map(file => path.join(__dirname, file))],
    { stdio: 'inherit', env });
  if (tests.error) throw tests.error;
  process.exitCode = tests.status ?? 1;
} finally {
  fs.rmSync(cache, { recursive: true, force: true });
  if (temporaryFixtures) fs.rmSync(temporaryFixtures, { recursive: true, force: true });
}
