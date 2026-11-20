import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ignored = new Set(['node_modules', '.git', '.next', '.neorion']);
const inputs = /\.(?:[cm]?[jt]sx?|json|png|jpe?g|gif|txt|xml)$/i;

// Include candidate inputs even when TypeScript excludes them. This detects
// additions before the next graph build has resolved the tsconfig and imports.
export function projectSnapshot(root: string) {
    const hash = createHash('sha256');
    function visit(relative: string) {
        let entries;
        try {
            entries = readdirSync(join(root, relative), { withFileTypes: true });
        } catch (error) {
            if (!['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (ignored.has(entry.name)) continue;
            const file = relative + entry.name;
            if (entry.isDirectory()) {
                visit(file + '/');
            } else if (inputs.test(file)) {
                const info = statSync(join(root, file), { throwIfNoEntry: false });
                if (info?.isFile()) hash.update(JSON.stringify([file, info.size, info.mtimeMs, info.ctimeMs]));
            }
        }
    }
    visit('');
    return hash.digest('hex');
}
