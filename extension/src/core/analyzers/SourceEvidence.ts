import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Node, Project, SyntaxKind, ts, type CallExpression, type SourceFile } from 'ts-morph';
import { ignoredProjectDirectories } from '../FindProject';
import { collectApiFacts } from './ArchitectureFacts';
import { visitKinds } from './CompilerWalk';
import { literalArgs, literalReturn } from './LiteralEvidence';
import { renderEvidence, type RenderEvidence } from './RenderEvidence';
import type { RouteNode } from '../types/GraphTypes';
import type { FetchEntry, QueryIndex } from '../../mcp/Index';

const sourceKinds = new Set([
  SyntaxKind.CallExpression, SyntaxKind.ReturnStatement, SyntaxKind.JsxOpeningElement, SyntaxKind.JsxSelfClosingElement
]);
const ignored = new Set([
  ...ignoredProjectDirectories, '.git', '.next', '.neorion', 'cdk.out', '.vercel', '.turbo', '.output', '.sst', '.open-next'
]);
const maxFileBytes = 512 * 1024;
const maxScanBytes = 16 * 1024 * 1024;
const maxScripts = 128;
const maxEntries = 20_000;

function isolatedProject() {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve }
  });
}

export class SourceEvidence {
  private sites = new Map<string, Map<string, Node> | undefined>();
  private renders = new Map<string, RenderEvidence | undefined>();
  private calls = new WeakMap<CallExpression, string | undefined>();
  private returns = new Map<string, string | undefined>();
  private excluded?: { fetches: FetchEntry[]; issue?: string };

  constructor(private root: string, private index: QueryIndex, private checkPath: (file: string) => string) {}

  private node(file: string, offset: number, kind: 'call' | 'render' | 'return') {
    if (!this.sites.has(file)) {
      this.sites.set(file, undefined);
      const indexed = this.index.files[file];
      if (indexed?.sha1) {
        try {
          const contents = readFileSync(this.checkPath(file));
          if (createHash('sha1').update(contents).digest('hex') !== indexed.sha1) return;
          // Use the same BOM handling as ts-morph's disk reader.
          const project = isolatedProject();
          const source = project.createSourceFile('/' + file, contents.toString('utf8').replace(/^\uFEFF/, ''));
          const sites = new Map<string, Node>();
          visitKinds(source, sourceKinds, node => {
            if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
              sites.set(`render:${node.getTagNameNode().getStart()}`, node);
              sites.set(`render:${node.getStart()}`, node);
            } else if (Node.isCallExpression(node)) {
              sites.set(`call:${node.getEnd()}`, node);
              const renderKey = `render:${node.getStart()}`;
              if (!sites.has(renderKey)) sites.set(renderKey, node);
            } else if (Node.isReturnStatement(node)) {
              sites.set(`return:${node.getStart()}`, node);
            }
          });
          this.sites.set(file, sites);
        } catch {
          // An unavailable source file cannot supply evidence for indexed coordinates.
        }
      }
    }
    return this.sites.get(file)?.get(`${kind}:${offset}`);
  }

  render(site?: string | null): RenderEvidence | undefined {
    if (!site || !this.index.sourceEvidence) return;
    if (!this.renders.has(site)) {
      const colon = site.lastIndexOf(':');
      const node = this.node(site.slice(0, colon), Number(site.slice(colon + 1)), 'render');
      const tag = Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node) ? node.getTagNameNode() :
        Node.isCallExpression(node) ? node.getArguments()[0] : undefined;
      this.renders.set(site, tag && renderEvidence(tag));
    }
    return this.renders.get(site);
  }

  call(file: string, offset: number) {
    const node = this.node(file, offset, 'call');
    if (!Node.isCallExpression(node)) return;
    if (!this.calls.has(node)) this.calls.set(node, literalArgs(node));
    return this.calls.get(node);
  }

  unresolvedCall(file: string, offset: number) {
    const args = this.call(file, offset);
    if (!args) return;
    const node = this.node(file, offset, 'call');
    if (Node.isCallExpression(node)) {
      const callee = node.getExpression().getText();
      if (/^[$\w]+(?:\.[$\w]+){0,6}$/.test(callee) && callee.length <= 120) return { callee, args };
    }
  }

  returned(file: string, offset: number) {
    const site = `${file}:${offset}`;
    if (!this.returns.has(site)) {
      const node = this.node(file, offset, 'return');
      const expression = Node.isReturnStatement(node) ? node.getExpression() : undefined;
      this.returns.set(site, expression && literalReturn(expression));
    }
    return this.returns.get(site);
  }

  excludedRequests() {
    if (this.excluded) return this.excluded;
    const fetches: FetchEntry[] = [];
    const result: NonNullable<SourceEvidence['excluded']> = { fetches };
    this.excluded = result;
    if (!this.index.sourceEvidence) return result;
    const routes: RouteNode[] = this.index.routes.filter(route => route.kind === 'api').map(route => ({
      id: String(route.id), type: 'api', file: route.file, path: route.url, pages: route.pages,
      methods: route.methods, isClient: false, domain: ''
    }));
    if (!routes.length) return result;
    const url = this.index.appUrlConfig ?? this.index.pagesUrlConfig;
    const config = url && { url, rules: [], issues: [] };
    let entries = 0;
    let bytes = 0;
    const scripts: string[] = [];
    const scan = (directory: string): boolean => {
      let children;
      try {
        children = readdirSync(path.join(this.root, directory), { withFileTypes: true });
      } catch {
        result.issue ??= 'excluded HTTP source unreadable';
        return true;
      }
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++entries > maxEntries || scripts.length >= maxScripts || bytes >= maxScanBytes) return false;
        if (child.name.startsWith('.') || ignored.has(child.name)) continue;
        const file = directory ? directory + '/' + child.name : child.name;
        if (child.isDirectory()) {
          if (!scan(file)) return false;
          continue;
        }
        if (!child.isFile() || Object.prototype.hasOwnProperty.call(this.index.files, file) ||
            !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) || /\.d\.[cm]?ts$/.test(file)) continue;
        try {
          const absolute = this.checkPath(file);
          const size = statSync(absolute).size;
          if (size > maxFileBytes) {
            result.issue ??= 'excluded HTTP source size limit';
            continue;
          }
          if (bytes + size > maxScanBytes) return false;
          bytes += size;
          const text = readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '');
          if (!/\bfetch\b|['"](?:axios|node-fetch|undici|(?:node:)?https?)['"]/.test(text)) continue;
          scripts.push(file);
          const source: SourceFile = isolatedProject().createSourceFile('/' + file, text);
          collectApiFacts(this.root, [source], routes, () => file, new Map(), undefined, () => undefined,
            undefined, undefined, undefined, undefined, config, entry => fetches.push(entry));
        } catch {
          result.issue ??= 'excluded HTTP source unreadable';
        }
      }
      return true;
    };
    if (!scan('')) result.issue ??= 'excluded HTTP source scan limit';
    return result;
  }
}
