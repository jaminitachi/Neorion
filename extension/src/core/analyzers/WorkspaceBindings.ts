import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { Node, Project } from 'ts-morph';
import { workspaceInputsHash } from '../ProjectSnapshot';
import { importBinding } from './StaticBindings';

function json(file: string) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

export class WorkspaceBindings {
  private workspaceRoot?: string;
  private readonly inputs = new Set<string>();
  private readonly packages = new Map<string, string>();
  private project?: Project;
  private readonly dependencies: Set<string>;

  constructor(private readonly root: string) {
    const manifest = json(path.join(root, 'package.json'));
    this.dependencies = new Set(Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies,
      ...manifest?.peerDependencies, ...manifest?.optionalDependencies }));
    for (let directory = root; directory !== path.dirname(directory); directory = path.dirname(directory)) {
      const workspace = json(path.join(directory, 'package.json'))?.workspaces;
      const yaml = path.join(directory, 'pnpm-workspace.yaml');
      const patterns: unknown = Array.isArray(workspace) ? workspace : workspace?.packages ??
        (existsSync(yaml) ? [...readFileSync(yaml, 'utf8').matchAll(/^\s*-\s+['"]?([\w./*-]+)['"]?\s*$/gm)].map(match => match[1]) : []);
      if (!Array.isArray(patterns) || !patterns.length) continue;
      this.workspaceRoot = directory;
      this.inputs.add(path.join(directory, 'package.json'));
      if (existsSync(yaml)) this.inputs.add(yaml);
      for (const pattern of patterns) {
        if (typeof pattern !== 'string' || !/^[\w./-]+(?:\/\*)?$/.test(pattern) || pattern.includes('..') || path.isAbsolute(pattern)) continue;
        const base = path.join(directory, pattern.replace(/\/\*$/, ''));
        if (!existsSync(base)) continue;
        const candidates = pattern.endsWith('/*') ? readdirSync(base, { withFileTypes: true })
          .filter(entry => entry.isDirectory()).map(entry => path.join(base, entry.name)) : [base];
        for (const candidate of candidates) {
          const name = json(path.join(candidate, 'package.json'))?.name;
          if (typeof name === 'string' && this.dependencies.has(name) && candidate !== root) this.packages.set(name, candidate);
        }
      }
      break;
    }
  }

  private packageName(module: string) {
    return module.split('/').slice(0, module.startsWith('@') ? 2 : 1).join('/');
  }

  has(module: string) {
    return this.packages.has(this.packageName(module));
  }

  resolve(expression: Node) {
    const binding = importBinding(expression);
    if (!binding) return;
    const name = this.packageName(binding.module);
    const root = this.packages.get(name);
    if (!root) return;
    const subpath = binding.module.slice(name.length);
    const manifestPath = path.join(root, 'package.json');
    this.inputs.add(manifestPath);
    const manifest = json(manifestPath);
    const key = subpath ? '.' + subpath : '.';
    const exports = manifest?.exports;
    const entry = !subpath && typeof exports === 'string' ? exports : exports?.[key];
    const target = typeof entry === 'string' ? entry : entry?.import ?? entry?.default;
    if (exports !== undefined) return typeof target === 'string' ?
      this.exportAt(root, path.resolve(root, target), binding.name, new Set()) : undefined;
    const candidate = subpath ? '.' + subpath : manifest?.main ?? './index';
    const selected = this.exportAt(root, path.resolve(root, candidate), binding.name, new Set());
    return selected ?? (!subpath && candidate !== './index'
      ? this.exportAt(root, path.join(root, 'index'), binding.name, new Set()) : undefined);
  }

  origin(expression: Node, module: string, name: string): boolean {
    const binding = importBinding(expression);
    if (!binding || binding.name !== name) return false;
    if (binding.module === module) return true;
    const source = binding.declaration.getSourceFile();
    const target = binding.declaration.getModuleSpecifierSourceFile() ??
      (binding.module.startsWith('.') ? this.sourceAt(path.dirname(source.getFilePath()),
        path.resolve(path.dirname(source.getFilePath()), binding.module), true) : undefined);
    return !!target && target.getExportDeclarations().some(entry =>
      entry.getModuleSpecifierValue() === module && !entry.isTypeOnly() &&
      (!entry.getNamedExports().length || entry.getNamedExports().some(specifier =>
        specifier.getName() === name && (specifier.getAliasNode() ?? specifier.getNameNode()).getText() === name)));
  }

  snapshot() {
    if (!this.workspaceRoot || !this.inputs.size) return;
    const offset = path.relative(this.root, this.workspaceRoot).split(path.sep).join('/');
    const files = [...this.inputs].map(file => path.relative(this.workspaceRoot!, file).split(path.sep).join('/')).sort();
    return { offset, files, hash: workspaceInputsHash(this.root, offset, files) };
  }

  private sourceAt(root: string, base: string, withinWorkspace = false) {
    const boundary = withinWorkspace ? this.workspaceRoot : root;
    if (!boundary) return;
    const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx'].map(ext => base + ext),
      ...['index.ts', 'index.tsx', 'index.js'].map(file => path.join(base, file))];
    const file = candidates.find(candidate => candidate.startsWith(boundary + path.sep) &&
      /\.[jt]sx?$/.test(candidate) && !candidate.endsWith('.d.ts') && statSync(candidate, { throwIfNoEntry: false })?.isFile());
    if (!file || !realpathSync(file).startsWith(boundary + path.sep)) return;
    this.inputs.add(file);
    return (this.project ??= new Project({ skipFileDependencyResolution: true })).addSourceFileAtPathIfExists(file);
  }

  private exportAt(root: string, base: string, name: string, seen: Set<string>): Node | undefined {
    if (!base.startsWith(root + path.sep) || seen.size >= 12 || (this.project?.getSourceFiles().length ?? 0) >= 150) return;
    const source = this.sourceAt(root, base);
    const file = source?.getFilePath();
    const key = file + '#' + name;
    if (!file || !source || seen.has(key)) return;
    seen.add(key);
    const local = source.getExportedDeclarations().get(name)?.find(node => node.getSourceFile() === source &&
      !Node.isExportSpecifier(node));
    if (local) return local;
    for (const declaration of source.getExportDeclarations()) {
      const module = declaration.getModuleSpecifierValue();
      if (!module?.startsWith('.') || declaration.isTypeOnly()) continue;
      const specifiers = declaration.getNamedExports();
      const specifier = specifiers.find(specifier => (specifier.getAliasNode() ?? specifier.getNameNode()).getText() === name);
      if (specifier?.isTypeOnly() || !specifier && (specifiers.length || name === 'default')) continue;
      const found = this.exportAt(root, path.resolve(path.dirname(file), module), specifier?.getName() ?? name, seen);
      if (found) return found;
    }
  }
}
