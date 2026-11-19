import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function workspaceCache(root: string) {
  const project = realpathSync(root);
  const home = homedir();
  const fallback = process.platform === 'darwin' ? join(home, 'Library', 'Caches') :
    process.platform === 'win32' ? join(home, 'AppData', 'Local') : join(home, '.cache');
  const configured = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_CACHE_HOME;
  const base = configured && isAbsolute(configured) ? configured : fallback;
  const key = createHash('sha256').update(project).digest('hex');
  const cache = resolve(base, 'neorion', key);
  const within = relative(project, cache);
  // Keep generated output hidden even when the project is the user's home directory.
  return isAbsolute(within) || within === '..' || within.startsWith('..' + sep)
    ? cache : join(tmpdir(), 'neorion-' + createHash('sha256').update(home).digest('hex').slice(0, 16), key);
}
