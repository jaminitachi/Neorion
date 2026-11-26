import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type RouterFramework = 'react-router' | 'remix';
export const configExtensions = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'];

export type FrameworkManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function vitePlugin(source: string, rr: boolean, remix: boolean): RouterFramework | undefined {
  // Keep project discovery lightweight. The framework adapter checks Vite
  // bindings with the compiler when it opens the selected project.
  const code = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\r\n]*/gm, '');
  const imports = code.matchAll(/^\s*import\s+(\{[^}]+\}|\*\s+as\s+[\w$]+)\s+from\s*['"]([^'"]+)['"]/gm);
  for (const [, bindings, module] of imports) {
    const framework = rr && module === '@react-router/dev/vite' ? 'react-router' :
      remix && ['@remix-run/dev', '@remix-run/dev/vite'].includes(module) ? 'remix' : undefined;
    if (!framework) continue;
    const plugin = framework === 'react-router' ? 'reactRouter' : 'vitePlugin';
    const namespace = /^\*\s+as\s+([\w$]+)$/.exec(bindings)?.[1];
    const aliases = namespace ? [namespace + '\\.' + plugin] : bindings.slice(1, -1).split(',').flatMap(specifier => {
      const [name, keyword, alias] = specifier.trim().split(/\s+/);
      return name === plugin ? [keyword === 'as' ? alias : name] : [];
    });
    if (aliases.some(alias => alias && new RegExp('(?:^|[^\\w$])' + alias.replace(/\$/g, '\\$') + '\\s*\\(').test(code))) return framework;
  }
}

export function routerFramework(root: string, pkg: FrameworkManifest, isFile: (file: string) => unknown): RouterFramework | undefined {
  const has = (name: string) => typeof (pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]) === 'string';
  const config = (name: string) => configExtensions.some(ext => isFile(join(root, name + '.config.' + ext)));
  const rr = has('@react-router/dev');
  const remix = has('@remix-run/dev');
  if (!rr && !remix) return;
  if (rr && config('react-router')) return 'react-router';
  for (const ext of configExtensions) {
    const file = join(root, 'vite.config.' + ext);
    if (!isFile(file)) continue;
    const framework = vitePlugin(readFileSync(file, 'utf8'), rr, remix);
    if (framework) return framework;
  }
  if (remix && config('remix')) return 'remix';
}
