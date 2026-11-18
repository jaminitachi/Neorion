import { Node, SourceFile } from 'ts-morph';
import * as path from 'path';
import type { ComponentEdge, ComponentNode, HookNode, RouteNode } from '../types/GraphTypes';
import { DomainExtractor } from '../utils/DomainExtractor';
import { HTTP_METHODS, isClientFile } from './RouteAnalyzer';

const HOOK = /^use[A-Z0-9]/;

function declarationsOf(node: Node): Node[] {
  const symbol = node.getSymbol();
  return (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
}

function callable(node: Node) {
  if (Node.isFunctionDeclaration(node) && node.getBody()) return node;
  if (Node.isVariableDeclaration(node) || Node.isExportAssignment(node)) {
    let initializer: Node | undefined = Node.isVariableDeclaration(node) ? node.getInitializer() : node.getExpression();
    while (initializer) {
      if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) return initializer;
      if (Node.isParenthesizedExpression(initializer)) initializer = initializer.getExpression();
      else if (Node.isCallExpression(initializer) &&
               /(?:^|\.)(?:memo|forwardRef)$/.test(initializer.getExpression().getText())) {
        initializer = initializer.getArguments()[0];
      } else break;
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

export class ComponentAnalyzer {
  constructor(private readonly root: string) {}

  public analyze(files: SourceFile[], routes: RouteNode[]) {
    const components = new Map<Node, ComponentNode>();
    const bodies = new Map<Node, Node>();
    const hooks = new Map<string, HookNode>();
    const localHooks = new Map<Node, HookNode>();
    const routesByFile = new Map(routes.map(route => [route.file, route]));

    for (const file of files) {
      const relative = path.relative(this.root, file.getFilePath()).split(path.sep).join('/');
      const route = routesByFile.get(relative);
      if (route?.type === 'api') continue;

      const defaultDeclarations = new Set(file.getDefaultExportSymbol()?.getDeclarations().flatMap(node =>
        Node.isExportAssignment(node) ? [node, ...declarationsOf(node.getExpression())] : [node]) ?? []);
      const candidates = [
        ...file.getFunctions(), ...file.getVariableDeclarations(), ...file.getClasses(),
        ...file.getExportAssignments().filter(node => !node.isExportEquals())
      ];
      for (const node of candidates) {
        const fn = callable(node);
        const body = fn ? fn.getBody() :
          Node.isClassDeclaration(node) ? node.getInstanceMethod('render')?.getBody() : undefined;
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
        if (!(route && isDefault) && !hasRender(body)) continue;

        const id = `cmp:${relative}#${name}`;
        const parameter = fn?.getParameters()[0];
        const pattern = parameter?.getNameNode();
        const props = pattern && Node.isObjectBindingPattern(pattern)
          ? pattern.getElements().map(element =>
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
    }

    for (const file of files) {
      const relative = path.relative(this.root, file.getFilePath()).split(path.sep).join('/');
      const route = routesByFile.get(relative);
      if (!route || route.type === 'api' || route.componentId) continue;
      const exported = file.getExportedDeclarations().get('default');
      route.componentId = exported?.map(node => components.get(node)).find(Boolean)?.id;
    }

    const edges = new Map<string, ComponentEdge>();
    for (const [node, component] of components) {
      const addEdge = (target: Node, type: ComponentEdge['type']) => {
        const child = components.get(target);
        if (!child || child.id === component.id) return;
        const edge = { from: component.id, to: child.id, type };
        edges.set(JSON.stringify([type, edge.from, edge.to]), edge);
      };

      const file = node.getSourceFile();
      const imports = new Map<Node, string>();
      for (const declaration of file.getImportDeclarations()) {
        if (declaration.isTypeOnly()) continue;
        const module = declaration.getModuleSpecifierValue();
        const imported = [declaration.getDefaultImport(), declaration.getNamespaceImport(),
          ...declaration.getNamedImports().filter(specifier => !specifier.isTypeOnly())
            .map(specifier => specifier.getAliasNode() ?? specifier.getNameNode())];
        for (const binding of imported) {
          for (const declaration of binding?.getSymbol()?.getDeclarations() ?? []) imports.set(declaration, module);
        }
      }

      const usedHooks = new Set<string>();
      const inspect = (child: Node) => {
        if (Node.isJsxOpeningElement(child) || Node.isJsxSelfClosingElement(child)) {
          for (const target of declarationsOf(child.getTagNameNode())) addEdge(target, 'renders');
        }
        if (Node.isIdentifier(child) || Node.isPropertyAccessExpression(child)) {
          const binding = Node.isPropertyAccessExpression(child) ? child.getExpression() : child;
          if (binding.getSymbol()?.getDeclarations().some(declaration => imports.has(declaration))) {
            for (const target of declarationsOf(child)) addEdge(target, 'imports');
          }
        }
        if (!Node.isCallExpression(child)) return;
        const expression = child.getExpression();
        const [argument] = child.getArguments();
        if (argument && /(?:^|\.)createElement$/.test(expression.getText())) {
          for (const target of declarationsOf(argument)) addEdge(target, 'renders');
        }
        const binding = Node.isPropertyAccessExpression(expression) ? expression.getExpression() : expression;
        const original = binding.getSymbol()?.getDeclarations() ?? [];
        const imported = original.find(declaration => imports.has(declaration));
        const name = Node.isImportSpecifier(imported) ? imported.getName() :
          Node.isPropertyAccessExpression(expression) ? expression.getName() : expression.getText();
        if (!HOOK.test(name)) return;
        const local = declarationsOf(expression).map(target => localHooks.get(target)).find(hook => hook);
        if (local) {
          usedHooks.add(local.id);
        } else if (imported) {
          const specifier = imports.get(imported)!;
          const module = path.isAbsolute(specifier)
            ? path.relative(this.root, specifier).split(path.sep).join('/') : specifier;
          const id = `hook:${module}#${name}`;
          hooks.set(id, { id, name, module });
          usedHooks.add(id);
        }
      };
      const body = bodies.get(node)!;
      inspect(body);
      body.forEachDescendant(inspect);
      component.hooks = [...usedHooks];
    }

    return { components: [...components.values()], hooks: [...hooks.values()], edges: [...edges.values()] };
  }
}
