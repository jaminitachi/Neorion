import { homepage, name, version } from '../../../neorion/package.json';

export const packageSpec = `${name}@${version}`;
export const releaseSpec = (release = version) =>
  `${homepage.split('#')[0]}/releases/download/v${release}/${name}-${release}.tgz`;

export function isTemporaryCliInstall(entry: string): boolean {
  const location = entry.replace(/\\/g, '/');
  return /(?:^|\/)_npx\/[^/]+\/node_modules\//.test(location)
    || /(?:^|\/)dlx\/[a-f0-9]{16,}\/(?:(?:pkg|[a-f0-9]+-[a-f0-9]+)\/)?node_modules\//.test(location)
    || /(?:^|\/)(?:bunx-[^/]+(?:\/[^/]+)?|\.bunx-[^/]+\/(?:@[^/]+\/)?[^/]+)\/node_modules\//.test(location);
}

export function mcpCommand({ localEntry, detectCache = false, root, platform = process.platform, registryVersion = version,
  useRelease = false }: { localEntry?: string; detectCache?: boolean; root?: string; platform?: NodeJS.Platform;
    registryVersion?: string; useRelease?: boolean } = {}) {
  const rootArgs = root === undefined ? [] : ['--root', root];
  if (localEntry && (!detectCache || !isTemporaryCliInstall(localEntry))) {
    return { command: process.execPath, args: [localEntry, 'mcp', ...rootArgs] };
  }

  const spec = useRelease ? releaseSpec(registryVersion) : `${name}@${registryVersion}`;
  if (platform === 'win32' || useRelease) {
    // The Windows npm shim needs a shell. Use the same launcher for shared release-based settings
    // on every platform and pass the project path outside the shell command.
    const launch = `const result = require('node:child_process').spawnSync('npx -y ${spec} mcp', {
      shell: true, stdio: 'inherit', env: process.argv.length > 1
        ? { ...process.env, NEORION_ROOT: process.argv[1] } : process.env
    });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;`;
    return { command: 'node', args: ['-e', launch.replace(/\n\s*/g, ' '), '--', ...(root === undefined ? [] : [root])] };
  }
  return { command: 'npx', args: ['-y', spec, 'mcp', ...rootArgs] };
}
