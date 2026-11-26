import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Node, ts, type ExportDeclaration, type ImportDeclaration, type ResolutionHostFactory, type SourceFile } from 'ts-morph';
import { projectConfig, workspaceDirectories } from '../FindProject';
import { parse } from 'yaml';
import { workspaceInputsHash, workspaceSourcesHash } from '../ProjectSnapshot';
import { bindingOf, importBinding } from './StaticBindings';

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
type ReExport = { declaration: ImportDeclaration | ExportDeclaration; name: string; namespace?: boolean };

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

type PnpmWorkspace = { packages?: unknown; catalog?: unknown; catalogs?: unknown };

function pnpmWorkspace(file: string): PnpmWorkspace | undefined {
  try {
    const value: unknown = parse(readFileSync(file, 'utf8'), { maxAliasCount: 32, logLevel: 'silent' });
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // Missing or malformed workspace settings cannot select a dependency version.
  }
}

function own(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
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
  private readonly reExports = new Map<SourceFile, {
    named: Map<string, ReExport | undefined>;
    stars: ExportDeclaration[];
    resolved: Set<string>;
  }>();
  private pnpmDirectory?: string;
  private pnpm?: PnpmWorkspace;

  constructor(private readonly root: string, includeRoot = false) {
    this.discoveryLimited = false;
    const manifest = json(path.join(root, 'package.json'));
    if (typeof manifest?.name === 'string') this.self = { directory: root, name: manifest.name, manifest };
    for (let directory = root, depth = 0; directory !== path.dirname(directory) && depth <= 8; directory = path.dirname(directory), depth++) {
      const pnpm = pnpmWorkspace(path.join(directory, 'pnpm-workspace.yaml'));
      if (pnpm && !this.pnpm) {
        this.pnpm = pnpm;
        this.pnpmDirectory = directory;
      }
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

  catalogVersion(name: string, spec: string): unknown {
    const catalog = spec.slice('catalog:'.length);
    return own(!catalog || catalog === 'default' ? this.pnpm?.catalog : own(this.pnpm?.catalogs, catalog), name);
  }

  catalogSnapshot() {
    if (!this.pnpmDirectory) return;
    const offset = path.relative(this.root, this.pnpmDirectory).split(path.sep).join('/');
    const files = ['package.json', 'pnpm-workspace.yaml'];
    return { offset, files, hash: workspaceInputsHash(this.root, offset, files) };
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
          if ((!file || declarationFile.test(file)) &&
              !/\.(?:css|scss|sass|less|json|svg|png|jpe?g|woff2?|mdx?)$/i.test(name)) {
            const missing = this.unresolved.get(containing) ?? new Set<string>();
            missing.add(name);
            this.unresolved.set(containing, missing);
          }
          if (file) return { resolvedFileName: file.split(path.sep).join('/'), extension: extensions[/\.d\.[cm]?ts$/.exec(file)?.[0] ?? path.extname(file)], isExternalLibraryImport: false };
          return resolved;
        })
      };
    };
  }

  isUnresolved(file: SourceFile, module: string) {
    return this.unresolved.get(file.getFilePath())?.has(module) ?? false;
  }

  unresolvedBinding(expression: Node) {
    if (!this.unresolved.size) return;
    let root = expression;
    const members: (string | undefined)[] = [];
    while (Node.isPropertyAccessExpression(root) || Node.isElementAccessExpression(root)) {
      const argument = Node.isElementAccessExpression(root) ? root.getArgumentExpression() : undefined;
      members.unshift(Node.isPropertyAccessExpression(root) ? root.getName() :
        Node.isStringLiteral(argument) ? argument.getLiteralText() : undefined);
      root = root.getExpression();
    }
    if (!Node.isIdentifier(root)) return;
    const binding = importBinding(root);
    if (!binding) return;
    const name = Node.isNamespaceImport(bindingOf(root)) ? members.shift() : binding.name;
    return this.unresolvedFrom(binding.declaration, name, members, new Set());
  }

  private unresolvedFrom(declaration: ImportDeclaration | ExportDeclaration, name: string | undefined,
    members: (string | undefined)[], seen: Set<string>): string | undefined {
    const module = declaration.getModuleSpecifierValue();
    if (module && this.isUnresolved(declaration.getSourceFile(), module)) return module;
    const source = declaration.getModuleSpecifierSourceFile();
    if (name !== undefined && source && !source.isInNodeModules() && !source.isDeclarationFile()) {
      return this.unresolvedExport(source, name, members, seen);
    }
  }

  private unresolvedExport(file: SourceFile, name: string, members: (string | undefined)[], seen: Set<string>): string | undefined {
    const key = JSON.stringify([file.getFilePath(), name, members]);
    if (seen.has(key)) return;
    seen.add(key);
    let exports = this.reExports.get(file);
    if (!exports) {
      exports = { named: new Map(), stars: [], resolved: new Set() };
      for (const entry of file.getExportDeclarations()) {
        if (entry.isTypeOnly()) continue;
        const namespace = entry.getNamespaceExport();
        if (namespace) exports.named.set(namespace.getName(), { declaration: entry, name: '*', namespace: true });
        else if (!entry.compilerNode.exportClause) exports.stars.push(entry);
        else for (const specifier of entry.getNamedExports()) {
          const symbol = specifier.getAliasNode() ?? specifier.getNameNode();
          let origin: ReExport | undefined;
          if (!specifier.isTypeOnly()) {
            if (entry.hasModuleSpecifier()) origin = { declaration: entry, name: specifier.getNameNode().compilerNode.text };
            else {
              const binding = specifier.getLocalTargetSymbol()?.getDeclarations()[0];
              const imported = binding?.getFirstAncestorByKind(ts.SyntaxKind.ImportDeclaration);
              if (imported && !imported.isTypeOnly() && !(Node.isImportSpecifier(binding) && binding.isTypeOnly())) {
                origin = { declaration: imported, name: Node.isImportSpecifier(binding) ? binding.getNameNode().compilerNode.text : 'default',
                  namespace: Node.isNamespaceImport(binding) || undefined };
              }
            }
          }
          exports.named.set(symbol.compilerNode.text, origin);
        }
      }
      if (exports.stars.length) for (const [exported, declarations] of file.getExportedDeclarations()) {
        if (declarations.some(node => !node.getSourceFile().isDeclarationFile())) exports.resolved.add(exported);
      }
      this.reExports.set(file, exports);
    }
    if (exports.named.has(name)) {
      const binding = exports.named.get(name);
      if (binding) return this.unresolvedFrom(binding.declaration, binding.namespace ? members[0] : binding.name,
        binding.namespace ? members.slice(1) : members, seen);
      return;
    }
    if (name === 'default' || exports.resolved.has(name)) return;
    for (const entry of exports.stars) {
      const missing = this.unresolvedFrom(entry, name, members, seen);
      if (missing) return missing;
    }
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
