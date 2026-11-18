import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { ComponentEdge, ComponentNode, RouteNode } from '../types/GraphTypes';

export function declarationsOf(node: Node): Node[] {
  const symbol = node.getSymbol();
  return (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
}

export type DetailFacts = Map<string, Set<string>>;
export function addFact(facts: DetailFacts, file: string, fact: string) {
  const rows = facts.get(file) ?? new Set<string>();
  rows.add(fact);
  facts.set(file, rows);
}

type RelativePath = (source: SourceFile) => string;

export function collectRenameFacts(
  files: SourceFile[], relativePath: RelativePath,
  symbols: Map<Node, string>, facts: DetailFacts
) {
  // The checker follows path aliases and re-exports to the declaration.
  const exported = new Map<string, string>();
  for (const file of files) {
    for (const declarations of file.getExportedDeclarations().values()) {
      for (const declaration of declarations) {
        const id = symbols.get(declaration);
        if (id) exported.set(id, id.slice(0, id.lastIndexOf('#')));
      }
    }
  }
  const impacts: DetailFacts = new Map();
  for (const file of files) {
    const importer = relativePath(file);
    const record = (declarations: Node[]) => {
      for (const declaration of declarations) {
        const id = symbols.get(declaration);
        if (id && exported.has(id) && exported.get(id) !== importer) addFact(impacts, id, importer);
      }
    };
    const namespaces = new Set<Node>();
    for (const declaration of file.getImportDeclarations()) {
      const defaultImport = declaration.getDefaultImport();
      if (defaultImport) record(declarationsOf(defaultImport));
      const namespace = declaration.getNamespaceImport();
      if (namespace) for (const binding of namespace.getSymbol()?.getDeclarations() ?? []) namespaces.add(binding);
      for (const specifier of declaration.getNamedImports()) {
        const binding = specifier.getAliasNode() ?? specifier.getNameNode();
        const imported = declarationsOf(binding);
        record(imported);
        if (imported.some(Node.isSourceFile)) {
          for (const declaration of binding.getSymbol()?.getDeclarations() ?? []) namespaces.add(declaration);
        }
      }
    }
    for (const declaration of file.getExportDeclarations()) {
      if (!declaration.getModuleSpecifier()) continue;
      const named = declaration.getNamedExports();
      if (named.length) {
        for (const specifier of named) record(declarationsOf(specifier.getAliasNode() ?? specifier.getNameNode()));
      } else {
        for (const symbol of declaration.getModuleSpecifierSourceFile()?.getExportSymbols() ?? []) {
          if (symbol.getName() !== 'default' || declaration.getNamespaceExport()) record((symbol.getAliasedSymbol() ?? symbol).getDeclarations());
        }
      }
    }
    if (namespaces.size) file.forEachDescendant(node => {
      if (!Node.isPropertyAccessExpression(node) && !Node.isElementAccessExpression(node)) return;
      const expression = node.getExpression();
      let root = expression;
      while (Node.isPropertyAccessExpression(root) || Node.isElementAccessExpression(root)) root = root.getExpression();
      if (!root.getSymbol()?.getDeclarations().some(binding => namespaces.has(binding))) return;
      if (Node.isPropertyAccessExpression(node)) record(declarationsOf(node));
      else {
        const key = node.getArgumentExpression();
        if (!Node.isStringLiteral(key)) return;
        const symbol = expression.getType().getProperty(key.getLiteralText());
        if (symbol) record((symbol.getAliasedSymbol() ?? symbol).getDeclarations());
      }
    });
  }
  for (const [id, file] of exported) {
    const importers = impacts.get(id);
    if (importers?.size) {
      for (const importer of importers) addFact(facts, file, `rename ${id} <- ${importer}`);
    }
  }
}

function wrappedChains(body: Node, pagesApp: boolean, relativePath: RelativePath,
  bodies: Map<Node, Node>, seen = new Set<Node>(), pageParameter?: string): string[][] {
  if (seen.has(body)) return [];
  seen = new Set(seen).add(body);
  const chains = new Map<string, string[]>();
  const slots = new Set([pageParameter ?? (pagesApp ? 'Component' : 'children')]);
  const parameter = body.getParentIfKind(SyntaxKind.ArrowFunction) ??
    body.getParentIfKind(SyntaxKind.FunctionDeclaration) ?? body.getParentIfKind(SyntaxKind.FunctionExpression);
  const binding = parameter?.getParameters()[0]?.getNameNode();
  if (Node.isObjectBindingPattern(binding)) {
    for (const element of binding.getElements()) {
      if (element.getPropertyNameNode()?.getText() === (pagesApp ? 'Component' : 'children')) {
        slots.add(element.getNameNode().getText());
      }
    }
  }
  const isSlot = (node: Node | undefined) => {
    if (Node.isPropertyAccessExpression(node)) return slots.has(node.getName());
    return !!node && slots.has(node.getText());
  };
  const visit = (node: Node) => {
    const slot = pagesApp
      ? (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) &&
        isSlot(node.getTagNameNode())
      : Node.isJsxExpression(node) && isSlot(node.getExpression());
    if (!slot) return;
    let chain: string[][] = [[]];
    for (const element of node.getAncestors().reverse().filter(Node.isJsxElement)) {
      if (!element.getAncestors().includes(body) && element !== body) continue;
      if (element.getOpeningElement() === node) continue;
      const tag = element.getOpeningElement().getTagNameNode();
      const name = tag.getText();
      if (!/^[A-Z]/.test(name) && !name.endsWith('.Provider')) continue;
      const declarations = declarationsOf(tag);
      const definition = declarations.find(declaration => !declaration.getSourceFile().isDeclarationFile());
      const local = definition && bodies.get(definition);
      const module = (Node.isPropertyAccessExpression(tag) ? tag.getExpression() : tag).getSymbol()
        ?.getDeclarations()[0]?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue();
      const exportedName = Node.isFunctionDeclaration(definition) || Node.isClassDeclaration(definition) ||
        Node.isVariableDeclaration(definition) ? definition.getName() ?? name : name;
      const label = definition ? `${relativePath(definition.getSourceFile())}#${exportedName}` :
        module ? `${module}#${name}` : `${relativePath(tag.getSourceFile())}#${name}`;
      const nested = local ? wrappedChains(local, false, relativePath, bodies, seen) : [];
      chain = chain.flatMap(prefix => (nested.length ? nested : [[]]).map(next => [...prefix, label, ...next]));
    }
    for (const path of chain) chains.set(path.join(' > '), path);
  };
  visit(body);
  body.forEachDescendant(visit);
  return [...chains.values()];
}

// Pages Router applications can wrap the page before inserting it into _app.
function pageLayout(source: SourceFile | undefined, relativePath: RelativePath, bodies: Map<Node, Node>) {
  if (!source || !source.getFullText().includes('getLayout')) return [];
  const page = new Set<Node>(source.getExportedDeclarations().get('default') ?? []);
  const chains: string[][] = [];
  for (const statement of source.getStatements()) {
    if (!Node.isExpressionStatement(statement)) continue;
    const expression = statement.getExpression();
    if (!Node.isBinaryExpression(expression) ||
        expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const left = expression.getLeft();
    const right = expression.getRight();
    if (!Node.isPropertyAccessExpression(left) || left.getName() !== 'getLayout' ||
        !declarationsOf(left.getExpression()).some(declaration => page.has(declaration)) ||
        (!Node.isArrowFunction(right) && !Node.isFunctionExpression(right))) continue;
    const parameter = right.getParameters()[0]?.getNameNode();
    if (Node.isIdentifier(parameter)) {
      chains.push(...wrappedChains(right.getBody(), false, relativePath, bodies, new Set(), parameter.getText()));
    }
  }
  return chains;
}

export function collectRenderFacts(
  routes: RouteNode[], components: ComponentNode[], edges: ComponentEdge[],
  files: SourceFile[], bodies: Map<Node, Node>, relativePath: RelativePath, facts: DetailFacts
) {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== 'renders') continue;
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const filesByPath = new Map(files.map(file => [relativePath(file), file]));
  const layoutsByPage = new Map<string, string[]>();
  for (const layout of routes.filter(route => route.wraps).sort((a, b) => a.file.length - b.file.length)) {
    for (const page of layout.wraps!) {
      const layouts = layoutsByPage.get(page) ?? [];
      layouts.push(layout.file);
      layoutsByPage.set(page, layouts);
    }
  }
  const componentsById = new Map(components.map(component => [component.id, component]));
  const routesByFile = new Map(routes.map(route => [route.file, route]));
  const componentByBody = new Map([...bodies].flatMap(([node, body]) => {
    const suffix = Node.isFunctionDeclaration(node) || Node.isVariableDeclaration(node) || Node.isClassDeclaration(node)
      ? node.getName() ?? 'default' : 'default';
    const id = `cmp:${relativePath(node.getSourceFile())}#${suffix}`;
    return componentsById.has(id) ? [[body, id] as const] : [];
  }));
  const wrapperRoots = new Map<string, string>();
  const wrapperChains = new Map<string, string[][]>();
  const reached = new Map<string, RouteNode[]>();
  for (const route of routes.filter(route => route.type === 'page')) {
    const pagesRoot = /^(?:src\/)?pages\//.exec(route.file)?.[0];
    const layouts = layoutsByPage.get(route.id) ?? [];
    const app = pagesRoot && ['tsx', 'ts', 'jsx', 'js'].map(ext => pagesRoot + '_app.' + ext)
      .find(file => filesByPath.has(file));
    const wrappers = app ? [app] : layouts;
    let chains: string[][] = [[]];
    const seeds = [route.componentId, `file:${route.file}`];
    for (const wrapper of wrappers) {
      if (!wrapperChains.has(wrapper)) {
        const source = filesByPath.get(wrapper);
        const exported = source?.getExportedDeclarations().get('default') ?? [];
        const body = exported.map(node => bodies.get(node)).find(Boolean);
        const component = routesByFile.get(wrapper)?.componentId ?? (body && componentByBody.get(body));
        if (component) wrapperRoots.set(wrapper, component);
        wrapperChains.set(wrapper, body ? wrappedChains(body, !!app, relativePath, bodies) : []);
      }
      seeds.push(wrapperRoots.get(wrapper), `file:${wrapper}`);
      const paths = wrapperChains.get(wrapper)!;
      chains = chains.flatMap(prefix => (paths.length ? paths : [[]]).map(next => [...prefix, wrapper, ...next]));
    }
    if (app && filesByPath.get(app)?.getFullText().includes('getLayout')) {
      const pageChains = pageLayout(filesByPath.get(route.file), relativePath, bodies);
      if (pageChains.length) chains = chains.flatMap(prefix => pageChains.map(chain => [...prefix, ...chain]));
    }
    for (const chain of chains) {
      if (chain.length) addFact(facts, route.file, `wrap ${route.file} <- ${chain.join(' > ')}`);
    }
    const visited = new Set<string>();
    while (seeds.length) {
      const id = seeds.pop();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const pages = reached.get(id) ?? [];
      pages.push(route);
      reached.set(id, pages);
      for (const target of outgoing.get(id) ?? []) seeds.push(target);
    }
  }
  // A shared layout can make one component reachable from hundreds of pages.
  for (const [id, pages] of reached) {
    const component = componentsById.get(id);
    if (!component) continue;
    const subject = `${component.path}#${component.name}`;
    if (pages.length > 8) addFact(facts, component.path, `rendered ${subject} <- ${pages.length} pages (list omitted)`);
    else for (const page of pages) addFact(facts, component.path, `rendered ${subject} <- ${page.file} ${page.path}`);
  }
}

function apiSegments(argument: Node | undefined): string[] | undefined {
  let url: string;
  if (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)) url = argument.getLiteralText();
  else if (Node.isTemplateExpression(argument)) {
    url = argument.getHead().getLiteralText() +
      argument.getTemplateSpans().map(span => '{}' + span.getLiteral().getLiteralText()).join('');
  } else return;
  if (url.startsWith('/api/')) return url.split(/[?#]/, 1)[0].replace(/\/$/, '').slice(1).split('/');
}

export function collectApiFacts(files: SourceFile[], routes: RouteNode[], relativePath: RelativePath,
  actionIds: Map<Node, string>, facts: DetailFacts, callable: (node: Node) => Node | undefined) {
  const endpoints = routes.filter(route => route.type === 'api').map(route => ({
    route,
    segments: route.path.slice(1).split('/')
  }));
  if (!endpoints.length) return;
  const endpointsByCall = new Map<Node, RouteNode[]>();
  const projectFiles = new Set(files);
  for (const file of files) {
    if (!file.getFullText().includes('/api/')) continue;
    const source = relativePath(file);
    file.forEachDescendant(node => {
      if (!Node.isCallExpression(node) || !/^(?:(?:globalThis|window)\.)?fetch$/.test(node.getExpression().getText())) return;
      if (declarationsOf(node.getExpression()).some(declaration => !declaration.getSourceFile().isDeclarationFile())) return;
      const [argument, options] = node.getArguments();
      const segments = apiSegments(argument);
      if (!segments) return;
      const methodProperty = Node.isObjectLiteralExpression(options) ? options.getProperty('method') : undefined;
      const methodValue = Node.isPropertyAssignment(methodProperty) ? methodProperty.getInitializer() : undefined;
      const method = Node.isStringLiteral(methodValue) ? methodValue.getLiteralText().toUpperCase() :
        options && (!Node.isObjectLiteralExpression(options) || methodProperty ||
          options.getProperties().some(Node.isSpreadAssignment)) ? undefined : 'GET';
      const compatible = endpoints.filter(({ segments: pattern }) => pattern.every((part, i) => {
        if (part.startsWith('[[...')) return true;
        if (!segments[i]) return false;
        if (part.startsWith('[...')) return true;
        return part.startsWith('[') || part === segments[i];
      }) && (pattern[pattern.length - 1]?.includes('...') || pattern.length === segments.length));
      const specificity = ({ segments }: typeof endpoints[number]) =>
        segments.map(part => part.startsWith('[[...') ? '0' : part.startsWith('[...') ? '1' :
          part.startsWith('[') ? '2' : '3').join('');
      compatible.sort((a, b) => specificity(b).localeCompare(specificity(a)));
      const action = node.getAncestors().map(parent => actionIds.get(parent)).find(Boolean);
      for (const candidate of compatible) {
        if (specificity(candidate) !== specificity(compatible[0])) break;
        const { route } = candidate;
        if (method && route.methods?.length && !route.methods.some(value => value === method || value === 'ALL' ||
          (method === 'HEAD' && value === 'GET'))) continue;
        const subject = action ? action.slice('action:'.length) : source;
        const owner = action ? subject.slice(0, subject.lastIndexOf('#')) : source;
        addFact(facts, owner, `fetch ${subject} -> ${route.file} ${route.path}`);
        const targets = endpointsByCall.get(node) ?? [];
        targets.push(route);
        endpointsByCall.set(node, targets);
      }
    });
  }

  if (!endpointsByCall.size) return;
  const callsByBody = new Map<Node, { direct: Set<RouteNode>; callees: Set<Node> }>();
  const inspect = (root: Node) => {
    const cached = callsByBody.get(root);
    if (cached) return cached;
    const direct = new Set<RouteNode>();
    const callees = new Set<Node>();
    const visit = (node: Node) => {
      if (!Node.isCallExpression(node)) return;
      for (const endpoint of endpointsByCall.get(node) ?? []) direct.add(endpoint);
      for (const declaration of declarationsOf(node.getExpression())) {
        if (!projectFiles.has(declaration.getSourceFile())) continue;
        const fn = callable(declaration);
        if (fn) callees.add(fn);
      }
    };
    visit(root);
    root.forEachDescendant((node, traversal) => {
      // Lexically nested functions are inspected once reached through a call.
      if (Node.isFunctionLikeDeclaration(node)) traversal.skip();
      else visit(node);
    });
    const result = { direct, callees };
    callsByBody.set(root, result);
    return result;
  };
  for (const [fn, id] of actionIds) {
    if (!Node.isFunctionDeclaration(fn) && !Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) continue;
    const subject = id.slice('action:'.length);
    const source = subject.slice(0, subject.lastIndexOf('#'));
    const visited = new Set<Node>();
    const pending: Node[] = [fn];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const { direct, callees } = inspect(current);
      for (const route of direct) addFact(facts, source, `fetch ${subject} -> ${route.file} ${route.path}`);
      for (const callee of callees) pending.push(callee);
    }
  }

}
