const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ts } = require('@ts-morph/common');

const root = path.resolve(__dirname, '..');
const metadataFile = process.argv.includes('--cli') ? 'out/cli-bundle-meta.json' : 'out/bundle-meta.json';
const metadata = JSON.parse(fs.readFileSync(path.join(root, metadataFile), 'utf8'));
const bundled = new Set();
for (const output of Object.values(metadata.outputs)) {
  for (const [input, { bytesInOutput }] of Object.entries(output.inputs ?? {})) {
    if (!bytesInOutput) continue;
    const packagePath = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1];
    if (!packagePath) continue;
    const { name, version } = JSON.parse(fs.readFileSync(path.join(root, packagePath, 'package.json'), 'utf8'));
    bundled.add(`${name} ${version}`);
    if (input === `${packagePath}/dist/typescript.js` && name === '@ts-morph/common') {
      bundled.add(`typescript ${ts.version}`);
    }
  }
}

// The vendored standalone UMD file matches the npm release byte for byte.
// Its source map lists the packages below, pinned by the upstream v9.1.9 package-lock.json.
const vendor = fs.readFileSync(path.join(root, 'media/vis-network.min.js'));
assert.equal(createHash('sha256').update(vendor).digest('hex'),
  'f53f833ddb9bf97efe856bb0637d4fe88f39e39999c7e94a4b8afc8de8a1a2e5',
  'Update the bundled webview inventory from the new vendor source map');
for (const notice of [
  'vis-network 9.1.9',
  '@babel/runtime-corejs3 7.23.2',
  '@egjs/hammerjs 2.0.17',
  'component-emitter 1.3.0',
  'core-js-pure 3.33.0',
  'keycharm 0.4.0',
  'style-inject 0.3.0',
  'uuid 9.0.1',
  'vis-data 7.1.7',
  'vis-util 5.0.5'
]) bundled.add(notice);

const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
const headings = [...notices.matchAll(/^((?:@[^\s/]+\/)?[^\s]+ \d+\.\d+\.\d+[^\s]*)\n\n/gm)];
const documented = new Set(headings.flatMap(([heading, name], index) => {
  const start = headings[index].index + heading.length;
  const end = headings[index + 1]?.index;
  return notices.slice(start, end).trim() ? [name] : [];
}));
const missing = [...bundled].filter(notice => !documented.has(notice));
assert.deepEqual(missing.sort(), [], 'Every bundled package must have a versioned license notice');
console.log(`Checked notices for ${bundled.size} bundled package versions`);
