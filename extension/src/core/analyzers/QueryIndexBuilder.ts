import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Node, SourceFile, SyntaxKind, ts } from 'ts-morph';
import type { ComponentNode, RouteNode } from '../types/GraphTypes';
import { VERSION, isTestFile, type FetchEntry, type QueryIndex, type Reference, type Wrapper } from '../../mcp/Index';
import { declarationsOf } from './ArchitectureFacts';

type RelativePath = (source: SourceFile) => string;
type PendingFetch = Omit<FetchEntry, 'route' | 'fn' | 'owner'> & { route: string; node: Node };

export class QueryIndexBuilder {
  private edges: [string, string, number, number][] = [];
  private pages = new Map<string, { layouts: string[]; chains: Wrapper[][] }>();
  private fetches: PendingFetch[] = [];

  render(from: string, to: string, line: number, conditional: number) {
    this.edges.push([from, to, line, conditional]);
  }

  page(route: string, layouts: (string | undefined)[], chains: Wrapper[][]) {
    this.pages.set(route, { layouts: layouts.filter((id): id is string => !!id), chains });
  }

  fetch(entry: PendingFetch) {
    this.fetches.push(entry);
  }

  build(files: SourceFile[], routes: RouteNode[], components: Map<Node, ComponentNode>,
    aliases: Map<Node, Node[]>, relativePath: RelativePath, actions: Map<Node, string>): QueryIndex {
    const index: QueryIndex = {
      schema: 1, coverage: 2, generator: `neorion ${VERSION}`, generatedAt: new Date().toISOString(), root: '.',
      files: Object.create(null), symbols: [], routes: [], renderEdges: [], wrapChains: Object.create(null),
      routeWrap: {}, branches: {}, references: [], fetches: [], mentions: Object.create(null)
    };
    const byNode = new Map<Node, number>();
    const byGraphId = new Map<string, number>();
    const exports = new Map(files.map(file => [file, file.getExportedDeclarations()]));
    const exported = new Set<Node>([...exports.values()].flatMap(entries => [...entries.values()].flat()));
    const fileByName = new Map<string, SourceFile>(files.map(file => [file.getFilePath(), file]));
    const names = new Set<string>();
    const add = (node: Node, name: string, kind: QueryIndex['symbols'][number]['kind'], aliasOf: string | null) => {
      if (byNode.has(node)) return byNode.get(node)!;
      const id = index.symbols.length + 1;
      const file = relativePath(node.getSourceFile());
      index.symbols.push({ id, file, name, kind, line: node.getStartLineNumber(), exported: exported.has(node) || undefined, aliasOf: aliasOf ?? undefined });
      byNode.set(node, id);
      names.add(name);
      return id;
    };

    for (const [node, component] of components) {
      byGraphId.set(component.id, add(node, component.name, 'component', component.aliasOf ?? null));
    }
    for (const [node, id] of actions) {
      if (Node.isIdentifier(node) || Node.isExportAssignment(node)) continue;
      const name = id.slice(id.lastIndexOf('#') + 1);
      const binding = Node.isArrowFunction(node) || Node.isFunctionExpression(node) ? node.getParentOrThrow() : node;
      byNode.set(node, add(Node.isVariableDeclaration(binding) ? binding : node, name, 'function', null));
    }
    for (const file of files) {
      const relative = relativePath(file);
      const { size, mtimeMs } = statSync(file.getFilePath());
      index.files[relative] = { size, mtimeMs, sha1: createHash('sha1').update(readFileSync(file.getFilePath())).digest('hex') };
      for (const node of [...file.getFunctions(), ...file.getVariableDeclarations(), ...file.getClasses(),
        ...file.getInterfaces(), ...file.getTypeAliases(), ...file.getEnums()]) {
        const name = node.getName() ?? 'default';
        if (!/^[\w$]+$/.test(name)) continue;
        const initializer = Node.isVariableDeclaration(node) ? node.getInitializer() : undefined;
        add(node, name, /^use[A-Z0-9]/.test(name) ? 'hook' :
          Node.isFunctionDeclaration(node) || Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)
            ? 'function' : 'constant', null);
      }
      byGraphId.set(`file:${relative}`, -(byGraphId.size + 1));
    }
    for (const [node, targets] of aliases) {
      const id = targets.map(target => byNode.get(target)).find(value => value !== undefined);
      if (id !== undefined) byNode.set(node, id);
    }
    const bodyOwner = (node: Node) => {
      for (const parent of node.getAncestors()) {
        const id = byNode.get(parent);
        if (id !== undefined && index.symbols[id - 1].kind !== 'constant') return id;
      }
    };
    const filesByRelative = new Map(files.map(file => [relativePath(file), file]));
    const routeIds = new Map(routes.map((route, i) => [route.id, i + 1]));
    for (const route of routes) {
      if (route.type !== 'page' && route.type !== 'api') continue;
      const id = routeIds.get(route.id)!;
      const page = this.pages.get(route.id);
      const component = route.componentId && byGraphId.get(route.componentId) || undefined;
      const symbol = component && index.symbols[component - 1];
      const source = filesByRelative.get(route.file);
      const defaultNode = source && exports.get(source)?.get('default')?.[0];
      const entry = defaultNode?.getSourceFile() === source ? defaultNode :
        source?.getExportAssignments().find(assignment => !assignment.isExportEquals()) ?? source?.getExportDeclarations().find(declaration => declaration.getNamedExports().some(
          specifier => (specifier.getAliasNode() ?? specifier.getNameNode()).getText() === 'default'
        ));
      const handler = route.type === 'api' && source ? route.methods?.flatMap(method => exports.get(source)?.get(method) ?? [])
        .find(node => node.getSourceFile() === source) : undefined;
      index.routes.push({
        id, url: route.path, file: route.file, kind: route.type, line: symbol && symbol.file === route.file ? symbol.line :
          (entry ?? handler ?? undefined)?.getStartLineNumber() ?? 1,
        component, fileSymbol: byGraphId.get(`file:${route.file}`),
        layouts: page?.layouts.flatMap(layout => byGraphId.get(layout) ?? [])
      });
      const chains = [...new Set(page?.chains.map(chain => {
        const key = createHash('sha1').update(JSON.stringify(chain)).digest('hex').slice(0, 12);
        index.wrapChains[key] = chain;
        return key;
      }))];
      if (chains.length) index.routeWrap[id] = chains[0];
      if (chains.length > 1) index.branches![id] = chains;
    }
    for (const [from, to, line, conditional] of this.edges) {
      const source = byGraphId.get(from);
      const target = byGraphId.get(to);
      if (source !== undefined && target !== undefined) index.renderEdges.push([source, target, line, conditional]);
    }
    for (const { node, route, ...entry } of this.fetches) {
      const owner = bodyOwner(node);
      index.fetches.push({ ...entry, route: routeIds.get(route)!, owner, fn: owner ? index.symbols[owner - 1].name : null });
    }

    const orderedFiles = [...filesByRelative.keys()].sort();
    for (const relative of orderedFiles) {
      const file = filesByRelative.get(relative)!;
      const content = file.getFullText();
      const comments = new Set<number>();
      const noteLines = new Map<string, Set<number>>();
      const references = new Map<number, Map<number, Reference[]>>();
      const localNames = new Set(file.getImportDeclarations().flatMap(entry => [
        entry.getDefaultImport()?.getText(), ...entry.getNamedImports().map(specifier => specifier.getAliasNode()?.getText())
      ]));
      const record = (node: Node, declarations: Node[], kind: string, detail?: string, caller?: number) => {
        const line = node.getStartLineNumber();
        for (const declaration of declarations) {
          const id = byNode.get(declaration);
          if (!id || (kind === 'use' && index.symbols[id - 1].file === relative)) continue;
          const lines = references.get(id) ?? new Map<number, Reference[]>();
          const entries = lines.get(line) ?? [];
          const same = entries.some(entry => entry[3] === kind && entry[4] === detail && entry[5] === caller);
          if (same || (kind === 'use' && entries.some(entry => entry[3] === 'call'))) continue;
          const entry: Reference = [id, relative, line, kind];
          if (detail !== undefined || caller !== undefined) entry[4] = detail;
          if (caller !== undefined) entry[5] = caller;
          // A call on the same line already records the resolved use for rename.
          lines.set(line, kind === 'call' ? [...entries.filter(entry => entry[3] !== 'use'), entry] :
            [...entries, entry]);
          references.set(id, lines);
        }
      };
      const scanComment = (range: ts.CommentRange) => {
        if (comments.has(range.pos)) return;
        comments.add(range.pos);
        const line = file.getLineAndColumnAtPos(range.pos).line;
        for (const [offset, text] of content.slice(range.pos, range.end).split('\n').entries()) {
          for (const name of new Set(text.match(/[\w$]+/g))) {
            if (!names.has(name)) continue;
            const observed = noteLines.get(name) ?? new Set<number>();
            observed.add(line + offset);
            noteLines.set(name, observed);
          }
        }
      };
      file.forEachDescendant(node => {
        for (const comment of ts.getLeadingCommentRanges(content, node.getFullStart()) ?? []) scanComment(comment);
        for (const comment of ts.getTrailingCommentRanges(content, node.getEnd()) ?? []) scanComment(comment);
        if (Node.isImportSpecifier(node)) {
          const binding = node.getAliasNode() ?? node.getNameNode();
          record(node, declarationsOf(binding), 'import', node.getAliasNode() ? `import as ${binding.getText()}` : undefined);
        } else if (Node.isImportClause(node)) {
          const binding = node.getDefaultImport();
          if (binding) record(binding, declarationsOf(binding), 'import');
        } else if (Node.isBindingElement(node) && Node.isObjectBindingPattern(node.getParent())) {
          const declaration = node.getParentOrThrow().getParent();
          const initializer = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
          const property = node.getPropertyNameNode() ?? node.getNameNode();
          if (!initializer || !Node.isIdentifier(property) || !Node.isIdentifier(node.getNameNode())) return;
          const symbol = initializer.getType().getProperty(property.getText());
          const declarations = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
          const id = declarations.map(target => byNode.get(target)).find(value => value !== undefined);
          if (id !== undefined) {
            byNode.set(node, id);
            localNames.add(node.getName());
            record(node, declarations, 'import', node.getName() === property.getText() ? undefined : `import as ${node.getName()}`);
          }
        } else if (Node.isExportDeclaration(node) && !node.compilerNode.exportClause) {
          const target = node.getModuleSpecifierSourceFile();
          for (const [name, declarations] of (target && exports.get(target)) ?? []) {
            if (name !== 'default') record(node, declarations, 'export-star');
          }
        } else if (Node.isExportSpecifier(node)) {
          record(node, declarationsOf(node.getAliasNode() ?? node.getNameNode()), 're-export');
        } else if (Node.isCallExpression(node)) {
          const expression = node.getExpression();
          record(node, declarationsOf(expression), 'call', undefined, bodyOwner(node));
          const [module, factory] = node.getArguments();
          const specifier = Node.isStringLiteral(module) ? module :
            Node.isCallExpression(module) && module.getExpression().getKind() === SyntaxKind.ImportKeyword
              ? module.getArguments()[0] : undefined;
          if (!/^(vi|jest)\.(mock|doMock)$/.test(expression.getText()) || !Node.isStringLiteral(specifier) || !factory) return;
          const moduleName = specifier.getLiteralText();
          const imported = file.getImportDeclarations().find(entry => entry.getModuleSpecifierValue() === moduleName);
          const resolved = imported?.getModuleSpecifierSourceFile() ?? fileByName.get(ts.resolveModuleName(
            moduleName, file.getFilePath(), file.getProject().getCompilerOptions(), ts.sys
          ).resolvedModule?.resolvedFileName ?? '');
          if (resolved) factory.forEachDescendant(key => {
            if (!Node.isPropertyAssignment(key) && !Node.isShorthandPropertyAssignment(key) && !Node.isMethodDeclaration(key)) return;
            const object = key.getParent();
            if (!Node.isObjectLiteralExpression(object)) return;
            let result = object.getParent();
            while (Node.isParenthesizedExpression(result) || Node.isAsExpression(result)) result = result.getParent();
            if (result !== factory && (!Node.isReturnStatement(result) || result.getParent()?.getParent() !== factory)) return;
            record(key, exports.get(resolved)?.get(key.getName()) ?? [], 'mock', `${expression.getText()} key`);
          });
        } else if (Node.isShorthandPropertyAssignment(node)) {
          const symbol = node.getValueSymbol();
          if (symbol) record(node, (symbol.getAliasedSymbol() ?? symbol).getDeclarations(), 'use');
        } else if (Node.isElementAccessExpression(node)) {
          const key = node.getArgumentExpression();
          if (Node.isStringLiteral(key)) {
            const symbol = node.getExpression().getType().getProperty(key.getLiteralText());
            if (symbol) record(key, (symbol.getAliasedSymbol() ?? symbol).getDeclarations(), 'use');
          }
        } else if (Node.isIdentifier(node) && (names.has(node.getText()) || localNames.has(node.getText()))) {
          const parent = node.getParent();
          if (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isExportSpecifier(parent)) return;
          record(node, declarationsOf(node).filter(declaration =>
            declaration.compilerNode !== parent?.compilerNode || !byNode.has(declaration)), 'use');
        }
      });
      for (const comment of ts.getLeadingCommentRanges(content, 0) ?? []) scanComment(comment);
      for (const lines of references.values()) for (const entries of lines.values()) index.references.push(...entries);
      // Keep the first ten diagnostic comment matches in each test category.
      // The tool can only show ten exclusions and can filter out tests.
      const test = isTestFile(relative);
      for (const [name, lines] of noteLines) {
        const notes = index.mentions![name] ??= [];
        const remaining = 10 - notes.filter(([file]) => isTestFile(file) === test).length;
        for (const line of [...lines].sort((a, b) => a - b).slice(0, remaining)) notes.push([relative, line]);
      }
    }
    return index;
  }
}
