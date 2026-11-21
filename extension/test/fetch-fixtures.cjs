const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const fixtureRoot = path.resolve(process.argv[2] ?? path.join(__dirname, '.fixtures'));
fs.mkdirSync(fixtureRoot, { recursive: true });

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function fetchRepository(name, url, revision) {
  const directory = path.join(fixtureRoot, name);
  if (fs.existsSync(directory)) {
    const current = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
    if (current !== revision) throw new Error(`Expected ${name} at ${revision}, found ${current}`);
    return;
  }
  fs.mkdirSync(directory);
  run('git', ['init', '--quiet'], directory);
  run('git', ['fetch', '--quiet', '--depth', '1', url, revision], directory);
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], directory);
}

fetchRepository('taxonomy', 'https://github.com/shadcn-ui/taxonomy.git', '298a8857c7128a0d121e7f699dfd729f23b3966d');
fetchRepository('commerce', 'https://github.com/vercel/commerce.git', 'f7521d57d29f0eb3d23c1399cf9bb299d61fcd21');

// The immutable npm release was built from Next.js commit 2eda33ce846f996ff627c7e8b64704259ecd4355.
if (!fs.existsSync(path.join(fixtureRoot, 'create-next-app', 'package.json'))) {
  run('npx', ['--yes', 'create-next-app@16.0.3', 'create-next-app', '--typescript', '--eslint',
    '--tailwind', '--app', '--src-dir', '--use-npm', '--import-alias', '@/*', '--skip-install',
    '--disable-git', '--yes'], fixtureRoot);
}
