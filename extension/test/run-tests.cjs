const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = { ...process.env };
let temporaryFixtures;
try {
  if (env.CI && !env.NEORION_FIXTURES) {
    temporaryFixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-ci-'));
    env.NEORION_FIXTURES = temporaryFixtures;
    const fetch = spawnSync(process.execPath, [path.join(__dirname, 'fetch-fixtures.cjs'), temporaryFixtures],
      { stdio: 'inherit', env });
    if (fetch.error) throw fetch.error;
    if (fetch.status !== 0) throw new Error('Failed to provision integration fixtures');
  }
  const tests = spawnSync(process.execPath, ['--test', path.join(__dirname, 'graph.test.cjs')], { stdio: 'inherit', env });
  if (tests.error) throw tests.error;
  process.exitCode = tests.status ?? 1;
} finally {
  if (temporaryFixtures) fs.rmSync(temporaryFixtures, { recursive: true, force: true });
}
