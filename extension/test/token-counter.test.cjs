const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { Tiktoken } = require('js-tiktoken/lite');
const ranks = require('js-tiktoken/ranks/o200k_base');

function tokenizers() {
  const { outputFiles } = buildSync({
    entryPoints: [path.join(__dirname, '../src/core/serializers/TokenCounter.ts')],
    bundle: true, packages: 'external', platform: 'node', write: false
  });
  const counterModule = { exports: {} };
  new Function('module', 'require', outputFiles[0].text)(counterModule, require);
  return { counter: new counterModule.exports.TokenCounter(), original: new Tiktoken(ranks) };
}

function randomFrom(seed) {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
}

const parts = [
  '🐈', '한글', '日本語', ' café', '中', 're\u0301sume\u0301', 'أهلاً', '\uD800',
  '👩‍💻', '\u0000', '\r\n', '\n', '\t', '    ', '\u2028', '\u2029', '\u00a0',
  '<|endoftext|>', '<|endofprompt|>', '1234567', 'HTTP/2', 'import type', 'export * from',
  'world', " we're", '=>', '@', '~~~', ']<', 'src/components/[id]/page.tsx', '\\u00FA',
  'a'.repeat(129), 'a'.repeat(3), '# Usage', '//', '/* comment */', '  \r\n  '
];

test('counts exactly as the o200k_base encoder over 2,038 strings', () => {
  const { counter, original } = tokenizers();
  const next = randomFrom(0xfa599b13);
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

if (process.env.NEORION_TOKEN_FUZZ_SEED !== undefined) {
  test('matches the encoder for random Unicode and after filling the piece cache', () => {
    const seed = Number(process.env.NEORION_TOKEN_FUZZ_SEED);
    assert.ok(Number.isInteger(seed) && seed > 0 && seed <= 0xffff_ffff, 'use a nonzero 32-bit unsigned seed');
    const next = randomFrom(seed);
    const { counter, original } = tokenizers();
    const compare = (sample, label) => {
      assert.equal(counter.count(sample), original.encode(sample, [], []).length, `seed ${seed}, ${label}`);
    };
    for (let i = 0; i < 3000; i++) {
      let units = '';
      let points = '';
      let mixed = '';
      const length = next() % 32;
      for (let j = 0; j < length; j++) {
        units += String.fromCharCode(next() % 0x10000);
        points += String.fromCodePoint(next() % 0x110000);
        mixed += parts[next() % parts.length];
      }
      compare(units, `UTF-16 sample ${i}`);
      compare(points, `Unicode sample ${i}`);
      compare(mixed, `mixed sample ${i}`);
    }
    for (let i = 0; i < 70_000; i++) {
      const letters = i.toString(16).padStart(5, '0').replace(/\d/g, digit => 'klmnopqrst'[Number(digit)]);
      compare(' fuzz' + letters, `cache sample ${i}`);
    }
    compare(parts.join(' '), 'after cache saturation');
  });
}
