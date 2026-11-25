import type { QueryIndexBuilder } from './QueryIndexBuilder';
import { AI_SDK_TRANSPORT, type PageRenderCondition, type Wrapper } from '../../mcp/Index';
import { type CallExpression, type NewExpression, Node, SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import { UI_TARGET } from '../types/GraphPaths';
import type { ComponentEdge, ComponentNode, DetailFacts, RouteNode } from '../types/GraphTypes';
import { visitKinds } from './CompilerWalk';
import { bindingOf, functionNode, importBinding, returns, valueNode } from './StaticBindings';
import { property, textValue, type NextConfig } from './NextConfig';
import { matchNextRoutes, normalizeNextUrl, patternRank, routeSegments } from './NextRouteMatch';
import type { WorkspaceBindings } from './WorkspaceBindings';
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
  dispatch?: string;
  possible?: boolean;
  getLayout?: boolean;
}

type PageProperties = {
  assignments: Map<string, { value: Node; site: Node }>;
  unknown: Set<string>;
  opaque: boolean;
};

type PagesWrapperScope = {
  page?: PageProperties;
  issues?: string[];
  parameter?: string;
  forwarded?: Node;
  renderCondition?: (tag: Node, decision: PageRenderCondition) => void;
};

const unknownValue = Symbol('unknown');
const truthyValue = Symbol('truthy');
type StaticValue = string | number | boolean | null | undefined | typeof unknownValue | typeof truthyValue;

function staticValue(node: Node | undefined): StaticValue {
  const value = valueNode(node);
  if (Node.isStringLiteral(value) || Node.isNumericLiteral(value)) return value.getLiteralValue();
  if (Node.isTrueLiteral(value)) return true;
  if (Node.isFalseLiteral(value)) return false;
  if (Node.isNullLiteral(value)) return null;
  if (Node.isIdentifier(value) && value.getText() === 'undefined' && !bindingOf(value)) return undefined;
  if (Node.isFunctionLikeDeclaration(value) || Node.isClassDeclaration(value) ||
    Node.isArrayLiteralExpression(value) || Node.isObjectLiteralExpression(value)) return truthyValue;
  return unknownValue;
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
  bodies: Map<Node, Node>, projectFiles: Set<SourceFile>, seen = new Set<Node>(), scope?: PagesWrapperScope): WrapperChain[] {
  if (seen.has(body) || seen.size >= 12) return [];
  const { page, parameter: pageParameter, forwarded, issues, renderCondition } = scope ?? {};
  const pagesScope = !!scope;
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
  const parameterDeclaration = parameter?.getParameters()[0];
  const isSlot = (node: Node | undefined): boolean => {
    if (!node) return false;
    if (!pagesScope) {
      if (Node.isPropertyAccessExpression(node)) return slots.has(node.getName());
      return slots.has(node.getText());
    }
    const declaration = bindingOf(node);
    if (forwarded) return declaration === forwarded;
    if (pageParameter && declaration === parameterDeclaration) return true;
    if (Node.isBindingElement(declaration)) {
      const binding = declaration.getParent().getParent();
      return (declaration.getPropertyNameNode() ?? declaration.getNameNode()).getText() === (pagesApp ? 'Component' : 'children') &&
        (binding === parameterDeclaration || Node.isVariableDeclaration(binding) &&
          bindingOf(binding.getInitializer()) === parameterDeclaration);
    }
    if (Node.isPropertyAccessExpression(node)) {
      return node.getName() === (pagesApp ? 'Component' : 'children') &&
        bindingOf(node.getExpression()) === parameterDeclaration;
    }
    const value = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
    if (!value || value === node || !Node.isIdentifier(value) && !Node.isPropertyAccessExpression(value) ||
      node.getSourceFile() === value.getSourceFile() && value.getStart() >= node.getStart()) return false;
    return isSlot(value);
  };
  const propertySlot = (node: Node | undefined) => {
    if (Node.isPropertyAccessExpression(node) && isSlot(node.getExpression())) return node.getName();
    if (Node.isElementAccessExpression(node) && isSlot(node.getExpression())) return textValue(node.getArgumentExpression());
    const element = Node.isIdentifier(node) ? bindingOf(node) : undefined;
    if (Node.isBindingElement(element)) {
      const declaration = element.getParent().getParent();
      if (Node.isVariableDeclaration(declaration) && isSlot(declaration.getInitializer())) {
        return (element.getPropertyNameNode() ?? element.getNameNode()).getText();
      }
    }
  };
  const tests = new Map<Node, { value: StaticValue; properties: Set<string> }>();
  const test = (node: Node) => {
    const cached = tests.get(node);
    if (cached) return cached;
    const properties = new Set<string>();
    const read = (expression: Node | undefined, depth = 0): StaticValue => {
      if (!expression || depth >= 12) return unknownValue;
      const key = propertySlot(expression);
      if (key !== undefined && page) {
        properties.add(key);
        const assignment = page.assignments.get(key);
        const value = page.unknown.has(key) ? unknownValue : assignment ? staticValue(assignment.value) :
          page.opaque ? unknownValue : undefined;
        return value;
      }
      if (Node.isElementAccessExpression(expression) && page && isSlot(expression.getExpression())) {
        properties.add(expression.getArgumentExpression()?.getText() ?? 'computed key');
        return unknownValue;
      }
      if (Node.isParenthesizedExpression(expression) || Node.isAsExpression(expression) ||
          Node.isNonNullExpression(expression) || Node.isSatisfiesExpression(expression)) return read(expression.getExpression(), depth + 1);
      if (Node.isIdentifier(expression)) {
        const value = valueNode(expression);
        if (value !== expression) return read(value, depth + 1);
      }
      if (Node.isPrefixUnaryExpression(expression) && expression.getOperatorToken() === SyntaxKind.ExclamationToken) {
        const value = read(expression.getOperand(), depth + 1);
        return value === unknownValue ? value : !value;
      }
      if (Node.isBinaryExpression(expression)) {
        const op = expression.getOperatorToken().getKind();
        const left = read(expression.getLeft(), depth + 1);
        if (op === SyntaxKind.AmpersandAmpersandToken && left !== unknownValue && !left ||
            op === SyntaxKind.BarBarToken && left !== unknownValue && left ||
            op === SyntaxKind.QuestionQuestionToken && left !== unknownValue && left != null) return left;
        const right = read(expression.getRight(), depth + 1);
        if (op === SyntaxKind.AmpersandAmpersandToken) return left === unknownValue && right !== unknownValue && !right ? false :
          left === unknownValue ? left : right;
        if (op === SyntaxKind.BarBarToken) return left === unknownValue && right !== unknownValue && right ? truthyValue :
          left === unknownValue ? left : right;
        if (op === SyntaxKind.QuestionQuestionToken) return left === unknownValue ? left : right;
        if (left === unknownValue || right === unknownValue || left === truthyValue || right === truthyValue) return unknownValue;
        if (op === SyntaxKind.EqualsEqualsEqualsToken) return left === right;
        if (op === SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
        if (op === SyntaxKind.EqualsEqualsToken) return left == right;
        if (op === SyntaxKind.ExclamationEqualsToken) return left != right;
      }
      if (page && Node.isCallExpression(expression)) {
        for (const argument of expression.getArguments()) read(argument, depth + 1);
      }
      return staticValue(expression);
    };
    const value = read(node);
    const result: { value: StaticValue; properties: Set<string> } = { value, properties };
    tests.set(node, result);
    return result;
  };
  const branchState = (node: Node, boundary: Node) => {
    const state = { dead: false, conditional: false, possible: false, readsPage: false };
    const unresolved = new Set<string>();
    const check = (expression: Node, accepts: (value: StaticValue) => boolean) => {
      const result = test(expression);
      state.readsPage ||= result.properties.size > 0;
      if (result.value !== unknownValue) state.dead ||= !accepts(result.value);
      else {
        state.conditional = true;
        for (const key of result.properties) unresolved.add(key);
      }
    };
    for (let child = node; child !== boundary;) {
      const parent = child.getParentOrThrow();
      if (Node.isConditionalExpression(parent) && child !== parent.getCondition()) {
        check(parent.getCondition(), value => Boolean(value) === (child === parent.getWhenTrue()));
      } else if (Node.isIfStatement(parent) && child !== parent.getExpression()) {
        check(parent.getExpression(), value => Boolean(value) === (child === parent.getThenStatement()));
      } else if (Node.isBinaryExpression(parent) && child === parent.getRight()) {
        const op = parent.getOperatorToken().getKind();
        if (op === SyntaxKind.AmpersandAmpersandToken) check(parent.getLeft(), Boolean);
        if (op === SyntaxKind.BarBarToken) check(parent.getLeft(), value => !value);
        if (op === SyntaxKind.QuestionQuestionToken) check(parent.getLeft(), value => value == null);
      } else if (Node.isBlock(parent)) {
        for (const statement of parent.getStatements()) {
          if (statement === child) break;
          if (Node.isReturnStatement(statement) || Node.isThrowStatement(statement)) state.dead = true;
          if (!Node.isIfStatement(statement)) continue;
          const otherwise = statement.getElseStatement();
          if (returnsFromBranch(statement.getThenStatement())) check(statement.getExpression(), value => !value);
          if (otherwise && returnsFromBranch(otherwise)) check(statement.getExpression(), Boolean);
        }
      } else state.conditional ||= conditionalChild(child, parent);
      child = parent;
    }
    if (!state.dead && unresolved.size) {
      state.possible = true;
      for (const key of unresolved) issues?.push(`unresolved page property ${key} in wrapper predicate`);
    }
    return state;
  };
  const layoutCall = (node: Node) => {
    if (!Node.isCallExpression(node)) return false;
    const callee = valueNode(node.getExpression()) ?? node.getExpression();
    const property = Node.isBinaryExpression(callee) &&
      [SyntaxKind.QuestionQuestionToken, SyntaxKind.BarBarToken].includes(callee.getOperatorToken().getKind()) ? callee.getLeft() : callee;
    return propertySlot(property) === 'getLayout';
  };
  const visit = (node: Node, root = body, outer: Node[] = [], selected = false, possible = false) => {
    const tag = Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node) ? node.getTagNameNode() : undefined;
    const dispatch = pagesApp ? propertySlot(tag) : undefined;
    const slot = pagesApp ? !!tag && isSlot(tag) : Node.isJsxExpression(node) && isSlot(node.getExpression());
    if (!slot && !dispatch) return;
    if (dispatch && (!(Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) ||
      !node.getAttributes().some(attribute => Node.isJsxSpreadAttribute(attribute) &&
        bindingOf(attribute.getExpression()) === parameterDeclaration))) return;
    const ancestors: Node[] = [];
    const state = pagesScope ? branchState(node, root) : undefined;
    if (state?.dead) return;
    let conditional = selected || !!state?.conditional;
    possible ||= !!state?.possible;
    let getLayout = false;
    for (let child = node; child !== root;) {
      const parent = child.getParentOrThrow();
      if (!state) conditional ||= conditionalChild(child, parent);
      getLayout ||= pagesApp && layoutCall(parent);
      ancestors.push(parent);
      child = parent;
    }
    ancestors.reverse();
    ancestors.unshift(...outer);
    getLayout ||= pagesApp && outer.some(layoutCall);
    let chain: WrapperChain[] = [{ path: [], locations: [], conditional, possible, dispatch, getLayout }];
    for (const element of ancestors.filter(Node.isJsxElement)) {
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
      const nestedScope = scope && { page, issues, renderCondition };
      const nested = local ? wrappedChains(local, false, relativePath, bodies, projectFiles, seen, nestedScope) : [];
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
          ...prefix,
          path: [...prefix.path, label, ...next.path],
          locations: [...prefix.locations, location, ...next.locations],
          conditional: prefix.conditional || next.conditional,
          possible: prefix.possible || next.possible,
          contextProvider: prefix.contextProvider || contextProvider
        };
      }));
    }
    for (const entry of chain) chains.set(JSON.stringify([entry.path, !!entry.conditional, !!entry.possible, entry.dispatch, entry.getLayout]), entry);
  };
  if (pagesScope) {
    if (page && renderCondition) {
      const record = (node: Node, walk?: { skip(): void }) => {
        if (Node.isFunctionLikeDeclaration(node)) {
          walk?.skip();
          return;
        }
        if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) return;
        const state = branchState(node, body);
        if (state.readsPage && (state.dead || state.possible)) {
          renderCondition(node.getTagNameNode(), state.dead ? 'excluded' : 'possible');
        }
      };
      record(body);
      body.forEachDescendant(record);
    }
    const scan = (root: Node, outer: Node[], conditional: boolean, possible: boolean, visited: Set<Node>) => {
      if (visited.has(root) || visited.size >= 12) return;
      visited = new Set(visited).add(root);
      const follow = (node: Node, walk?: { skip(): void }) => {
        if (Node.isFunctionLikeDeclaration(node)) { walk?.skip(); return; }
        visit(node, root, outer, conditional, possible);
        if (!Node.isIdentifier(node) || !Node.isVariableDeclaration(bindingOf(node))) return;
        const value = valueNode(node);
        if (!value || value === node || !body.containsRange(value.getPos(), value.getEnd())) return;
        if (node !== root && !Node.isJsxExpression(node.getParent()) && !Node.isConditionalExpression(node.getParent()) && !layoutCall(node.getParentOrThrow())) return;
        const context: Node[] = [];
        for (let child: Node = node; child !== root;) {
          child = child.getParentOrThrow();
          context.unshift(child);
        }
        const state = branchState(node, root);
        if (!state.dead) scan(value, [...outer, ...context], conditional || state.conditional, possible || state.possible, visited);
      };
      follow(root);
      root.forEachDescendant(follow);
    };
    for (const expression of returns(body)) {
      const state = branchState(expression, body);
      if (!state.dead) scan(expression, [], state.conditional, state.possible, new Set());
    }
  } else {
    visit(body);
    body.forEachDescendant(node => visit(node));
  }
  return [...chains.values()];
}

function pageProperties(source: SourceFile | undefined): PageProperties {
  const assignments = new Map<string, { value: Node; site: Node }>();
  const unknown = new Set<string>();
  const exported = new Set(source?.getExportedDeclarations().get('default')?.map(node => valueNode(node)));
  const page = exported.size === 1 ? [...exported][0] : undefined;
  let opaque = !functionNode(page);
  if (Node.isClassDeclaration(page)) {
    opaque = page.getExtends() !== undefined;
    for (const member of page.getStaticMembers()) {
      const name = member.getName();
      const value = Node.isPropertyDeclaration(member) ? member.getInitializer() : Node.isMethodDeclaration(member) ? member : undefined;
      if (value) assignments.set(name, { value, site: member });
      else if (!Node.isPropertyDeclaration(member)) unknown.add(name);
    }
  }
  if (!source || !page) return { assignments, unknown, opaque };
  const invalidate = () => {
    opaque = true;
    for (const key of assignments.keys()) unknown.add(key);
  };
  for (const file of new Set([page.getSourceFile(), source])) {
    for (const statement of file.getStatements()) {
      if (Node.isFunctionLikeDeclaration(statement) || Node.isClassDeclaration(statement)) continue;
      const inspect = (node: Node, traversal?: { skip(): void }) => {
        if (Node.isFunctionLikeDeclaration(node) || Node.isClassDeclaration(node)) {
          traversal?.skip();
          return;
        }
        if (Node.isBinaryExpression(node) &&
          node.getOperatorToken().getKind() >= SyntaxKind.FirstAssignment &&
          node.getOperatorToken().getKind() <= SyntaxKind.LastAssignment) {
          const left = node.getLeft();
          if ((!Node.isPropertyAccessExpression(left) && !Node.isElementAccessExpression(left)) ||
            valueNode(left.getExpression()) !== page) return;
          const name = Node.isPropertyAccessExpression(left) ? left.getName() : textValue(left.getArgumentExpression());
          if (!name) invalidate();
          else if (Node.isExpressionStatement(statement) && statement.getExpression() === node &&
            node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
            assignments.set(name, { value: node.getRight(), site: left });
            unknown.delete(name);
          } else unknown.add(name);
        } else if (Node.isCallExpression(node) && node.getArguments().some(argument => valueNode(argument) === page)) {
          invalidate();
        } else if (Node.isDeleteExpression(node)) {
          const operand = node.getExpression();
          if (Node.isPropertyAccessExpression(operand) && valueNode(operand.getExpression()) === page) {
            unknown.add(operand.getName());
          } else if (Node.isElementAccessExpression(operand) && valueNode(operand.getExpression()) === page) {
            invalidate();
          }
        }
      };
      inspect(statement);
      statement.forEachDescendant(inspect);
    }
  }
  return { assignments, unknown, opaque };
}

function andThen(outer: WrapperChain, inner: WrapperChain): WrapperChain {
  return { path: [...outer.path, ...inner.path], locations: [...outer.locations, ...inner.locations],
    conditional: outer.conditional || inner.conditional, possible: outer.possible || inner.possible };
}

function pagesApplication(source: SourceFile, relativePath: RelativePath, bodies: Map<Node, Node>,
  files: Set<SourceFile>, workspace?: WorkspaceBindings) {
  let application = [emptyChain];
  const issues: string[] = [];
  const locations = (node: Node, symbol: string, evidence?: string): Wrapper => ({
    file: relativePath(node.getSourceFile()), symbol, line: startLine(node), conditional: false, phase: 'application', evidence
  });
  let value = valueNode(source.getExportedDeclarations().get('default')?.[0]);
  for (let depth = 0; depth < 8 && Node.isCallExpression(value); depth++) {
    const callee = value.getExpression();
    const origin = importBinding(callee);
    const tRPC = Node.isPropertyAccessExpression(callee) && callee.getName() === 'withTRPC' &&
      (() => {
        const receiver = callee.getExpression();
        const client = valueNode(receiver) ?? valueNode(workspace?.resolve(receiver));
        const init = Node.isCallExpression(client) ? client : valueNode(workspace?.resolve(receiver));
        const factory = Node.isCallExpression(init) ? importBinding(init.getExpression()) : undefined;
        return (factory?.module === '@trpc/next' && factory.name === 'createTRPCNext') ||
          (Node.isCallExpression(init) && !!workspace?.origin(init.getExpression(), '@trpc/next', 'createTRPCNext'));
      })();
    const factory = functionNode(callee);
    const parameter = factory?.getParameters()[0];
    const argument = parameter?.getNameNode().getSymbol();
    const forwarding = argument ? returns(factory?.getBody()).map(functionNode).filter(fn =>
      !!fn && returns(fn.getBody()).some(expression =>
        [expression, ...expression.getDescendants()].some(node =>
          (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) &&
          node.getTagNameNode().getSymbol() === argument && node.getAttributes().some(attribute =>
            Node.isJsxSpreadAttribute(attribute) && bindingOf(attribute.getExpression()) === fn.getParameters()[0])))) : [];
    const localChains = forwarding.flatMap(fn => {
      const body = fn?.getBody();
      return body && parameter ? wrappedChains(body, true, relativePath, bodies, files, new Set(), { forwarded: parameter }) : [];
    });
    const forwards = localChains.length > 0;
    const known = tRPC || forwards || origin?.module === 'next-i18next' && origin.name === 'appWithTranslation';
    const hoc = locations(value, callee.getText(), known ? undefined : 'possible wrapper');
    application = application.flatMap(outer => (localChains.length ? localChains : [emptyChain])
      .map(inner => andThen(outer, { ...inner, locations: [hoc, ...inner.locations] }))).slice(0, 16);
    if (!known) issues.push(`opaque App wrapper ${callee.getText()} (${relativePath(value.getSourceFile())}:${startLine(value)})`);
    value = valueNode(value.getArguments()[0]);
  }
  const fn = functionNode(value);
  if (!fn || !files.has(fn.getSourceFile())) {
    return { chains: application.map(chain => ({ ...chain, path: [relativePath(source), ...chain.path] })),
      issues: [...issues, 'custom App body unresolved'], body: undefined, paths: undefined };
  }
  const name = 'getName' in fn && fn.getName() || fn.getParentIfKind(SyntaxKind.VariableDeclaration)?.getName() || 'default';
  const app = locations(fn, name);
  const body = fn.getBody();
  const paths = (scope: PagesWrapperScope) => {
    const paths = body ? wrappedChains(body, true, relativePath, bodies, files, new Set(), scope) : [];
    if (!paths.length) scope.issues?.push('custom App page slot unresolved');
    return application.flatMap(outer => (paths.length ? paths : [emptyChain]).map(path => ({
      ...path,
      conditional: path.conditional || outer.conditional,
      possible: path.possible || outer.possible,
      path: [relativePath(source), ...outer.path, ...path.path],
      locations: [...outer.locations, app, ...path.locations]
    })));
  };
  return { body, issues, chains: application, paths };
}

function pagesDocument(source: SourceFile, relativePath: RelativePath): Wrapper {
  const exported = source.getExportedDeclarations().get('default')?.[0];
  const definition = valueNode(exported) ?? exported ?? source;
  const name = 'getName' in definition && typeof definition.getName === 'function' ? definition.getName() : undefined;
  const main = definition.getDescendants().find(node => {
    if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) return false;
    const origin = importBinding(node.getTagNameNode());
    return origin?.module === 'next/document' && origin.name === 'Main';
  });
  return { file: relativePath(definition.getSourceFile()), symbol: name || 'default', line: startLine(definition),
    conditional: false, phase: 'document',
    evidence: main ? `Main at ${relativePath(main.getSourceFile())}:${startLine(main)}` : 'Main slot unresolved' };
}

export function collectRenderFacts(
  routes: RouteNode[], components: ComponentNode[], edges: ComponentEdge[],
  files: SourceFile[], bodies: Map<Node, Node>, relativePath: RelativePath, facts: DetailFacts, index?: QueryIndexBuilder, config?: NextConfig, workspace?: WorkspaceBindings
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
  const apps = new Map<string, ReturnType<typeof pagesApplication>>();
  const documents = new Map<string, Wrapper>();
  const wrapperLocations = new Map<string, Wrapper>();
  const wrapperRoots = new Map<string, string>();
  const wrapperChains = new Map<string, WrapperChain[]>();
  const reached = new Map<string, { page: RouteNode; viaLayout: boolean; depth: number }[]>();
  for (const route of routes.filter(route => route.type === 'page')) {
    const pagesRoot = route.pages ? /^(?:src\/)?pages\//.exec(route.file)?.[0] : undefined;
    const layouts = layoutsByPage.get(route.id) ?? [];
    const shell = (name: string) => pagesRoot && (config?.extensions ?? ['tsx', 'ts', 'jsx', 'js'])
      .map(ext => pagesRoot + name + '.' + ext).find(file => filesByPath.has(file));
    const app = shell('_app');
    const document = shell('_document');
    const wrappers = app ? [] : layouts;
    const issues: string[] = [];
    let chains = [emptyChain];
    if (document) {
      if (!documents.has(document)) documents.set(document, pagesDocument(filesByPath.get(document)!, relativePath));
      const wrapper = documents.get(document)!;
      if (wrapper.evidence === 'Main slot unresolved') issues.push('custom Document Main slot unresolved');
      index?.shell(document);
      chains = [{ path: [], locations: [wrapper] }];
    }
    const layoutSeeds: (string | undefined)[] = [];
    const pageWrapperSeeds = new Map<string, number>();
    for (const wrapper of wrappers) {
      if (!wrapperChains.has(wrapper)) {
        const source = filesByPath.get(wrapper);
        const exported = source?.getExportedDeclarations().get('default') ?? [];
        const body = exported.map(node => bodies.get(node)).find(Boolean);
        const component = routesByFile.get(wrapper)?.componentId ?? (body && componentByBody.get(body));
        if (component) wrapperRoots.set(wrapper, component);
        const definition = exported[0];
        const symbol = component && componentsById.get(component)?.name || 'default';
        const paths = body ? wrappedChains(body, false, relativePath, bodies, projectFiles) : [];
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
    if (app) {
      if (!apps.has(app)) apps.set(app, pagesApplication(filesByPath.get(app)!, relativePath, bodies, projectFiles, workspace));
      const application = apps.get(app)!;
      const page = pageProperties(filesByPath.get(route.file));
      const assignments = page.assignments;
      const scope: PagesWrapperScope = {
        page, issues,
        renderCondition: (tag, decision) => index?.pageRenderCondition(route.id, tag, decision)
      };
      const applicationChains = application.paths?.(scope) ?? application.chains;
      index?.shell(app, application.body);
      layoutSeeds.push(`file:${app}`, application.body && componentByBody.get(application.body));
      issues.push(...application.issues);
      const expanded = applicationChains.flatMap(chain => {
        let branches = [chain];
        const dispatch = chain.dispatch;
        if (dispatch) {
          const assigned = assignments.get(dispatch);
          if (!assigned) {
            if (!page.opaque && !page.unknown.has(dispatch)) return [];
            issues.push(`unresolved page property ${dispatch}`);
            return [{ ...chain, possible: true }];
          }
          if (page.unknown.has(dispatch)) chain = { ...chain, possible: true };
          const fn = functionNode(assigned.value);
          const body = fn?.getBody();
          if (!fn || !body || !projectFiles.has(fn.getSourceFile())) {
            issues.push(`unresolved page property ${dispatch}`);
            return [{ ...chain, possible: true }];
          }
          const definition = Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)
            ? fn.getParentIfKind(SyntaxKind.VariableDeclaration) ?? fn : fn;
          const name = 'getName' in definition && definition.getName() || dispatch;
          const wrapper: Wrapper = { file: relativePath(fn.getSourceFile()), symbol: name, line: startLine(definition),
            conditional: false, evidence: `${dispatch} assigned at ${relativePath(assigned.site.getSourceFile())}:${startLine(assigned.site)}`,
            site: { file: relativePath(assigned.site.getSourceFile()), line: startLine(assigned.site) } };
          const paths = wrappedChains(body, true, relativePath, bodies, projectFiles, new Set(), scope);
          if (!paths.length) issues.push(`page slot unresolved in ${dispatch}`);
          branches = (paths.length ? paths : [emptyChain]).map(path => ({
            ...andThen(andThen(chain, { path: [wrapper.file + '#' + name], locations: [wrapper] }), path),
            getLayout: path.getLayout
          }));
        }
        const assigned = assignments.get('getLayout');
        return branches.flatMap(branch => {
          if (!branch.getLayout) return [branch];
          if (page.unknown.has('getLayout') || !assigned && page.opaque) {
            issues.push('getLayout binding unresolved');
            return [{ ...branch, possible: true }];
          }
          if (!assigned) return [branch];
          const fn = functionNode(assigned.value);
          const body = fn?.getBody();
          const parameter = fn?.getParameters()[0]?.getNameNode();
          if (!body || !Node.isIdentifier(parameter) || !projectFiles.has(body.getSourceFile())) {
            issues.push('getLayout binding unresolved');
            return [branch];
          }
          const paths = wrappedChains(body, false, relativePath, bodies, projectFiles, new Set(), { ...scope, parameter: parameter.getText() });
          if (!paths.length) {
            if (!returns(body).every(node => bindingOf(node) === fn?.getParameters()[0])) issues.push('getLayout page slot unresolved');
            return [branch];
          }
          const origin = declarationsOf(assigned.value)[0];
          if (origin && projectFiles.has(origin.getSourceFile())) {
            index?.wrapperDependency(route.id, origin, assigned.site, 'getLayout');
          }
          const evidence = `getLayout at ${relativePath(fn!.getSourceFile())}:${startLine(fn!)}; assigned at ${relativePath(assigned.site.getSourceFile())}:${startLine(assigned.site)}`;
          return paths.map(path => andThen(branch, { ...path, locations: path.locations.map((wrapper, i) =>
            i === 0 ? { ...wrapper, evidence, site: { file: relativePath(assigned.site.getSourceFile()), line: startLine(assigned.site) } } : wrapper) }));
        });
      });
      if (expanded.length) chains = chains.flatMap(prefix => expanded.map(chain => andThen(prefix, chain)));
      else chains = chains.flatMap(prefix => applicationChains.map(chain => andThen(prefix, chain)));
      chains = chains.map(chain => chain.possible ? { ...chain, locations: chain.locations.map(wrapper =>
        wrapper.phase ? wrapper : { ...wrapper, possible: true }) } : chain);
      for (const chain of [...chains].sort((a, b) => Number(!!a.possible) - Number(!!b.possible))) for (const [position, wrapper] of chain.locations.entries()) {
        if (wrapper.phase || wrapper.external) continue;
        const id = `cmp:${wrapper.definitionFile ?? wrapper.file}#${wrapper.symbol}`;
        if (componentsById.has(id)) {
          index?.render(`file:${route.file}`, id,
            wrapper.site?.file === route.file ? wrapper.site.line : route.file === wrapper.file ? wrapper.line :
              startLine(filesByPath.get(route.file)!.getExportedDeclarations().get('default')?.[0] ?? filesByPath.get(route.file)!),
            Number(wrapper.conditional || !!chain.conditional), true, chain.possible ? true : undefined);
          layoutSeeds.push(id);
          pageWrapperSeeds.set(id, Math.min(pageWrapperSeeds.get(id) ?? Infinity, position + 1));
        }
      }
    }
    if (issues.length) index?.wrapperIssues(route.id, [...new Set(issues)]);
    if (route.pages) {
      const unique = new Map<string, WrapperChain>();
      for (const chain of chains) {
        const key = JSON.stringify(chain.locations.map(({ conditional, possible, ...item }) => item));
        const prior = unique.get(key);
        if (!prior || prior.possible && !chain.possible || prior.possible === chain.possible && prior.conditional && !chain.conditional) unique.set(key, chain);
      }
      chains = [...unique.values()];
    }
    index?.page(route.id, app ? [] : layoutSeeds, chains.map(chain => chain.locations));
    for (const { path, conditional } of chains) {
      if (path.length) addFact(facts, route.file, `wrap ${route.file} <- ${path.join(' > ')}${conditional ? ' (conditional)' : ''}`, path.length);
    }
    const visited = new Set<string>();
    const layoutRoots = new Set(layoutSeeds.filter(id => id === undefined || !pageWrapperSeeds.has(id)));
    const traverse = (seeds: (string | undefined)[], viaLayout: boolean) => {
      const queue = seeds.map(id => ({ id, depth: viaLayout && id ? pageWrapperSeeds.get(id) ?? 0 : 0 }));
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
        for (const target of outgoing.get(id) ?? []) {
          if (!index?.pageRenderExcluded(route.id, id, target)) queue.push({ id: target, depth: depth + 1 });
        }
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

export function urlTexts(node: Node, seen = new Set<Node>(), expandConditional = true, wholeUrl = true): UrlText[] | undefined {
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

function apiSegments(url: UrlText, config?: NextConfig) {
  const prefix = /^(?:[\0\x01]+|https?:\/\/[^/?#]+)(?=\/api(?:[/?#]|$))/.exec(url.text)?.[0];
  const raw = prefix ? url.text.slice(prefix.length) : url.text;
  const local = config ? (normalizeNextUrl(raw, config.url) ?? raw) + (/[?#].*$/.exec(raw)?.[0] ?? '') : raw;
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

const requestMethods = ['get', 'delete', 'head', 'options', 'post', 'put', 'patch'];

function axiosInstance(node: Node | undefined) {
  const init = valueNode(node);
  if (!Node.isCallExpression(init)) return;
  const factory = importBinding(init.getExpression());
  return factory?.module === 'axios' && factory.name === 'create' ? init : undefined;
}

function playwrightType(node: Node) {
  const binding = bindingOf(node);
  const type = Node.isParameterDeclaration(binding) || Node.isVariableDeclaration(binding) ? binding.getTypeNode() : undefined;
  const origin = type?.getKind() === SyntaxKind.TypeReference ?
    importBinding(type.asKindOrThrow(SyntaxKind.TypeReference).getTypeName(), true) : undefined;
  return origin && /^(?:@playwright\/test|playwright)$/.test(origin.module) ? origin.name : undefined;
}

function playwrightRequest(node: Node) {
  if (playwrightType(node) === 'APIRequestContext') return true;
  if (Node.isPropertyAccessExpression(node) && node.getName() === 'request') {
    const owner = node.getExpression();
    if (['Page', 'BrowserContext'].includes(playwrightType(owner) ?? '')) return true;
    if (Node.isCallExpression(owner)) {
      const method = owner.getExpression();
      if (Node.isPropertyAccessExpression(method) && method.getName() === 'context' &&
        playwrightType(method.getExpression()) === 'Page') return true;
    }
  }
  const binding = bindingOf(node);
  if (!Node.isBindingElement(binding) || (binding.getPropertyNameNode() ?? binding.getNameNode()).getText() !== 'request') return false;
  const callback = binding.getParent().getParent().getParent();
  const call = callback.getParentIfKind(SyntaxKind.CallExpression);
  if (!call || !call.getArguments().some(arg => arg === callback)) return false;
  const origin = importBinding(call.getExpression());
  return origin?.module === '@playwright/test' && origin.name === 'test';
}

function httpRequest(call: import('ts-morph').CallExpression, pages: boolean) {
  const expression = call.getExpression();
  const origin = importBinding(expression);
  const [url, options] = call.getArguments();
  if (!url) return;
  if (/^(?:(?:globalThis|window)\.)?fetch$/.test(expression.getText()) &&
    !declarationsOf(expression).some(declaration => !declaration.getSourceFile().isDeclarationFile())) {
    const methodProperty = property(options, 'method');
    const method = textValue(methodProperty)?.toUpperCase() ??
      (options && (!Node.isObjectLiteralExpression(options) || methodProperty ||
        options.getProperties().some(Node.isSpreadAssignment)) ? '?' : 'GET');
    return { url, method, via: 'fetch' };
  }
  if (!Node.isPropertyAccessExpression(expression) || !requestMethods.includes(expression.getName())) return;
  const method = expression.getName().toUpperCase();
  const instance = pages && axiosInstance(expression.getExpression());
  if (origin?.module === 'axios' && requestMethods.includes(origin.name) || instance) {
    const options = instance ? instance.getArguments()[0] : undefined;
    return { url, method, via: 'axios', base: textValue(property(options, 'baseURL')) };
  }
  if (pages && playwrightRequest(expression.getExpression())) return { url, method, via: 'Playwright request' };
}

function trpcRequest(call: import('ts-morph').CallExpression, workspace?: WorkspaceBindings) {
  let expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return;
  const operation = expression.getName();
  const method = ['query', 'useQuery', 'useInfiniteQuery'].includes(operation) ? 'GET' :
    ['mutate', 'mutateAsync'].includes(operation) ? 'POST' : undefined;
  if (!method) return;
  const members: string[] = [];
  expression = expression.getExpression();
  const mutation = method === 'POST' && valueNode(expression);
  if (mutation && Node.isCallExpression(mutation)) {
    const hook = mutation.getExpression();
    if (!Node.isPropertyAccessExpression(hook) || hook.getName() !== 'useMutation') return;
    expression = hook.getExpression();
  }
  while (Node.isPropertyAccessExpression(expression)) {
    members.unshift(expression.getName());
    expression = expression.getExpression();
  }
  if (!members.length) return;
  const local = valueNode(expression);
  const init = Node.isCallExpression(local) ? local : valueNode(workspace?.resolve(expression));
  if (!Node.isCallExpression(init)) return;
  if (operation.startsWith('use') && property(call.getArguments()[1], 'enabled')?.getKind() === SyntaxKind.FalseKeyword) return;
  const factory = importBinding(init.getExpression());
  if (!factory || !['@trpc/client', '@trpc/next', '@trpc/react-query'].includes(factory.module) ||
      !['createTRPCClient', 'createTRPCProxyClient', 'createTRPCNext', 'createTRPCReact'].includes(factory.name)) return;
  const links = init.getDescendantsOfKind(SyntaxKind.CallExpression).filter(node => {
    const origin = importBinding(node.getExpression());
    return origin?.module === '@trpc/client' && origin.name === 'httpBatchLink';
  });
  if (links.length !== 1) return;
  const url = property(links[0].getArguments()[0], 'url');
  const prefix = textValue(url);
  if (!url || !prefix) return;
  return { url, text: prefix.replace(/\/$/, '') + '/' + members.join('.'), method, via: 'tRPC request',
    evidence: `httpBatchLink at ${init.getSourceFile().getBaseName()}:${startLine(links[0])}`,
    partial: !Node.isCallExpression(local) || !!property(call.getArguments()[1], 'enabled') };
}

const API_REFERENCE_KINDS = new Set([
  SyntaxKind.CallExpression, SyntaxKind.NewExpression, SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateExpression, SyntaxKind.BinaryExpression
]);

export function collectApiFacts(files: SourceFile[], routes: RouteNode[], relativePath: RelativePath,
  actionIds: Map<Node, string>, facts: DetailFacts, callable: (node: Node) => Node | undefined, index?: QueryIndexBuilder, config?: NextConfig, workspace?: WorkspaceBindings) {
  const endpoints = routes.filter(route => route.type === 'api').map(route => ({
    route,
    segments: routeSegments(route.path)
  })).map(endpoint => ({ ...endpoint, rank: patternRank(endpoint.segments) }));
  if (!endpoints.length) return;
  endpoints.sort((a, b) => b.rank.localeCompare(a.rank));
  const urlMatches = (parsed: NonNullable<ReturnType<typeof apiSegments>>) => {
    const { segments, partial } = parsed;
    if (config && !segments.some(segment => unknownSlot.test(segment))) {
      return matchNextRoutes('/' + segments.join('/'), endpoints, endpoint => endpoint.route.path)
        .map(({ route }) => ({ route, partial, markdown: parsed.markdown, dynamic: undefined }));
    }
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
  const matchValues = (values: UrlText[]) => {
    let matches: Map<string, ReturnType<typeof urlMatches>[number]> | undefined;
    for (const value of values) {
      const parsed = apiSegments(value, config);
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
  const matchesFor = (url: Node | string) => matchValues(typeof url === 'string' ? [{ text: url }] : urlTexts(url) ?? []);
  type Request = NonNullable<ReturnType<typeof httpRequest>>;
  const summaries = new Map<Node, { request: Request; call: Node; parameter: number }[]>();
  const summarize = (node: Node) => {
    const fn = functionNode(node);
    if (!fn || !projectFiles.has(fn.getSourceFile())) return [];
    if (summaries.has(fn)) return summaries.get(fn)!;
    const result: { request: Request; call: Node; parameter: number }[] = [];
    const visit = (node: Node, traversal?: { skip(): void }) => {
      if (Node.isFunctionLikeDeclaration(node)) { traversal?.skip(); return; }
      if (!Node.isCallExpression(node) || conditionalAt(node, fn)) return;
      const request = httpRequest(node, true);
      if (!request) return;
      const binding = bindingOf(valueNode(request.url) ?? request.url);
      const parameter = fn.getParameters().findIndex(parameter => parameter === binding);
      if (parameter >= 0) result.push({ request, call: node, parameter });
    };
    const body = fn.getBody();
    if (body) { visit(body); body.forEachDescendant(visit); }
    summaries.set(fn, result);
    return result;
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
      if (config && !isConstructor && !isFetch && !isSwr && !axiosMethod && !isAiSdk) {
        const direct = httpRequest(node, true);
        const trpc = trpcRequest(node, workspace);
        const requests = direct ? [{ ...direct, evidence: undefined, text: undefined }] : trpc ? [trpc] :
          summarize(expression).flatMap(summary => {
            const url = node.getArguments()[summary.parameter];
            return url ? [{ ...summary.request, url, text: undefined,
              evidence: `HTTP client at ${relativePath(summary.call.getSourceFile())}:${startLine(summary.call)}` }] : [];
          });
        for (const request of requests) {
          const base = 'base' in request ? request.base : undefined;
          const values = request.text ? [{ text: request.text, partial: 'partial' in request && request.partial }] : (urlTexts(request.url) ?? []).map(value =>
            base && !/^https?:/.test(value.text) ? { ...value, text: base.replace(/\/$/, '') + '/' + value.text.replace(/^\//, '') } : value);
          const matches = matchValues(values);
          if (!matches?.size) continue;
          classify(request.url);
          for (const { route, partial, dynamic, markdown } of matches.values()) {
            index?.fetch({ file: source, line: startLine(node), node, route: route.id, method: request.method, url: route.path,
              via: request.via, partial: partial || undefined, dynamic, evidence: request.evidence });
            if (markdown) addFact(facts, source, `fetch ${source} -> ${route.file} ${route.path} (${request.via})`);
          }
        }
        return;
      }
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
