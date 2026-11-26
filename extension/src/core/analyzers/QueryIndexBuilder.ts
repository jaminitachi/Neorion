import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Node, SourceFile, SyntaxKind, ts } from 'ts-morph';
import type { ComponentNode, RouteNode } from '../types/GraphTypes';
import {
  GRAPH_INDEX_REVISION, INDEX_SCHEMA, QUERY_INDEX_REVISION, GraphReferenceKind, WRAPPER_INDEX_REVISION, VERSION,
  isMiddlewareFile, isTestFile, renderSiteKey, type ExternalCall, type FetchEntry, type FlowGate, type GraphReference,
  type ModuleImport, type NamespaceUse, type PageRenderCondition, type QueryIndex, type Reference, type ServerAction, type Wrapper
} from '../../mcp/Index';
import { conditionalAt, declarationsOf, isPackageSpecifier, wrappedExpression } from './ArchitectureFacts';
import { middlewareMatcher } from './ChangeSource';
import { visitKinds } from './CompilerWalk';
import { inspectRuntimeExports } from './RuntimeExports';
import { endLine, lineAt, startLine } from './SourceLines';
import { CallableFlow, callbackRefWrites, FunctionNode, isFunction, jsxLabel, jsxRefContainer, refBinding, sectionLabels, useRefBinding } from './CallableFlow';
import { constValue, JsxSite, jsxValue, PropFlow, PropGate, RenderSite } from './PropFlow';
import { collectPagesFacts, type PagesDependency } from './PagesFacts';
import type { NextConfig } from './NextConfig';
import type { WorkspaceBindings } from './WorkspaceBindings';
import { TrpcFacts } from './TrpcFacts';

type RelativePath = (source: SourceFile) => string;
type PendingFetch = Omit<FetchEntry, 'route' | 'fn' | 'owner' | 'binding' | 'gates'> & {
  route: string; node: Node; prop?: { site: RenderSite; value: Node; name: string }; propGates?: PropGate[];
};

const REFERENCE_KINDS = new Set([
  SyntaxKind.ImportSpecifier, SyntaxKind.ImportClause, SyntaxKind.BindingElement, SyntaxKind.ExportDeclaration,
  SyntaxKind.ExportSpecifier, SyntaxKind.CallExpression, SyntaxKind.NewExpression, SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.JsxOpeningElement, SyntaxKind.JsxSelfClosingElement, SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.ElementAccessExpression, SyntaxKind.Identifier
]);
const FLOW_KINDS = new Set([SyntaxKind.JsxAttribute, SyntaxKind.CallExpression]);
const MOCK_KEY_KINDS = new Set([SyntaxKind.PropertyAssignment, SyntaxKind.ShorthandPropertyAssignment, SyntaxKind.MethodDeclaration]);

function stylesheetPaths(source: SourceFile, root: string, specifier: string) {
  if (specifier.startsWith('.')) return [path.resolve(path.dirname(source.getFilePath()), specifier)];
  const options = source.getProject().getCompilerOptions();
  const matches = Object.entries(options.paths ?? {}).flatMap(([pattern, targets]) => {
    const star = pattern.indexOf('*');
    if (star === -1) return pattern === specifier ? [{ targets, wildcard: '', rank: Infinity }] : [];
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      return [{ targets, wildcard: specifier.slice(prefix.length, specifier.length - suffix.length), rank: prefix.length }];
    }
    return [];
  }).sort((a, b) => b.rank - a.rank);
  const match = matches[0];
  return match ? match.targets.map(target => path.resolve(root, options.baseUrl ?? '.', target.replace('*', match.wildcard))) : [];
}

function wrappedFunction(node: Node | undefined, remaining = 2): boolean {
  if (remaining <= 0 || !Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  if (Node.isPropertyAccessExpression(callee) && ['map', 'filter', 'reduce', 'forEach'].includes(callee.getName())) return false;
  return node.getArguments().some(argument =>
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
  if (!Node.isPropertyAccessExpression(parent) || parent.getName() !== 'then') return { name: 'default' };
  const call = parent.getParent();
  const callback = Node.isCallExpression(call) ? call.getArguments()[0] : undefined;
  if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return;
  const body = callback.getBody();
  const statements = Node.isBlock(body) ? body.getStatements() : [];
  const result = Node.isBlock(body)
    ? statements.length === 1 && Node.isReturnStatement(statements[0]) ? statements[0].getExpression() : undefined
    : body;
  if (Node.isPropertyAccessExpression(result) &&
      result.getExpression().getText() === callback.getParameters()[0]?.getName()) {
    return { name: result.getName(), selector: result.getNameNode() };
  }
}

export class QueryIndexBuilder {
  private edges: [string, string, number, number, true?, true?, string?, RenderSite?, string?][] = [];
  private renderSites = new Map<Node, typeof this.edges>();
  private renderPairs = new Map<string, typeof this.edges>();
  private pageConditions = new Map<string, Map<typeof this.edges[number], PageRenderCondition>>();
  private propRequests: { file: string; node: Node; method?: string; gates: PropGate[] }[] = [];
  private pages = new Map<string, { layouts: string[]; chains: Wrapper[][] }>();
  private shells = new Map<string, Node | undefined>();
  private wrapperProblems = new Map<string, string[]>();
  private wrapperDependencies: PagesDependency[] = [];

  shell(file: string, body?: Node) {
    this.shells.set(file, body);
  }

  wrapperIssues(route: string, reasons: string[]) {
    this.wrapperProblems.set(route, reasons);
  }

  wrapperDependency(route: string, target: Node, site: Node, detail: string) {
    this.wrapperDependencies.push({ route, target, site, detail, kind: 'wrap' });
  }

  private fetches: PendingFetch[] = [];
  private uncertainChatTransports: { file: string; node: Node; unbounded: boolean; override: boolean }[] = [];
  private actions = new Map<string, ServerAction>();
  private actionUses: { caller: ServerAction['callers'][number]; node: Node }[] = [];

  render(from: string, to: string, line: number, conditional: number, layout?: true, possible?: true, tag?: Node, detail?: string, site?: RenderSite, file?: string) {
    const edge: typeof this.edges[number] = possible ? [from, to, line, conditional, layout, possible] :
      layout ? [from, to, line, conditional, layout] : [from, to, line, conditional];
    if (detail) edge[6] = detail;
    if (site) edge[7] = site;
    if (file) edge[8] = file;
    this.edges.push(edge);
    if (tag) {
      const entries = this.renderSites.get(tag) ?? [];
      entries.push(edge);
      this.renderSites.set(tag, entries);
      const key = from + '\0' + to;
      const pair = this.renderPairs.get(key) ?? [];
      pair.push(edge);
      this.renderPairs.set(key, pair);
    }
  }

  pageRenderCondition(route: string, tag: Node, decision: PageRenderCondition) {
    for (const edge of this.renderSites.get(tag) ?? []) {
      const conditions = this.pageConditions.get(route) ?? new Map();
      conditions.set(edge, decision);
      this.pageConditions.set(route, conditions);
    }
  }

  pageRenderExcluded(route: string, from: string, to: string) {
    const conditions = this.pageConditions.get(route);
    const pair = conditions && this.renderPairs.get(from + '\0' + to);
    return !!pair?.length && pair.every(edge => conditions?.get(edge) === 'excluded');
  }

  uncertainPropRequest(file: string, node: Node, method: string | undefined, gates: PropGate[]) {
    this.propRequests.push({ file, node, method, gates });
  }

  page(route: string, layouts: (string | undefined)[], chains: Wrapper[][]) {
    this.pages.set(route, { layouts: layouts.filter((id): id is string => !!id), chains });
  }

  fetch(entry: PendingFetch) {
    this.fetches.push(entry);
  }

  uncertainChatTransport(file: string, node: Node, unbounded: boolean, override: boolean) {
    this.uncertainChatTransports.push({ file, node, unbounded, override });
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
    aliases: Map<Node, Node[]>, relativePath: RelativePath, actions: Map<Node, string>, root: string, config: NextConfig | undefined, workspace: WorkspaceBindings | undefined, flow: PropFlow, historyOnly = false): QueryIndex {
    const pages = config && collectPagesFacts(files, routes, config, relativePath, workspace, this.shells);
    const index: QueryIndex = {
      schema: INDEX_SCHEMA, coverage: 2, generator: VERSION, generatedAt: new Date().toISOString(), root: '.',
      wrapperRevision: WRAPPER_INDEX_REVISION, queryRevision: QUERY_INDEX_REVISION,
      files: Object.create(null), symbols: [], routes: [], renderEdges: [], wrapChains: Object.create(null),
      routeWrap: {}, branches: {}, references: [], fetches: [], serverActions: [...this.actions.values()], mentions: Object.create(null),
      graphRevision: GRAPH_INDEX_REVISION, graphReferences: {}, graphNames: [], externalCalls: [], externalModules: [],
      unresolvedCalls: {}, fileSymbols: [],
      defaultSymbols: Object.create(null), exportSymbols: {}, runtimeExports: {}, moduleImports: {},
      routeFiles: Object.create(null), layoutStyles: Object.create(null), trpcFiles: []
    };
    const byNode = new Map<Node, number>();
    const byGraphId = new Map<string, number>();
    const exports = new Map(files.map(file => [file, file.getExportedDeclarations()]));
    const exported = new Set<Node>([...exports.values()].flatMap(entries => [...entries.values()].flat()));
    const fileByName = new Map<string, SourceFile>(files.map(file => [file.getFilePath(), file]));
    const names = new Set<string>();
    const wrappedOwners = new Set<number>();
    const add = (node: Node, name: string, kind: QueryIndex['symbols'][number]['kind'], aliasOf: string | null) => {
      if (byNode.has(node) && kind !== 'procedure') return byNode.get(node)!;
      const id = index.symbols.length + 1;
      const file = relativePath(node.getSourceFile());
      const line = startLine(node);
      const end = endLine(node);
      index.symbols.push({ id, file, name, kind, line, end: end > line ? end : undefined, exported: exported.has(node) || undefined,
        aliasOf: aliasOf ?? undefined, typeOnly: Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node) || undefined });
      if (!byNode.has(node)) byNode.set(node, id);
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
      if (historyOnly) index.files[relative] = { size: 0, mtimeMs: 0, sha1: '' };
      else {
        const { size, mtimeMs } = statSync(file.getFilePath());
        index.files[relative] = { size, mtimeMs, sha1: createHash('sha1').update(readFileSync(file.getFilePath())).digest('hex') };
      }
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
      if (isMiddlewareFile(relative)) {
        const matcher = middlewareMatcher(file.compilerNode);
        index.routeFiles![relative] = ['middleware', '/', matcher?.label, undefined, matcher?.values];
      } else if (this.shells.has(relative)) {
        index.routeFiles![relative] = ['app-shell', '/'];
      }
    }
    for (const [node, targets] of aliases) {
      const id = targets.map(target => byNode.get(target)).find(value => value !== undefined);
      if (id !== undefined) byNode.set(node, id);
    }
    if (pages) for (const [node, name] of pages.lifecycleNames) {
      const id = byNode.get(node) ?? add(node, name, 'function', null);
      index.symbols[id - 1].kind = 'function';
    }
    for (const [file, body] of this.shells) {
      const parent = body?.getParent();
      if (!parent) continue;
      const declaration = parent.getParentIfKind(SyntaxKind.VariableDeclaration) ?? parent;
      const id = byNode.get(declaration);
      if (id !== undefined) index.routeFiles![file][3] = id;
    }
    const hasValueBinding = (entry: ReturnType<SourceFile['getImportDeclarations']>[number]) => !entry.isTypeOnly() &&
      (!!entry.getDefaultImport() || !!entry.getNamespaceImport() || entry.getNamedImports().some(binding => !binding.isTypeOnly()));
    const trpcSources = new Set(files.filter(file => file.getImportDeclarations().some(entry =>
      /^@trpc\/server(?:\/|$)/.test(entry.getModuleSpecifierValue()) && hasValueBinding(entry))));
    const trpcFacts = new TrpcFacts(files, trpcSources);
    const procedureIds = new Map<ReturnType<TrpcFacts['procedures']>[number], number>();
    const procedureSymbols = new Map<Node, Map<string, number>>();
    const procedureResolvers = new Map<Node, Node>();
    const unboundProcedures = new Set<number>();
    const boundProcedures = new Set<number>();
    const recordTrpcIssue = (id: number, file: number, line: number) => {
      const sites = (index.trpcIssues ??= {})[id] ??= [];
      if (!sites.some(site => site[0] === file && site[1] === line)) sites.push([file, line]);
    };
    for (const procedure of trpcFacts.procedures()) {
      const known = procedureSymbols.get(procedure.property) ?? new Map<string, number>();
      procedureSymbols.set(procedure.property, known);
      const id = known.get(procedure.name) ?? add(procedure.property, procedure.name, 'procedure', null);
      known.set(procedure.name, id);
      procedureIds.set(procedure, id);
      const bodyOwner = byNode.get(procedure.body);
      if (bodyOwner === undefined) {
        byNode.set(procedure.body, id);
        procedureResolvers.set(procedure.body, procedure.resolver);
      } else if (bodyOwner !== id) {
        const aliases = (index.trpcAliases ??= {})[bodyOwner] ??= [];
        if (!aliases.includes(id)) aliases.push(id);
      }
      if (procedure.unresolved) {
        const source = relativePath(procedure.unresolved.getSourceFile());
        recordTrpcIssue(id, byGraphId.get(`file:${source}`)!, startLine(procedure.unresolved));
      }
      if (procedure.clientsKnown) boundProcedures.add(id);
      else unboundProcedures.add(id);
    }

    const siteKeys = new WeakMap<RenderSite, string>();
    const siteKey = (site: RenderSite) => {
      let key = siteKeys.get(site);
      if (!key) siteKeys.set(site, key = `${relativePath(site.getSourceFile())}:${site.getStart()}`);
      return key;
    };
    const indexedGates = new WeakMap<PropGate, FlowGate>();
    const gatesOf = (gates: PropGate[]): FlowGate[] => gates.flatMap(gate => {
      const previous = indexedGates.get(gate);
      if (previous) return [previous];
      const { component, sites, partial, uncertainSites, unscoped } = gate;
      const scope = byNode.get(component);
      if (scope === undefined) return [];
      const entry = { scope, sites: sites.map(siteKey), partial: partial || undefined,
        uncertainSites: uncertainSites?.map(siteKey), unscoped };
      indexedGates.set(gate, entry);
      return [entry];
    });

    const projectFiles = new Set(files);
    const declarations = new WeakMap<Node, Node[]>();
    const flowDeclarations = (node: Node) => {
      let entries = declarations.get(node);
      if (!entries) declarations.set(node, entries = declarationsOf(node));
      return entries;
    };
    const callableFlow = new CallableFlow(projectFiles, flowDeclarations);
    const callableId = (fn: FunctionNode, event?: string) => {
      let returned: Node = fn;
      let parent: Node | undefined = fn.getParent();
      while (parent && (wrappedExpression(parent) === returned || isFunction(parent) && parent.getBody() === returned)) {
        returned = parent;
        parent = parent.getParent();
      }
      const declaration = Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent) ? parent : undefined;
      const returnedCallback = isFunction(returned) && returned !== fn;
      const binding = returnedCallback ? fn : declaration ?? fn;
      const known = byNode.get(fn) ?? byNode.get(binding);
      if (known !== undefined) return known;
      // Top-level declarations already passed through the ordinary symbol index.
      // Keep its exclusions when the same value is referenced indirectly.
      if (!returnedCallback && (Node.isSourceFile(parent) ||
          Node.isVariableDeclaration(declaration) && Node.isSourceFile(declaration.getVariableStatement()?.getParent()))) return;
      const factoryName = declaration?.getName();
      const attribute = Node.isJsxExpression(parent) && parent.getParent();
      const declaredName = Node.isArrowFunction(fn) ? undefined : fn.getName();
      const name = declaredName ??
        (returnedCallback && factoryName ? factoryName + ' (returned callback)' : factoryName) ?? event ??
        (attribute && Node.isJsxAttribute(attribute) ? attribute.getNameNode().getText() : undefined);
      if (!name) return;
      const id = add(binding, name, 'function', null);
      if (returnedCallback || !factoryName && !declaredName) index.symbols[id - 1].synthetic = true;
      byNode.set(fn, id);
      return id;
    };
    const eventSites: { site: JsxSite; attribute: import('ts-morph').JsxAttribute; target: number; detail: string; gates?: PropGate[] }[] = [];
    const refWrites = new Map<Node, { site: JsxSite; assignment: Node; key?: string; direct?: boolean }[]>();
    const indirectCalls = new Map<Node, { id: number; via: string[]; gates?: PropGate[] }[]>();
    const dynamicCallSites = new Set<Node>();
    const callableTargets = (expression: Node) => {
      const prop = flow.read(expression);
      if (!prop) return callableFlow.resolve(expression).map(target => ({ ...target, gates: undefined, supplied: undefined }));
      const bindings = flow.bindings(prop);
      return bindings.flatMap(({ value, gates }) => value ? callableFlow.resolve(value).map(target =>
        ({ ...target, gates, supplied: value })) : []);
    };
    const suppliedCallbacks = new Set<Node>();
    for (const file of files) {
      visitKinds(file, FLOW_KINDS, node => {
        if (Node.isJsxAttribute(node)) {
          const site = node.getParent()?.getParent();
          if (!Node.isJsxOpeningElement(site) && !Node.isJsxSelfClosingElement(site)) return;
          const name = node.getNameNode().getText();
          const value = jsxValue(node);
          if (!value) return;
          if (name === 'ref') {
            const direct = Node.isIdentifier(value) && useRefBinding(value);
            if (direct) {
              const sites = refWrites.get(direct) ?? [];
              sites.push({ site, assignment: node, direct: true });
              refWrites.set(direct, sites);
            }
            const functions = isFunction(value) ? [value] : callableFlow.resolve(value).map(target => target.fn);
            for (const fn of functions) for (const write of callbackRefWrites(fn)) {
              const sites = refWrites.get(write.binding) ?? [];
              sites.push({ site, assignment: write.assignment, key: write.key });
              refWrites.set(write.binding, sites);
            }
            return;
          }
          if (!/^on[A-Z]/.test(name) || !flow.forwardsEvent(site, name)) return;
          const targets = callableTargets(value);
          if (!targets.length) {
            if (flow.read(value)) dynamicCallSites.add(node);
            return;
          }
          const label = jsxLabel(site);
          const event = isFunction(value) ? name + ' ' + label : undefined;
          for (const { fn, via, gates, supplied } of targets) {
            const target = callableId(fn, event);
            if (supplied) suppliedCallbacks.add(supplied);
            if (target !== undefined) eventSites.push({
              site, attribute: node, target, detail: `${name} <${label}>${via.length ? ' via ' + via.join(' > ') : ''}`, gates
            });
          }
          return;
        }
        if (!Node.isCallExpression(node)) return;
        const expression = node.getExpression();
        // Existing references cover ordinary declarations. Resolve value flow for
        // lexical bindings, property reads, and calls whose target is returned.
        if (!Node.isIdentifier(expression) && !Node.isPropertyAccessExpression(expression) &&
            !Node.isElementAccessExpression(expression) && !Node.isCallExpression(expression)) return;
        let binding: Node = expression;
        while (Node.isPropertyAccessExpression(binding) || Node.isElementAccessExpression(binding) || Node.isCallExpression(binding)) {
          binding = binding.getExpression();
        }
        if (!Node.isIdentifier(binding)) return;
        const bindings = flowDeclarations(binding);
        if (!bindings.some(decl => projectFiles.has(decl.getSourceFile()) &&
            (Node.isBindingElement(decl) || Node.isParameterDeclaration(decl) || constValue(decl) || isFunction(decl)))) return;
        if (expression === binding && bindings.some(decl => byNode.has(decl) && !Node.isBindingElement(decl))) return;
        const targets = callableTargets(expression);
        if (targets.length && expression !== binding && flowDeclarations(expression)
          .some(decl => byNode.has(decl) && !Node.isBindingElement(decl))) return;
        const resolved = targets.flatMap(({ fn, via, gates, supplied }) => {
          if (supplied) suppliedCallbacks.add(supplied);
          const id = callableId(fn);
          return id === undefined ? [] : [{ id, via, gates }];
        });
        if (resolved.length) indirectCalls.set(node, resolved);
        else if (flow.read(expression)) dynamicCallSites.add(node);
      });
    }

    type Owners = [legacy?: number, graph?: number, possible?: boolean];
    const graphOwners = new Map([...byNode].filter(([, id]) => index.symbols[id - 1].kind !== 'constant')
      .map(([node, id]) => [node.compilerNode, id]));
    const ownerCache = new WeakMap<ts.Node, Owners>();
    const noOwner: Owners = [];
    const ownerAt = (node: ts.Node | undefined): Owners => {
      if (!node) return noOwner;
      const previous = ownerCache.get(node);
      if (previous) return previous;
      const id = graphOwners.get(node);
      let result: Owners;
      if (id === undefined) result = ownerAt(node.parent);
      else if (wrappedOwners.has(id)) result = [ownerAt(node.parent)[0], id];
      else result = [id, id];
      ownerCache.set(node, result);
      return result;
    };
    const owners = (node: Node): Owners => {
      if (!pages) return ownerAt(node.compilerNode.parent);
      let graph: number | undefined;
      for (const parent of [node, ...node.getAncestors()]) {
        const lifecycle = pages?.owners.get(parent);
        const entry = lifecycle?.declaration && byNode.get(lifecycle.declaration);
        if (entry !== undefined && entry !== null) return [entry, entry, lifecycle?.possible];
        if (parent === node) continue;
        const id = byNode.get(parent);
        if (id === undefined || index.symbols[id - 1].kind === 'constant') continue;
        graph ??= id;
        if (!wrappedOwners.has(id)) return [id, graph];
      }
      return [undefined, graph];
    };
    const fileIdOf = (node: Node) => byGraphId.get(`file:${relativePath(node.getSourceFile())}`)!;
    const setFlowIssue = (node: Node, reason: string) => {
      const id = owners(node)[1] ?? fileIdOf(node);
      ((index.flowIssues ??= {})[id] ??= []).push({
        reason: `${reason} (${relativePath(node.getSourceFile())}:${startLine(node)})`, gates: gatesOf(flow.gates(node))
      });
    };
    for (const site of dynamicCallSites) setFlowIssue(site, 'prop callback untraced');
    const gateKey = (from: number, to: number, line: number) => `${from}:${to}:${line}`;
    const addFlowCall = (from: number, to: number, node: Node, detail: string, gates: PropGate[] = []) => {
      const line = startLine(node);
      const applicable = gatesOf([...flow.gates(node), ...gates]);
      (index.flowCalls ??= []).push([from, to, relativePath(node.getSourceFile()), line, detail,
        applicable.length ? applicable : undefined]);
    };
    const eventReferences = suppliedCallbacks;
    const actionBySymbol = new Map([...actionSymbols].map(([id, symbol]) => [symbol, this.actions.get(id)]));
    const suppliedActionSites = new Set(this.actionUses.filter(({ node }) => suppliedCallbacks.has(node)).map(({ caller }) => caller));
    for (const event of eventSites) {
      const value = Node.isJsxAttribute(event.attribute) && jsxValue(event.attribute);
      if (value && !isFunction(value)) eventReferences.add(value);
      addFlowCall(owners(event.site)[1] ?? fileIdOf(event.site), event.target, event.attribute, event.detail, event.gates);
    }
    for (const [call, targets] of indirectCalls) {
      if (!Node.isCallExpression(call)) continue;
      const from = owners(call)[1] ?? fileIdOf(call);
      let issue: string | undefined;
      const refs = call.getArguments().flatMap(argument => {
        const binding = refBinding(argument);
        if (!binding) return [];
        const writes = refWrites.get(binding);
        if (!writes?.length) {
          issue ??= `ref source untraced (${relativePath(call.getSourceFile())}:${startLine(call)})`;
          return [];
        }
        return writes.map(({ site, assignment, key, direct }) => {
          const container = jsxRefContainer(site);
          return `${argument.getText()} receives <${site.getTagNameNode().getText()}> via ${direct ? 'ref' : 'callback ref'} ${relativePath(site.getSourceFile())}:${startLine(assignment)}` +
            (key ? ` (key ${key})` : '') + (container ? ' ' + container : '');
        });
      });
      for (const { id, via, gates } of targets) {
        const detail = [via.length ? 'via ' + via.join(' > ') : '', ...refs].filter(Boolean).join(' | ');
        addFlowCall(from, id, call, detail, gates);
        if (issue) (index.callIssues ??= {})[gateKey(from, id, startLine(call))] = issue;
      }
    }
    for (const [from, to, file, line] of index.flowCalls ?? []) {
      actionBySymbol.get(to)?.callers.push([file, line, from]);
    }
    const mapArgument = (expression: Node, remaining = 6): string | undefined => {
      if (!remaining) return;
      const wrapped = wrappedExpression(expression);
      if (wrapped) return mapArgument(wrapped, remaining - 1);
      if (Node.isIdentifier(expression)) {
        const value = declarationsOf(expression).map(constValue).find(Boolean);
        return value && mapArgument(value, remaining - 1);
      }
      if (!Node.isCallExpression(expression)) return;
      const callee = expression.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'get') return;
      if (declarationsOf(callee.getExpression()).some(Node.isParameterDeclaration)) return expression.getText();
    };

    for (const { caller, node } of this.actionUses) {
      const owner = owners(node)[1];
      if (owner !== undefined) caller[2] = owner;
    }
    for (const action of this.actions.values()) {
      const seen = new Set<string>();
      action.callers = action.callers.filter(caller => {
        const key = JSON.stringify(caller);
        if (suppliedActionSites.has(caller) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    const filesByRelative = new Map(files.map(file => [relativePath(file), file]));
    const runtimeExports = inspectRuntimeExports(files);
    for (const [relative, file] of filesByRelative) {
      const fileId = byGraphId.get(`file:${relative}`)!;
      const runtime = runtimeExports.get(file)!;
      if (Object.keys(runtime.names).length || runtime.unknownStar) index.runtimeExports![fileId] = runtime;
      const entries = exports.get(file)!;
      if (!entries.size) continue;
      const ids = Object.fromEntries([...entries].map(([name, declarations]) =>
        [name, [...new Set(declarations.flatMap(node => byNode.get(node) ?? []))]]));
      index.exportSymbols![fileId] = ids;
      if (ids.default?.length) index.defaultSymbols![fileId] = ids.default[0];
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
      const site = entry ?? handler;
      index.routes.push({
        id, url: route.path, file: route.file, kind: route.type, line: symbol && symbol.file === route.file ? symbol.line : site ? startLine(site) : 1,
        component, fileSymbol: byGraphId.get(`file:${route.file}`),
        layouts: page?.layouts.flatMap(layout => byGraphId.get(layout) ?? []), methods: route.methods,
        handlers: Object.keys(handlers).length ? handlers : undefined,
        pages: route.pages, methodBasis: route.methodBasis, observedMethods: route.observedMethods
      });
      const chains = [...new Set(page?.chains.map(chain => {
        const annotations: [number, string][] = [];
        const shared = route.pages ? chain.map((wrapper, position) => {
          const { site, evidence, ...location } = wrapper;
          if (!site || !evidence) return wrapper;
          annotations.push([position, evidence]);
          return location;
        }) : chain;
        const key = createHash('sha1').update(JSON.stringify(shared)).digest('hex').slice(0, 12);
        index.wrapChains[key] = shared;
        if (annotations.length) ((index.pagesWrapSites ??= {})[id] ??= {})[key] = annotations;
        return key;
      }))];
      if (chains.length) index.routeWrap[id] = chains[0];
      if (chains.length > 1) index.branches![id] = chains;
    }
    if (pages && config) {
      const routeEntries = new Map(index.routes.map(route => [route.id, route]));
      const routeStart = (id: number | undefined) => id === undefined ? undefined : routeEntries.get(id)?.fileSymbol;
      const issues = (source: Map<string, Iterable<string>>) => Object.fromEntries([...source].flatMap(([route, reasons]) => {
        const id = routeIds.get(route);
        return id === undefined ? [] : [[id, [...reasons]]];
      }));
      index.pagesUrlConfig = config.url;
      index.pagesIssues = issues(pages.issues);
      index.pagesWrapperIssues = issues(this.wrapperProblems);
      if (this.pageConditions.size) {
        index.pagesRenderConditions = {};
        for (const [route, conditions] of this.pageConditions) {
          const id = routeIds.get(route);
          if (id === undefined) continue;
          const entries: Record<string, PageRenderCondition> = {};
          for (const [edge, decision] of conditions) {
            const [from, to, line] = edge;
            const source = byGraphId.get(from);
            const target = byGraphId.get(to);
            if (source === undefined || target === undefined) continue;
            const combined = this.renderPairs.get(from + '\0' + to)?.filter(other => other[2] === line)
              .map(other => conditions.get(other));
            if (combined?.includes(undefined)) continue;
            entries[renderSiteKey(source, target, line)] = combined?.includes('possible') ? 'possible' : decision;
          }
          index.pagesRenderConditions[id] = entries;
        }
      }
      index.pagesApiIssues = issues(pages.apiIssues);
      index.pagesOwnerIssues = {};
      for (const [node, reasons] of pages.ownerIssues) {
        const id = byNode.get(node) ?? owners(node)[1] ?? byGraphId.get(`file:${relativePath(node.getSourceFile())}`);
        if (id !== undefined) index.pagesOwnerIssues[id] = [...new Set([...index.pagesOwnerIssues[id] ?? [], ...reasons])];
      }
      index.pagesEdges = [];
      const seen = new Set<string>();
      for (const edge of [...pages.dependencies, ...this.wrapperDependencies]) {
        const file = relativePath(edge.site.getSourceFile());
        const route = edge.destination ? routeIds.get(edge.destination) : undefined;
        const from = edge.route ? routeStart(routeIds.get(edge.route)) : edge.owner ? byNode.get(edge.owner) :
          owners(edge.site)[1] ?? byGraphId.get(`file:${file}`);
        const to = edge.target ? byNode.get(edge.target) : undefined;
        if (from === undefined || to === undefined && route === undefined) continue;
        const row = { from, to, route, kind: edge.kind, file, line: startLine(edge.site), detail: edge.detail, possible: edge.possible, matcher: edge.matcher };
        const key = JSON.stringify(row);
        if (seen.has(key)) continue;
        seen.add(key);
        index.pagesEdges.push(row);
      }
    }
    for (const [from, to, line, conditional, layout, possible, detail, site, file] of this.edges) {
      const source = byGraphId.get(from);
      const target = byGraphId.get(to);
      if (source === undefined || target === undefined) continue;
      index.renderEdges.push(file ? [source, target, line, conditional, layout, possible, detail, site && siteKey(site), file] :
        site || detail ? [source, target, line, conditional, layout, possible, detail, site && siteKey(site)] :
        possible ? [source, target, line, conditional, layout, possible] : layout ?
          [source, target, line, conditional, layout] : [source, target, line, conditional]);
    }
    for (const { node, route, prop, propGates, ...entry } of this.fetches) {
      if (pages?.ignored.size && node.getAncestors().some(parent => pages.ignored.has(parent))) continue;
      const [owner, graphOwner, possible] = owners(node);
      const key = prop && siteKey(prop.site);
      const binding = prop && key ? {
        file: relativePath(prop.value.getSourceFile()), line: startLine(prop.value), name: prop.name,
        supplier: owners(prop.site)[1], site: key
      } : undefined;
      index.fetches.push({ ...entry, route: routeIds.get(route)!, owner, graphOwner: graphOwner === owner ? undefined : graphOwner,
        lifecyclePossible: possible ? true : undefined, fn: owner ? index.symbols[owner - 1].name : null, binding,
        gates: propGates?.length ? gatesOf([...flow.gates(node), ...propGates]) : undefined });
    }
    const suppliers = new Set(index.fetches.flatMap(fetch => fetch.binding?.supplier ?? []));
    for (const [, to, , , , , , site] of this.edges) {
      if (!site || Node.isCallExpression(site) || !suppliers.has(byGraphId.get(to)!)) continue;
      const label = sectionLabels(site);
      if (label) (index.renderLabels ??= {})[siteKey(site)] = label;
    }
    if (this.propRequests.length) index.uncertainPropRequests = this.propRequests.flatMap(({ file, node, method, gates }) => {
      if (pages?.ignored.size && node.getAncestors().some(parent => pages.ignored.has(parent))) return [];
      return [{ file, owner: owners(node)[1] ?? fileIdOf(node), method, gates: gatesOf([...flow.gates(node), ...gates]) }];
    });
    if (this.uncertainChatTransports.length) {
      index.uncertainChatTransports = this.uncertainChatTransports.map(({ file, node, unbounded, override }) => {
        const [owner, graphOwner] = owners(node);
        return [file, graphOwner ?? owner ?? byGraphId.get(`file:${file}`)!, unbounded, startLine(node), override];
      });
    }

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
      const content = historyOnly ? '' : file.getFullText();
      const comments = new Set<number>();
      const noteLines = new Map<string, Set<number>>();
      const references = new Map<number, Map<number, Reference[]>>();
      const dynamicSelectors = new Set<Node>();
      const imports = file.getImportDeclarations();
      const namespaces = new Map<string, { declaration: Node; uses: NamespaceUse[] }>();
      for (const entry of [...imports, ...file.getExportDeclarations()]) {
        const source = entry.getModuleSpecifierSourceFile();
        const target = source && byGraphId.get(`file:${relativePath(source)}`);
        if (target === undefined) continue;
        const edges = index.moduleImports![fileId] ??= [];
        const line = startLine(entry);
        if (entry.isTypeOnly()) {
          edges.push([target, line, 'type']);
          continue;
        }
        if (Node.isImportDeclaration(entry)) {
          if (!entry.getImportClause()) edges.push([target, line, 'effect']);
          else {
            const named = entry.getNamedImports();
            if (named.some(binding => binding.isTypeOnly())) edges.push([target, line, 'type']);
            const names = named.filter(binding => !binding.isTypeOnly())
              .map(({ compilerNode: binding }) => (binding.propertyName ?? binding.name).text);
            if (entry.getDefaultImport()) names.push('default');
            const namespace = entry.getNamespaceImport();
            const uses: NamespaceUse[] = [];
            if (namespace) {
              names.push('*');
              namespaces.set(namespace.getText(), { declaration: namespace.getParentOrThrow(), uses });
              edges.push([target, line, 'import', names.map(name => [name]), uses]);
            } else if (names.length) edges.push([target, line, 'import', names.map(name => [name])]);
            else if (!named.length) edges.push([target, line, 'effect']);
          }
        } else {
          const namespace = entry.getNamespaceExport();
          const named = entry.getNamedExports();
          if (named.some(binding => binding.isTypeOnly())) edges.push([target, line, 'type']);
          const bindings: ModuleImport[3] = entry.compilerNode.exportClause && !namespace ?
            named.filter(binding => !binding.isTypeOnly())
              .map(({ compilerNode: binding }) => [(binding.propertyName ?? binding.name).text, binding.name.text]) :
            [['*', namespace?.getName() ?? '*']];
          if (bindings.length) edges.push([target, line, 'export', bindings]);
          else if (!named.length) edges.push([target, line, 'effect']);
        }
      }
      const routeKind = index.routeFiles![relative]?.[0];
      if (routeKind === 'layout' || routeKind === 'template' || routeKind === 'app-shell') {
        for (const entry of imports) {
          const specifier = entry.getModuleSpecifierValue();
          if (!specifier.endsWith('.css') || entry.isTypeOnly()) continue;
          for (const absolute of stylesheetPaths(file, root, specifier)) {
            const style = path.relative(root, absolute).split(path.sep).join('/');
            if (!style || style.startsWith('../') || path.isAbsolute(style)) continue;
            const layouts = index.layoutStyles![style] ??= [];
            if (!layouts.includes(relative)) layouts.push(relative);
          }
        }
      }
      const trpc = trpcSources.has(file) || trpcSources.size > 0 && imports.some(entry =>
        trpcSources.has(entry.getModuleSpecifierSourceFile()!) && hasValueBinding(entry));
      if (trpc) index.trpcFiles!.push(relative);
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
      const trpcModuleUses = new Map<string, [number, number]>();
      const trpcUseKeys = new Set<string>();
      const recordTrpcUse = (use: NonNullable<ReturnType<TrpcFacts['uses']>>[number], owner?: number) => {
        const line = startLine(use.site);
        const operation = use.cache ? 'cache:' + use.operation : use.operation;
        for (const procedure of use.targets) {
          const id = procedureIds.get(procedure);
          if (id === undefined) continue;
          const key = JSON.stringify([id, line, operation, owner]);
          if (trpcUseKeys.has(key)) continue;
          trpcUseKeys.add(key);
          ((index.trpcUses ??= {})[fileId] ??= []).push([id, line, operation, owner]);
          if (!use.cache && !isTestFile(relative)) boundProcedures.add(id);
        }
        if (!use.unresolved) return;
        const ids = new Set([owner ?? fileId, ...use.unresolved.flatMap(path => procedureIds.get(path) ?? [])]);
        for (const id of ids) recordTrpcIssue(id, fileId, line);
      };
      const recordGraph = (id: number, line: number, kind: GraphReferenceKind, owner?: number, detail?: number) => {
        const key = JSON.stringify([id, line, kind, owner, detail]);
        if (graphReferences.has(key)) return;
        const ref: GraphReference = [id, line, kind];
        if (owner !== undefined || detail !== undefined) ref[3] = owner;
        if (detail !== undefined) ref[4] = detail;
        graphReferences.set(key, ref);
      };
      const record = (node: Node, declarations: Node[], kind: string, detail?: string, caller?: number, graphOwner?: number, possible?: true) => {
        const line = startLine(node);
        let found = false;
        for (const declaration of declarations) {
          const id = byNode.get(declaration);
          if (!id) continue;
          found = true;
          if (kind === 'call') {
            const from = graphOwner ?? caller ?? fileId;
            const gates = gatesOf(flow.gates(node));
            if (gates.length) (index.callGates ??= {})[gateKey(from, id, line)] = gates;
            if (Node.isCallExpression(node) && refWrites.size) {
              const args = node.getArguments().flatMap(argument => mapArgument(argument) ?? []);
              if (args.length) (index.refEvidence ??= {})[gateKey(from, id, line)] = 'argument ' + args.join(', ');
            }
          }
          let referenceKind = kind;
          let referenceCaller = caller;
          let referenceOwner = graphOwner;
          let moduleUse = kind === 'call' && (graphOwner ?? caller) === undefined;
          if (kind === 'use') {
            const symbol = index.symbols[id - 1];
            const sameFile = symbol.file === relative;
            const parent = node.getParent();
            const jsx = (Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent) || Node.isJsxClosingElement(parent)) &&
              parent.getTagNameNode() === node;
            const signature = Node.isFunctionDeclaration(parent) && parent.getNameNode() === node;
            referenceOwner = jsx ? undefined : owners(node)[1];
            const executable = eventReferences.has(node) || Node.isPropertyAccessExpression(parent) &&
              eventReferences.has(parent) || Node.isCallExpression(parent) && parent.getExpression() === node;
            if (executable) {
              referenceOwner = undefined;
              referenceKind = 'binding-use';
            }
            const callbackUse = pages?.callbackUses.has(node) ||
              !!pages?.ignored.size && node.getAncestors().some(ancestor => pages.ignored.has(ancestor));
            const typeUse = !jsx && node.getAncestors().some(Node.isTypeNode);
            if (sameFile && !callbackUse && !executable && !jsx && !signature && referenceOwner !== id &&
              (referenceOwner !== undefined || symbol.kind !== 'constant' || symbol.typeOnly)) {
              recordGraph(id, line, typeUse ? GraphReferenceKind.TypeUse : GraphReferenceKind.Use, referenceOwner);
            }
            moduleUse = !typeUse && !jsx && !signature && referenceOwner === undefined;
            referenceCaller = sameFile ? undefined : referenceOwner;
            if (sameFile) referenceOwner = undefined;
            else if (callbackUse) referenceKind = 'callback-argument';
            else if (jsx) referenceKind = 'jsx-use';
            if (typeUse && !sameFile && referenceKind === 'use') referenceKind = 'type-use';
          }
          // Type queries such as ReturnType<typeof createContext> are graph uses
          // but do not show that a dependency passed into a runtime router.
          if (trpc && moduleUse && !index.symbols[id - 1].typeOnly && !node.getAncestors().some(Node.isTypeNode)) {
            trpcModuleUses.set(`${id}:${line}`, [id, line]);
          }
          const lines = references.get(id) ?? new Map<number, Reference[]>();
          const entries = lines.get(line) ?? [];
          const same = entries.some(entry => entry[3] === referenceKind && entry[4] === detail && entry[5] === referenceCaller &&
            (entry[6] ?? entry[5]) === (referenceOwner ?? referenceCaller) && !!entry[7] === !!possible);
          if (same || (kind === 'use' && entries.some(entry => entry[3] === 'call'))) continue;
          const entry: Reference = [id, relative, line, referenceKind];
          if (detail !== undefined || referenceCaller !== undefined) entry[4] = detail;
          if (referenceCaller !== undefined) entry[5] = referenceCaller;
          if (referenceOwner !== undefined && referenceOwner !== referenceCaller) entry[6] = referenceOwner;
          if (possible) entry[7] = possible;
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
            calls.set(key, [owner, startLine(node), module, graphName(name)]);
          }
          externalCalls.set(owner, calls);
          return;
        }
        if (found) return;
        const targets = members.length ? declarationsOf(root).flatMap(target => byNode.get(target) ?? []) : [];
        for (const id of targets) recordGraph(id, startLine(node), GraphReferenceKind.MemberCall, owner, graphName('.' + members.join('.')));
        if (!targets.length && declaration?.getSourceFile() === file &&
            (Node.isParameterDeclaration(declaration) || Node.isVariableDeclaration(declaration) || Node.isBindingElement(declaration))) {
          index.unresolvedCalls![owner] = (index.unresolvedCalls![owner] ?? 0) + 1;
          if (pages && pages.lifecycleNames.size && index.symbols[owner - 1]?.name.match(/^(?:getServerSideProps|getStaticProps|getStaticPaths|getInitialProps)$/)) {
            const sites = ((index.pagesObservedCalls ??= {})[owner] ??= []);
            sites.push([relative, startLine(node), expression.getText()]);
            const reasons = (index.pagesOwnerIssues![owner] ??= []);
            if (!reasons.includes('lifecycle calls on locals/params unresolved')) reasons.push('lifecycle calls on locals/params unresolved');
          }
        }
      };
      const recordDynamic = (node: Node, specifier: Node | undefined, owner?: number) => {
        if (!Node.isStringLiteral(specifier)) return;
        const targetExport = dynamicExport(node);
        if (!targetExport) return;
        const { name, selector } = targetExport;
        const resolved = declarationsOf(specifier).find(Node.isSourceFile) ?? fileByName.get(ts.resolveModuleName(
          specifier.getLiteralText(), file.getFilePath(), file.getProject().getCompilerOptions(), ts.sys
        ).resolvedModule?.resolvedFileName ?? '');
        const targets = resolved && exports.get(resolved)?.get(name);
        if (!targets?.length) return;
        const moduleId = byGraphId.get(`file:${relativePath(resolved!)}`);
        if (moduleId !== undefined) (index.moduleImports![fileId] ??= []).push([moduleId, startLine(node), 'import', [[name]]]);
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
            // JSX sites already point to the imported component. Keep a
            // module-level import edge without inserting the local alias.
            if (owner === byNode.get(variable)) owner = undefined;
            if (selector) dynamicSelectors.add(selector);
          }
        }
        for (const target of targets) {
          const id = byNode.get(target);
          if (id !== undefined) recordGraph(id, startLine(node), GraphReferenceKind.DynamicImport, owner);
        }
      };
      const scanComment = (range: ts.CommentRange) => {
        if (comments.has(range.pos)) return;
        comments.add(range.pos);
        const line = lineAt(file, range.pos);
        for (const [offset, text] of content.slice(range.pos, range.end).split('\n').entries()) {
          for (const name of new Set(text.match(/[\w$]+/g))) {
            if (!names.has(name)) continue;
            const observed = noteLines.get(name) ?? new Set<number>();
            observed.add(line + offset);
            noteLines.set(name, observed);
          }
        }
      };
      const scanNodeComments = (node: ts.Node) => {
        for (const comment of ts.getLeadingCommentRanges(content, node.getFullStart()) ?? []) scanComment(comment);
        for (const comment of ts.getTrailingCommentRanges(content, node.end) ?? []) scanComment(comment);
      };
      const recordNamespaceUse = (node: Node) => {
        const namespace = namespaces.get(node.getText());
        let parent = node.getParent();
        if (!namespace || parent === namespace.declaration ||
            node.getAncestors().some(Node.isTypeNode)) return;
        const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : node.getSymbol();
        if (!symbol?.getDeclarations().includes(namespace.declaration)) return;
        let receiver = node;
        while (Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent) || Node.isAsExpression(parent)) {
          if (parent.getExpression() !== receiver) break;
          receiver = parent;
          parent = parent.getParent();
        }
        const line = startLine(node);
        const owner = owners(node)[1];
        const pattern = Node.isVariableDeclaration(parent) && parent.getInitializer() === receiver ? parent.getNameNode() : undefined;
        if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === receiver) {
          namespace.uses.push([line, parent.getName(), owner]);
        } else if (Node.isElementAccessExpression(parent) && parent.getExpression() === receiver) {
          const key = parent.getArgumentExpression();
          const member = Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key) ? key.getLiteralText() : undefined;
          namespace.uses.push([line, member, owner]);
        } else if (Node.isObjectBindingPattern(pattern)) {
          for (const binding of pattern.getElements()) {
            const key = binding.getPropertyNameNode() ?? binding.getNameNode();
            const member = binding.getDotDotDotToken() ? undefined : Node.isIdentifier(key) ? key.getText() :
              Node.isStringLiteral(key) ? key.getLiteralText() : undefined;
            namespace.uses.push([line, member, owner]);
          }
        } else namespace.uses.push([line, undefined, owner]);
      };
      // Keep REFERENCE_KINDS in sync with the node kinds handled below, including tRPC calls and resolver owners.
      visitKinds(file, REFERENCE_KINDS, node => {
        if (namespaces.size && Node.isIdentifier(node)) recordNamespaceUse(node);
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
            if (index.symbols[id - 1].kind !== 'constant') graphOwners.set(node.compilerNode, id);
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
          if (pages?.ignored.size && node.getAncestors().some(parent => pages.ignored.has(parent))) return;
          const expression = Node.isTaggedTemplateExpression(node) ? node.getTag() : node.getExpression();
          const [owner, graphOwner, possible] = owners(node);
          if (Node.isCallExpression(node) && expression.getKind() === SyntaxKind.ImportKeyword) {
            recordDynamic(node, node.getArguments()[0], graphOwner);
          }
          const trpcUses = trpcFacts.active && Node.isCallExpression(node) ? trpcFacts.uses(node) : undefined;
          if (trpcUses) {
            for (const use of trpcUses) recordTrpcUse(use, graphOwner);
            return;
          }
          const resolver = procedureResolvers.get(node);
          if (resolver && !Node.isArrowFunction(resolver) && !Node.isFunctionExpression(resolver)) {
            const procedure = byNode.get(node)!;
            if (!record(resolver, declarationsOf(resolver), 'call', undefined, procedure, procedure)) {
              for (const id of [procedure, ...index.trpcAliases?.[procedure] ?? []]) {
                recordTrpcIssue(id, fileId, startLine(resolver));
              }
            }
          }
          const found = Node.isCallExpression(node) && !!record(node, declarations.get(expression) ?? declarationsOf(expression),
            'call', undefined, owner, graphOwner, possible ? true : undefined);
          if (graphOwner !== undefined) recordCall(node, expression, graphOwner, found || indirectCalls.has(node));
          if (!Node.isCallExpression(node)) return;
          const [module, factory] = node.getArguments();
          const specifier = Node.isStringLiteral(module) ? module :
            Node.isCallExpression(module) && module.getExpression().getKind() === SyntaxKind.ImportKeyword
              ? module.getArguments()[0] : undefined;
          if (historyOnly || !/^(vi|jest)\.(mock|doMock)$/.test(expression.getText()) || !Node.isStringLiteral(specifier) || !factory) return;
          const moduleName = specifier.getLiteralText();
          const imported = file.getImportDeclarations().find(entry => entry.getModuleSpecifierValue() === moduleName);
          const resolved = imported?.getModuleSpecifierSourceFile() ?? fileByName.get(ts.resolveModuleName(
            moduleName, file.getFilePath(), file.getProject().getCompilerOptions(), ts.sys
          ).resolvedModule?.resolvedFileName ?? '');
          // Keep MOCK_KEY_KINDS in sync with the node kinds handled below.
          if (resolved) visitKinds(factory, MOCK_KEY_KINDS, key => {
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
          renderSites.push({ node, owner: owners(node)[1], line: startLine(node), file: relative });
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
          if (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isExportSpecifier(parent) ||
              dynamicSelectors.has(node)) return;
          record(node, declarationsOf(node).filter(declaration =>
            declaration.compilerNode !== parent?.compilerNode || !byNode.has(declaration)), 'use');
        }
      }, { visitRaw: historyOnly ? undefined : scanNodeComments });
      for (const comment of ts.getLeadingCommentRanges(content, 0) ?? []) scanComment(comment);
      // Same-file uses need only a line number and do not affect cross-file search ranking.
      for (const [id, lines] of references) {
        const symbol = index.symbols[id - 1];
        const sameFile = symbol.file === relative;
        for (const [line, entries] of lines) {
          if (!historyOnly && sameFile && entries.some(entry => entry[3] === 'use')) (symbol.localUses ??= []).push(line);
          for (const entry of entries) {
            if (historyOnly && entry[3] !== 'call' && entry[3] !== 'use' && entry[3] !== 'type-use') continue;
            if (!sameFile) index.references.push(entry);
            else if (entry[3] !== 'use') {
              const [, , ...site] = entry;
              index.references.push([id, null, ...site]);
            }
          }
        }
      }
      const graphEntries = [...graphReferences.values()].filter(([id, line, kind, owner]) =>
        kind !== GraphReferenceKind.Use && kind !== GraphReferenceKind.TypeUse || !references.get(id)?.get(line)?.some(reference =>
          reference[3] === 'call' && (reference[6] ?? reference[5]) === owner));
      if (graphEntries.length) index.graphReferences![fileId] = graphEntries;
      if (trpcModuleUses.size) (index.trpcModuleUses ??= {})[fileId] = [...trpcModuleUses.values()];
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
    const unbound = [...unboundProcedures].filter(id => !boundProcedures.has(id));
    if (unbound.length) index.trpcUnbound = unbound;
    const scopes = new Set([
      ...Object.values(index.callGates ?? {}).flat(),
      ...Object.values(index.flowIssues ?? {}).flatMap(issues => issues.flatMap(issue => issue.gates)),
      ...(index.flowCalls ?? []).flatMap(call => call[5] ?? []),
      ...index.fetches.flatMap(fetch => fetch.gates ?? []),
      ...(index.uncertainPropRequests ?? []).flatMap(request => request.gates ?? [])
    ].map(gate => gate.scope));
    for (const edge of index.renderEdges) {
      if (!scopes.has(edge[1]) && !suppliers.has(edge[1]) && edge[7]) {
        if (edge[8]) edge[7] = undefined;
        else edge.length = edge[6] ? 7 : edge[5] ? 6 : edge[4] ? 5 : 4;
      }
    }
    if (workspace) {
      const packages = files.flatMap(file => {
        const pkg = workspace.packageFor(file.getFilePath());
        return pkg ? [[relativePath(file), pkg.name] as const] : [];
      });
      if (packages.length) index.workspacePackages = Object.fromEntries(packages);
      const unresolved = files.flatMap(file => {
        const modules = workspace.unresolvedFor(file);
        return modules.length ? [[relativePath(file), modules] as const] : [];
      });
      if (unresolved.length) index.workspaceUnresolved = Object.fromEntries(unresolved);
      if (workspace.discoveryLimited) index.workspaceDiscoveryLimited = true;
    }
    return index;
  }
}
