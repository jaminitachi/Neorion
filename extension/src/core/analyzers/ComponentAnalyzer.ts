import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import type { ComponentEdge, ComponentNode, HookNode, RouteNode } from '../types/GraphTypes';
import { DomainExtractor } from '../utils/DomainExtractor';
import { hasDirective, HTTP_METHODS, isClientFile } from './RouteAnalyzer';

type NodeWithBody = import('ts-morph').FunctionDeclaration | import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression;

const HOOK = /^use[A-Z0-9]/;

function declarationsOf(node: Node): Node[] {
  const symbol = node.getSymbol();
  return (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
}

function rootBinding(node: Node): Node {
  while (Node.isPropertyAccessExpression(node)) node = node.getExpression();
  return node;
}

function isPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('#') &&
    !path.isAbsolute(specifier) && !path.win32.isAbsolute(specifier);
}

function isRadixAlias(node: Node | undefined): node is import('ts-morph').PropertyAccessExpression {
  if (!Node.isPropertyAccessExpression(node)) return false;
  return (rootBinding(node).getSymbol()?.getDeclarations() ?? []).some(binding => {
    const specifier = binding.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue();
    return specifier === 'radix-ui' || specifier?.startsWith('@radix-ui/react-');
  });
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

  public analyze(files: SourceFile[], routes: RouteNode[]) {
    const components = new Map<Node, ComponentNode>();
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
      const candidates = [
        ...file.getFunctions(), ...file.getVariableDeclarations(), ...file.getClasses(),
        ...file.getExportAssignments().filter(node => !node.isExportEquals())
      ];
      const exported = new Set<Node>([...file.getExportedDeclarations().values()].flat());
      for (const node of candidates) {
        if (aliases.has(node)) continue;
        const fn = callable(node);
        const initializer = Node.isVariableDeclaration(node) && exported.has(node) ? node.getInitializer() : undefined;
        const radixAlias = isRadixAlias(initializer) ? initializer : undefined;
        const body = fn ? fn.getBody() : radixAlias ??
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
        if (!radixAlias && !(route && isDefault) && !hasRender(body)) continue;

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
          domain: DomainExtractor.extract('/' + relative), props, hooks: [], description
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

    const rendersExternal = (tag: Node, seen = new Set<Node>()): boolean => {
      if (Node.isParenthesizedExpression(tag)) return rendersExternal(tag.getExpression(), seen);
      if (Node.isConditionalExpression(tag)) {
        return rendersExternal(tag.getWhenTrue(), new Set(seen)) && rendersExternal(tag.getWhenFalse(), seen);
      }
      if (Node.isStringLiteral(tag)) return /^[a-z]/.test(tag.getLiteralText());
      if (!Node.isIdentifier(tag) && !Node.isPropertyAccessExpression(tag)) return false;
      const binding = rootBinding(tag);
      if (seen.has(binding)) return false;
      seen.add(binding);
      const symbol = binding.getSymbol();
      for (const node of symbol?.getDeclarations() ?? []) {
        const declaration = node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
        if (declaration && !declaration.isTypeOnly() &&
            isPackageSpecifier(declaration.getModuleSpecifierValue())) {
          const source = declaration.getModuleSpecifierSourceFile();
          if (!source || !projectFiles.has(source)) return true;
        }
      }
      return declarationsOf(binding).some(node => {
        if (!Node.isVariableDeclaration(node)) return false;
        const initializer = node.getInitializer();
        return initializer !== undefined && rendersExternal(initializer, new Set(seen));
      });
    };

    const edges = new Map<string, ComponentEdge>();
    for (const [node, component] of components) {
      const addEdge = (to: string | undefined, type: ComponentEdge['type']) => {
        if (!to || to === component.id) return;
        const edge = { from: component.id, to, type };
        edges.set(JSON.stringify([type, edge.from, edge.to]), edge);
      };

      const body = bodies.get(node)!;
      const file = body.getSourceFile();
      const imports = new Map<Node, import('ts-morph').ImportDeclaration>();
      for (const declaration of file.getImportDeclarations()) {
        if (declaration.isTypeOnly()) continue;
        const imported = [declaration.getDefaultImport(), declaration.getNamespaceImport(),
          ...declaration.getNamedImports().filter(specifier => !specifier.isTypeOnly())
            .map(specifier => specifier.getAliasNode() ?? specifier.getNameNode())];
        for (const binding of imported) {
          for (const bindingDeclaration of binding?.getSymbol()?.getDeclarations() ?? []) imports.set(bindingDeclaration, declaration);
        }
      }

      const usedHooks = new Set<string>();
      let primitiveCandidate = /^(?:src\/)?components\/ui\//.test(component.path);
      const render = (tag: Node) => {
        const binding = rootBinding(tag);
        const targets = declarationsOf(tag).map(node => resolveComponent(node)).filter(Boolean);
        if (!targets.length && binding !== tag) {
          targets.push(...declarationsOf(binding).map(node => resolveComponent(node)).filter(Boolean));
        }
        for (const target of targets) addEdge(target?.id, 'renders');
        const intrinsic = (Node.isIdentifier(tag) && /^[a-z]/.test(tag.getText())) ||
          (Node.isStringLiteral(tag) && /^[a-z]/.test(tag.getLiteralText()));
        if (!intrinsic && !targets.length && !rendersExternal(tag)) primitiveCandidate = false;
      };
      const inspect = (child: Node) => {
        if (Node.isIdentifier(child) || Node.isPropertyAccessExpression(child)) {
          if (!actionNames.has(child)) {
            for (const target of declarationsOf(child)) addEdge(actionIds.get(target), 'uses-action');
          }
        } else if (Node.isArrowFunction(child) || Node.isFunctionExpression(child)) {
          if (!Node.isVariableDeclaration(child.getParent())) addEdge(actionIds.get(child), 'uses-action');
        }
        if (Node.isJsxOpeningElement(child) || Node.isJsxSelfClosingElement(child)) {
          render(child.getTagNameNode());
        }
        if (Node.isIdentifier(child) || Node.isPropertyAccessExpression(child)) {
          const binding = Node.isPropertyAccessExpression(child) ? child.getExpression() : child;
          if (binding.getSymbol()?.getDeclarations().some(declaration => imports.has(declaration))) {
            for (const target of declarationsOf(child)) addEdge(resolveComponent(target)?.id, 'imports');
          }
        }
        if (!Node.isCallExpression(child)) return;
        const expression = child.getExpression();
        const [argument] = child.getArguments();
        if (argument && /(?:^|\.)createElement$/.test(expression.getText())) render(argument);
        const binding = Node.isPropertyAccessExpression(expression) ? expression.getExpression() : expression;
        const original = binding.getSymbol()?.getDeclarations() ?? [];
        const imported = original.find(declaration => imports.has(declaration));
        const name = Node.isImportSpecifier(imported) ? imported.getName() :
          Node.isPropertyAccessExpression(expression) ? expression.getName() : expression.getText();
        if (['getState', 'setState', 'subscribe', 'dispatch'].includes(name)) primitiveCandidate = false;
        if (!HOOK.test(name)) return;
        primitiveCandidate = false;
        const importDeclaration = imported && imports.get(imported);
        const specifier = importDeclaration?.getModuleSpecifierValue();
        if (specifier === 'react' || specifier === 'react-dom') return;
        const targets = declarationsOf(expression);
        const local = targets.map(target => localHooks.get(target)).find(hook => hook);
        if (local) {
          usedHooks.add(local.id);
          return;
        }
        const source = targets.map(target => target.getSourceFile()).find(target => projectFiles.has(target)) ??
          importDeclaration?.getModuleSpecifierSourceFile();
        if (source && projectFiles.has(source)) {
          const path = relativePath(source);
          const id = `hook:${path}#${name}`;
          hooks.set(id, { id, path, name });
          usedHooks.add(id);
        } else if (specifier && isPackageSpecifier(specifier)) {
          const id = `hook:${specifier}#${name}`;
          hooks.set(id, { id, name, module: specifier });
          usedHooks.add(id);
        }
      };
      inspect(body);
      body.forEachDescendant(inspect);
      component.hooks = [...usedHooks];
      component.primitiveCandidate = primitiveCandidate;
    }

    return { components: [...components.values()], hooks: [...hooks.values()], edges: [...edges.values()], actions: [...actions] };
  }
}
