import { homepage, name, version } from '../../../neorion/package.json';
import { workspaceCache } from './WorkspaceCache';

export const packageSpec = `${name}@${version}`;
export const releaseSpec = (release = version) =>
  `${homepage.split('#')[0]}/releases/download/v${release}/${name}-${release}.tgz`;

export function isTemporaryCliInstall(entry: string): boolean {
  const location = entry.replace(/\\/g, '/');
  return /(?:^|\/)_npx\/[^/]+\/node_modules\//.test(location)
    || /(?:^|\/)dlx\/[a-f0-9]{16,}\/(?:(?:pkg|[a-f0-9]+-[a-f0-9]+)\/)?node_modules\//.test(location)
    || /(?:^|\/)(?:bunx-[^/]+(?:\/[^/]+)?|\.bunx-[^/]+\/(?:@[^/]+\/)?[^/]+)\/node_modules\//.test(location);
}

export function mcpCommand({ localEntry, detectCache = false, root, discover = false, platform = process.platform,
  registryVersion = version, useRelease = false, workspaceCli, requireWorkspaceCli = false }: { localEntry?: string; detectCache?: boolean; root?: string;
    discover?: boolean; platform?: NodeJS.Platform; registryVersion?: string; useRelease?: boolean; workspaceCli?: string; requireWorkspaceCli?: boolean } = {}) {
  if (localEntry && (!detectCache || !isTemporaryCliInstall(localEntry))) {
    return { command: process.execPath, args: [localEntry, 'mcp', ...(root === undefined ? [] : [discover ? '--workspace' : '--root', root])] };
  }

  const spec = useRelease ? releaseSpec(registryVersion) : `${name}@${registryVersion}`;
  const cwdDiscovery = root !== undefined && discover;
  if (platform === 'win32' || useRelease || cwdDiscovery) {
    // The Windows npm shim needs a shell. Use the same launcher for shared release-based settings
    // on every platform and pass the project path outside the shell command.
    const bundled = workspaceCli && cwdDiscovery ? `
      const root = process.argv[1];
      const cli = require('node:path').join((${workspaceCache.toString()})(root), ${JSON.stringify(workspaceCli)});
      if (require('node:fs').existsSync(cli)) {
        process.argv.splice(1, 1, cli, 'mcp', '--workspace', root);
        process.execArgv = [];
        require(cli);
        return;
      }` : '';
    const rootEnv = cwdDiscovery ? 'NEORION_ROOT: undefined, NEORION_WORKSPACE: undefined' : 'NEORION_ROOT: process.argv[1]';
    const fallback = `const result = require('node:child_process').spawnSync('npx -y ${spec} mcp', {
      shell: true, stdio: 'inherit', ${cwdDiscovery ? 'cwd: process.argv[1], ' : ''}env: process.argv.length > 1
        ? { ...process.env, ${rootEnv} } : process.env
    });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;`;
    const missingBundle = `console.error('Neorion MCP bundle missing. Run neorion setup cursor at the workspace root.');
    process.exitCode = 1;`;
    const launch = bundled ? `(() => { ${bundled}\n${requireWorkspaceCli ? missingBundle : fallback} })();` : fallback;
    return { command: 'node', args: ['-e', launch.replace(/\n\s*/g, ' '), '--', ...(root === undefined ? [] : [root])] };
  }
  return { command: 'npx', args: ['-y', spec, 'mcp', ...(root === undefined ? [] : ['--root', root])] };
}
