import type { QueryIndexBuilder } from './QueryIndexBuilder';
import { AI_SDK_TRANSPORT, type Wrapper } from '../../mcp/Index';
import { type CallExpression, type NewExpression, Node, SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import { UI_TARGET } from '../types/GraphPaths';
import type { ComponentEdge, ComponentNode, DetailFacts, RouteNode } from '../types/GraphTypes';
import { visitKinds } from './CompilerWalk';
import { startLine } from './SourceLines';

export function declarationsOf(node: Node): Node[] {
  const symbol = node.getSymbol();
  return (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
}

export function isPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('#') &&
    !path.isAbsolute(specifier) && !path.win32.isAbsolute(specifier);
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
  contextProvider?: boolean;
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

const providerName = (name: string) => name.endsWith('Provider');
const externalProviderName = (name: string) => /(?:Config|Context)$/.test(name);
const layoutPrimitive = (name: string) => /(?:^|\.)(?:Grid|Column|Suspense|ErrorBoundary)$/.test(name);

function wrappedChains(body: Node, pagesApp: boolean, relativePath: RelativePath,
  bodies: Map<Node, Node>, projectFiles: Set<SourceFile>, seen = new Set<Node>(), pageParameter?: string): WrapperChain[] {
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
      const member = Node.isPropertyAccessExpression(tag) ? tag.getName() : name;
      if (!/^[A-Z]/.test(member)) continue;
      const contextProvider = member === 'Provider' && Node.isPropertyAccessExpression(tag);
      const declarations = declarationsOf(tag);
      const definition = declarations.find(declaration => projectFiles.has(declaration.getSourceFile()));
      const local = definition && bodies.get(definition);
      let root = tag;
      while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
      const binding = root.getSymbol()?.getDeclarations()[0];
      const module = binding?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue();
      const external = !definition && module && isPackageSpecifier(module) ? module : undefined;
      const exportedName = Node.isFunctionDeclaration(definition) || Node.isClassDeclaration(definition) ||
        Node.isVariableDeclaration(definition) ? definition.getName() ?? name : name;
      const importedName = root === tag && Node.isImportSpecifier(binding) ? binding.getName() : name;
      const names = [name, exportedName, importedName];
      const namedProvider = names.some(providerName) || (!!external && names.some(externalProviderName));
      const label = definition ? `${relativePath(definition.getSourceFile())}#${exportedName}` :
        module ? `${module}#${name}` : `${relativePath(tag.getSourceFile())}#${name}`;
      const nested = local ? wrappedChains(local, false, relativePath, bodies, projectFiles, seen) : [];
      const primitive = names.some(layoutPrimitive);
      chain = chain.flatMap(prefix => (nested.length ? nested : [emptyChain]).map(next => {
        const provider = !primitive && (namedProvider || !!next.contextProvider);
        // A dedicated component gets its own row. Inline provider tags belong to the file rendering them.
        const providerTag = provider && (!local || definition.getSourceFile() === tag.getSourceFile());
        const source = providerTag ? tag : definition ?? tag;
        const location: Wrapper = {
          file: relativePath(source.getSourceFile()), symbol: providerTag ? name : exportedName,
          line: startLine(source), conditional, provider, providerTag, external,
          definitionFile: providerTag && definition && definition.getSourceFile() !== tag.getSourceFile()
            ? relativePath(definition.getSourceFile()) : undefined
        };
        return {
          path: [...prefix.path, label, ...next.path],
          locations: [...prefix.locations, location, ...next.locations],
          conditional: prefix.conditional || next.conditional,
          contextProvider: prefix.contextProvider || contextProvider
        };
      }));
    }
    for (const entry of chain) chains.set(JSON.stringify([entry.path, !!entry.conditional]), entry);
  };
  visit(body);
  body.forEachDescendant(visit);
  return [...chains.values()];
}

// Pages Router applications can wrap the page before inserting it into _app.
function pageLayout(source: SourceFile | undefined, relativePath: RelativePath, bodies: Map<Node, Node>,
  projectFiles: Set<SourceFile>) {
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
      chains.push(...wrappedChains(right.getBody(), false, relativePath, bodies, projectFiles, new Set(), parameter.getText()));
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
  const projectFiles = new Set(files);
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
        const symbol = component && componentsById.get(component)?.name || 'default';
        const paths = body ? wrappedChains(body, !!app, relativePath, bodies, projectFiles) : [];
        wrapperLocations.set(wrapper, {
          file: wrapper, symbol,
          line: definition && definition.getSourceFile() === source ? startLine(definition) : 1, conditional: false,
          provider: paths.length > 0 && providerName(symbol), providerTag: false
        });
        wrapperChains.set(wrapper, paths);
      }
      layoutSeeds.push(wrapperRoots.get(wrapper), `file:${wrapper}`);
      const paths = wrapperChains.get(wrapper)!;
      const location = wrapperLocations.get(wrapper)!;
      chains = chains.flatMap(prefix => (paths.length ? paths : [emptyChain]).map(next => ({
        path: [...prefix.path, wrapper, ...next.path],
        locations: [...prefix.locations, next.contextProvider ? { ...location, provider: true } : location, ...next.locations],
        conditional: prefix.conditional || next.conditional
      })));
    }
    if (app && filesByPath.get(app)?.getFullText().includes('getLayout')) {
      const pageChains = pageLayout(filesByPath.get(route.file), relativePath, bodies, projectFiles);
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

export function wrappedExpression(node: Node) {
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) ||
      Node.isTypeAssertion(node) || Node.isSatisfiesExpression(node) || Node.isNonNullExpression(node)) {
    return node.getExpression();
  }
}

function unwrap(node: Node): Node {
  const inner = wrappedExpression(node);
  return inner ? unwrap(inner) : node;
}

function sdkPropertyName(node: Node) {
  if (Node.isComputedPropertyName(node)) node = unwrap(node.getExpression());
  else if (Node.isIdentifier(node)) return node.compilerNode.text;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isNumericLiteral(node)) {
    return node.getLiteralText();
  }
}

function optionValueDeclarations(node: Node) {
  const shorthand = node.getParentIfKind(SyntaxKind.ShorthandPropertyAssignment);
  if (shorthand?.getNameNode() !== node) return declarationsOf(node);
  const symbol = shorthand.getValueSymbol();
  return (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
}

function isNullish(node: Node) {
  return node.getKind() === SyntaxKind.NullKeyword || Node.isVoidExpression(node) ||
    Node.isIdentifier(node) && node.compilerNode.text === 'undefined' && !optionValueDeclarations(node).length;
}

function literalUrl(node: Node) {
  const url = unwrap(node);
  if (Node.isStringLiteral(url) || Node.isNoSubstitutionTemplateLiteral(url)) return url.getLiteralText();
}

function isGlobalFetch(expression: Node) {
  return /^(?:(?:globalThis|window)\.)?fetch$/.test(expression.getText()) &&
    !optionValueDeclarations(expression).some(declaration => !declaration.getSourceFile().isDeclarationFile());
}

// A single local use lets us read an object without assuming that a const binding makes it immutable.
function localSdkInitializer(value: Node) {
  if (!Node.isIdentifier(value)) return;
  const [declaration] = optionValueDeclarations(value);
  if (!Node.isVariableDeclaration(declaration) || declaration.getSourceFile() !== value.getSourceFile() ||
      declaration.isExported() || declaration.getVariableStatement()?.getDeclarationKind() !== 'const') return;
  const name = declaration.getNameNode();
  if (!Node.isIdentifier(name)) return;
  const references = name.findReferencesAsNodes();
  if (references.length === 1 && references[0] === value) return declaration.getInitializer();
}

type SdkOption = { value: Node; overwritten?: boolean; indirect?: boolean };

function sdkOptions(argument: Node | undefined, observe: (name: string, value: Node) => void) {
  const properties = new Map<string, SdkOption>();
  let opaque = false;
  const seen = new Set<Node>();
  const unknown = () => {
    opaque = true;
    for (const option of properties.values()) option.overwritten = true;
  };
  const inspect = (expression: Node, indirect: boolean) => {
    const value = unwrap(expression);
    if (seen.has(value)) return unknown();
    seen.add(value);
    const initializer = localSdkInitializer(value);
    if (initializer) return inspect(initializer, true);
    if (isNullish(value) && indirect) return;
    if (!Node.isObjectLiteralExpression(value)) return unknown();
    for (const property of value.getProperties()) {
      if (Node.isSpreadAssignment(property)) {
        const api = properties.get('api');
        if (api) api.indirect = true;
        inspect(property.getExpression(), true);
        continue;
      }
      const name = sdkPropertyName(property.getNameNode());
      if (name === undefined || name === '__proto__') {
        unknown();
        continue;
      }
      const option = Node.isPropertyAssignment(property) ? property.getInitializer() :
        Node.isShorthandPropertyAssignment(property) ? property.getNameNode() : property;
      if (!option || !/^(?:api|fetch|then|transport|chat)$|^prepare/.test(name)) continue;
      observe(name, option);
      properties.set(name, { value: option, indirect });
    }
  };
  if (argument) inspect(argument, false);
  return { properties, opaque };
}

function sdkCallback(value: Node, seen = new Set<Node>()) {
  const expression = unwrap(value);
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression) || Node.isMethodDeclaration(expression)) {
    return expression;
  }
  if (seen.has(expression) || !Node.isIdentifier(expression)) return;
  seen.add(expression);
  const declarations = optionValueDeclarations(expression);
  if (declarations.length !== 1) return;
  const [declaration] = declarations;
  if (Node.isFunctionDeclaration(declaration) && declaration.getBody()) {
    const name = declaration.getNameNode();
    const reassigned = name?.findReferences().some(symbol => symbol.getReferences().some(reference =>
      reference.isWriteAccess() && !reference.isDefinition() &&
      !reference.getNode().getFirstAncestorByKind(SyntaxKind.ImportDeclaration)));
    if (!reassigned) return declaration;
  }
  if (Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === 'const') {
    const initializer = declaration.getInitializer();
    if (initializer) return sdkCallback(initializer, seen);
  }
}

function forwardsFetch(value: Node) {
  const expression = unwrap(value);
  if (isGlobalFetch(expression) || isNullish(expression)) return true;
  const wrapper = sdkCallback(expression);
  if (!wrapper) return false;
  const parameters = wrapper.getParameters();
  if (parameters.length !== 2 || parameters.some(parameter =>
    !Node.isIdentifier(parameter.getNameNode()) || parameter.isRestParameter() || parameter.getInitializer())) return false;
  let request = wrapper.getBody();
  if (Node.isBlock(request)) {
    let first = request.getStatements()[0];
    if (Node.isTryStatement(first)) first = first.getTryBlock().getStatements()[0];
    if (Node.isReturnStatement(first)) request = first.getExpression();
    else if (Node.isVariableStatement(first) && first.getDeclarations().length === 1) {
      request = first.getDeclarations()[0].getInitializer();
    }
  }
  if (request) request = unwrap(request);
  if (Node.isAwaitExpression(request)) request = unwrap(request.getExpression());
  if (!Node.isCallExpression(request) || request.hasQuestionDotToken() || !isGlobalFetch(request.getExpression())) return false;
  const args = request.getArguments();
  const callee = request.getExpression();
  return args.length === parameters.length && args.every((arg, i) =>
    Node.isIdentifier(arg) && declarationsOf(arg)[0] === parameters[i]) &&
    !wrapper.getDescendants().some(node => node !== callee && node.getParent() !== callee &&
      (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) && isGlobalFetch(node));
}

const sdkTransports = new Set(['DefaultChatTransport', 'TextStreamChatTransport']);
const sdkHooks = new Set(['useChat', 'useCompletion', 'useObject', 'experimental_useObject']);
const sdkModules = new Set(['ai', '@ai-sdk/react', 'ai/react']);

type SdkRequest = { method: 'POST' | 'GET'; urls: Set<Node | string>; partial: boolean; unbounded: boolean };

function aiSdkRequests(
  node: Node, argument: Node | undefined, name: string, module: string | undefined,
  classify: (url: Node) => void, handledTransports: Set<Node>
): SdkRequest[] {
  const observe = (key: string, value: Node) => {
    if (key === 'api' && value.getSourceFile() === node.getSourceFile()) classify(value);
  };
  const nested = new Map<Node, ReturnType<typeof sdkOptions>>();
  const transportExpression = (value: Node) => unwrap(localSdkInitializer(unwrap(value)) ?? value);
  const readTransport = (implementation: Node) => {
    if (!Node.isNewExpression(implementation)) return;
    const origin = importOrigin(implementation.getExpression());
    if (origin.module !== 'ai' || !sdkTransports.has(origin.name)) return;
    handledTransports.add(implementation);
    nested.set(implementation, sdkOptions(implementation.getArguments()[0], observe));
  };
  let options = sdkOptions(argument, (key, value) => {
    observe(key, value);
    if (name !== 'useChat' || key !== 'transport') return;
    const implementation = transportExpression(value);
    readTransport(implementation);
    for (const child of implementation.getDescendantsOfKind(SyntaxKind.NewExpression)) readTransport(child);
  });
  const defaultUrl = name === 'useCompletion' ? '/api/completion' :
    name === 'useChat' || sdkTransports.has(name) ? '/api/chat' : undefined;
  let unbounded = false;
  let delegated = false;
  if (name === 'useChat') {
    const { properties, opaque } = options;
    const transport = properties.get('transport');
    const chat = properties.get('chat');
    const implementation = transport && transportExpression(transport.value);
    if (chat) unbounded = true;
    if (Node.isNewExpression(implementation)) {
      const origin = importOrigin(implementation.getExpression());
      const transportOptions = nested.get(implementation);
      if (transportOptions) {
        delegated = true;
        options = transportOptions;
        unbounded ||= opaque;
      } else if (origin.module === 'ai' && origin.name === 'DirectChatTransport' && !opaque && !unbounded) {
        return [];
      } else unbounded = true;
    } else if (implementation && !isNullish(implementation)) unbounded = true;
  }
  const { properties, opaque } = options;
  unbounded ||= opaque;
  const api = properties.get('api');
  const fetch = properties.get('fetch');
  unbounded ||= !!fetch && !forwardsFetch(fetch.value);
  const send: SdkRequest = { method: 'POST', urls: new Set(), partial: !!api?.indirect, unbounded: false };
  const reconnect: SdkRequest = { method: 'GET', urls: new Set(), partial: false, unbounded: false };
  let fallsBack = true;
  for (const [key, request] of [
    ['prepareSendMessagesRequest', send], ['prepareReconnectToStreamRequest', reconnect]
  ] as const) {
    if (request === reconnect && !delegated && !sdkTransports.has(name)) continue;
    const option = properties.get(key);
    if (!option || isNullish(unwrap(option.value))) continue;
    const callback = sdkCallback(option.value);
    const body = callback?.getBody();
    // The SDK binds regular callbacks to the transport. Receiver access can change or
    // expose its shared API and fetch state before either request uses it.
    unbounded ||= !callback || !Node.isArrowFunction(callback) &&
      !!callback.getFirstDescendantByKind(SyntaxKind.ThisKeyword);
    let withoutApi = false;
    const result = (expression?: Node) => {
      const value = expression && unwrap(expression);
      if (!value || isNullish(value)) {
        withoutApi = true;
        return;
      }
      if (Node.isConditionalExpression(value)) {
        result(value.getWhenTrue());
        result(value.getWhenFalse());
        return;
      }
      const prepared = sdkOptions(value, observe);
      const returnedApi = prepared.properties.get('api');
      // Await adopts a thenable before the SDK reads the prepared object's properties.
      if (prepared.opaque || prepared.properties.has('then')) {
        request.unbounded = true;
        withoutApi = true;
      }
      if (returnedApi && !isNullish(unwrap(returnedApi.value))) {
        request.urls.add(returnedApi.value);
        request.partial ||= !!returnedApi.indirect;
        withoutApi ||= literalUrl(returnedApi.value) === undefined;
      } else withoutApi = true;
    };
    if (!body) {
      request.unbounded = true;
    } else if (Node.isBlock(body)) {
      body.forEachDescendant((child, traversal) => {
        if (Node.isFunctionLikeDeclaration(child)) traversal.skip();
        else if (Node.isReturnStatement(child)) result(child.getExpression());
      });
      // A branch may fall through without a prepared request.
      withoutApi ||= !returnsFromBranch(body);
    } else result(body);
    if (request === send) {
      send.partial ||= send.urls.size > 0;
      if (body && !option.overwritten) fallsBack = withoutApi;
    } else {
      reconnect.partial ||= reconnect.urls.size > 0 && (withoutApi || reconnect.urls.size > 1);
    }
  }
  let usesDefault = !api || isNullish(unwrap(api.value)) || !!api.overwritten;
  if (fallsBack && api && !isNullish(unwrap(api.value))) {
    send.urls.add(api.value);
    // React's transport-based useChat does not use a top-level api from older versions.
    if (name === 'useChat' && module === '@ai-sdk/react' && !delegated) {
      const parameters = node.asKindOrThrow(SyntaxKind.CallExpression).getExpression().getType().getCallSignatures()[0]?.getParameters();
      const type = parameters?.[0]?.getTypeAtLocation(node);
      const variants = type?.isUnion() ? type.getUnionTypes() : type ? [type] : [];
      if (variants.some(variant => variant.getProperty('transport'))) {
        send.urls.delete(api.value);
        usesDefault = true;
      }
      usesDefault ||= !variants.some(variant => variant.getProperty('api'));
    }
  }
  if (fallsBack && usesDefault) {
    if (defaultUrl) {
      if (![...send.urls].some(url => typeof url !== 'string' && literalUrl(url) === defaultUrl)) send.urls.add(defaultUrl);
      send.partial = true;
    } else send.unbounded = true;
  }
  // The default reconnect URL includes the chat ID. Only explicit reconnect overrides are indexed here.
  const requests = reconnect.urls.size || reconnect.unbounded ? [send, reconnect] : [send];
  for (const request of requests) {
    request.unbounded ||= unbounded;
    for (const url of request.urls) {
      if (typeof url === 'string' || literalUrl(url) !== undefined) continue;
      request.partial = true;
      const values = urlTexts(url);
      const expression = unwrap(url);
      if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression) ||
          !values?.length || !values.every(value => apiSegments(value))) request.unbounded = true;
    }
    request.partial ||= request.unbounded;
  }
  return requests;
}

// Keep unresolved parts distinct from literal URL text and from expressions that can supply slashes.
const slot = '\0';
const spanningSlot = '\x01';
const unknownSlot = /[\0\x01]/;
type UrlText = { text: string; dynamic?: boolean; partial?: boolean };

function urlTexts(node: Node, seen = new Set<Node>(), expandConditional = true, wholeUrl = true): UrlText[] | undefined {
  if (seen.has(node)) return;
  seen.add(node);
  const resolve = (expression: Node, whole = wholeUrl) => urlTexts(expression, seen, expandConditional, whole);
  // An unresolved expression gets a slot. An empty set has no viable URL.
  const fallback = (values: UrlText[] | undefined): UrlText[] => values ?? [{ text: slot }];
  try {
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
      return [{ text: node.getLiteralText() }];
    }
    const wrapped = wrappedExpression(node);
    if (wrapped) return resolve(wrapped);
    if (node.getKind() === SyntaxKind.NullKeyword) return [];
    if (Node.isConditionalExpression(node)) {
      const branches = [node.getWhenTrue(), node.getWhenFalse()]
        .flatMap(branch => fallback(urlTexts(branch, seen, true, wholeUrl)))
        .filter(value => !wholeUrl || value.text !== '');
      if (!branches.length) return [];
      const hasSlash = branches.some(value => value.text.includes('/'));
      if (!expandConditional) {
        const values = branches.filter(value => value.text === '');
        if (values.length < branches.length) values.push({ text: hasSlash ? spanningSlot : slot });
        return values;
      }
      return branches.map(value => {
        if (value.text === slot) return value;
        const text = value.text.includes('/') && !apiSegments(value)
          ? value.text.split(slot).join(spanningSlot) : value.text;
        return { ...value, text, partial: value.partial || branches.length > 1 };
      });
    }
    if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
      const [declaration] = optionValueDeclarations(node);
      if (Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration)) {
        const initializer = declaration.getInitializer();
        const constant = Node.isVariableDeclaration(declaration) &&
          declaration.getVariableStatement()?.getDeclarationKind() === 'const';
        if (initializer) {
          return urlTexts(initializer, seen, expandConditional && constant, wholeUrl)
            ?.map(value => value.text === slot ? value : { ...value, partial: value.partial || !constant });
        }
      }
      if (Node.isIdentifier(node) && node.getText() === 'undefined' &&
          (!declaration || declaration.getSourceFile().isDeclarationFile())) return [];
    }
    const plus = addition(node);
    if (plus) {
      const left = resolve(plus.getLeft(), false);
      const right = resolve(plus.getRight(), false);
      if (!left && !right) return;
      return fallback(left).flatMap(prefix => fallback(right).map(suffix => {
        const text = prefix.text + suffix.text;
        return { text, dynamic: prefix.dynamic || suffix.dynamic || unknownSlot.test(text),
          partial: prefix.partial || suffix.partial };
      }));
    }
    if (Node.isTemplateExpression(node)) {
      let values: UrlText[] = [{ text: node.getHead().getLiteralText() }];
      for (const span of node.getTemplateSpans()) {
        const substitutions = resolve(span.getExpression(), false);
        const tail = span.getLiteral().getLiteralText();
        values = values.flatMap(prefix => fallback(substitutions).map(value => {
          const text = prefix.text + value.text + tail;
          if (/[?#]/.test(prefix.text)) return { ...prefix, text };
          return { text, dynamic: prefix.dynamic || value.dynamic || value.text !== slot &&
            unknownSlot.test(value.text) || !prefix.text && localApi.test(value.text) && unknownSlot.test(text),
            partial: prefix.partial || value.partial };
        }));
      }
      return values;
    }
    if (Node.isCallExpression(node)) {
      const callee = node.getExpression();
      const [separator] = node.getArguments();
      if (separator && Node.isPropertyAccessExpression(callee) && callee.getName() === 'join') {
        const values = resolve(separator, false);
        if (!values || values.some(({ text }) => unknownSlot.test(text) || text.includes('/'))) {
          return [{ text: spanningSlot }];
        }
      }
    }
    return;
  } finally {
    seen.delete(node);
  }
}

function apiSegments(url: UrlText) {
  const prefix = /^(?:[\0\x01]+|https?:\/\/[^/?#]+)(?=\/api(?:[/?#]|$))/.exec(url.text)?.[0];
  const local = prefix ? url.text.slice(prefix.length) : url.text;
  if (!localApi.test(local)) return;
  const [pathname] = local.split(/[?#]/, 1);
  const spanning = pathname.includes(spanningSlot);
  const trailingSlash = pathname.endsWith('/');
  const path = trailingSlash ? pathname.slice(0, -1) : pathname;
  const segments = path.slice(1).split('/');
  const boundedTail = pathname === local && segments.at(-1) === slot && pathname.indexOf(slot) === pathname.length - 1;
  return { segments, spanning, dynamic: spanning || !!url.dynamic && !boundedTail,
    partial: !!prefix || !!url.partial || trailingSlash && !unknownSlot.test(pathname),
    markdown: (!prefix || prefix === slot) && !url.partial };
}

function matchesSegment(part: string, segment: string) {
  if (part.startsWith('[')) return !!segment;
  if (!segment.includes(slot)) return part === segment;
  const regex = segment.split(slot).map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${regex}$`).test(part);
}

function matchesSpanningPath(pattern: string[], segments: string[]) {
  const visited = new Set<string>();
  const match = (routeIndex: number, urlIndex: number): boolean => {
    const part = pattern[routeIndex];
    if (part?.startsWith('[[...')) return true;
    const segment = segments[urlIndex];
    if (!part || segment === undefined) return !part && segment === undefined;
    const key = `${routeIndex}:${urlIndex}`;
    if (visited.has(key)) return false;
    visited.add(key);
    const pieces = segment.split(spanningSlot);
    if (matchesSegment(part, pieces.join(slot)) &&
        (part.startsWith('[...') || match(routeIndex + 1, urlIndex + 1))) return true;
    if (pieces.length === 1 || !matchesSegment(part, pieces[0] + slot)) return false;
    // A slash inside the substitution moves the trailing literal into a later route segment.
    for (let end = routeIndex + 1; end < pattern.length; end++) {
      if (pattern[end].startsWith('[...') || pattern[end].startsWith('[[...')) return true;
      if (matchesSegment(pattern[end], slot + pieces.at(-1)!) && match(end + 1, urlIndex + 1)) return true;
    }
    return false;
  };
  return match(0, 0);
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
    const resolved = declarationsOf(key).flatMap(declaration =>
      Node.isVariableDeclaration(declaration) && declaration.getSourceFile() === key.getSourceFile() &&
      declaration.getVariableStatement()?.getDeclarationKind() === 'const'
        ? swrUrls(declaration.getInitializer(), seen) : []);
    return resolved.length ? resolved : [key];
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

function isSwrFallbackKey(node: Node): boolean {
  const name = node.getParentIfKind(SyntaxKind.ComputedPropertyName) ?? node;
  const property = name.getParentIfKind(SyntaxKind.PropertyAssignment);
  if (!property || property.getNameNode() !== name) return false;
  const fallback = property.getParentIfKind(SyntaxKind.ObjectLiteralExpression)?.getParentIfKind(SyntaxKind.PropertyAssignment);
  const config = fallback?.getParentIfKind(SyntaxKind.ObjectLiteralExpression);
  if (!fallback || config?.getProperty('fallback') !== fallback) return false;
  const attribute = config.getParentIfKind(SyntaxKind.JsxExpression)?.getParentIfKind(SyntaxKind.JsxAttribute);
  if (attribute?.getNameNode().getText() !== 'value') return false;
  const tag = attribute.getParent().getParent();
  if (!Node.isJsxOpeningElement(tag) && !Node.isJsxSelfClosingElement(tag)) return false;
  const origin = importOrigin(tag.getTagNameNode());
  return origin.module === 'swr' && origin.name === 'SWRConfig';
}

const API_REFERENCE_KINDS = new Set([
  SyntaxKind.CallExpression, SyntaxKind.NewExpression, SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateExpression, SyntaxKind.BinaryExpression
]);

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
    if (parsed.spanning) {
      return endpoints.filter(({ segments: pattern }) => matchesSpanningPath(pattern, segments))
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
        if (!matchesSegment(part, segment)) return false;
        if (!part.startsWith('[') && segment.includes(slot)) uncertain = true;
        return true;
      }) && (pattern.at(-1)?.includes('...') || pattern.length === segments.length);
      if (!compatible) continue;
      if (!uncertain) bestCertain = rank;
      matches.push({ route,
        partial: partial || parsed.dynamic || uncertain || moreSpecificMatch ||
          segments.some(segment => segment.includes(slot) && segment !== slot),
        markdown: !uncertain && !parsed.dynamic && parsed.markdown, dynamic: parsed.dynamic || undefined });
      moreSpecificMatch ||= uncertain;
    }
    return matches;
  };
  const matchesFor = (url: Node | string) => {
    let matches: Map<string, ReturnType<typeof urlMatches>[number]> | undefined;
    for (const value of typeof url === 'string' ? [{ text: url }] : urlTexts(url) ?? []) {
      const parsed = apiSegments(value);
      if (!parsed) continue;
      matches ??= new Map();
      for (const match of urlMatches(parsed)) {
        const previous = matches.get(match.route.id);
        if (!previous || previous.partial && (!match.partial || previous.dynamic && !match.dynamic)) {
          matches.set(match.route.id, match);
        }
      }
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
      } else if (Node.isConditionalExpression(url)) {
        classify(url.getWhenTrue());
        classify(url.getWhenFalse());
      } else if (Node.isTemplateExpression(url)) {
        for (const span of url.getTemplateSpans()) classify(span.getExpression());
      }
    };
    const source = relativePath(file);
    const usesHttpLibrary = file.getImportDeclarations().some(declaration =>
      ['swr', 'swr/immutable', 'axios'].includes(declaration.getModuleSpecifierValue()) ||
      sdkModules.has(declaration.getModuleSpecifierValue()));
    const handledTransports = new Set<Node>();
    const collectRequest = (node: CallExpression | NewExpression) => {
      const isConstructor = Node.isNewExpression(node);
      const expression = node.getExpression();
      const isFetch = !isConstructor && isGlobalFetch(expression);
      const origin = !isFetch && usesHttpLibrary ? importOrigin(expression) : undefined;
      const isAiSdk = origin && (isConstructor ? origin.module === 'ai' && sdkTransports.has(origin.name) :
        (origin.module === '@ai-sdk/react' || origin.module === 'ai/react') && sdkHooks.has(origin.name));
      const isSwr = !isConstructor && (origin?.module === 'swr' || origin?.module === 'swr/immutable') &&
        ['default', 'useSWR', 'mutate'].includes(origin.name);
      const isSwrMutate = isSwr && origin.name === 'mutate';
      const axiosMethod = !isConstructor && origin?.module === 'axios' &&
        ['get', 'delete', 'head', 'options', 'post', 'put', 'patch'].includes(origin.name)
        ? origin.name.toUpperCase() : undefined;
      if (!isFetch && !isSwr && !axiosMethod && !isAiSdk) return;
      const [argument, options] = node.getArguments();
      if (handledTransports.has(node)) return;
      const sdkRequests = isAiSdk ? aiSdkRequests(node, argument, origin.name, origin.module, classify, handledTransports) : undefined;
      if (sdkRequests?.some(request => request.partial)) {
        index?.uncertainChatTransport(source, node, sdkRequests.some(request => request.unbounded));
      }
      const methodProperty = Node.isObjectLiteralExpression(options) ? options.getProperty('method') : undefined;
      const methodValue = Node.isPropertyAssignment(methodProperty) ? methodProperty.getInitializer() : undefined;
      const fetchMethod = Node.isStringLiteral(methodValue) ? methodValue.getLiteralText().toUpperCase() :
        options && (!Node.isObjectLiteralExpression(options) || methodProperty ||
          options.getProperties().some(Node.isSpreadAssignment)) ? undefined : 'GET';
      const via = sdkRequests ? AI_SDK_TRANSPORT :
        isSwrMutate ? 'SWR mutate' : isSwr ? 'SWR key' : axiosMethod ? 'axios' : 'fetch';
      const action = node.getAncestors().map(parent => actionIds.get(parent)).find(Boolean);
      const subject = action ? action.slice('action:'.length) : source;
      const owner = action ? subject.slice(0, subject.lastIndexOf('#')) : source;
      const kind = via === 'fetch' ? '' : ` (${via})`;
      const requests = sdkRequests ?? [{
        urls: isSwr ? swrUrls(argument) : [argument], method: isFetch ? fetchMethod : axiosMethod,
        partial: false, unbounded: false
      }];
      for (const request of requests) {
        const method = request.unbounded ? undefined : request.method;
        for (const url of request.urls) {
          if (url === undefined) continue;
          const matches = matchesFor(url);
          if (!matches) continue;
          if (typeof url !== 'string' && url.getSourceFile() === file) classify(url);
          const line = startLine(sdkRequests && typeof url !== 'string' && url.getSourceFile() === file ? url : node);
          for (const { route, partial, markdown, dynamic } of matches.values()) {
            const matchesMethod = !method || !route.methods?.length || route.methods.some(value =>
              value === method || value === 'ALL' || (method === 'HEAD' && value === 'GET'));
            const mapFact = markdown && matchesMethod && origin?.name !== 'mutate' && !request.partial;
            if (mapFact) addFact(facts, owner, `fetch ${subject} -> ${route.file} ${route.path}${kind}`);
            index?.fetch({
              file: source, line, node, route: route.id,
              method: method ?? (isSwr && !isSwrMutate ? 'GET' : '?'), url: route.path, via,
              partial: partial || request.partial || undefined, dynamic
            });
            if (isSwr || !mapFact) continue;
            const targets = endpointsByCall.get(node) ?? [];
            targets.push({ route, kind });
            endpointsByCall.set(node, targets);
          }
        }
      }
    };
    const constructors: NewExpression[] = [];
    // Read hooks first so a constructor supplied as a transport is indexed through its hook.
    visitKinds(file, API_REFERENCE_KINDS, node => {
      if (Node.isCallExpression(node)) collectRequest(node);
      else if (Node.isNewExpression(node)) {
        if (usesHttpLibrary) constructors.push(node);
      } else if (index && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ||
          Node.isTemplateExpression(node) || addition(node))) literals.push(node);
    });
    for (const constructor of constructors) collectRequest(constructor);
    for (const node of literals) {
      if (classified.has(node)) continue;
      const matches = matchesFor(node);
      if (!matches) continue;
      classify(node);
      const via = isSwrFallbackKey(node) ? 'SWR fallback key' : 'route literal';
      for (const { route, partial, dynamic } of matches.values()) {
        index?.fetch({
          file: source, line: startLine(node), node, route: route.id, method: '?',
          url: route.path, via, partial: partial || undefined, dynamic
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
      for (const endpoint of endpointsByCall.get(node) ?? []) direct.add(endpoint);
      if (!Node.isCallExpression(node)) return;
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
