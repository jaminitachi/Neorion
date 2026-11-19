import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import type { ComponentEdge, ComponentNode, DetailFacts, HookNode, RouteNode } from '../types/GraphTypes';
import { collectApiFacts, collectRenameFacts, collectRenderFacts, conditionalAt, declarationsOf } from './ArchitectureFacts';
import { QueryIndexBuilder } from './QueryIndexBuilder';
import { DomainExtractor } from '../utils/DomainExtractor';
import { hasDirective, HTTP_METHODS, isClientFile } from './RouteAnalyzer';

type NodeWithBody = import('ts-morph').FunctionDeclaration | import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression;

const HOOK = /^use[A-Z0-9]/;

function rootBinding(node: Node): Node {
  while (Node.isPropertyAccessExpression(node)) node = node.getExpression();
  return node;
}

function isPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('#') &&
    !path.isAbsolute(specifier) && !path.win32.isAbsolute(specifier);
}

function externalAlias(node: Node | undefined, files: Set<SourceFile>): string | undefined {
  if (!Node.isIdentifier(node) && !Node.isPropertyAccessExpression(node)) return;
  const root = rootBinding(node);
  const binding = root.getSymbol()?.getDeclarations()[0];
  const imported = binding?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  const module = imported?.getModuleSpecifierValue();
  if (!module || !isPackageSpecifier(module) || declarationsOf(root).some(target => files.has(target.getSourceFile()))) return;
  const name = Node.isImportSpecifier(binding) ? binding.getName() :
    Node.isNamespaceImport(binding) ? '' : 'default';
  const member = node.getText().slice(root.getText().length).replace(/^\./, '');
  const importedName = member || (name === 'default' ? root.getText() : name);
  if (!/^[A-Z]/.test(importedName) || /^[A-Z][A-Z0-9_]+$/.test(importedName)) return;
  return module + '#' + [name, member].filter(Boolean).join('.');
}

function unwrapComponent(node: Node | undefined): Node | undefined {
  while (node) {
    if (Node.isParenthesizedExpression(node)) node = node.getExpression();
    else if (Node.isCallExpression(node) &&
             /(?:^|\.)(?:memo|forwardRef)$/.test(node.getExpression().getText())) {
      node = node.getArguments()[0];
    } else return node;
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

function actionBinding(node: NodeWithBody): Node {
  const parent = node.getParent();
  return Node.isVariableDeclaration(parent) || Node.isExportAssignment(parent) ? parent : node;
}

function lexicalName(node: Node): string | undefined {
  if (Node.isExportAssignment(node)) return 'default';
  if (Node.isVariableDeclaration(node) || Node.isFunctionExpression(node)) return node.getName();
  if (Node.isFunctionDeclaration(node)) return node.getName() ?? (node.isDefaultExport() ? 'default' : undefined);
}

export class ComponentAnalyzer {
  constructor(private readonly root: string) {}

  public analyze(files: SourceFile[], routes: RouteNode[], includeFacts: boolean) {
    const components = new Map<Node, ComponentNode>();
    const index = includeFacts ? new QueryIndexBuilder() : undefined;
    const bodies = new Map<Node, Node>();
    const aliases = new Map<Node, Node[]>();
    const hooks = new Map<string, HookNode>();
    const localHooks = new Map<Node, HookNode>();
    const projectFiles = new Set(files);
    const actions = new Set<string>();
    const actionIds = new Map<Node, string>();
    const actionNames = new Set<Node>();
    const relativePath = (file: SourceFile) => path.relative(this.root, file.getFilePath()).split(path.sep).join('/');
    const routesByFile = new Map(routes.map(route => [route.file, route]));

    for (const file of files) {
      const relative = relativePath(file);
      const route = routesByFile.get(relative);
      if (route?.type === 'api') continue;
      const addAction = (name: string, fn: NodeWithBody, declaration: Node) => {
        const binding = actionBinding(fn);
        let id = actionIds.get(binding);
        if (!id) {
          const base = `action:${relative}#${name}`;
          id = base;
          for (let suffix = 2; actions.has(id); suffix++) id = `${base}~${suffix}`;
          actions.add(id);
        }
        for (const target of [fn, binding, declaration]) {
          actionIds.set(target, id);
          if (Node.isVariableDeclaration(target) || Node.isFunctionDeclaration(target) || Node.isFunctionExpression(target)) {
            const name = target.getNameNode();
            if (name) actionNames.add(name);
          }
        }
      };
      if (hasDirective(file.getStatements(), 'use server')) {
        for (const [name, declarations] of file.getExportedDeclarations()) {
          for (const declaration of declarations) {
            const fn = callable(declaration);
            if (fn?.isAsync()) addAction(name, fn, declaration);
          }
        }
      }
      if (file.getFullText().includes('use server')) {
        file.forEachDescendant(node => {
          if (!Node.isFunctionDeclaration(node) && !Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) return;
          const body = node.getBody();
          if (!node.isAsync() || !Node.isBlock(body) || !hasDirective(body.getStatements(), 'use server')) return;
          const binding = actionBinding(node);
          const scopes = binding.getAncestors().reverse().filter(ancestor =>
            !Node.isFunctionExpression(ancestor) || actionBinding(ancestor) === ancestor);
          const name = [...scopes.map(lexicalName).filter(Boolean), lexicalName(binding) ?? '(inline)'].join('.');
          addAction(name, node, binding);
        });
      }

      if (isMetadata(route)) continue;
      const defaultDeclarations = new Set(file.getDefaultExportSymbol()?.getDeclarations());
      for (const assignment of file.getExportAssignments().filter(node => !node.isExportEquals())) {
        const expression = unwrapComponent(assignment.getExpression());
        if (!Node.isIdentifier(expression) && !Node.isPropertyAccessExpression(expression)) continue;
        const targets = declarationsOf(expression);
        if (!targets.length) continue;
        aliases.set(assignment, targets);
        for (const target of targets) defaultDeclarations.add(target);
      }
      const exported = new Set<Node>([...file.getExportedDeclarations().values()].flat());
      const candidates = [
        ...file.getFunctions(), ...file.getVariableDeclarations(), ...file.getClasses(),
        ...file.getExportAssignments().filter(node => !node.isExportEquals())
      ];
        for (const node of candidates) {
        if (aliases.has(node)) continue;
        const fn = callable(node);
        const initializer = Node.isVariableDeclaration(node) ? node.getInitializer() : undefined;
        const aliasOf = externalAlias(initializer, projectFiles);
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

    for (const file of files) {
      const relative = relativePath(file);
      const route = routesByFile.get(relative);
      if (!route || route.type === 'api' || isMetadata(route) || route.componentId) continue;
      const exported = file.getExportedDeclarations().get('default');
      route.componentId = exported?.flatMap(node => aliases.get(node) ?? [node])
        .map(node => resolveComponent(node)).find(Boolean)?.id;
    }

    const edges = new Map<string, ComponentEdge>();
    const componentCalls = new Set<Node>();
    type Imports = Map<Node, import('ts-morph').ImportDeclaration>;
    const importsByFile = new Map<SourceFile, Imports>();
    const importsFor = (file: SourceFile) => {
      const cached = importsByFile.get(file);
      if (cached) return cached;
      const imports: Imports = new Map();
      for (const declaration of file.getImportDeclarations()) {
        if (declaration.isTypeOnly()) continue;
        const imported = [declaration.getDefaultImport(), declaration.getNamespaceImport(),
          ...declaration.getNamedImports().filter(specifier => !specifier.isTypeOnly())
            .map(specifier => specifier.getAliasNode() ?? specifier.getNameNode())];
        for (const binding of imported) {
          for (const bindingDeclaration of binding?.getSymbol()?.getDeclarations() ?? []) imports.set(bindingDeclaration, declaration);
        }
      }

      importsByFile.set(file, imports);
      return imports;
    };
    const resolveHook = (expression: Node, imports: Imports) => {
      const binding = Node.isPropertyAccessExpression(expression) ? expression.getExpression() : expression;
      const original = binding.getSymbol()?.getDeclarations() ?? [];
      const imported = original.find(declaration => imports.has(declaration));
      const name = Node.isImportSpecifier(imported) ? imported.getName() :
        Node.isPropertyAccessExpression(expression) ? expression.getName() : expression.getText();
      if (!HOOK.test(name)) return;
      const importDeclaration = imported && imports.get(imported);
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
    const render = (tag: Node, from: string, body?: Node) => {
      const binding = rootBinding(tag);
      const targets = declarationsOf(tag).flatMap(declaration => {
        const assignment = declaration.getParent();
        if (Node.isPropertyAccessExpression(declaration) && Node.isBinaryExpression(assignment) &&
            assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken && assignment.getLeft() === declaration) {
          return declarationsOf(assignment.getRight());
        }
        return [declaration];
      }).map(node => resolveComponent(node)).filter(Boolean);
      if (!targets.length && binding !== tag) {
        targets.push(...declarationsOf(binding).map(node => resolveComponent(node)).filter(Boolean));
      }
      for (const target of targets) {
        addEdge(from, target?.id, 'renders');
        if (target && index && from !== target.id) index.render(from, target.id, tag.getStartLineNumber(), conditionalAt(tag, body));
      }
    };
    const componentTags = new Set<Node>();
    for (const [node, component] of components) {
      const body = bodies.get(node)!;
      const file = body.getSourceFile();
      const imports = importsFor(file);

      const usedHooks = new Set<string>();
      const inspect = (child: Node) => {
        if (Node.isIdentifier(child) || Node.isPropertyAccessExpression(child)) {
          if (!actionNames.has(child)) {
            for (const target of declarationsOf(child)) addEdge(component.id, actionIds.get(target), 'uses-action');
          }
        } else if (Node.isArrowFunction(child) || Node.isFunctionExpression(child)) {
          if (!Node.isVariableDeclaration(child.getParent())) addEdge(component.id, actionIds.get(child), 'uses-action');
        }
        if (Node.isJsxOpeningElement(child) || Node.isJsxSelfClosingElement(child)) {
          componentTags.add(child);
          render(child.getTagNameNode(), component.id, body);
        }
        if (Node.isIdentifier(child) || Node.isPropertyAccessExpression(child)) {
          const binding = Node.isPropertyAccessExpression(child) ? child.getExpression() : child;
          if (binding.getSymbol()?.getDeclarations().some(declaration => imports.has(declaration))) {
            for (const target of declarationsOf(child)) addEdge(component.id, resolveComponent(target)?.id, 'imports');
          }
        }
        if (!Node.isCallExpression(child)) return;
        componentCalls.add(child);
        const expression = child.getExpression();
        const [argument] = child.getArguments();
        if (argument && /(?:^|\.)createElement$/.test(expression.getText())) render(argument, component.id, body);
        const hook = resolveHook(expression, imports);
        if (hook) usedHooks.add(hook);
      };
      inspect(body);
      body.forEachDescendant(inspect);
      component.hooks = [...usedHooks];
    }

    const fileHooks = new Map<string, { hooks: string[]; isClient: boolean }>();
    for (const file of files) {
      const relative = relativePath(file);
      const from = `file:${relative}`;
      const usedHooks = new Set<string>();
      const aliasedHooks = new Set(file.getImportDeclarations().flatMap(declaration => declaration.getNamedImports())
        .filter(specifier => HOOK.test(specifier.getName())).flatMap(specifier => specifier.getAliasNode()?.getText() ?? []));
      file.forEachDescendant(node => {
        if ((Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) && !componentTags.has(node)) {
          render(node.getTagNameNode(), from);
        }
        if (!Node.isCallExpression(node) || componentCalls.has(node)) return;
        const expression = node.getExpression();
        const [argument] = node.getArguments();
        if (argument && /(?:^|\.)createElement$/.test(expression.getText())) render(argument, from);
        if (actions.size) {
          for (const declaration of declarationsOf(expression)) {
            const to = actionIds.get(declaration);
            addEdge(from, to, 'uses-action');
          }
        }
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
      collectRenameFacts(files, relativePath, symbols, facts);
      collectRenderFacts(routes, [...components.values()], [...edges.values()], files, bodies, relativePath, facts, index);
      collectApiFacts(files, routes, relativePath, actionIds, facts, callable, index);
    }
    return { index: index?.build(files, routes, components, aliases, relativePath, actionIds), facts, components: [...components.values()], hooks: [...hooks.values()], edges: [...edges.values()], actions: [...actions], fileHooks };
  }
}
