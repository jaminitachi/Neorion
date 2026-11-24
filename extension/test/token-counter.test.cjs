const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { Tiktoken } = require('js-tiktoken/lite');
const ranks = require('js-tiktoken/ranks/o200k_base');

test('counts exactly as the o200k_base encoder over 2,038 strings', () => {
  const { outputFiles } = buildSync({
    entryPoints: [path.join(__dirname, '../src/core/serializers/TokenCounter.ts')],
    bundle: true, packages: 'external', platform: 'node', write: false
  });
  const counterModule = { exports: {} };
  new Function('module', 'require', outputFiles[0].text)(counterModule, require);
  const counter = new counterModule.exports.TokenCounter();
  const original = new Tiktoken(ranks);
  let seed = 0xfa599b13;
  function next() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  }
  const parts = [
    '🐈', '한글', '日本語', ' café', '中', 're\u0301sume\u0301', 'أهلاً', '\uD800',
    '👩‍💻', '\u0000', '\r\n', '\n', '\t', '    ', '\u2028', '\u2029', '\u00a0',
    '<|endoftext|>', '<|endofprompt|>', '1234567', 'HTTP/2', 'import type', 'export * from',
    'world', " we're", '=>', '@', '~~~', ']<', 'src/components/[id]/page.tsx', '\\u00FA',
    'a'.repeat(129), 'a'.repeat(3), '# Usage', '//', '/* comment */', '  \r\n  '
  ];
  const samples = ['', ...parts];
  for (let i = 0; i < 2000; i++) {
    let sample = '';
    const length = next() % 37;
    for (let j = 0; j < length; j++) sample += parts[next() % parts.length];
    samples.push(sample);
  }
  assert.equal(samples.length, 2038);
  for (const [i, sample] of samples.entries()) {
    assert.equal(counter.count(sample), original.encode(sample, [], []).length, `sample ${i}`);
  }
});
