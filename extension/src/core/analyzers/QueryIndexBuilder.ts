import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Node, SourceFile, SyntaxKind, ts } from 'ts-morph';
import type { ComponentNode, RouteNode } from '../types/GraphTypes';
import {
  GRAPH_INDEX_REVISION, INDEX_SCHEMA, QUERY_INDEX_REVISION, GraphReferenceKind, WRAPPER_INDEX_REVISION, VERSION, isTestFile, type ExternalCall, type FetchEntry,
  type GraphReference, type QueryIndex, type Reference, type ServerAction, type Wrapper
} from '../../mcp/Index';
import { conditionalAt, declarationsOf, isPackageSpecifier } from './ArchitectureFacts';

type RelativePath = (source: SourceFile) => string;
type PendingFetch = Omit<FetchEntry, 'route' | 'fn' | 'owner'> & { route: string; node: Node };

function wrappedFunction(node: Node | undefined, remaining = 2): boolean {
  return remaining > 0 && Node.isCallExpression(node) && node.getArguments().some(argument =>
    Node.isArrowFunction(argument) || Node.isFunctionExpression(argument) || wrappedFunction(argument, remaining - 1));
}

function receiver(expression: Node) {
  const members: string[] = [];
  while (Node.isPropertyAccessExpression(expression) || Node.isElementAccessExpression(expression)) {
    if (Node.isPropertyAccessExpression(expression)) members.unshift(expression.getName());
    else {
      const key = expression.getArgumentExpression();
      if (!Node.isStringLiteral(key)) return;
      members.unshift(key.getLiteralText());
    }
    expression = expression.getExpression();
  }
  if (Node.isIdentifier(expression)) return { root: expression, members };
}

function dynamicExport(node: Node) {
  const parent = node.getParent();
  if (!Node.isPropertyAccessExpression(parent) || parent.getName() !== 'then') return 'default';
  const call = parent.getParent();
  const callback = Node.isCallExpression(call) ? call.getArguments()[0] : undefined;
  if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return;
  const body = callback.getBody();
  const statements = Node.isBlock(body) ? body.getStatements() : [];
  const result = Node.isBlock(body)
    ? statements.length === 1 && Node.isReturnStatement(statements[0]) ? statements[0].getExpression() : undefined
    : body;
  if (Node.isPropertyAccessExpression(result) &&
      result.getExpression().getText() === callback.getParameters()[0]?.getName()) return result.getName();
}

export class QueryIndexBuilder {
  private edges: [string, string, number, number][] = [];
  private pages = new Map<string, { layouts: string[]; chains: Wrapper[][] }>();
  private fetches: PendingFetch[] = [];
  private actions = new Map<string, ServerAction>();
  private actionUses: { caller: ServerAction['callers'][number]; node: Node }[] = [];

  render(from: string, to: string, line: number, conditional: number) {
    this.edges.push([from, to, line, conditional]);
  }

  page(route: string, layouts: (string | undefined)[], chains: Wrapper[][]) {
    this.pages.set(route, { layouts: layouts.filter((id): id is string => !!id), chains });
  }

  fetch(entry: PendingFetch) {
    this.fetches.push(entry);
  }

  action(id: string, name: string, file: string, line: number) {
    this.actions.set(id, { name, file, line, callers: [] });
  }

  actionAlias(id: string, alias: string) {
    const action = this.actions.get(id)!;
    if (alias !== action.name && !action.aliases?.includes(alias)) (action.aliases ??= []).push(alias);
  }

  useAction(id: string, file: string, line: number, node: Node) {
    const caller: ServerAction['callers'][number] = [file, line];
    this.actionUses.push({ caller, node });
    this.actions.get(id)!.callers.push(caller);
  }

  build(files: SourceFile[], routes: RouteNode[], components: Map<Node, ComponentNode>,
    aliases: Map<Node, Node[]>, relativePath: RelativePath, actions: Map<Node, string>): QueryIndex {
    const index: QueryIndex = {
      schema: INDEX_SCHEMA, coverage: 2, generator: VERSION, generatedAt: new Date().toISOString(), root: '.',
      wrapperRevision: WRAPPER_INDEX_REVISION, queryRevision: QUERY_INDEX_REVISION,
      files: Object.create(null), symbols: [], routes: [], renderEdges: [], wrapChains: Object.create(null),
      routeWrap: {}, branches: {}, references: [], fetches: [], serverActions: [...this.actions.values()], mentions: Object.create(null),
      graphRevision: GRAPH_INDEX_REVISION, graphReferences: {}, graphNames: [], externalCalls: [], externalModules: [],
      unresolvedCalls: {}, fileSymbols: [],
      defaultSymbols: Object.create(null), routeFiles: Object.create(null), trpcFiles: []
    };
    const byNode = new Map<Node, number>();
    const byGraphId = new Map<string, number>();
    const exports = new Map(files.map(file => [file, file.getExportedDeclarations()]));
    const exported = new Set<Node>([...exports.values()].flatMap(entries => [...entries.values()].flat()));
    const fileByName = new Map<string, SourceFile>(files.map(file => [file.getFilePath(), file]));
    const names = new Set<string>();
    const wrappedOwners = new Set<number>();
    const add = (node: Node, name: string, kind: QueryIndex['symbols'][number]['kind'], aliasOf: string | null) => {
      if (byNode.has(node)) return byNode.get(node)!;
      const id = index.symbols.length + 1;
      const file = relativePath(node.getSourceFile());
      index.symbols.push({ id, file, name, kind, line: node.getStartLineNumber(), exported: exported.has(node) || undefined,
        aliasOf: aliasOf ?? undefined, typeOnly: Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node) || undefined });
      byNode.set(node, id);
      names.add(name);
      return id;
    };

    for (const [node, component] of components) {
      byGraphId.set(component.id, add(node, component.name, 'component', component.aliasOf ?? null));
    }
    const actionSymbols = new Map<string, number>();
    for (const [node, id] of actions) {
      const name = id.slice(id.lastIndexOf('#') + 1);
      const symbol = actionSymbols.get(id) ?? add(node, name, 'function', null);
      actionSymbols.set(id, symbol);
      const action = this.actions.get(id);
      if (action) action.symbol = symbol;
      byNode.set(node, symbol);
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
        const id = add(node, name, /^use[A-Z0-9]/.test(name) ? 'hook' :
          Node.isFunctionDeclaration(node) || Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)
            ? 'function' : 'constant', null);
        if (index.symbols[id - 1].kind === 'constant' && wrappedFunction(initializer)) {
          wrappedOwners.add(id);
          index.symbols[id - 1].kind = 'function';
        }
      }
      byGraphId.set(`file:${relative}`, -(byGraphId.size + 1));
      index.fileSymbols!.push(byGraphId.get(`file:${relative}`)!);
      if (/^(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]sx?$/.test(relative)) {
        const config = file.getVariableDeclaration('config')?.getInitializer();
        const property = Node.isObjectLiteralExpression(config) ? config.getProperty('matcher') : undefined;
        const matcher = Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
        const values = Node.isArrayLiteralExpression(matcher) ? matcher.getElements() : matcher ? [matcher] : [];
        index.routeFiles![relative] = ['middleware', '/', values.length && values.every(Node.isStringLiteral)
          ? values.map(value => value.getText()).join(', ') : undefined];
      } else if (/^(?:src\/)?pages\/_(?:app|document)\.[jt]sx?$/.test(relative)) {
        index.routeFiles![relative] = ['app-shell', '/'];
      }
    }
    for (const [node, targets] of aliases) {
      const id = targets.map(target => byNode.get(target)).find(value => value !== undefined);
      if (id !== undefined) byNode.set(node, id);
    }
    const owners = (node: Node): [legacy?: number, graph?: number] => {
      let graph: number | undefined;
      for (const parent of node.getAncestors()) {
        const id = byNode.get(parent);
        if (id === undefined || index.symbols[id - 1].kind === 'constant') continue;
        graph ??= id;
        if (!wrappedOwners.has(id)) return [id, graph];
      }
      return [undefined, graph];
    };
    for (const { caller, node } of this.actionUses) {
      const owner = owners(node)[1];
      if (owner !== undefined) caller[2] = owner;
    }
    for (const action of this.actions.values()) {
      const seen = new Set<string>();
      action.callers = action.callers.filter(caller => {
        const key = JSON.stringify(caller);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    const filesByRelative = new Map(files.map(file => [relativePath(file), file]));
    for (const [relative, file] of filesByRelative) {
      const id = exports.get(file)?.get('default')?.map(node => byNode.get(node)).find(value => value !== undefined);
      if (id !== undefined) index.defaultSymbols![byGraphId.get(`file:${relative}`)!] = id;
    }
    const routeIds = new Map(routes.map((route, i) => [route.id, i + 1]));
    for (const route of routes) {
      if (route.type !== 'page' && route.type !== 'api') {
        const component = route.componentId && byGraphId.get(route.componentId) || undefined;
        index.routeFiles![route.file] = component === undefined ? [route.type, route.path] : [route.type, route.path, undefined, component];
        continue;
      }
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
      const handlers: Record<string, number> = {};
      if (route.type === 'api' && source) for (const method of route.methods ?? []) {
        const methodNodes = exports.get(source)?.get(method) ?? exports.get(source)?.get('default') ?? [];
        const id = methodNodes.map(node => byNode.get(node)).find(value => value !== undefined);
        if (id !== undefined) handlers[method] = id;
      }
      index.routes.push({
        id, url: route.path, file: route.file, kind: route.type, line: symbol && symbol.file === route.file ? symbol.line :
          (entry ?? handler ?? undefined)?.getStartLineNumber() ?? 1,
        component, fileSymbol: byGraphId.get(`file:${route.file}`),
        layouts: page?.layouts.flatMap(layout => byGraphId.get(layout) ?? []), methods: route.methods,
        handlers: Object.keys(handlers).length ? handlers : undefined
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
      const [owner, graphOwner] = owners(node);
      index.fetches.push({ ...entry, route: routeIds.get(route)!, owner, graphOwner: graphOwner === owner ? undefined : graphOwner,
        fn: owner ? index.symbols[owner - 1].name : null });
    }

    const trpcSources = new Set(files.filter(file =>
      file.getImportDeclarations().some(entry => /^@trpc\/server(?:\/|$)/.test(entry.getModuleSpecifierValue()))));
    const dynamicBindings = new Map<Node, number>();
    const externalModules = new Map<string, number>();
    const graphNames = new Map<string, number>();
    const graphName = (name: string) => {
      let id = graphNames.get(name);
      if (id === undefined) {
        id = index.graphNames!.push(name) - 1;
        graphNames.set(name, id);
      }
      return id;
    };
    const renderSites: { node: Node; owner?: number; line: number; file: string }[] = [];
    const orderedFiles = [...filesByRelative.keys()].sort();
    for (const relative of orderedFiles) {
      const file = filesByRelative.get(relative)!;
      const fileId = byGraphId.get(`file:${relative}`)!;
      const content = file.getFullText();
      const comments = new Set<number>();
      const noteLines = new Map<string, Set<number>>();
      const references = new Map<number, Map<number, Reference[]>>();
      const imports = file.getImportDeclarations();
      if (trpcSources.has(file) || trpcSources.size && imports.some(entry => trpcSources.has(entry.getModuleSpecifierSourceFile()!))) {
        index.trpcFiles!.push(relative);
      }
      const localNames = new Set(imports.flatMap(entry => [
        entry.getDefaultImport()?.getText(), ...entry.getNamedImports().map(specifier => specifier.getAliasNode()?.getText())
      ]));
      const packageBindings = new Map<string, { module: string; name: string; binding: Node }>();
      for (const entry of imports) {
        const module = entry.getModuleSpecifierValue();
        if (!isPackageSpecifier(module) || entry.isTypeOnly() || exports.has(entry.getModuleSpecifierSourceFile()!)) continue;
        for (const binding of [entry.getDefaultImport(), entry.getNamespaceImport()]) {
          if (!binding) continue;
          const name = binding.getText();
          packageBindings.set(name, { module, name, binding: binding.getSymbol()?.getDeclarations()[0] ?? binding });
        }
        for (const binding of entry.getNamedImports()) {
          if (!binding.isTypeOnly()) packageBindings.set((binding.getAliasNode() ?? binding.getNameNode()).getText(),
            { module, name: binding.getName(), binding });
        }
      }
      const externalCalls = new Map<number, Map<string, ExternalCall>>();
      const graphReferences = new Map<string, GraphReference>();
      const recordGraph = (id: number, line: number, kind: GraphReferenceKind, owner?: number, detail?: number) => {
        const key = JSON.stringify([id, line, kind, owner, detail]);
        if (graphReferences.has(key)) return;
        const ref: GraphReference = [id, line, kind];
        if (owner !== undefined || detail !== undefined) ref[3] = owner;
        if (detail !== undefined) ref[4] = detail;
        graphReferences.set(key, ref);
      };
      const record = (node: Node, declarations: Node[], kind: string, detail?: string, caller?: number, graphOwner?: number) => {
        const line = node.getStartLineNumber();
        let found = false;
        for (const declaration of declarations) {
          const id = byNode.get(declaration);
          if (!id) continue;
          found = true;
          let referenceKind = kind;
          let referenceCaller = caller;
          let referenceOwner = graphOwner;
          if (kind === 'use') {
            const symbol = index.symbols[id - 1];
            const sameFile = symbol.file === relative;
            const parent = node.getParent();
            const jsx = (Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent) || Node.isJsxClosingElement(parent)) &&
              parent.getTagNameNode() === node;
            const signature = Node.isFunctionDeclaration(parent) && parent.getNameNode() === node;
            referenceOwner = !jsx && (!sameFile || symbol.kind !== 'constant' || symbol.typeOnly) ? owners(node)[1] : undefined;
            if (sameFile && !jsx && !signature && (symbol.kind !== 'constant' || symbol.typeOnly) && referenceOwner !== id) {
              recordGraph(id, line, GraphReferenceKind.Use, referenceOwner);
            }
            referenceCaller = sameFile ? undefined : referenceOwner;
            if (sameFile) referenceOwner = undefined;
            else if (jsx) referenceKind = 'jsx-use';
          }
          const lines = references.get(id) ?? new Map<number, Reference[]>();
          const entries = lines.get(line) ?? [];
          const same = entries.some(entry => entry[3] === referenceKind && entry[4] === detail && entry[5] === referenceCaller &&
            (entry[6] ?? entry[5]) === (referenceOwner ?? referenceCaller));
          if (same || (kind === 'use' && entries.some(entry => entry[3] === 'call'))) continue;
          const entry: Reference = [id, relative, line, referenceKind];
          if (detail !== undefined || referenceCaller !== undefined) entry[4] = detail;
          if (referenceCaller !== undefined) entry[5] = referenceCaller;
          if (referenceOwner !== undefined && referenceOwner !== referenceCaller) entry[6] = referenceOwner;
          // A call on the same line already records the resolved use for rename.
          lines.set(line, kind === 'call' ? [...entries.filter(entry => entry[3] !== 'use' && entry[3] !== 'jsx-use'), entry] :
            [...entries, entry]);
          references.set(id, lines);
        }
        return found;
      };
      const recordCall = (node: Node, expression: Node, owner: number, found: boolean) => {
        const binding = receiver(expression);
        if (!binding) return;
        const { root, members } = binding;
        const imported = packageBindings.get(root.getText());
        const declaration = imported || !found ? root.getSymbol()?.getDeclarations()[0] : undefined;
        if (imported && declaration === imported.binding) {
          const name = [imported.name, ...members].slice(0, 2).join('.');
          const calls = externalCalls.get(owner) ?? new Map();
          const key = imported.module + '\0' + name;
          const previous = calls.get(key);
          if (previous) previous[4] = (previous[4] ?? 1) + 1;
          else {
            let module = externalModules.get(imported.module);
            if (module === undefined) {
              module = index.externalModules!.push(imported.module) - 1;
              externalModules.set(imported.module, module);
            }
            calls.set(key, [owner, node.getStartLineNumber(), module, graphName(name)]);
          }
          externalCalls.set(owner, calls);
          return;
        }
        if (found) return;
        const targets = members.length ? declarationsOf(root).flatMap(target => byNode.get(target) ?? []) : [];
        for (const id of targets) recordGraph(id, node.getStartLineNumber(), GraphReferenceKind.MemberCall, owner, graphName('.' + members.join('.')));
        if (!targets.length && declaration?.getSourceFile() === file &&
            (Node.isParameterDeclaration(declaration) || Node.isVariableDeclaration(declaration) || Node.isBindingElement(declaration))) {
          index.unresolvedCalls![owner] = (index.unresolvedCalls![owner] ?? 0) + 1;
        }
      };
      const recordDynamic = (node: Node, specifier: Node | undefined, owner?: number) => {
        if (!Node.isStringLiteral(specifier)) return;
        const name = dynamicExport(node);
        if (!name) return;
        const resolved = declarationsOf(specifier).find(Node.isSourceFile) ?? fileByName.get(ts.resolveModuleName(
          specifier.getLiteralText(), file.getFilePath(), file.getProject().getCompilerOptions(), ts.sys
        ).resolvedModule?.resolvedFileName ?? '');
        const targets = resolved && exports.get(resolved)?.get(name);
        if (!targets?.length) return;
        const variable = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        const id = targets.map(target => byNode.get(target)).find(value => value !== undefined);
        if (id !== undefined && variable && byNode.has(variable)) {
          const initializer = variable.getInitializer();
          const wrapper = Node.isCallExpression(initializer) && receiver(initializer.getExpression());
          const imported = wrapper && packageBindings.get(wrapper.root.getText());
          if (imported && (imported.module === 'next/dynamic' || imported.module === 'react' &&
            (imported.name === 'lazy' || wrapper.members[0] === 'lazy')) &&
            wrapper.root.getSymbol()?.getDeclarations().includes(imported.binding)) {
            dynamicBindings.set(variable, id);
            owner = byNode.get(variable);
          }
        }
        for (const target of targets) {
          const id = byNode.get(target);
          if (id !== undefined) recordGraph(id, node.getStartLineNumber(), GraphReferenceKind.DynamicImport, owner);
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
        } else if (Node.isCallExpression(node) || Node.isNewExpression(node) || Node.isTaggedTemplateExpression(node)) {
          const expression = Node.isTaggedTemplateExpression(node) ? node.getTag() : node.getExpression();
          const [owner, graphOwner] = owners(node);
          if (Node.isCallExpression(node) && expression.getKind() === SyntaxKind.ImportKeyword) {
            recordDynamic(node, node.getArguments()[0], graphOwner);
          }
          const found = Node.isCallExpression(node) && !!record(node, declarationsOf(expression), 'call', undefined, owner, graphOwner);
          if (graphOwner !== undefined) recordCall(node, expression, graphOwner, found);
          if (!Node.isCallExpression(node)) return;
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
        } else if ((Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) &&
          (Node.isIdentifier(node.getTagNameNode()) || Node.isPropertyAccessExpression(node.getTagNameNode()))) {
          renderSites.push({ node, owner: owners(node)[1], line: node.getStartLineNumber(), file: relative });
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
      // Same-file uses need only a line number and do not affect cross-file search ranking.
      for (const [id, lines] of references) {
        const symbol = index.symbols[id - 1];
        const sameFile = symbol.file === relative;
        for (const [line, entries] of lines) {
          if (sameFile && entries.some(entry => entry[3] === 'use')) (symbol.localUses ??= []).push(line);
          for (const entry of entries) {
            if (!sameFile) index.references.push(entry);
            else if (entry[3] !== 'use') {
              const [, , ...site] = entry;
              index.references.push([id, null, ...site]);
            }
          }
        }
      }
      const graphEntries = [...graphReferences.values()].filter(([id, line, kind, owner]) =>
        kind !== GraphReferenceKind.Use || !references.get(id)?.get(line)?.some(reference =>
          reference[3] === 'call' && (reference[6] ?? reference[5]) === owner));
      if (graphEntries.length) index.graphReferences![fileId] = graphEntries;
      for (const calls of externalCalls.values()) index.externalCalls!.push(...calls.values());
      // Keep the first ten diagnostic comment matches in each test category.
      // The tool can only show ten exclusions and can filter out tests.
      const test = isTestFile(relative);
      for (const [name, lines] of noteLines) {
        const notes = index.mentions![name] ??= [];
        const remaining = 10 - notes.filter(([file]) => isTestFile(file) === test).length;
        for (const line of [...lines].sort((a, b) => a - b).slice(0, remaining)) notes.push([relative, line]);
      }
    }
    if (dynamicBindings.size) for (const site of renderSites) {
      if (!Node.isJsxOpeningElement(site.node) && !Node.isJsxSelfClosingElement(site.node)) continue;
      const declarations = declarationsOf(site.node.getTagNameNode());
      const binding = declarations.find(node => dynamicBindings.has(node));
      if (binding) {
        const owner = site.owner;
        const body = owner === undefined ? undefined : site.node.getAncestors().find(node => byNode.get(node) === owner);
        const conditional = conditionalAt(site.node, body);
        const refs = index.graphReferences![byGraphId.get(`file:${site.file}`)!] ??= [];
        refs.push([dynamicBindings.get(binding)!, site.line, GraphReferenceKind.Render, owner, conditional]);
      }
    }
    return index;
  }
}
