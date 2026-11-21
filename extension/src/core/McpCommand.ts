import { name, version } from '../../../neorion/package.json';

export const packageSpec = `${name}@${version}`;

export function isTemporaryCliInstall(entry: string): boolean {
  const location = entry.replace(/\\/g, '/');
  return /(?:^|\/)_npx\/[^/]+\/node_modules\//.test(location)
    || /(?:^|\/)dlx\/[a-f0-9]{16,}\/(?:(?:pkg|[a-f0-9]+-[a-f0-9]+)\/)?node_modules\//.test(location)
    || /(?:^|\/)(?:bunx-[^/]+(?:\/[^/]+)?|\.bunx-[^/]+\/(?:@[^/]+\/)?[^/]+)\/node_modules\//.test(location);
}

export function mcpCommand({ localEntry, detectCache = false, root, platform = process.platform }:
  { localEntry?: string; detectCache?: boolean; root?: string; platform?: NodeJS.Platform } = {}) {
  const rootArgs = root === undefined ? [] : ['--root', root];
  if (localEntry && (!detectCache || !isTemporaryCliInstall(localEntry))) {
    return { command: process.execPath, args: [localEntry, 'mcp', ...rootArgs] };
  }

  if (platform === 'win32') {
    // The Windows npm shim needs a shell. Pass the project path as data, outside the shell command.
    const launch = `const result = require('node:child_process').spawnSync('npx -y ${packageSpec} mcp', {
      shell: true, stdio: 'inherit', env: process.argv.length > 1
        ? { ...process.env, NEORION_ROOT: process.argv[1] } : process.env
    });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;`;
    return { command: 'node', args: ['-e', launch, '--', ...(root === undefined ? [] : [root])] };
  }
  return { command: 'npx', args: ['-y', packageSpec, 'mcp', ...rootArgs] };
}
