import type { QueryIndexBuilder } from './QueryIndexBuilder';
import type { Wrapper } from '../../mcp/Index';
import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import { UI_TARGET } from '../types/GraphPaths';
import type { ComponentEdge, ComponentNode, DetailFacts, RouteNode } from '../types/GraphTypes';

export function declarationsOf(node: Node): Node[] {
  const symbol = node.getSymbol();
  return (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
}

function addFact(facts: DetailFacts, file: string, fact: string, depth = 1, fanOut = 1, layoutOnly = false) {
  const rows = facts.get(file) ?? new Map();
  rows.set(fact, { depth: Math.max(rows.get(fact)?.depth ?? 0, depth), fanOut, layoutOnly });
  facts.set(file, rows);
}

const MAX_LISTED_IMPORTERS = 8;

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
        if (id && !UI_TARGET.test(id)) exported.set(id, id.slice(0, id.lastIndexOf('#')));
      }
    }
  }
  const impacts = new Map<string, Set<string>>();
  const reExported = new Set<string>();
  for (const file of files) {
    const importer = relativePath(file);
    const record = (declarations: Node[], reExport = false) => {
      for (const declaration of declarations) {
        const id = symbols.get(declaration);
        if (!id || !exported.has(id) || exported.get(id) === importer) continue;
        const importers = impacts.get(id) ?? new Set<string>();
        importers.add(importer);
        if (reExport) reExported.add(id);
        impacts.set(id, importers);
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
      for (const specifier of declaration.getNamedExports()) {
        record(declarationsOf(specifier.getAliasNode() ?? specifier.getNameNode()), true);
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
    if (!importers?.size) continue;
    const depth = reExported.has(id) ? 2 : 1;
    if (importers.size > MAX_LISTED_IMPORTERS) {
      addFact(facts, file, `rename ${id} <- ${importers.size} files (list omitted)`, depth, importers.size);
    } else {
      for (const importer of importers) addFact(facts, file, `rename ${id} <- ${importer}`, depth, importers.size);
    }
  }
}

interface WrapperChain {
  path: string[];
  locations: Wrapper[];
  conditional?: boolean;
}

const emptyChain: WrapperChain = { path: [], locations: [] };

function returnsFromBranch(node: Node): boolean {
  if (Node.isReturnStatement(node)) return true;
  if (Node.isBlock(node)) return node.getStatements().some(returnsFromBranch);
  if (!Node.isIfStatement(node)) return false;
  const otherwise = node.getElseStatement();
  return !!otherwise && returnsFromBranch(node.getThenStatement()) && returnsFromBranch(otherwise);
}

function followsEarlyReturn(node: Node, block: Node): boolean {
  if (!Node.isBlock(block)) return false;
  for (const statement of block.getStatements()) {
    if (statement === node) break;
    if (!Node.isIfStatement(statement)) continue;
    const otherwise = statement.getElseStatement();
    if (returnsFromBranch(statement.getThenStatement()) || (otherwise && returnsFromBranch(otherwise))) return true;
  }
  return false;
}

function conditionalChild(node: Node, parent: Node) {
  return (Node.isConditionalExpression(parent) && parent.getCondition() !== node) ||
    (Node.isIfStatement(parent) && parent.getExpression() !== node) ||
    Node.isCaseClause(parent) || Node.isDefaultClause(parent) || followsEarlyReturn(node, parent) ||
    (Node.isBinaryExpression(parent) && parent.getRight() === node &&
      [SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken]
        .includes(parent.getOperatorToken().getKind()));
}

export function conditionalAt(node: Node, boundary?: Node): number {
  for (let parent = node.getParent(); parent && node !== boundary; node = parent, parent = parent.getParent()) {
    if (conditionalChild(node, parent)) return 1;
  }
  return 0;
}

function wrappedChains(body: Node, pagesApp: boolean, relativePath: RelativePath,
  bodies: Map<Node, Node>, seen = new Set<Node>(), pageParameter?: string): WrapperChain[] {
  if (seen.has(body)) return [];
  seen = new Set(seen).add(body);
  const chains = new Map<string, WrapperChain>();
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
    const ancestors: Node[] = [];
    let conditional = false;
    for (let child = node; child !== body;) {
      const parent = child.getParentOrThrow();
      conditional ||= conditionalChild(child, parent);
      ancestors.push(parent);
      child = parent;
    }
    let chain: WrapperChain[] = [{ path: [], locations: [], conditional }];
    for (const element of ancestors.reverse().filter(Node.isJsxElement)) {
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
      const location: Wrapper = {
        file: relativePath((definition ?? tag).getSourceFile()),
        symbol: exportedName, line: (definition ?? tag).getStartLineNumber(), conditional,
        external: definition ? undefined : module
      };
      const nested = local ? wrappedChains(local, false, relativePath, bodies, seen) : [];
      chain = chain.flatMap(prefix => (nested.length ? nested : [emptyChain]).map(next => ({
        path: [...prefix.path, label, ...next.path],
        locations: [...prefix.locations, location, ...next.locations],
        conditional: prefix.conditional || next.conditional
      })));
    }
    for (const entry of chain) chains.set(JSON.stringify([entry.path, !!entry.conditional]), entry);
  };
  visit(body);
  body.forEachDescendant(visit);
  return [...chains.values()];
}

// Pages Router applications can wrap the page before inserting it into _app.
function pageLayout(source: SourceFile | undefined, relativePath: RelativePath, bodies: Map<Node, Node>) {
  if (!source || !source.getFullText().includes('getLayout')) return [];
  const page = new Set<Node>(source.getExportedDeclarations().get('default') ?? []);
  const chains: WrapperChain[] = [];
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
  files: SourceFile[], bodies: Map<Node, Node>, relativePath: RelativePath, facts: DetailFacts, index?: QueryIndexBuilder
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
  const wrapperLocations = new Map<string, Wrapper>();
  const wrapperRoots = new Map<string, string>();
  const wrapperChains = new Map<string, WrapperChain[]>();
  const reached = new Map<string, { page: RouteNode; viaLayout: boolean; depth: number }[]>();
  for (const route of routes.filter(route => route.type === 'page')) {
    const pagesRoot = /^(?:src\/)?pages\//.exec(route.file)?.[0];
    const layouts = layoutsByPage.get(route.id) ?? [];
    const app = pagesRoot && ['tsx', 'ts', 'jsx', 'js'].map(ext => pagesRoot + '_app.' + ext)
      .find(file => filesByPath.has(file));
    const wrappers = app ? [app] : layouts;
    let chains = [emptyChain];
    const layoutSeeds: (string | undefined)[] = [];
    for (const wrapper of wrappers) {
      if (!wrapperChains.has(wrapper)) {
        const source = filesByPath.get(wrapper);
        const exported = source?.getExportedDeclarations().get('default') ?? [];
        const body = exported.map(node => bodies.get(node)).find(Boolean);
        const component = routesByFile.get(wrapper)?.componentId ?? (body && componentByBody.get(body));
        if (component) wrapperRoots.set(wrapper, component);
        const definition = exported[0];
        wrapperLocations.set(wrapper, {
          file: wrapper, symbol: component && componentsById.get(component)?.name || 'default',
          line: definition?.getSourceFile() === source ? definition?.getStartLineNumber() ?? 1 : 1, conditional: false
        });
        wrapperChains.set(wrapper, body ? wrappedChains(body, !!app, relativePath, bodies) : []);
      }
      layoutSeeds.push(wrapperRoots.get(wrapper), `file:${wrapper}`);
      const paths = wrapperChains.get(wrapper)!;
      chains = chains.flatMap(prefix => (paths.length ? paths : [emptyChain]).map(next => ({
        path: [...prefix.path, wrapper, ...next.path],
        locations: [...prefix.locations, wrapperLocations.get(wrapper)!, ...next.locations],
        conditional: prefix.conditional || next.conditional
      })));
    }
    if (app && filesByPath.get(app)?.getFullText().includes('getLayout')) {
      const pageChains = pageLayout(filesByPath.get(route.file), relativePath, bodies);
      if (pageChains.length) chains = chains.flatMap(prefix => pageChains.map(chain => ({
        path: [...prefix.path, ...chain.path],
        locations: [...prefix.locations, ...chain.locations],
        conditional: prefix.conditional || chain.conditional
      })));
    }
    index?.page(route.id, layoutSeeds, chains.map(chain => chain.locations));
    for (const { path, conditional } of chains) {
      if (path.length) addFact(facts, route.file, `wrap ${route.file} <- ${path.join(' > ')}${conditional ? ' (conditional)' : ''}`, path.length);
    }
    const visited = new Set<string>();
    const layoutRoots = new Set(layoutSeeds);
    const traverse = (seeds: (string | undefined)[], viaLayout: boolean) => {
      const queue = seeds.map(id => ({ id, depth: 0 }));
      for (let i = 0; i < queue.length; i++) {
        const { id, depth } = queue[i];
        if (!id || visited.has(id)) continue;
        visited.add(id);
        const component = componentsById.get(id);
        if (component && !(id === route.componentId && component.path === route.file) &&
            !(viaLayout && layoutRoots.has(id))) {
          const pages = reached.get(id) ?? [];
          pages.push({ page: route, viaLayout, depth });
          reached.set(id, pages);
        }
        for (const target of outgoing.get(id) ?? []) queue.push({ id: target, depth: depth + 1 });
      }
    };
    traverse([route.componentId, `file:${route.file}`], false);
    traverse(layoutSeeds, true);
  }
  // Keep layout-only reachability distinct from rendering by the page.
  for (const [id, pages] of reached) {
    const component = componentsById.get(id)!;
    const subject = `${component.path}#${component.name}`;
    // Reachability confined to the page's own file is readily visible in source.
    const depth = pages.reduce((max, entry) => entry.page.file === component.path
      ? max : Math.max(max, entry.depth), 0);
    const layoutOnly = pages.every(entry => entry.viaLayout);
    if (pages.length > 8) {
      const viaLayout = pages.filter(entry => entry.viaLayout).length;
      addFact(facts, component.path, `rendered ${subject} <- ${pages.length} pages (list omitted${viaLayout ? `; ${viaLayout} via layout` : ''})`, depth, pages.length, layoutOnly);
    } else {
      for (const { page, viaLayout } of pages) {
        addFact(facts, component.path, `rendered ${subject} <- ${page.file} ${page.path}${viaLayout ? ' (via layout)' : ''}`, depth, pages.length, layoutOnly);
      }
    }
  }
}

const localApi = /^\/api(?:[/?#]|$)/;

function addition(node: Node | undefined) {
  return Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken ? node : undefined;
}

function wrappedExpression(node: Node) {
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) ||
      Node.isTypeAssertion(node) || Node.isSatisfiesExpression(node) || Node.isNonNullExpression(node)) {
    return node.getExpression();
  }
}

type UrlText = { text: string; dynamic?: true; placeholders?: true };

function urlText(node: Node | undefined, seen = new Set<Node>()): UrlText | undefined {
  if (!node || seen.has(node)) return;
  seen.add(node);
  try {
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
      return { text: node.getLiteralText() };
    }
    const wrapped = wrappedExpression(node);
    if (wrapped) return urlText(wrapped, seen);
    if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
      const [declaration] = declarationsOf(node);
      if (Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === 'const') {
        return urlText(declaration.getInitializer(), seen);
      }
    }
    const plus = addition(node);
    if (plus) {
      const left = urlText(plus.getLeft(), seen);
      if (!left || left.dynamic) return left;
      const right = urlText(plus.getRight(), seen);
      if (localApi.test(left.text) && (left.placeholders || !right || right.placeholders)) {
        const known = left.placeholders ? left.text : left.text + (right?.text ?? '');
        return { text: known.split('{}', 1)[0], dynamic: true };
      }
      if (right && !left.placeholders && !right.placeholders) {
        return { text: left.text + right.text, dynamic: right.dynamic };
      }
    }
    if (Node.isTemplateExpression(node)) {
      let text = node.getHead().getLiteralText();
      let placeholders: true | undefined;
      let prefixSlot = false;
      for (const [i, span] of node.getTemplateSpans().entries()) {
        const expression = span.getExpression();
        const value = urlText(expression, seen);
        if (i === 0 && !text && value && localApi.test(value.text)) {
          prefixSlot = true;
        }
        if (value?.dynamic || (prefixSlot && (!value || value.placeholders))) {
          return { text: text + (value?.text.split('{}', 1)[0] ?? ''), dynamic: true };
        }
        if (!value || value.placeholders) placeholders = true;
        text += (value && !value.placeholders ? value.text : '{}') + span.getLiteral().getLiteralText();
      }
      return { text, placeholders };
    }
  } finally {
    seen.delete(node);
  }
}

function apiSegments(argument: Node | undefined) {
  const url = urlText(argument);
  if (!url) return;
  const prefix = /^(?:\{\}|https?:\/\/[^/?#]+)(?=\/api(?:[/?#]|$))/.exec(url.text)?.[0];
  const local = prefix ? url.text.slice(prefix.length) : url.text;
  if (localApi.test(local)) {
    const [pathname] = local.split(/[?#]/, 1);
    const segments = (url.placeholders && !url.dynamic ? pathname.replace(/\/$/, '') : pathname).slice(1).split('/');
    return { segments, dynamic: url.dynamic, pathFixed: pathname !== local,
      partial: !!prefix, markdown: !prefix || prefix === '{}' };
  }
}

function matchesDynamicPrefix(pattern: string[], segments: string[], pathFixed: boolean) {
  return segments.every((segment, i) => {
    if (pattern[i]?.startsWith('[')) return !!segment || !pathFixed;
    if (pattern.slice(0, i).some(part => part.includes('...'))) return !!segment || !pathFixed;
    return !pathFixed && i === segments.length - 1 ? pattern[i]?.startsWith(segment) : pattern[i] === segment;
  }) && (!pathFixed || pattern.length === segments.length || !!pattern.at(-1)?.includes('...'));
}

function swrUrls(key: Node | undefined, seen = new Set<Node>()): Node[] {
  if (!key || seen.has(key)) return [];
  seen = new Set(seen).add(key);
  if (Node.isConditionalExpression(key)) {
    return [...swrUrls(key.getWhenTrue(), seen), ...swrUrls(key.getWhenFalse(), seen)];
  }
  if (Node.isBinaryExpression(key) && key.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
    return swrUrls(key.getRight(), seen);
  }
  if (Node.isArrayLiteralExpression(key)) return swrUrls(key.getElements()[0], seen);
  if (Node.isParenthesizedExpression(key) || Node.isAsExpression(key)) return swrUrls(key.getExpression(), seen);
  if (Node.isIdentifier(key)) {
    return declarationsOf(key).flatMap(declaration =>
      Node.isVariableDeclaration(declaration) && declaration.getSourceFile() === key.getSourceFile() &&
      declaration.getVariableStatement()?.getDeclarationKind() === 'const'
        ? swrUrls(declaration.getInitializer(), seen) : []);
  }
  return [key];
}

function importOrigin(expression: Node) {
  const binding = Node.isPropertyAccessExpression(expression) ? expression.getExpression() : expression;
  const declaration = binding.getSymbol()?.getDeclarations()[0];
  const imported = declaration?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  return {
    module: imported?.getModuleSpecifierValue(),
    name: Node.isImportSpecifier(declaration) ? declaration.getName() :
      Node.isPropertyAccessExpression(expression) ? expression.getName() : 'default'
  };
}

export function collectApiFacts(files: SourceFile[], routes: RouteNode[], relativePath: RelativePath,
  actionIds: Map<Node, string>, facts: DetailFacts, callable: (node: Node) => Node | undefined, index?: QueryIndexBuilder) {
  const endpoints = routes.filter(route => route.type === 'api').map(route => ({
    route,
    segments: route.path.slice(1).split('/')
  })).map(endpoint => ({ ...endpoint, rank: endpoint.segments.map(part =>
    part.startsWith('[[...') ? '0' : part.startsWith('[...') ? '1' : part.startsWith('[') ? '2' : '3').join('') }));
  if (!endpoints.length) return;
  endpoints.sort((a, b) => b.rank.localeCompare(a.rank));
  const urlMatches = (parsed: NonNullable<ReturnType<typeof apiSegments>>) => {
    const { segments, partial } = parsed;
    if (parsed.dynamic) {
      return endpoints.filter(({ segments: pattern }) => matchesDynamicPrefix(pattern, segments, parsed.pathFixed))
        .map(({ route }) => ({ route, partial: true, markdown: false, dynamic: true }));
    }
    const matches: { route: RouteNode; partial: boolean; markdown: boolean; dynamic?: boolean }[] = [];
    let bestCertain: string | undefined;
    let moreSpecificMatch = false;
    for (const endpoint of endpoints) {
      const { route, segments: pattern, rank } = endpoint;
      if (bestCertain && rank < bestCertain) break;
      let uncertain = false;
      const compatible = pattern.every((part, i) => {
        if (part.startsWith('[[...')) return true;
        const segment = segments[i];
        if (!segment) return false;
        if (part.startsWith('[') || part === segment) return true;
        if (!segment.includes('{}')) return false;
        const regex = segment.split('{}').map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        if (!new RegExp(`^${regex}$`).test(part)) return false;
        uncertain = true;
        return true;
      }) && (pattern.at(-1)?.includes('...') || pattern.length === segments.length);
      if (!compatible) continue;
      if (!uncertain) bestCertain = rank;
      matches.push({ route,
        partial: partial || uncertain || moreSpecificMatch || segments.some(segment => segment.includes('{}') && segment !== '{}'),
        markdown: !uncertain && parsed.markdown });
      moreSpecificMatch ||= uncertain;
    }
    return matches;
  };
  type Endpoint = { route: RouteNode; kind: string };
  const endpointsByCall = new Map<Node, Endpoint[]>();
  const projectFiles = new Set(files);
  for (const file of files) {
    if (!/\/api|\\(?:x|u|\/)/.test(file.getFullText()) && !file.getImportDeclarations().length) continue;
    const literals: Node[] = [];
    const classified = new Set<Node>();
    const classify = (url: Node) => {
      classified.add(url);
      const wrapped = wrappedExpression(url);
      const plus = addition(url);
      if (wrapped) classify(wrapped);
      else if (plus) {
        classify(plus.getLeft());
        classify(plus.getRight());
      } else if (Node.isTemplateExpression(url)) {
        for (const span of url.getTemplateSpans()) classify(span.getExpression());
      }
    };
    const source = relativePath(file);
    const usesHttpLibrary = file.getImportDeclarations().some(declaration =>
      ['swr', 'swr/immutable', 'axios'].includes(declaration.getModuleSpecifierValue()));
    file.forEachDescendant(node => {
      if (index && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isTemplateExpression(node) || addition(node))) {
        literals.push(node);
      }
      if (!Node.isCallExpression(node)) return;
      const expression = node.getExpression();
      const isFetch = /^(?:(?:globalThis|window)\.)?fetch$/.test(expression.getText()) &&
        !declarationsOf(expression).some(declaration => !declaration.getSourceFile().isDeclarationFile());
      const origin = !isFetch && usesHttpLibrary ? importOrigin(expression) : undefined;
      const isSwr = (origin?.module === 'swr' || origin?.module === 'swr/immutable') &&
        ['default', 'useSWR', 'mutate'].includes(origin.name);
      const axiosMethod = origin?.module === 'axios' &&
        ['get', 'delete', 'head', 'options', 'post', 'put', 'patch'].includes(origin.name)
        ? origin.name.toUpperCase() : undefined;
      if (!isFetch && !isSwr && !axiosMethod) return;
      const [argument, options] = node.getArguments();
      const methodProperty = Node.isObjectLiteralExpression(options) ? options.getProperty('method') : undefined;
      const methodValue = Node.isPropertyAssignment(methodProperty) ? methodProperty.getInitializer() : undefined;
      const fetchMethod = Node.isStringLiteral(methodValue) ? methodValue.getLiteralText().toUpperCase() :
        options && (!Node.isObjectLiteralExpression(options) || methodProperty ||
          options.getProperties().some(Node.isSpreadAssignment)) ? undefined : 'GET';
      const method = isFetch ? fetchMethod : axiosMethod;
      const action = node.getAncestors().map(parent => actionIds.get(parent)).find(Boolean);
      for (const url of isSwr ? swrUrls(argument) : [argument]) {
        const parsed = apiSegments(url);
        if (!url || !parsed) continue;
        classify(url);
        for (const { route, partial, markdown, dynamic } of urlMatches(parsed)) {
          const matchesMethod = !method || !route.methods?.length || route.methods.some(value =>
            value === method || value === 'ALL' || (method === 'HEAD' && value === 'GET'));
          const subject = action ? action.slice('action:'.length) : source;
          const owner = action ? subject.slice(0, subject.lastIndexOf('#')) : source;
          const kind = isSwr ? ' (SWR key)' : axiosMethod ? ' (axios)' : '';
          const mapFact = markdown && matchesMethod && origin?.name !== 'mutate';
          if (mapFact) addFact(facts, owner, `fetch ${subject} -> ${route.file} ${route.path}${kind}`);
          index?.fetch({
            file: source, line: node.getStartLineNumber(), node, route: route.id, method: method ?? (isSwr && origin?.name !== 'mutate' ? 'GET' : '?'),
            url: route.path, via: isSwr ? 'SWR key' : axiosMethod ? 'axios' : 'fetch',
            partial: partial || undefined, dynamic
          });
          if (isSwr || !mapFact) continue;
          const targets = endpointsByCall.get(node) ?? [];
          targets.push({ route, kind });
          endpointsByCall.set(node, targets);
        }
      }
    });
    for (const node of literals) {
      if (classified.has(node)) continue;
      const parsed = apiSegments(node);
      if (!parsed) continue;
      classify(node);
      for (const { route, partial, dynamic } of urlMatches(parsed)) {
        index?.fetch({
          file: source, line: node.getStartLineNumber(), node, route: route.id, method: '?',
          url: route.path, via: 'route literal', partial: partial || undefined, dynamic
        });
      }
    }
  }

  if (!endpointsByCall.size) return;
  const callsByBody = new Map<Node, { direct: Set<Endpoint>; callees: Set<Node> }>();
  const inspect = (root: Node) => {
    const cached = callsByBody.get(root);
    if (cached) return cached;
    const direct = new Set<Endpoint>();
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
    const pending: { node: Node; depth: number }[] = [{ node: fn, depth: 1 }];
    for (let i = 0; i < pending.length; i++) {
      const { node, depth } = pending[i];
      if (visited.has(node)) continue;
      visited.add(node);
      const { direct, callees } = inspect(node);
      for (const { route, kind } of direct) {
        addFact(facts, source, `fetch ${subject} -> ${route.file} ${route.path}${kind}`, depth);
      }
      for (const callee of callees) pending.push({ node: callee, depth: depth + 1 });
    }
  }
}
