const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const assert = require('node:assert/strict');

async function openMcp(t, root, entry = path.resolve(__dirname, '../out/mcp.cjs')) {
  const start = performance.now();
  const { command, args, cwd, env } = typeof entry === 'string'
    ? { command: process.execPath, args: [entry, '--root', root] } : entry;
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const stdout = [];
  let wire = '';
  let protocolError;
  child.stdout.setEncoding('utf8').on('data', chunk => { wire += chunk; });
  let nextId = 0;
  let stderr = '';
  const exited = once(child, 'exit');
  async function close() {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 2000);
    try {
      const [code] = await exited;
      assert.equal(code, 0, stderr);
      assert.equal(protocolError, undefined);
      assert.equal(wire, stdout.map(line => line + '\n').join(''));
    } finally {
      clearTimeout(timeout);
    }
  }
  t.after(close);
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    stdout.push(line);
    try {
      const response = JSON.parse(line);
      assert.equal(response.jsonrpc, '2.0');
      const request = pending.get(response.id);
      assert.ok(request, `Unsolicited stdout: ${line}`);
      pending.delete(response.id);
      if (response.error) request.reject(new Error(JSON.stringify(response.error)));
      else request.resolve(response.result);
    } catch (error) {
      protocolError = error;
      for (const request of pending.values()) request.reject(error);
    }
  });
  child.on('exit', code => {
    for (const request of pending.values()) request.reject(new Error(`MCP exited with ${code}: ${stderr}`));
  });
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const init = await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'neorion-test', version: '1' }
  });
  const startup = performance.now() - start;
  send({ method: 'notifications/initialized' });
  assert.equal(init.serverInfo.name, 'neorion-mcp');
  return {
    request, stdout, startup, close, stderr: () => stderr,
    call: (name, args) => request('tools/call', { name: 'neorion_' + name, arguments: args }),
    async text(name, args) {
      const result = await this.call(name, args);
      assert.equal(result.isError, undefined, result.content[0]?.text);
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, 'text');
      return result.content[0].text;
    }
  };
}

module.exports = { openMcp };
