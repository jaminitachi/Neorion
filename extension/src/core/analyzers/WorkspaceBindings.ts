import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Node, ts, type ResolutionHostFactory } from 'ts-morph';
import { projectConfig, workspaceDirectories } from '../FindProject';
import { workspaceSourcesHash } from '../ProjectSnapshot';
import { importBinding } from './StaticBindings';

function json(file: string) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

export function within(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

const sourceFile = /\.[cm]?[jt]sx?$/i;
const declarationFile = /\.d\.[cm]?ts$/i;
const packageName = (module: string) => module.split('/').slice(0, module.startsWith('@') ? 2 : 1).join('/');
type Package = { directory: string; name: string; manifest: ReturnType<typeof json> };

function exportTargets(entry: unknown, wildcard: string): string[] {
  if (typeof entry === 'string') return [entry.split('*').join(wildcard)];
  if (Array.isArray(entry)) return entry.flatMap(value => exportTargets(value, wildcard));
  if (!entry || typeof entry !== 'object') return [];
  const conditions = entry as Record<string, unknown>;
  return ['source', 'development', 'types', 'import', 'default', 'require', 'node', 'browser', 'react-server']
    .flatMap(condition => exportTargets(conditions[condition], wildcard));
}

function packageEntries(pkg: Package, subpath: string) {
  const exports = pkg.manifest.exports;
  if (exports == null) return subpath ? ['.' + subpath] :
    [pkg.manifest.source, pkg.manifest.module, pkg.manifest.main, pkg.manifest.types, './index', './src/index']
      .filter((entry): entry is string => typeof entry === 'string');
  const key = subpath ? '.' + subpath : '.';
  if (typeof exports !== 'object' || Array.isArray(exports) || !Object.keys(exports).some(key => key.startsWith('.'))) {
    return subpath ? [] : exportTargets(exports, '');
  }
  if (Object.prototype.hasOwnProperty.call(exports, key)) return exportTargets(exports[key], '');
  const match = Object.keys(exports).filter(pattern => pattern.includes('*')).map(pattern => {
    const [prefix, suffix] = pattern.split('*');
    return { pattern, prefix, suffix };
  }).filter(({ prefix, suffix }) => key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length)
    .sort((a, b) => b.prefix.length - a.prefix.length || b.suffix.length - a.suffix.length)[0];
  return match ? exportTargets(exports[match.pattern], key.slice(match.prefix.length, key.length - match.suffix.length)) : [];
}

export class WorkspaceBindings {
  private workspaceRoot?: string;
  private readonly self?: Package;
  readonly discoveryLimited: boolean;
  private readonly packages = new Map<string, Package>();
  private readonly directories = new Map<string, Package>();
  private readonly packageOptions = new Map<string, ts.CompilerOptions>();
  private readonly names = new Map<string, Package | undefined>();
  private readonly entryFiles = new Map<string, string | undefined>();
  private readonly unresolved = new Map<string, Set<string>>();

  constructor(private readonly root: string, includeRoot = false) {
    this.discoveryLimited = false;
    const manifest = json(path.join(root, 'package.json'));
    if (typeof manifest?.name === 'string') this.self = { directory: root, name: manifest.name, manifest };
    for (let directory = root, depth = 0; directory !== path.dirname(directory) && depth <= 8; directory = path.dirname(directory), depth++) {
      const workspace = directory === root && !includeRoot ? undefined : workspaceDirectories(directory);
      if (workspace) {
        this.discoveryLimited = workspace.limited;
        this.workspaceRoot = directory;
        const packages = workspace.directories.flatMap(directory => {
          const file = path.join(directory, 'package.json');
          const manifest = json(file);
          return typeof manifest?.name === 'string' && /^(@[\w.-]+\/)?[\w.-]+$/.test(manifest.name) &&
            path.resolve(realpathSync(file)) === file ? [{ directory, name: manifest.name, manifest }] : [];
        });
        const duplicates = new Set<string>();
        for (const pkg of packages) {
          this.directories.set(pkg.directory, pkg);
          // A duplicated package name has no unambiguous workspace binding.
          if (this.packages.has(pkg.name)) {
            this.packages.delete(pkg.name);
            duplicates.add(pkg.name);
          } else if (!duplicates.has(pkg.name)) this.packages.set(pkg.name, pkg);
        }
        break;
      }
      if (existsSync(path.join(directory, '.git'))) break;
    }
  }

  isRootWorkspace() {
    return this.workspaceRoot === this.root;
  }

  manifestBoundary() {
    return this.workspaceRoot ?? this.root;
  }

  has(module: string) {
    const target = this.packages.get(packageName(module));
    return target !== undefined && target.directory !== this.root;
  }

  packageFor(file: string) {
    const parent = path.dirname(path.resolve(file));
    if (!this.names.has(parent)) {
      let target: Package | undefined;
      if (this.workspaceRoot && within(this.workspaceRoot, parent) && (this.workspaceRoot === this.root || !within(this.root, parent))) {
        for (let directory = parent; directory !== this.workspaceRoot; directory = path.dirname(directory)) {
          target = this.directories.get(directory);
          if (target) break;
        }
      }
      this.names.set(parent, target);
    }
    return this.names.get(parent);
  }

  configHost(): ts.ParseConfigHost {
    return {
      ...ts.sys,
      readFile: file => {
        const content = ts.sys.readFile(file);
        if (!content || !file.endsWith('.json')) return content;
        const { config, error } = ts.parseConfigFileTextToJson(file, content);
        if (error || !config?.extends) return content;
        const locate = (specifier: unknown) => {
          if (typeof specifier !== 'string') return specifier;
          const name = packageName(specifier);
          const pkg = this.packages.get(name);
          if (!pkg) return specifier;
          const subpath = specifier.slice(name.length);
          const targets = [...packageEntries(pkg, subpath), subpath ? '.' + subpath : './tsconfig.json'];
          for (const target of targets) {
            const absolute = path.resolve(pkg.directory, target);
            for (const candidate of [absolute, absolute + '.json']) {
              if (within(pkg.directory, candidate) && candidate.endsWith('.json') &&
                  statSync(candidate, { throwIfNoEntry: false })?.isFile() && path.resolve(realpathSync(candidate)) === candidate) {
                return candidate.split(path.sep).join('/');
              }
            }
          }
          return specifier;
        };
        config.extends = Array.isArray(config.extends) ? config.extends.map(locate) : locate(config.extends);
        return JSON.stringify(config);
      }
    };
  }

  private compilerOptions(pkg: Package) {
    let options = this.packageOptions.get(pkg.directory);
    if (!options) {
      const config = projectConfig(pkg.directory);
      const host = this.configHost();
      const parsed = config && ts.readConfigFile(config, host.readFile);
      options = parsed && !parsed.error ? ts.parseJsonConfigFileContent(parsed.config,
        { ...host, readDirectory: () => [] }, pkg.directory, undefined, config).options : {};
      this.packageOptions.set(pkg.directory, options);
    }
    return options;
  }

  private sourceAt(pkg: Package, target: string) {
    const base = path.resolve(pkg.directory, target);
    if (!within(pkg.directory, base)) return;
    const src = base.replace(/(?:\.d\.[cm]?ts|\.[cm]?jsx?)$/i, '');
    const emitted = /^(?:dist|build|out)\//.test(path.relative(pkg.directory, src).split(path.sep).join('/'));
    const fromOutput = emitted ? src.replace(/([\\/])(?:dist|build|out)(?=[\\/])/, '$1src') : undefined;
    const options = fromOutput ? this.compilerOptions(pkg) : undefined;
    const fromConfig = fromOutput && options?.rootDir && options.outDir && within(options.outDir, src)
      ? path.resolve(options.rootDir, path.relative(options.outDir, src)) : undefined;
    const bases = [...new Set([fromConfig, fromOutput, emitted ? undefined : src].filter((file): file is string => !!file))];
    const candidates = bases.flatMap(file => [
      ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map(ext => file + ext),
      file, ...['.d.ts', '.d.mts', '.d.cts'].map(ext => file + ext), ...['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.d.ts'].map(index => path.join(file, index))
    ]);
    return candidates.find(file => within(pkg.directory, file) && sourceFile.test(file) &&
      statSync(file, { throwIfNoEntry: false })?.isFile() && path.resolve(realpathSync(file)) === file);
  }

  resolutionHost(): ResolutionHostFactory | undefined {
    if (!this.workspaceRoot) return;
    const caches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
    const extensions: Record<string, ts.Extension> = {
      '.ts': ts.Extension.Ts, '.tsx': ts.Extension.Tsx, '.mts': ts.Extension.Mts, '.cts': ts.Extension.Cts,
      '.d.ts': ts.Extension.Dts, '.d.mts': ts.Extension.Dmts, '.d.cts': ts.Extension.Dcts, '.js': ts.Extension.Js, '.jsx': ts.Extension.Jsx, '.mjs': ts.Extension.Mjs, '.cjs': ts.Extension.Cjs
    };
    return (host, defaults) => {
      const moduleHost = { ...host, realpath: ts.sys.realpath };
      return {
        resolveModuleNames: (names, containing, _reused, redirects, compiler, source) => names.map((name, index) => {
          const origin = this.packageFor(containing);
          const localOptions = origin && this.compilerOptions(origin);
          const options = localOptions && Object.keys(localOptions).length ? localOptions : compiler ?? defaults();
          let cache = caches.get(options);
          if (!cache) {
            cache = ts.createModuleResolutionCache(this.root, file => ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(), options);
            caches.set(options, cache);
          }
          const mode = source && ts.getModeForResolutionAtIndex(source, index);
          const resolved = ts.resolveModuleName(name, containing, options, moduleHost, cache, redirects, mode).resolvedModule;
          if (resolved && (within(this.root, resolved.resolvedFileName) || this.packageFor(resolved.resolvedFileName)) &&
              !resolved.resolvedFileName.split(/[\\/]/).includes('node_modules') &&
              (!declarationFile.test(resolved.resolvedFileName) || !this.has(name))) return { ...resolved, isExternalLibraryImport: false };
          const key = packageName(name);
          const pkg = this.packages.get(key);
          if (!pkg) return resolved;
          if (!this.entryFiles.has(name)) {
            const entries = packageEntries(pkg, name.slice(key.length));
            if (name === key && entries.some(target => /^(?:\.\/)?(?:dist|build|out)\//.test(target))) entries.push('./src/index');
            let typeEntry: string | undefined;
            let sourceEntry: string | undefined;
            for (const target of entries) {
              const file = this.sourceAt(pkg, target);
              if (!file) continue;
              if (declarationFile.test(file)) typeEntry ??= file;
              else {
                sourceEntry = file;
                break;
              }
            }
            this.entryFiles.set(name, sourceEntry ?? typeEntry);
          }
          const file = this.entryFiles.get(name);
          if (file) return { resolvedFileName: file.split(path.sep).join('/'), extension: extensions[/\.d\.[cm]?ts$/.exec(file)?.[0] ?? path.extname(file)], isExternalLibraryImport: false };
          if (resolved && this.packageFor(resolved.resolvedFileName) && declarationFile.test(resolved.resolvedFileName)) return resolved;
          if (!/\.(?:css|scss|sass|less|json|svg|png|jpe?g|woff2?|mdx?)$/i.test(name)) {
            const missing = this.unresolved.get(containing) ?? new Set<string>();
            missing.add(name);
            this.unresolved.set(containing, missing);
          }
          return resolved;
        })
      };
    };
  }

  unresolvedFor(files: string[]) {
    return [...new Set(files.flatMap(file => [...this.unresolved.get(file) ?? []]))].sort();
  }

  resolve(expression: Node | undefined) {
    const binding = importBinding(expression);
    if (!binding) return;
    const name = packageName(binding.module);
    if (this.packages.has(name)) {
      const resolved = binding.declaration.getModuleSpecifierSourceFile()?.getExportedDeclarations().get(binding.name)?.[0];
      if (resolved) return resolved;
    }
    if (name !== this.self?.name) return;
    const project = binding.declaration.getProject();
    for (const target of packageEntries(this.self, binding.module.slice(name.length))) {
      const file = this.sourceAt(this.self, target);
      const declaration = file && project.getSourceFile(file)?.getExportedDeclarations().get(binding.name)?.[0];
      if (declaration) return declaration;
    }
  }

  origin(expression: Node, module: string, name: string): boolean {
    const binding = importBinding(expression);
    if (!binding || binding.name !== name) return false;
    if (binding.module === module) return true;
    return !!binding.declaration.getModuleSpecifierSourceFile()?.getExportDeclarations().some(entry =>
      entry.getModuleSpecifierValue() === module && !entry.isTypeOnly() &&
      (!entry.getNamedExports().length || entry.getNamedExports().some(specifier =>
        specifier.getName() === name && (specifier.getAliasNode() ?? specifier.getNameNode()).getText() === name)));
  }

  snapshot() {
    if (!this.workspaceRoot || this.isRootWorkspace()) return;
    const offset = path.relative(this.root, this.workspaceRoot).split(path.sep).join('/');
    const packages = [...this.directories.keys()].filter(directory => directory !== this.root && directory !== this.workspaceRoot)
      .map(directory => path.relative(this.workspaceRoot!, directory).split(path.sep).join('/')).sort();
    const hash = workspaceSourcesHash(this.root, { offset, packages });
    if (hash) return { offset, packages, hash };
  }
}
