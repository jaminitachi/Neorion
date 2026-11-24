const { createHash } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const indexFile = '.neorion/index.v2.json';

function cachePath(root, ...parts) {
  const home = homedir();
  const fallback = process.platform === 'darwin' ? path.join(home, 'Library', 'Caches') :
    process.platform === 'win32' ? path.join(home, 'AppData', 'Local') : path.join(home, '.cache');
  const env = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_CACHE_HOME;
  const key = createHash('sha256').update(realpathSync(root)).digest('hex');
  return path.join(env && path.isAbsolute(env) ? env : fallback, 'neorion', key, ...parts);
}

module.exports = { cachePath, indexFile };
