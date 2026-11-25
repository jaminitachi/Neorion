const assert = require('node:assert/strict');
const { test } = require('node:test');
const { name, version } = require('../../neorion/package.json');
const { mcpCommand } = require('./mcp-command.cjs');

test('MCP cache detection handles npm, pnpm, and Bun CLI installs', () => {
  const pinned = ['-y', `${name}@${version}`, 'mcp'];
  for (const entry of [
    '/home/user/.npm/_npx/abc/node_modules/neorion/dist/neorion.cjs',
    'C:\\npm-cache\\_npx\\abc\\node_modules\\@org\\neorion\\dist\\neorion.cjs',
    '/pnpm/cache/dlx/eb1103ca40b35d46/19ca2848fd2-3fad/node_modules/.pnpm/neorion@0.5.0/node_modules/neorion/dist/neorion.cjs',
    '/pnpm/cache/dlx/eb1103ca40b35d46/pkg/node_modules/@org/neorion/dist/neorion.cjs',
    '/tmp/bunx-1000-neorion@0.5.0/node_modules/neorion/dist/neorion.cjs',
    '/bun/install/cache/.bunx-1000/@org/neorion@0.5.0/node_modules/@org/neorion/dist/neorion.cjs'
  ]) {
    assert.deepEqual(mcpCommand({ localEntry: entry, detectCache: true, platform: 'linux' }),
      { command: 'npx', args: pinned }, entry);
  }

  for (const entry of [
    '/checkout/neorion/dist/neorion.cjs',
    'C:\\node\\node_modules\\neorion\\dist\\neorion.cjs',
    '/checkout/_npx-tools/example/node_modules/neorion/dist/neorion.cjs',
    '/checkout/dlx/project/node_modules/neorion/dist/neorion.cjs'
  ]) {
    assert.deepEqual(mcpCommand({ localEntry: entry, detectCache: true }),
      { command: process.execPath, args: [entry, 'mcp'] }, entry);
  }
});

test('MCP commands preserve the explicit local entry and pin registry installs', () => {
  const localEntry = '/checkout/neorion.cjs';
  const root = '/project with spaces';
  assert.deepEqual(mcpCommand({ localEntry, root }), {
    command: process.execPath, args: [localEntry, 'mcp', '--root', root]
  });
  assert.deepEqual(mcpCommand({ root, platform: 'linux' }), {
    command: 'npx', args: ['-y', `${name}@${version}`, 'mcp', '--root', root]
  });
  assert.deepEqual(mcpCommand({ root, platform: 'linux', discover: true }), {
    command: 'npx', args: ['-y', `${name}@${version}`, 'mcp', '--workspace', root]
  });
});

test('Windows MCP launcher keeps the project path outside the shell command', () => {
  const root = 'C:\\Workspace & Tools\\%PROJECT%';
  for (const [discover, variable] of [[false, 'NEORION_ROOT'], [true, 'NEORION_WORKSPACE']]) {
    const { command, args } = mcpCommand({ root, platform: 'win32', discover });
    assert.equal(command, 'node');
    assert.deepEqual([args[0], ...args.slice(2)], ['-e', '--', root]);
    const requireStub = () => ({
      spawnSync(commandLine, options) {
        assert.equal(commandLine, `npx -y ${name}@${version} mcp`);
        assert.equal(options.shell, true);
        assert.equal(options.stdio, 'inherit');
        assert.equal(options.env[variable], root);
        assert.equal(options.env.NEORION_ROOT, discover ? undefined : root);
        return { status: 7 };
      }
    });
    const processStub = { argv: ['node', root], env: { NEORION_ROOT: 'inherited' } };
    new Function('require', 'process', args[1])(requireStub, processStub);
    assert.equal(processStub.exitCode, 7);
  }
});
