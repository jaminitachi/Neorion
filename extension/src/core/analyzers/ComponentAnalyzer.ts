import type { NextConfig } from './NextConfig';
import type { WorkspaceBindings } from './WorkspaceBindings';
import { Node, SourceFile, SyntaxKind, ts } from 'ts-morph';
import * as path from 'path';
import type { ComponentEdge, ComponentNode, DetailFacts, HookNode, RouteNode } from '../types/GraphTypes';
import { RENDER_LOOKUP_ISSUE } from '../../mcp/Index';
import {
  collectApiFacts, collectRenameFacts, collectRenderFacts, conditionalAt, declarationsOf, isPackageSpecifier, wrappedExpression
} from './ArchitectureFacts';
import { visitKinds } from './CompilerWalk';
import { packageMember } from './CallableFlow';
import type { RouterProject } from '../frameworks/react-router/RouteTypes';
import { QueryIndexBuilder } from './QueryIndexBuilder';
import { jsxValue, PropFlow } from './PropFlow';
import { forwardedComponent, isComponentWrapper, preferRenderBinding, renderBindings, unprovidedContextTruth, type RenderCertainty } from './RenderBindings';
import { startLine } from './SourceLines';
import { DomainExtractor } from '../utils/DomainExtractor';
import { hasDirective, HTTP_METHODS, isClientFile } from './RouteAnalyzer';

type NodeWithBody = import('ts-morph').FunctionDeclaration | import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression;

const HOOK = /^use[A-Z0-9]/;
const ACTION_DECLARATION_KINDS = new Set([SyntaxKind.FunctionDeclaration, SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression]);
const RENDER_KINDS = new Set([SyntaxKind.JsxOpeningElement, SyntaxKind.JsxSelfClosingElement, SyntaxKind.JsxAttribute, SyntaxKind.CallExpression]);
const COMPONENT_BODY_KINDS = new Set([...RENDER_KINDS, SyntaxKind.Identifier, SyntaxKind.PropertyAccessExpression]);
const ACTION_SCAN_KINDS = new Set([
  ...COMPONENT_BODY_KINDS, SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression, SyntaxKind.ShorthandPropertyAssignment
]);

function rootBinding(node: Node): Node {
  while (Node.isPropertyAccessExpression(node)) node = node.getExpression();
  return node;
}

function externalAlias(node: Node | undefined, files: Set<SourceFile>, workspace?: WorkspaceBindings): string | undefined {
  if (!Node.isIdentifier(node) && !Node.isPropertyAccessExpression(node)) return;
  const root = rootBinding(node);
  const binding = root.getSymbol()?.getDeclarations()[0];
  const imported = binding?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  const module = imported?.getModuleSpecifierValue();
  if (!module || !isPackageSpecifier(module) || workspace?.has(module) || declarationsOf(root).some(target => files.has(target.getSourceFile()))) return;
  if (module === 'zod' || module.startsWith('zod/')) return;
  const name = Node.isImportSpecifier(binding) ? binding.getName() :
    Node.isNamespaceImport(binding) ? '' : 'default';
  const member = node.getText().slice(root.getText().length).replace(/^\./, '');
  const importedName = member || (name === 'default' ? root.getText() : name);
  if (!/^[A-Z]/.test(importedName) || /^[A-Z][A-Z0-9_]+$/.test(importedName)) return;
  return module + '#' + [name, member].filter(Boolean).join('.');
}

function zodSchemaBindings(file: SourceFile): Set<Node> {
  const schemas = new Set<Node>();
  const imports = file.getImportDeclarations().filter(entry => /^zod(?:\/|$)/.test(entry.getModuleSpecifierValue()));
  if (!imports.length) return schemas;
  visitKinds(file, new Set([SyntaxKind.TypeQuery]), node => {
    if (!Node.isTypeQuery(node)) return;
    const reference = node.getParent();
    if (!Node.isTypeReference(reference)) return;
    const type = reference.getTypeName();
    const binding = Node.isQualifiedName(type) ? type.getLeft() : type;
    const origin = binding.getSymbol()?.getDeclarations().find(declaration =>
      imports.some(entry => declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) === entry));
    const name = Node.isQualifiedName(type) ? type.getRight().getText() :
      Node.isImportSpecifier(origin) ? origin.getName() : undefined;
    if (!origin || !name || !['infer', 'input', 'output'].includes(name)) return;
    for (const declaration of declarationsOf(node.getExprName())) schemas.add(declaration);
  });
  return schemas;
}

function unwrapComponent(node: Node | undefined): Node | undefined {
  while (node) {
    const wrapped = wrappedExpression(node);
    if (wrapped) node = wrapped;
    else if (isComponentWrapper(node)) node = node.getArguments()[0];
    else return node;
  }
}

function isMetadata(route: RouteNode | undefined): boolean {
  return route?.type === 'robots' || route?.type === 'sitemap' || route?.type === 'opengraph-image';
}

function callable(node: Node, seen = new Set<Node>()): NodeWithBody | undefined {
  if (seen.has(node)) return;
  seen.add(node);
  if (Node.isFunctionDeclaration(node) && node.getBody()) return node;
  if (Node.isVariableDeclaration(node) || Node.isExportAssignment(node)) {
    const initializer = unwrapComponent(Node.isVariableDeclaration(node) ? node.getInitializer() : node.getExpression());
    if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) return initializer;
    if (Node.isIdentifier(initializer) || Node.isPropertyAccessExpression(initializer)) {
      for (const declaration of declarationsOf(initializer)) {
        const resolved = callable(declaration, seen);
        if (resolved) return resolved;
      }
    }
  }
}

function hasRender(body: Node): boolean {
  const returnsJsx = (node: Node) =>
    Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node) ||
    (Node.isCallExpression(node) && /(?:^|\.)createElement$/.test(node.getExpression().getText()));
  if (!Node.isBlock(body)) return returnsJsx(body) || body.getDescendants().some(returnsJsx);

  let found = false;
  body.forEachDescendant((node, traversal) => {
    if (Node.isFunctionLikeDeclaration(node) || Node.isClassDeclaration(node)) {
      traversal.skip();
    } else if (Node.isReturnStatement(node)) {
      const value = node.getExpression();
      if (value && (returnsJsx(value) || value.getDescendants().some(returnsJsx))) {
        found = true;
        traversal.stop();
      }
    }
  });
  return found;
}

function actionBinding(node: Node): Node {
  let expression = node;
  for (let parent = expression.getParent(); parent && wrappedExpression(parent) === expression; parent = expression.getParent()) {
    expression = parent;
  }
  const parent = expression.getParent();
  return Node.isVariableDeclaration(parent) || Node.isExportAssignment(parent) ? parent : node;
}

function exportedAction(node: Node, seen = new Set<Node>()): Node | undefined {
  if (seen.has(node)) return;
  seen.add(node);
  if (Node.isFunctionDeclaration(node) && node.getBody()) return node;
  let expression = Node.isVariableDeclaration(node) ? node.getInitializer() :
    Node.isExportAssignment(node) ? node.getExpression() : Node.isExpression(node) ? node : undefined;
  while (expression) {
    const inner = wrappedExpression(expression);
    if (!inner) break;
    expression = inner;
  }
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression) || Node.isCallExpression(expression)) return expression;
  if (Node.isConditionalExpression(expression) &&
      exportedAction(expression.getWhenTrue(), new Set(seen)) && exportedAction(expression.getWhenFalse(), seen)) return expression;
  if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression)) {
    for (const declaration of declarationsOf(expression)) {
      const action = exportedAction(declaration, seen);
      if (action) return action;
    }
  }
}

function actionReferences(checker: ts.TypeChecker, bindings: Map<Node, string>, modules: Map<ts.Symbol, Map<string, string>>) {
  const byDeclaration = new Map([...bindings].map(([node, id]) => [node.compilerNode, id]));
  const exports = new Map<ts.Symbol, Map<string, ts.Symbol>>();
  const cached = new Map<ts.Symbol, string | undefined>();
  const exportedSymbol = (module: ts.Symbol, name: string) => {
    let entry = exports.get(module);
    if (!entry) {
      entry = new Map(checker.getExportsOfModule(module).map(symbol => [symbol.name, symbol]));
      exports.set(module, entry);
    }
    return entry.get(name);
  };
  const fromModule = (module: ts.Symbol | undefined, name: string, seen = new Set<ts.Symbol>()): string | undefined => {
    if (!module || seen.has(module)) return;
    const id = modules.get(module)?.get(name);
    if (id) return id;
    const symbol = exportedSymbol(module, name);
    if (!symbol) return;
    // Star exports can skip the intervening module in the checker's alias chain.
    if (!module.exports?.has(symbol.escapedName)) {
      seen.add(module);
      for (const file of module.declarations ?? []) {
        if (!ts.isSourceFile(file)) continue;
        for (const statement of file.statements) {
          if (!ts.isExportDeclaration(statement) || statement.exportClause || statement.isTypeOnly || !statement.moduleSpecifier) continue;
          const source = checker.getSymbolAtLocation(statement.moduleSpecifier);
          if (source && exportedSymbol(source, name) === symbol) {
            const forwarded = fromModule(source, name, seen);
            if (forwarded) return forwarded;
          }
        }
      }
    }
    return fromSymbol(symbol);
  };
  const fromSymbol = (symbol: ts.Symbol | undefined): string | undefined => {
    if (!symbol || cached.has(symbol)) return symbol && cached.get(symbol);
    cached.set(symbol, undefined);
    let id: string | undefined;
    for (const declaration of symbol.declarations ?? []) {
      id = byDeclaration.get(declaration);
      if (id) break;
      if (ts.isImportSpecifier(declaration)) {
        id = fromModule(checker.getSymbolAtLocation(declaration.parent.parent.parent.moduleSpecifier),
          (declaration.propertyName ?? declaration.name).text);
      } else if (ts.isImportClause(declaration) && declaration.name) {
        id = fromModule(checker.getSymbolAtLocation(declaration.parent.moduleSpecifier), 'default');
      } else if (ts.isExportSpecifier(declaration) && declaration.parent.parent.moduleSpecifier) {
        id = fromModule(checker.getSymbolAtLocation(declaration.parent.parent.moduleSpecifier),
          (declaration.propertyName ?? declaration.name).text);
      }
      if (id) break;
    }
    if (!id && symbol.flags & ts.SymbolFlags.Alias && symbol.declarations?.length) {
      try {
        id = fromSymbol(checker.getImmediateAliasedSymbol(symbol));
      } catch (error) {
        // The checker can mark synthesized members as aliases without a resolvable alias declaration.
        if (!(error instanceof Error) || error.message !== 'Debug Failure.') throw error;
      }
    }
    cached.set(symbol, id);
    return id;
  };
  // ACTION_SCAN_KINDS includes the node kinds resolved by this callback.
  return (node: Node): string | undefined => {
    if (Node.isPropertyAccessExpression(node)) {
      const namespace = node.getExpression().getSymbol()?.compilerSymbol;
      const source = namespace && namespace.flags & ts.SymbolFlags.Alias && checker.getAliasedSymbol(namespace);
      const id = source && source.flags & ts.SymbolFlags.Module ? fromModule(source, node.getName()) : undefined;
      if (id) return id;
    }
    if (Node.isIdentifier(node) && node.getParentIfKind(SyntaxKind.PropertyAccessExpression)?.getNameNode() === node) return;
    if (Node.isShorthandPropertyAssignment(node)) return fromSymbol(node.getValueSymbol()?.compilerSymbol);
    if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) return fromSymbol(node.getSymbol()?.compilerSymbol);
    if ((Node.isArrowFunction(node) || Node.isFunctionExpression(node)) && !Node.isVariableDeclaration(actionBinding(node))) {
      return bindings.get(node);
    }
  };
}

function lexicalName(node: Node): string | undefined {
  if (Node.isExportAssignment(node)) return 'default';
  if (Node.isVariableDeclaration(node) || Node.isFunctionExpression(node)) return node.getName();
  if (Node.isFunctionDeclaration(node)) return node.getName() ?? (node.isDefaultExport() ? 'default' : undefined);
}

export class ComponentAnalyzer {
  constructor(private readonly root: string, private readonly config?: NextConfig, private readonly workspace?: WorkspaceBindings) {}

  public analyze(files: SourceFile[], routes: RouteNode[], includeFacts: boolean, historyOnly = false, appConfig?: NextConfig, router?: RouterProject) {
    const components = new Map<Node, ComponentNode>();
    const bodies = new Map<Node, Node>();
    const aliases = new Map<Node, Node[]>();
    const hooks = new Map<string, HookNode>();
    const localHooks = new Map<Node, HookNode>();
    const projectFiles = new Set(files);
    const exportsByFile = new Map<SourceFile, ReturnType<SourceFile['getExportedDeclarations']>>();
    const exportsOf = (file: SourceFile) => {
      let exported = exportsByFile.get(file);
      if (!exported) {
        exported = file.getExportedDeclarations();
        if (projectFiles.has(file)) exportsByFile.set(file, exported);
      }
      return exported;
    };
    const index = includeFacts ? new QueryIndexBuilder(exportsOf) : undefined;
    const actions = new Set<string>();
    const actionIds = new Map<Node, string>();
    const actionNames = new Set<Node>();
    const actionModules = new Map<ts.Symbol, Map<string, string>>();
    const paths = new WeakMap<SourceFile, string>();
    const relativePath = (file: SourceFile) => {
      let relative = paths.get(file);
      if (relative === undefined) paths.set(file, relative = path.relative(this.root, file.getFilePath()).split(path.sep).join('/'));
      return relative;
    };
    const routesByFile = new Map(routes.map(route => [route.file, route]));

    for (const file of files) {
      const relative = relativePath(file);
      const route = routesByFile.get(relative);
      const registerAction = (name: string, site: Node) => {
        const base = `action:${relative}#${name}`;
        let id = base;
        for (let suffix = 2; actions.has(id); suffix++) id = `${base}~${suffix}`;
        actions.add(id);
        index?.action(id, name, relative, startLine(site));
        return id;
      };
      const addAction = (name: string, declaration: Node, action = declaration, site = declaration) => {
        const binding = actionBinding(action);
        const id = actionIds.get(binding) ?? registerAction(name, site);
        for (const target of [declaration, binding, action]) {
          actionIds.set(target, id);
          if (Node.isVariableDeclaration(target) || Node.isFunctionDeclaration(target) || Node.isFunctionExpression(target)) {
            const name = target.getNameNode();
            if (name) actionNames.add(name);
          }
        }
        return id;
      };
      if (hasDirective(file.getStatements(), 'use server')) {
        const named = new Map(file.getExportDeclarations().flatMap(statement => statement.getNamedExports()
          .map(specifier => [(specifier.getAliasNode() ?? specifier.getNameNode()).getText(), specifier] as const)));
        const stars = file.getExportDeclarations().filter(statement =>
          !statement.isTypeOnly() && !statement.compilerNode.exportClause && statement.hasModuleSpecifier());
        const defaultSite = file.getExportAssignments().find(assignment => !assignment.isExportEquals());
        const module = file.getSymbol()?.compilerSymbol;
        const exportedActions = new Map<string, string>();
        if (module) actionModules.set(module, exportedActions);
        for (const [name, declarations] of exportsOf(file)) {
          const specifier = named.get(name);
          if (specifier?.isTypeOnly() || specifier?.getExportDeclaration().isTypeOnly()) continue;
          for (const declaration of declarations) {
            const action = exportedAction(declaration);
            if (!action) continue;
            const local = declaration.getSourceFile() === file;
            const site = specifier ?? (name === 'default' ? defaultSite : undefined) ?? (local ? declaration :
              stars.find(star => star.getModuleSpecifierSourceFile()?.getExportedDeclarations().get(name)?.includes(declaration)));
            if (!site) continue;
            // Cross-module exports are actions at this boundary. Keep the implementation's
            // binding available for ordinary imports from its own module.
            const localAction = local && action.getSourceFile() === file;
            const location = localAction && specifier && !specifier.getExportDeclaration().hasModuleSpecifier()
              ? declaration : site;
            const id = Node.isExportDeclaration(site)
              ? registerAction(name, site)
              : addAction(name, site, localAction ? action : site, location);
            exportedActions.set(name, id);
            index?.actionAlias(id, name);
            if (name === 'default' && local && Node.isFunctionDeclaration(declaration) && declaration.isDefaultExport()) {
              const lexical = declaration.getName();
              if (lexical) index?.actionAlias(id, lexical);
            }
            break;
          }
        }
      }
      if (file.getFullText().includes('use server')) {
        // Keep ACTION_DECLARATION_KINDS in sync with the node kinds handled below.
        visitKinds(file, ACTION_DECLARATION_KINDS, node => {
          if (!Node.isFunctionDeclaration(node) && !Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) return;
          const body = node.getBody();
          if (!node.isAsync() || !Node.isBlock(body) || !hasDirective(body.getStatements(), 'use server')) return;
          const binding = actionBinding(node);
          const scopes = binding.getAncestors().reverse().filter(ancestor =>
            !Node.isFunctionExpression(ancestor) || actionBinding(ancestor) === ancestor);
          const name = [...scopes.map(lexicalName).filter(Boolean), lexicalName(binding) ?? '(inline)'].join('.');
          addAction(name, binding, node);
        });
      }

      if (route?.type === 'api' || isMetadata(route)) continue;
      const defaultDeclarations = new Set(file.getDefaultExportSymbol()?.getDeclarations());
      for (const assignment of file.getExportAssignments().filter(node => !node.isExportEquals())) {
        const expression = unwrapComponent(assignment.getExpression());
        if (!Node.isIdentifier(expression) && !Node.isPropertyAccessExpression(expression)) continue;
        const targets = declarationsOf(expression);
        if (!targets.length) continue;
        aliases.set(assignment, targets);
        for (const target of targets) defaultDeclarations.add(target);
      }
      const exported = new Set<Node>([...exportsOf(file).values()].flat());
      const schemaBindings = zodSchemaBindings(file);
      const candidates = [
        ...file.getFunctions(), ...file.getVariableDeclarations(), ...file.getClasses(),
        ...file.getExportAssignments().filter(node => !node.isExportEquals())
      ];
        for (const node of candidates) {
        if (aliases.has(node)) continue;
        const fn = callable(node);
        const initializer = Node.isVariableDeclaration(node) ? node.getInitializer() : undefined;
        const aliasOf = schemaBindings.has(node) ? undefined : externalAlias(initializer, projectFiles, this.workspace);
        const body = fn ? fn.getBody() : (aliasOf ? initializer : undefined) ??
          (Node.isClassDeclaration(node) ? node.getInstanceMethod('render')?.getBody() : undefined);
        if (!body) continue;
        const name = (Node.isFunctionDeclaration(node) || Node.isVariableDeclaration(node) ||
          Node.isClassDeclaration(node)) ? node.getName() ?? 'default' : 'default';
        if (HOOK.test(name)) {
          const hook = { id: `hook:${relative}#${name}`, name, path: relative };
          localHooks.set(node, hook);
          hooks.set(hook.id, hook);
          continue;
        }
        const isDefault = defaultDeclarations.has(node);
        if (HTTP_METHODS.includes(name) || (!isDefault && !/^[A-Z]/.test(name))) continue;
        if (!aliasOf && !(route && isDefault) && !hasRender(body)) continue;

        const id = `cmp:${relative}#${name}`;
        const parameter = fn?.getParameters()[0];
        const pattern = parameter?.getNameNode();
        const props = pattern && Node.isObjectBindingPattern(pattern)
          ? pattern.getElements().filter(element => !element.getDotDotDotToken()).map(element =>
            (element.getPropertyNameNode() ?? element.getNameNode()).getText())
          : [];
        const docs = Node.isVariableDeclaration(node) ? node.getVariableStatement() : node;
        const description = docs && Node.isJSDocable(docs) ? docs.getJsDocs()[0]?.getDescription().trim() : undefined;
        components.set(node, {
          id, name, path: relative, isClient: isClientFile(file),
          domain: DomainExtractor.extract('/' + relative), props, hooks: [], description, aliasOf
        });
        bodies.set(node, body);
        if (route && isDefault) route.componentId = id;
      }

      for (const wrapper of file.getVariableDeclarations()) {
        const initializer = wrapper.getInitializer();
        const target = unwrapComponent(initializer);
        if (!components.has(wrapper) || !Node.isCallExpression(initializer) || !Node.isIdentifier(target)) continue;
        for (const inner of declarationsOf(target)) {
          if (inner.getSourceFile() !== file || exported.has(inner) || !components.has(inner)) continue;
          const innerId = components.get(inner)!.id;
          components.delete(inner);
          aliases.set(inner, [wrapper]);
          if (route?.componentId === innerId) route.componentId = components.get(wrapper)!.id;
        }
      }
    }

    const resolveComponent = (node: Node, seen = new Set<Node>()): ComponentNode | undefined => {
      if (seen.has(node)) return;
      seen.add(node);
      return components.get(node) ?? aliases.get(node)?.map(target => resolveComponent(target, seen)).find(Boolean);
    };

    const defaultWrappers: { from: string; to: string; node: Node; conditional: number }[] = [];
    for (const file of files) {
      const relative = relativePath(file);
      const route = routesByFile.get(relative);
      if (route?.type === 'api' || isMetadata(route) || /^(?:src\/)?pages\/_app\.[jt]sx?$/.test(relative)) continue;
      for (const assignment of file.getExportAssignments()) {
        if (assignment.isExportEquals() || components.has(assignment) || aliases.has(assignment)) continue;
        const call = unwrapComponent(assignment.getExpression());
        if (!Node.isCallExpression(call)) continue;
        const forwarding = forwardedComponent(call, projectFiles);
        if (!forwarding) continue;
        const inner = unwrapComponent(forwarding.argument);
        const target = inner && declarationsOf(inner).map(node => resolveComponent(node)).find(Boolean);
        if (!target) continue;
        const id = `cmp:${relative}#default`;
        components.set(assignment, { id, name: 'default', renderName: `${call.getExpression().getText()}(${target.name})`,
          path: relative, isClient: isClientFile(file),
          domain: DomainExtractor.extract('/' + relative), props: [], hooks: [] });
        bodies.set(assignment, call);
        if (route) route.componentId = id;
        for (const site of forwarding.sites) defaultWrappers.push({ from: id, to: target.id, ...site });
      }
    }

    const pagesApps: { file: string; componentId?: string }[] = [];
    for (const file of files) {
      const relative = relativePath(file);
      const route = routesByFile.get(relative);
      const isPagesApp = !router && /^(?:src\/)?pages\/_app\.[jt]sx?$/.test(relative);
      if (!isPagesApp && (!route || route.type === 'api' || isMetadata(route) || route.componentId)) continue;
      const exported = exportsOf(file).get('default');
      const componentId = exported?.flatMap(node => aliases.get(node) ?? [node])
        .map(node => resolveComponent(node)).find(Boolean)?.id;
      if (isPagesApp) pagesApps.push({ file: relative, componentId });
      else if (route) route.componentId = componentId;
    }

    if (router) for (const route of routes) route.componentId = routesByFile.get(route.file)?.componentId;

    const edges = new Map<string, ComponentEdge>();
    const componentCalls = new Set<Node>();
    type Imports = { byDeclaration: Map<Node, import('ts-morph').ImportDeclaration>; names: Set<string> };
    const importsByFile = new Map<SourceFile, Imports>();
    const importsFor = (file: SourceFile) => {
      const cached = importsByFile.get(file);
      if (cached) return cached;
      const imports: Imports = { byDeclaration: new Map(), names: new Set() };
      for (const declaration of file.getImportDeclarations()) {
        if (declaration.isTypeOnly()) continue;
        const imported = [declaration.getDefaultImport(), declaration.getNamespaceImport(),
          ...declaration.getNamedImports().filter(specifier => !specifier.isTypeOnly())
            .map(specifier => specifier.getAliasNode() ?? specifier.getNameNode())];
        for (const binding of imported) {
          if (!binding) continue;
          imports.names.add(binding.compilerNode.text);
          for (const bindingDeclaration of binding.getSymbol()?.getDeclarations() ?? []) {
            imports.byDeclaration.set(bindingDeclaration, declaration);
          }
        }
      }

      importsByFile.set(file, imports);
      return imports;
    };
    const resolveHook = (expression: Node, imports: Imports) => {
      const binding = Node.isPropertyAccessExpression(expression) ? expression.getExpression() : expression;
      const canBeImported = !Node.isIdentifier(binding) || imports.names.has(binding.compilerNode.text);
      const imported = canBeImported ? binding.getSymbol()?.getDeclarations().find(declaration => imports.byDeclaration.has(declaration)) : undefined;
      const name = Node.isImportSpecifier(imported) ? imported.getName() :
        Node.isPropertyAccessExpression(expression) ? expression.getName() : Node.isIdentifier(expression) ? expression.compilerNode.text : expression.getText();
      if (!HOOK.test(name)) return;
      const importDeclaration = imported && imports.byDeclaration.get(imported);
      const specifier = importDeclaration?.getModuleSpecifierValue();
      if (specifier === 'react' || specifier === 'react-dom') return;
      const targets = declarationsOf(expression);
      const local = targets.map(target => localHooks.get(target)).find(hook => hook);
      if (local) {
        return local.id;
      }
      const source = targets.map(target => target.getSourceFile()).find(target => projectFiles.has(target)) ??
        importDeclaration?.getModuleSpecifierSourceFile();
      if (source && projectFiles.has(source)) {
        const path = relativePath(source);
        const id = `hook:${path}#${name}`;
        hooks.set(id, { id, path, name });
        return id;
      } else if (specifier && isPackageSpecifier(specifier)) {
        const id = `hook:${specifier}#${name}`;
        hooks.set(id, { id, name, module: specifier });
        return id;
      }
    };
    const addEdge = (from: string, to: string | undefined, type: ComponentEdge['type']) => {
      if (!to || to === from) return;
      edges.set(JSON.stringify([type, from, to]), { from, to, type });
    };
    for (const { from, to, node, conditional } of defaultWrappers) {
      addEdge(from, to, 'renders');
      index?.render(from, to, startLine(node), conditional, undefined, undefined, undefined, undefined, undefined,
        relativePath(node.getSourceFile()));
    }
    for (const [node, wrapper] of components) {
      const initializer = Node.isVariableDeclaration(node) ? node.getInitializer() : undefined;
      if (!Node.isCallExpression(initializer) ||
          !['memo', 'forwardRef'].includes(packageMember(initializer.getExpression(), 'react') ?? '')) continue;
      const [argument] = initializer.getArguments();
      if (!argument) continue;
      // Exported inner components keep their own symbols alongside their wrappers.
      for (const declaration of declarationsOf(argument)) {
        const target = components.get(declaration);
        if (!target || target === wrapper) continue;
        addEdge(wrapper.id, target.id, 'renders');
      }
    }
    const declaredRenderTargets = (declarations: Node[]) => declarations.flatMap(declaration => {
      const assignment = declaration.getParent();
      if (Node.isPropertyAccessExpression(declaration) && Node.isBinaryExpression(assignment) &&
          assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken && assignment.getLeft() === declaration) {
        return declarationsOf(assignment.getRight());
      }
      return [declaration];
    }).flatMap(node => resolveComponent(node) ?? []);
    // Discover component-valued bindings before assigning JSX to its owning body.
    const renderTargets = new Map<Node, ComponentNode[]>();
    const renderChoices = new Map<Node, Map<string, RenderCertainty>>();
    const contextTruth = unprovidedContextTruth(projectFiles, file => !relativePath(file).startsWith('../'));
    const unresolvedLookups = new Map<Node, Node[]>();
    const opaqueLookups = new Map<Node, Set<Node>>();
    const isFetcherForm = router && (require('../frameworks/react-router/Navigation') as typeof import('../frameworks/react-router/Navigation')).isFetcherForm;
    const callbackBodies = new Set<ts.Node>();
    const indexedComponent = (node: Node) => !!resolveComponent(node);
    const componentForBinding = (target: Node, tag: Node) => {
      let binding: Node = target;
      while (Node.isParenthesizedExpression(binding.getParent()) || Node.isAsExpression(binding.getParent()) ||
             Node.isCallExpression(binding.getParent())) binding = binding.getParentOrThrow();
      const parent = binding.getParent();
      if (Node.isVariableDeclaration(parent) || Node.isExportAssignment(parent)) binding = parent;
      const existing = resolveComponent(binding);
      if (existing) return existing;
      if (!Node.isFunctionDeclaration(target) && !Node.isArrowFunction(target) && !Node.isFunctionExpression(target)) return;
      const body = target.getBody();
      if (!body || !hasRender(body)) return;
      const source = target.getSourceFile();
      const relative = relativePath(source);
      const name = lexicalName(binding) ?? tag.getText();
      const component = {
        id: `cmp:${relative}#${name}~${binding.getStart()}`, name, path: relative,
        isClient: isClientFile(source), domain: DomainExtractor.extract('/' + relative), props: [], hooks: []
      };
      components.set(binding, component);
      bodies.set(binding, body);
      callbackBodies.add(body.compilerNode);
      return component;
    };
    for (const file of files) {
      // Keep RENDER_KINDS in sync with the render sites handled here and in the file scan below.
      visitKinds(file, RENDER_KINDS, node => {
        let tag: Node | undefined;
        if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
          tag = node.getTagNameNode();
          if (Node.isIdentifier(tag) && /^[a-z]/.test(tag.getText())) return;
        } else if (Node.isCallExpression(node) && /(?:^|\.)createElement$/.test(node.getExpression().getText())) {
          tag = node.getArguments()[0];
        }
        if (!tag || isFetcherForm?.(tag)) return;
        const targets = Node.isElementAccessExpression(tag) ? [tag] : declarationsOf(tag);
        const resolved = declaredRenderTargets(targets);
        renderTargets.set(tag, resolved);
        if (resolved.length) return;
        const bindings = Node.isIdentifier(tag) ? targets : [tag];

        const choices = new Map<string, RenderCertainty>();
        const register = (component: ComponentNode, choice: RenderCertainty) => {
          const previous = choices.get(component.id);
          if (!previous) resolved.push(component);
          if (!previous || preferRenderBinding(choice, previous)) choices.set(component.id, choice);
        };
        const traced = renderBindings(bindings, projectFiles, indexedComponent, undefined, undefined, contextTruth);
        if (traced.unresolvedLookup || traced.opaqueLookups.size) unresolvedLookups.set(tag, bindings);
        for (const { target, ...choice } of traced.targets) {
          const component = componentForBinding(target, tag);
          if (component) register(component, choice);
        }
        if (choices.size) renderChoices.set(tag, choices);
      });
    }
    const definitions = new Map([...components].map(([node, component]) => [component.id, node]));
    const uncertainLookups = new Set([...renderChoices].flatMap(([tag, choices]) =>
      [...choices.values()].some(choice => choice.possible) ? [tag] : []));
    const flow = new PropFlow(bodies, new Map([...renderTargets].map(([tag, targets]) =>
      [tag, targets.flatMap(target => definitions.get(target.id) ?? [])])), projectFiles, relativePath, uncertainLookups);
    const propAttribute = (tag: Node, body?: Node) =>
      tag.getAncestors().find(parent => parent === body || Node.isJsxAttribute(parent));
    const propRenders = new Map<Node, (RenderCertainty & { target: ComponentNode; detail: string })[]>();
    for (const [tag, bindings] of unresolvedLookups) {
      const traced = renderBindings(bindings, projectFiles, indexedComponent, flow, undefined, contextTruth);
      if (!traced.unresolvedLookup) unresolvedLookups.delete(tag);
      if (traced.opaqueLookups.size) opaqueLookups.set(tag, traced.opaqueLookups);
      const attribute = propAttribute(tag);
      if (Node.isJsxAttribute(attribute) && !flow.mayRenderSlot(attribute)) continue;
      for (const { target, supply, possible, conditional, contextExcluded } of traced.targets) {
        if (!supply) continue;
        const component = componentForBinding(target, tag);
        if (!component) continue;
        const receiver = Node.isCallExpression(supply.site) ? supply.site.getArguments()[0] : supply.site.getTagNameNode();
        if (!receiver) continue;
        const entries = propRenders.get(receiver) ?? [];
        entries.push({ target: component, possible, contextExcluded, conditional: conditional || !!conditionalAt(tag),
          detail: `prop ${supply.name} via ${receiver.getText()} (rendered at ${relativePath(tag.getSourceFile())}:${startLine(tag)})` });
        propRenders.set(receiver, entries);
      }
    }
    const render = (tag: Node, from: string, body?: Node, suppliedComponent = false) => {
      const targets = suppliedComponent ? declaredRenderTargets(declarationsOf(tag)) : renderTargets.get(tag) ?? [];
      const unresolved = !suppliedComponent && unresolvedLookups.get(tag);
      if (unresolved) index?.unresolvedRenderLookup(from, tag, unresolved);
      const opaque = !suppliedComponent && opaqueLookups.get(tag);
      if (opaque) index?.opaqueRenderLookup(from, tag, opaque);
      const site = tag.getParent();
      if (!targets.length && Node.isPropertyAccessExpression(tag)) {
        targets.push(...declarationsOf(rootBinding(tag)).flatMap(node => resolveComponent(node) ?? []));
      }
      const transferred = suppliedComponent ? [] : propRenders.get(tag) ?? [];
      const renders = [...new Set(targets)].map(target => ({ target, ...renderChoices.get(tag)?.get(target.id), detail: undefined as string | undefined }));
      for (const { target, possible, conditional: guarded, contextExcluded, detail, selection } of [...renders, ...transferred]) {
        const attribute = propAttribute(tag, body);
        const element = Node.isJsxOpeningElement(site) ? site.getParent() : site;
        const parent = element?.getParent();
        const children = Node.isJsxElement(parent) ? flow.renderChildren(parent) : [];
        const slot = Node.isJsxAttribute(attribute) ? flow.renderSlot(attribute, suppliedComponent) :
          children.length ? children : undefined;
        if (slot && !slot.length && Node.isJsxAttribute(attribute) && attribute.getNameNode().getText() === 'fallback') {
          const receiver = attribute.getParent()?.getParent();
          if ((Node.isJsxOpeningElement(receiver) || Node.isJsxSelfClosingElement(receiver)) &&
              packageMember(receiver.getTagNameNode(), 'react') === 'Suspense') {
            const binding = flow.value(receiver, { name: 'fallback' });
            if (binding.value === jsxValue(attribute)) {
              slot.push({ detail: 'prop fallback via React Suspense', conditional: true, partial: !!binding.unknown });
            }
          }
        }
        if (slot && !slot.length && Node.isJsxAttribute(attribute) && !flow.mayRenderSlot(attribute)) continue;
        addEdge(from, target.id, 'renders');
        if (index && from !== target.id) {
          const conditional = guarded ? 1 : conditionalAt(tag, body);
          const lookup = [possible && RENDER_LOOKUP_ISSUE, detail].filter(Boolean).join('; ') || undefined;
          const renderSite = Node.isJsxOpeningElement(site) || Node.isJsxSelfClosingElement(site) || Node.isCallExpression(site)
            ? site : undefined;
          if (!slot?.length) {
            index.render(from, target.id, startLine(tag), conditional, undefined, possible || undefined, this.config && tag,
              lookup, renderSite, undefined, contextExcluded, selection);
          } else for (const transfer of slot) {
            index.render(from, target.id, startLine(tag), conditional || Number(transfer.conditional),
              undefined, possible || (transfer.partial ? true : undefined), this.config && tag,
              lookup ? `${lookup}; ${transfer.detail}` : transfer.detail, renderSite, undefined, contextExcluded, selection);
          }
        }
      }
    };
    const suppliedComponents = (value: Node | undefined, from: string, body?: Node) => {
      if (!value) return;
      const wrapped = wrappedExpression(value);
      if (wrapped) suppliedComponents(wrapped, from, body);
      else if (Node.isIdentifier(value) || Node.isPropertyAccessExpression(value)) render(value, from, body, true);
      else if (Node.isConditionalExpression(value)) {
        suppliedComponents(value.getWhenTrue(), from, body);
        suppliedComponents(value.getWhenFalse(), from, body);
      } else if (Node.isArrayLiteralExpression(value)) {
        for (const entry of value.getElements()) suppliedComponents(entry, from, body);
      } else if (Node.isObjectLiteralExpression(value)) {
        for (const entry of value.getProperties()) {
          if (Node.isPropertyAssignment(entry)) suppliedComponents(entry.getInitializer(), from, body);
          else if (Node.isShorthandPropertyAssignment(entry)) suppliedComponents(entry.getNameNode(), from, body);
        }
      }
    };
    const inspectAttribute = (attribute: import('ts-morph').JsxAttribute, from: string, body?: Node) => {
      if (/^on[A-Z]/.test(attribute.getNameNode().getText())) return;
      const site = attribute.getParent()?.getParent();
      if (!Node.isJsxOpeningElement(site) && !Node.isJsxSelfClosingElement(site)) return;
      const tag = site.getTagNameNode();
      if (Node.isIdentifier(tag) && /^[a-z]/.test(tag.getText())) return;
      suppliedComponents(jsxValue(attribute), from, body);
    };
    const componentTags = new Set<Node>();
    const componentAttributes = new Set<Node>();
    const componentOwners = new Map<Node, string>();
    for (const [node, component] of components) {
      const body = bodies.get(node)!;
      componentOwners.set(body, component.id);
      const file = body.getSourceFile();
      const imports = historyOnly ? undefined : importsFor(file);

      const usedHooks = new Set<string>();
      // Keep COMPONENT_BODY_KINDS in sync with the node kinds handled below.
      const inspect = (child: Node) => {
        if (Node.isJsxOpeningElement(child) || Node.isJsxSelfClosingElement(child)) {
          componentTags.add(child);
          render(child.getTagNameNode(), component.id, body);
        } else if (Node.isJsxAttribute(child)) {
          componentAttributes.add(child);
          inspectAttribute(child, component.id, body);
        }
        if (imports && (Node.isIdentifier(child) || Node.isPropertyAccessExpression(child))) {
          const binding = Node.isPropertyAccessExpression(child) ? child.getExpression() : child;
          if ((!Node.isIdentifier(binding) || imports.names.has(binding.compilerNode.text)) &&
              binding.getSymbol()?.getDeclarations().some(declaration => imports.byDeclaration.has(declaration))) {
            for (const target of declarationsOf(child)) addEdge(component.id, resolveComponent(target)?.id, 'imports');
          }
        }
        if (!Node.isCallExpression(child)) return;
        componentCalls.add(child);
        const expression = child.getExpression();
        const [argument] = child.getArguments();
        if (argument && /(?:^|\.)createElement$/.test(expression.getText())) render(argument, component.id, body);
        const hook = imports && resolveHook(expression, imports);
        if (hook) usedHooks.add(hook);
      };
      inspect(body);
      visitKinds(body, COMPONENT_BODY_KINDS, inspect, {
        skip: callbackBodies,
        filterRaw: child => {
          const binding = ts.isPropertyAccessExpression(child) ? child.expression : child;
          return !ts.isIdentifier(binding) || !!imports?.names.has(binding.text);
        }
      });
      component.hooks = [...usedHooks];
    }

    const actionReference = actions.size && actionReferences(files[0].getProject().getTypeChecker().compilerObject, actionIds, actionModules);
    const fileHooks = new Map<string, { hooks: string[]; isClient: boolean }>();
    for (const file of files) {
      const relative = relativePath(file);
      const from = `file:${relative}`;
      const usedHooks = new Set<string>();
      const aliasedHooks = historyOnly ? undefined : new Set(file.getImportDeclarations().flatMap(declaration => declaration.getNamedImports())
        .filter(specifier => HOOK.test(specifier.getName())).flatMap(specifier => specifier.getAliasNode()?.getText() ?? []));
      // RENDER_KINDS covers render and hook sites. ACTION_SCAN_KINDS also covers actionReferences().
      visitKinds(file, actionReference ? ACTION_SCAN_KINDS : RENDER_KINDS, node => {
        if (actionReference && !actionNames.has(node)) {
          const id = actionReference(node);
          if (id) {
            const ancestors = node.getAncestors();
            if (!Node.isExportAssignment(ancestors.find(parent => !wrappedExpression(parent))) && !ancestors.some(parent =>
              Node.isImportDeclaration(parent) || Node.isExportDeclaration(parent) || Node.isTypeNode(parent))) {
              const owner = componentOwners.get(node) ?? ancestors.map(parent => componentOwners.get(parent)).find(Boolean) ?? from;
              const line = startLine(node);
              addEdge(owner, id, 'uses-action');
              index?.useAction(id, relative, line, node);
            }
          }
        }
        if ((Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) && !componentTags.has(node)) {
          render(node.getTagNameNode(), from);
        }
        if (Node.isJsxAttribute(node) && !componentAttributes.has(node)) inspectAttribute(node, from);
        if (!Node.isCallExpression(node) || componentCalls.has(node)) return;
        const expression = node.getExpression();
        const [argument] = node.getArguments();
        if (argument && /(?:^|\.)createElement$/.test(expression.getText())) render(argument, from);
        if (!aliasedHooks) return;
        const name = Node.isPropertyAccessExpression(expression) ? expression.getName() :
          Node.isIdentifier(expression) ? expression.getText() : '';
        if (!HOOK.test(name) && !aliasedHooks.has(name)) return;
        const hook = resolveHook(expression, importsFor(file));
        if (hook && hooks.get(hook)?.path) usedHooks.add(hook);
      });
      if (usedHooks.size) fileHooks.set(relative, { hooks: [...usedHooks], isClient: isClientFile(file) });
    }

    const facts: DetailFacts = new Map();
    if (includeFacts) {
      const symbols = new Map<Node, string>();
      for (const [node, id] of actionIds) symbols.set(node, id.slice('action:'.length));
      for (const [node, component] of components) symbols.set(node, component.id.slice('cmp:'.length));
      for (const [node, hook] of localHooks) symbols.set(node, hook.id.slice('hook:'.length));
      for (const [node, targets] of aliases) {
        const component = resolveComponent(node);
        if (component) symbols.set(node, component.id.slice('cmp:'.length));
        const body = targets.map(target => bodies.get(target)).find(Boolean);
        if (body) bodies.set(node, body);
      }
      if (!historyOnly) collectRenameFacts(files, relativePath, symbols, facts, exportsOf);
      collectRenderFacts(this.root, routes, [...components.values()], [...edges.values()], files, bodies, relativePath, historyOnly ? undefined : facts, index, this.config, this.workspace);
      if (!router) collectApiFacts(this.root, files, routes, relativePath, actionIds, historyOnly ? undefined : facts, callable, index, this.config, this.workspace, flow, appConfig);
    }
    return { index: index?.build(files, routes, components, aliases, relativePath, actionIds, this.root, this.config, this.workspace, flow, historyOnly, router), facts, components: [...components.values()], hooks: [...hooks.values()], edges: [...edges.values()], actions: [...actions], fileHooks, pagesApps };
  }
}
