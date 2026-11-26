import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Node, SourceFile, SyntaxKind, ts, type CallExpression } from 'ts-morph';
import type { ComponentNode, RouteNode } from '../types/GraphTypes';
import {
  GRAPH_INDEX_REVISION, INDEX_SCHEMA, QUERY_INDEX_REVISION, GraphReferenceKind, WRAPPER_INDEX_REVISION, VERSION,
  isMiddlewareFile, isTestFile, RENDER_LOOKUP_ISSUE, renderGuardKey, renderSiteKey, type ExternalCall, type FetchEntry, type FlowGate, type GraphReference,
  type DetailFact, type DetailFacts, type ModuleImport, type NamespaceUse, type PageRenderCondition, type QueryIndex, type Reference, type ServerAction, type Wrapper
} from '../../mcp/Index';
import { conditionalAt, declarationsOf as uncachedDeclarationsOf, isPackageSpecifier, wrappedExpression } from './ArchitectureFacts';
import { middlewareMatcher } from './ChangeSource';
import { visitKinds } from './CompilerWalk';
import { inspectRuntimeExports } from './RuntimeExports';
import { endLine, lineAt, startLine } from './SourceLines';
import { CallableFlow, callbackRefWrites, FunctionNode, isFunction, jsxLabel, jsxRefContainer, packageMember, refBinding, sectionLabels, useRefBinding } from './CallableFlow';
import { constValue, JsxSite, jsxValue, PropFlow, PropGate, RenderSite } from './PropFlow';
import { collectPagesFacts, type PagesDependency } from './PagesFacts';
import type { RouterProject } from '../frameworks/react-router/RouteTypes';
import type { NextConfig } from './NextConfig';
import type { WorkspaceBindings } from './WorkspaceBindings';
import { TrpcFacts } from './TrpcFacts';
import { isComponentWrapper, renderBindings } from './RenderBindings';
import { bindingOf, executionSites, functionNode, importBinding, returns, valueNode } from './StaticBindings';
import { evaluateRenderGuards, type RenderSelection } from './RenderGuards';
import type { ReactFacts, IndexedRequest } from './ReactFacts';

type RelativePath = (source: SourceFile) => string;
type PendingFetch = Omit<FetchEntry, 'route' | 'fn' | 'owner' | 'binding' | 'gates'> & {
  route: string; node: Node; prop?: { site: RenderSite; value: Node; name: string }; propGates?: PropGate[];
};

const REFERENCE_KINDS = new Set([
  SyntaxKind.ImportSpecifier, SyntaxKind.ImportClause, SyntaxKind.BindingElement, SyntaxKind.ExportDeclaration,
  SyntaxKind.ExportSpecifier, SyntaxKind.CallExpression, SyntaxKind.NewExpression, SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.JsxOpeningElement, SyntaxKind.JsxSelfClosingElement, SyntaxKind.PropertyAssignment, SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.ElementAccessExpression, SyntaxKind.Identifier
]);
const FLOW_KINDS = new Set([SyntaxKind.JsxAttribute, SyntaxKind.CallExpression]);
const MOCK_KEY_KINDS = new Set([SyntaxKind.PropertyAssignment, SyntaxKind.ShorthandPropertyAssignment, SyntaxKind.MethodDeclaration]);

function configuredPaths(source: SourceFile, root: string, specifier: string) {
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

function throughWrappers(node: Node) {
  for (let parent = node.getParent(); parent && wrappedExpression(parent) === node; parent = node.getParent()) node = parent;
  return node;
}

function unwrapValue(node: Node | undefined) {
  let inner: Node | undefined;
  while (node && (inner = wrappedExpression(node))) node = inner;
  return node;
}

function dynamicExport(node: Node) {
  let expression = throughWrappers(node);
  const awaited = expression.getParent();
  if (Node.isAwaitExpression(awaited) && awaited.getExpression() === expression) {
    expression = throughWrappers(awaited);
    const selector = expression.getParent();
    if (Node.isPropertyAccessExpression(selector) && selector.getExpression() === expression) {
      return { name: selector.getName(), selector, expression: throughWrappers(selector) };
    }
  }
  const parent = expression.getParent();
  if (!Node.isPropertyAccessExpression(parent) || parent.getExpression() !== expression || parent.getName() !== 'then') {
    return { name: 'default', expression };
  }
  const call = parent.getParent();
  if (!Node.isCallExpression(call) || call.getExpression() !== parent) return;
  const callback = call.getArguments()[0];
  if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return;
  let result = unwrapValue(simpleReturn(callback.getBody()));
  // React.lazy expects an object with a default export.
  if (Node.isObjectLiteralExpression(result) && result.getProperties().length === 1) {
    const [member] = result.getProperties();
    if (Node.isPropertyAssignment(member) && member.getName() === 'default') result = unwrapValue(member.getInitializer());
  }
  const parameter = callback.getParameters()[0];
  if (!parameter) return;
  if (Node.isPropertyAccessExpression(result) && bindingOf(unwrapValue(result.getExpression())) === parameter) {
    return { name: result.getName(), selector: result, expression: throughWrappers(call) };
  }
  if (!Node.isIdentifier(result)) return;
  const binding = bindingOf(result);
  if (binding === parameter) return { name: 'default', expression: throughWrappers(call) };
  const pattern = parameter.getNameNode();
  if (!Node.isBindingElement(binding) || !Node.isObjectBindingPattern(pattern) || binding.getParent() !== pattern ||
      binding.getInitializer() || binding.getDotDotDotToken()) return;
  const property = binding.getPropertyNameNode() ?? binding.getNameNode();
  if (Node.isIdentifier(property) || Node.isStringLiteral(property)) {
    return { name: Node.isIdentifier(property) ? property.getText() : property.getLiteralText(), expression: throughWrappers(call) };
  }
}

function simpleReturn(body: Node) {
  if (!Node.isBlock(body)) return body;
  const statements = body.getStatements();
  const last = statements.pop();
  if (Node.isReturnStatement(last) && statements.every(statement =>
    Node.isVariableStatement(statement) && statement.getDeclarationKind() === 'const')) return last.getExpression();
}

function returnedValueUse(node: Node) {
  let child = node;
  for (let parent = child.getParent(); parent; child = parent, parent = parent.getParent()) {
    if (Node.isReturnStatement(parent)) return parent.getExpression() === child;
    if (Node.isArrowFunction(parent)) return parent.getBody() === child;
    if (wrappedExpression(parent) === child || Node.isShorthandPropertyAssignment(parent) ||
        Node.isPropertyAssignment(parent) && parent.getInitializer() === child ||
        Node.isObjectLiteralExpression(parent) || Node.isArrayLiteralExpression(parent) ||
        Node.isConditionalExpression(parent) && parent.getCondition() !== child) continue;
    return false;
  }
  return false;
}

function lazyFactory(call: import('ts-morph').CallExpression) {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee) && !Node.isPropertyAccessExpression(callee)) return false;
  const origin = importBinding(callee);
  return origin?.module === 'next/dynamic' && origin.name === 'default' && Node.isIdentifier(callee) ||
    origin?.module === 'react' && packageMember(callee, 'react') === 'lazy';
}

function lazyVariable(call: Node) {
  const initializer = throughWrappers(call);
  const binding = initializer.getParent();
  return Node.isVariableDeclaration(binding) && binding.getInitializer() === initializer &&
    binding.getVariableStatement()?.getDeclarationKind() === 'const' ? binding : undefined;
}

function stableComponentBinding(node: Node) {
  if (Node.isVariableDeclaration(node)) return !!constValue(node);
  if (!Node.isFunctionDeclaration(node)) return false;
  const name = node.getNameNode();
  return !name?.findReferences().some(symbol => symbol.getReferences().some(reference =>
    reference.isWriteAccess() && !reference.isDefinition() && reference.getNode() !== name &&
    !reference.getNode().getFirstAncestorByKind(SyntaxKind.ImportDeclaration)));
}

function resolvedPromiseValue(call: import('ts-morph').CallExpression) {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'resolve') return;
  const promise = callee.getExpression();
  if (!Node.isIdentifier(promise) || promise.getText() !== 'Promise' ||
      uncachedDeclarationsOf(promise).some(declaration => !declaration.getSourceFile().compilerNode.hasNoDefaultLib)) return;
  const value = unwrapValue(call.getArguments()[0]);
  if (Node.isIdentifier(value)) return value;
}

type LoaderImport = {
  imported: import('ts-morph').CallExpression;
  name?: string;
  selector?: import('ts-morph').PropertyAccessExpression;
  possible: boolean;
  partialOnly?: 'namespace' | 'opaque';
};

type LoaderTarget = LoaderImport | { value: Node; promise: import('ts-morph').CallExpression; possible: boolean };

function loaderTargets(loader: FunctionNode, files: ReadonlySet<SourceFile>): LoaderTarget[] {
  type Selection = Pick<LoaderImport, 'name' | 'selector'>;
  type PromiseBinding = { parameter: Node; input: Node; outer?: PromiseBinding };
  const targets: LoaderTarget[] = [];
  let budget = 64;
  const follow = (value: Node | undefined, possible: boolean, selection?: Selection, binding?: PromiseBinding) => {
    const node = unwrapValue(value);
    if (!node || --budget < 0) return;
    if (Node.isAwaitExpression(node)) {
      follow(node.getExpression(), possible, selection, binding);
    } else if (Node.isConditionalExpression(node)) {
      const condition = valueNode(node.getCondition());
      if (!Node.isFalseLiteral(condition)) follow(node.getWhenTrue(), possible || !Node.isTrueLiteral(condition), selection, binding);
      if (!Node.isTrueLiteral(condition)) follow(node.getWhenFalse(), possible || !Node.isFalseLiteral(condition), selection, binding);
    } else if (!selection && Node.isPropertyAccessExpression(node)) {
      follow(node.getExpression(), possible, { name: node.getName(), selector: node }, binding);
    } else if (!selection && Node.isElementAccessExpression(node)) {
      const index = node.getArgumentExpression();
      const keys = index ? finiteTemplateValues(index) : [undefined];
      for (const key of keys) if (key !== undefined) {
        follow(node.getExpression(), possible || keys.length !== 1, { name: key }, binding);
      }
    } else if (Node.isObjectLiteralExpression(node) && (!selection || selection.name === 'default')) {
      const [member, extra] = node.getProperties();
      if (!extra && Node.isPropertyAssignment(member) && member.getName() === 'default') {
        follow(member.getInitializer(), possible, undefined, binding);
      }
    } else if (Node.isIdentifier(node)) {
      const declaration = bindingOf(node);
      if (binding && declaration === binding.parameter) {
        follow(binding.input, possible, selection, binding.outer);
      } else if (!selection && Node.isBindingElement(declaration) && !declaration.getInitializer() && !declaration.getDotDotDotToken()) {
        const pattern = declaration.getParent();
        const property = declaration.getPropertyNameNode() ?? declaration.getNameNode();
        const name = Node.isIdentifier(property) ? property.getText() : Node.isStringLiteral(property) ? property.getLiteralText() : undefined;
        if (name && Node.isObjectBindingPattern(pattern)) {
          const owner = pattern.getParent();
          if (binding && owner === binding.parameter) follow(binding.input, possible, { name }, binding.outer);
          else follow(constValue(owner), possible, { name }, binding);
        }
      } else if (declaration) {
        const local = Node.isVariableDeclaration(declaration) && localLoaderValue(declaration, node);
        follow(constValue(declaration) ?? (local || undefined), possible, selection, binding);
      }
    } else if (Node.isCallExpression(node)) {
      const callee = node.getExpression();
      const resolved = !selection ? resolvedPromiseValue(node) : undefined;
      if (callee.getKind() === SyntaxKind.ImportKeyword) {
        targets.push({ imported: node, name: 'default', ...selection, possible });
      } else if (resolved) {
        targets.push({ value: resolved, promise: node, possible });
      } else if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'then') {
        const callback = functionNode(node.getArguments()[0]);
        const parameter = callback?.getParameters()[0];
        if (callback && files.has(callback.getSourceFile())) {
          const body = callback.getBody();
          const result = body && (simpleReturn(body) ?? mutableLoaderReturn(body));
          const input = callee.getExpression();
          for (const returned of result ? [result] : executionSites(body).returned.map(entry => entry.node)) {
            const before = targets.length;
            follow(returned, possible || !result, selection, parameter ? { parameter, input, outer: binding } : binding);
            if (targets.length !== before || !Node.isCallExpression(input) ||
                input.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
            const value = unwrapValue(returned);
            if (!Node.isElementAccessExpression(value) && !Node.isPropertyAccessExpression(value)) continue;
            const receiver = unwrapValue(value.getExpression());
            const declaration = bindingOf(receiver);
            const namespace = parameter && declaration === parameter;
            const opaque = Node.isPropertyAccessExpression(value) && Node.isIdentifier(receiver) && !declaration;
            if (namespace || opaque) targets.push({ imported: input,
              name: Node.isPropertyAccessExpression(value) ? value.getName() : undefined,
              possible: true, partialOnly: namespace ? 'namespace' : 'opaque' });
          }
        }
      } else {
        const fn = functionNode(callee);
        if (fn && files.has(fn.getSourceFile())) {
          for (const { node } of executionSites(fn.getBody()).returned) follow(node, true, selection);
        }
      }
    }
  };
  const body = loader.getBody();
  const result = body && (simpleReturn(body) ?? mutableLoaderReturn(body));
  for (const returned of result ? [result] : executionSites(body).returned.map(entry => entry.node)) follow(returned, !result);
  return targets;
}

function mutableLoaderReturn(body: Node) {
  const [result, other] = executionSites(body).returned;
  if (!result || other || result.possible) return;
  const read = unwrapValue(result.node);
  const binding = bindingOf(read);
  if (Node.isIdentifier(read) && Node.isVariableDeclaration(binding) && localLoaderValue(binding, read)) return result.node;
}

function localLoaderValue(declaration: import('ts-morph').VariableDeclaration, read: import('ts-morph').Identifier) {
  const statement = declaration.getVariableStatement();
  const name = declaration.getNameNode();
  const returned = throughWrappers(read).getParent();
  if (!statement || statement.getDeclarationKind() !== 'let' || !Node.isIdentifier(name) ||
      !Node.isReturnStatement(returned) || !Node.isBlock(statement.getParent()) ||
      statement.getParent() !== returned.getParent() || statement.getStart() >= returned.getStart()) return;
  let value = declaration.getInitializer();
  let latest = statement.getStart();
  for (const symbol of name.findReferences()) for (const reference of symbol.getReferences()) {
    if (!reference.isWriteAccess() || reference.isDefinition()) continue;
    const use = reference.getNode();
    const assignment = use.getParent();
    if (!Node.isBinaryExpression(assignment) || assignment.getLeft() !== use ||
        assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return;
    const entry = assignment.getParent();
    if (!Node.isExpressionStatement(entry) || entry.getParent() !== statement.getParent() ||
        entry.getStart() <= statement.getStart()) return;
    if (entry.getStart() < returned.getStart() && entry.getStart() > latest) {
      value = assignment.getRight();
      latest = entry.getStart();
    }
  }
  return value;
}

function finiteTemplateValues(node: Node, remaining = 8): (string | undefined)[] {
  if (!remaining) return [undefined];
  const value = valueNode(node);
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) return [value.getLiteralText()];
  if (Node.isNumericLiteral(value)) return [String(value.getLiteralValue())];
  if (Node.isConditionalExpression(value)) {
    const condition = valueNode(value.getCondition());
    if (Node.isTrueLiteral(condition)) return finiteTemplateValues(value.getWhenTrue(), remaining - 1);
    if (Node.isFalseLiteral(condition)) return finiteTemplateValues(value.getWhenFalse(), remaining - 1);
    return [...new Set([value.getWhenTrue(), value.getWhenFalse()].flatMap(branch => finiteTemplateValues(branch, remaining - 1)))];
  }
  if (Node.isElementAccessExpression(value)) {
    const array = valueNode(value.getExpression());
    const index = value.getArgumentExpression();
    if (Node.isArrayLiteralExpression(array) && index && !array.getElements().some(Node.isSpreadElement)) {
      const keys = finiteTemplateValues(index, remaining - 1);
      if (keys.every(key => key !== undefined && /^\d+$/.test(key))) {
        return [...new Set(keys.flatMap(key => {
          const element = array.getElements()[Number(key)];
          return element && !Node.isOmittedExpression(element) ? finiteTemplateValues(element, remaining - 1) : ['undefined'];
        }))];
      }
    }
  }
  // The checker can prove finite literal domains even when their runtime source
  // is opaque (for example, an indexed tuple or a union-valued parameter).
  const type = (value ?? node).getType();
  const choices = type.isUnion() ? type.getUnionTypes() : [type];
  if (choices.every(choice => choice.isStringLiteral() || choice.isNumberLiteral() ||
      choice.isBooleanLiteral() || choice.isNull() || choice.isUndefined())) {
    return [...new Set(choices.map(choice => String(choice.getLiteralValue() ?? choice.getText())))];
  }
  return [undefined];
}

function readsUrlParameter(value: Node) {
  if (!Node.isCallExpression(value)) return false;
  const callee = value.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'get' ||
      !Node.isStringLiteral(value.getArguments()[0])) return false;
  const seen = new Set<Node>();
  const fromLocation = (input: Node | undefined): boolean => {
    const source = valueNode(input);
    if (!source || seen.size >= 16 || seen.has(source)) return false;
    seen.add(source);
    if (Node.isBinaryExpression(source) &&
        [SyntaxKind.QuestionQuestionToken, SyntaxKind.BarBarToken].includes(source.getOperatorToken().getKind())) {
      return fromLocation(source.getLeft()) || fromLocation(source.getRight());
    }
    if (Node.isNewExpression(source)) {
      const constructor = source.getExpression();
      const params = packageMember(constructor, 'next/navigation') === 'ReadonlyURLSearchParams' ||
        Node.isIdentifier(constructor) && constructor.getText() === 'URLSearchParams' &&
          uncachedDeclarationsOf(constructor).some(declaration => declaration.getSourceFile().compilerNode.hasNoDefaultLib);
      return params && fromLocation(source.getArguments()[0]);
    }
    if (!Node.isCallExpression(source)) return false;
    const expression = source.getExpression();
    if (packageMember(expression, 'next/navigation') === 'useSearchParams') return true;
    if (Node.isPropertyAccessExpression(expression) && expression.getName() === 'toString') {
      return fromLocation(expression.getExpression());
    }
    return returns(functionNode(expression)?.getBody()).some(fromLocation);
  };
  return fromLocation(callee.getExpression());
}

export class QueryIndexBuilder {
  constructor(private readonly exportsOf = (file: SourceFile) => file.getExportedDeclarations()) {}

  private edges: [string, string, number, number, true?, true?, string?, RenderSite?, string?][] = [];
  private renderSelections = new Map<typeof this.edges[number], RenderSelection>();
  private contextExcluded = new Set<typeof this.edges[number]>();
  private replacedInlineRenders = new Set<typeof this.edges[number]>();
  private renderSites = new Map<Node, typeof this.edges>();
  private renderPairs = new Map<string, typeof this.edges>();
  private renderLookupIssues = new Map<string, { tag: Node; bindings: Node[] }>();
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

  render(from: string, to: string, line: number, conditional: number, layout?: true, possible?: true, tag?: Node,
    detail?: string, site?: RenderSite, file?: string, contextExcluded?: true, selection?: RenderSelection) {
    const edge: typeof this.edges[number] = possible ? [from, to, line, conditional, layout, possible] :
      layout ? [from, to, line, conditional, layout] : [from, to, line, conditional];
    if (detail) edge[6] = detail;
    if (site) edge[7] = site;
    if (file) edge[8] = file;
    this.edges.push(edge);
    if (selection) this.renderSelections.set(edge, selection);
    if (contextExcluded) this.contextExcluded.add(edge);
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

  unresolvedRenderLookup(owner: string, tag: Node, bindings: Node[]) {
    if (!this.renderLookupIssues.has(owner)) this.renderLookupIssues.set(owner, { tag, bindings });
  }

  private opaqueRenderLookups: { owner: string; tag: Node; sources: Set<Node> }[] = [];

  opaqueRenderLookup(owner: string, tag: Node, sources: Set<Node>) {
    this.opaqueRenderLookups.push({ owner, tag, sources });
  }

  replaceInlineRender(tag: Node, target: string, file: string, component?: string) {
    for (const edge of this.renderSites.get(tag) ?? []) {
      if (edge[1] === target && (edge[0] === file || edge[0] === component)) this.replacedInlineRenders.add(edge);
    }
  }

  hasRenderAt(tag: Node, from: string, to: string) {
    return this.renderSites.get(tag)?.some(edge => edge[0] === from && edge[1] === to);
  }

  pageRenderCondition(route: string, tag: Node, decision: PageRenderCondition) {
    for (const edge of this.renderSites.get(tag) ?? []) {
      const conditions = this.pageConditions.get(route) ?? new Map();
      if (decision === 'conditional' && conditions.has(edge)) continue;
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
    aliases: Map<Node, Node[]>, relativePath: RelativePath, actions: Map<Node, string>, root: string, config: NextConfig | undefined, workspace: WorkspaceBindings | undefined, flow: PropFlow, historyOnly = false, router?: RouterProject): QueryIndex {
    const declarationsOf = (node: Node) => flow.declarations(node);
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
    const routerCallSites = router && new Map<Node, number>();
    const byNode = new Map<Node, number>();
    const byGraphId = new Map<string, number>();
    const exports = new Map(files.map(file => [file, this.exportsOf(file)]));
    const exported = new Set<Node>([...exports.values()].flatMap(entries => [...entries.values()].flat()));
    const fileByName = new Map<string, SourceFile>(files.map(file => [file.getFilePath(), file]));
    const resolveDynamicModules = (specifier: Node | undefined, source: SourceFile, allowTemplate: boolean) => {
      const resolve = (text: string) => fileByName.get(ts.resolveModuleName(text, source.getFilePath(),
        source.getProject().getCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName ?? '');
      if (Node.isStringLiteral(specifier) || Node.isNoSubstitutionTemplateLiteral(specifier)) {
        const target = declarationsOf(specifier).find(Node.isSourceFile) ?? resolve(specifier.getLiteralText());
        return { modules: target ? [target] : [], exact: true };
      }
      if (!allowTemplate || !specifier) return { modules: [], exact: false };
      if (!Node.isTemplateExpression(specifier)) {
        const choices = finiteTemplateValues(specifier);
        return { modules: [...new Set(choices.flatMap(value => value === undefined ? [] : resolve(value) ?? []))],
          exact: choices.length === 1 && choices[0] !== undefined };
      }
      const placeholder = '\u0000';
      let choices = [specifier.getHead().getLiteralText()];
      let exact = true;
      for (const span of specifier.getTemplateSpans()) {
        const values = finiteTemplateValues(span.getExpression());
        const suffix = span.getLiteral().getLiteralText();
        exact &&= values.length === 1 && values[0] !== undefined;
        const expanded = new Set<string>();
        for (const prefix of choices) {
          for (const value of values) {
            expanded.add(prefix + (value ?? placeholder) + suffix);
            if (expanded.size >= 4096) break;
          }
          if (expanded.size >= 4096) break;
        }
        choices = [...expanded];
      }
      const finite = choices.filter(choice => !choice.includes(placeholder)).flatMap(choice => resolve(choice) ?? []);
      const patterns = choices.filter(choice => choice.includes(placeholder) && choice.split(placeholder, 1)[0].includes('/'))
        .flatMap(choice => configuredPaths(source, root, choice)).map(absolute =>
          new RegExp('^' + absolute.split(placeholder).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
      const modules = patterns.length ? files.filter(file => {
        const absolute = file.getFilePath();
        const stem = absolute.replace(/\.[cm]?[jt]sx?$/, '');
        return patterns.some(regex => regex.test(absolute) || regex.test(stem) ||
          stem.endsWith('/index') && regex.test(stem.slice(0, -6)));
      }) : [];
      return { modules: [...new Set([...finite, ...modules])], exact };
    };
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
      const id = add(node, component.name, 'component', component.aliasOf ?? null);
      if (component.renderName) index.symbols[id - 1].renderName = component.renderName;
      byGraphId.set(component.id, id);
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
      const declaration = parent.getParentIfKind(SyntaxKind.VariableDeclaration) ??
        parent.getParentIfKind(SyntaxKind.ClassDeclaration) ?? parent;
      const id = byNode.get(declaration);
      if (id !== undefined) index.routeFiles![file][3] = id;
    }
    const hasValueBinding = (entry: ReturnType<SourceFile['getImportDeclarations']>[number]) => !entry.isTypeOnly() &&
      (!!entry.getDefaultImport() || !!entry.getNamespaceImport() || entry.getNamedImports().some(binding => !binding.isTypeOnly()));
    const trpcSources = new Set(files.filter(file => file.getImportDeclarations().some(entry =>
      /^@trpc\/server(?:\/|$)/.test(entry.getModuleSpecifierValue()) && hasValueBinding(entry))));
    const types = new WeakMap<Node, ReturnType<Node['getType']>>();
    const typeOf = (node: Node) => {
      let type = types.get(node);
      if (type === undefined) {
        type = node.getType();
        types.set(node, type);
      }
      return type;
    };
    const trpcFacts = new TrpcFacts(files, trpcSources, declarationsOf);
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
    const callbackGates = new WeakMap<PropGate, FlowGate>();
    const gatesOf = (gates: PropGate[], callback?: true): FlowGate[] => gates.flatMap(gate => {
      const cache = callback ? callbackGates : indexedGates;
      const previous = cache.get(gate);
      if (previous) return [previous];
      const { component, sites, partial, uncertainSites, unscoped } = gate;
      const scope = byNode.get(component);
      if (scope === undefined) return [];
      const entry = { scope, sites: sites.map(siteKey), partial: partial || undefined,
        uncertainSites: uncertainSites?.map(siteKey), unscoped, callback };
      cache.set(gate, entry);
      return [entry];
    });

    const projectFiles = new Set(files);
    const callableFlow = new CallableFlow(projectFiles, declarationsOf, node => flow.symbol(node));
    const localCallables = new Map<number, Node>();
    const workspaceEvent = (attribute: Node | undefined) => {
      if (!Node.isJsxAttribute(attribute)) return;
      const site = attribute.getParent()?.getParent();
      if (!workspace || !Node.isJsxOpeningElement(site) && !Node.isJsxSelfClosingElement(site)) return;
      const name = attribute.getNameNode().getText();
      if (!/^on[A-Z]/.test(name)) return;
      const imported = importBinding(site.getTagNameNode());
      if (imported && workspace.has(imported.module) ||
          flow.targetsOf(site).some(target => workspace.packageFor(target.getSourceFile().getFilePath()))) {
        return { site, name };
      }
    };
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
      const workspaceSite = workspaceEvent(attribute || undefined);
      const declaredName = Node.isArrowFunction(fn) ? undefined : fn.getName();
      const name = declaredName ??
        (returnedCallback && factoryName ? factoryName + ' (returned callback)' : factoryName) ?? event ??
        (workspaceSite && workspaceSite.name + ' ' + jsxLabel(workspaceSite.site)) ??
        (attribute && Node.isJsxAttribute(attribute) ? attribute.getNameNode().getText() : undefined);
      if (!name) return;
      const id = add(binding, name, 'function', null);
      localCallables.set(id, binding);
      const symbol = index.symbols[id - 1];
      if (returnedCallback || !factoryName && !declaredName) symbol.synthetic = true;
      if (symbol.synthetic && !event && workspaceSite && name !== workspaceSite.name) {
        symbol.selectorAliases = [workspaceSite.name];
      }
      byNode.set(fn, id);
      return id;
    };
    const eventSites: { site: JsxSite; attribute: import('ts-morph').JsxAttribute; target: number;
      detail: string; gates?: PropGate[]; lookup: boolean }[] = [];
    const pendingEvents: { site: JsxSite; attribute: import('ts-morph').JsxAttribute; fn: FunctionNode; name: string }[] = [];
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
    const reactFacts = historyOnly ? undefined : (require('./ReactFacts') as typeof import('./ReactFacts')).ReactFacts;
    const factCalls = new Map<SourceFile, CallExpression[]>();
    for (const file of files) {
      // Keep call sites from the existing walk, in source order. Facts still
      // resolve owners and fetch targets after the index has been assembled.
      const calls: CallExpression[] | undefined = reactFacts?.appliesTo(file, true) ? [] : undefined;
      if (calls) factCalls.set(file, calls);
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
          const delivery = flow.eventDelivery(site, name);
          if (!delivery) {
            if (isFunction(value) && workspaceEvent(node)) {
              pendingEvents.push({ site, attribute: node, fn: value, name });
            }
            return;
          }
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
              site, attribute: node, target, detail: `${name} <${label}>${via.length ? ' via ' + via.join(' > ') : ''}`, gates,
              lookup: delivery === 'possible'
            });
          }
          return;
        }
        if (!Node.isCallExpression(node)) return;
        calls?.push(node);
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
        const bindings = declarationsOf(binding);
        if (!bindings.some(decl => projectFiles.has(decl.getSourceFile()) &&
            (Node.isBindingElement(decl) || Node.isParameterDeclaration(decl) || constValue(decl) || isFunction(decl)))) return;
        if (expression === binding && bindings.some(decl => byNode.has(decl) && !Node.isBindingElement(decl))) return;
        const targets = callableTargets(expression);
        if (targets.length && expression !== binding && declarationsOf(expression)
          .some(decl => byNode.has(decl) && !Node.isBindingElement(decl))) return;
        const resolved = targets.flatMap(({ fn, via, gates, supplied }) => {
          if (supplied) suppliedCallbacks.add(supplied);
          const id = callableId(fn);
          return id === undefined ? [] : [{ id, via, gates }];
        });
        if (resolved.length) indirectCalls.set(node, resolved);
        else if (flow.read(expression)) dynamicCallSites.add(node);
      }, { filterRaw: node => !ts.isJsxAttribute(node) || ts.isIdentifier(node.name) &&
        (node.name.text === 'ref' || /^on[A-Z]/.test(node.name.text)) });
    }
    // Let existing invocation evidence establish selector aliases before
    // adding handlers that were previously absent from the index.
    const untracedEvents = pendingEvents.flatMap(({ site, attribute, fn, name }) => {
      const label = jsxLabel(site);
      const target = callableId(fn, name + ' ' + label);
      return target === undefined ? [] : [{ site, attribute, target, detail: `${name} <${label}>` }];
    });

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
    for (const [id, binding] of localCallables) {
      const owner = ownerAt(binding.compilerNode.parent)[1];
      if (owner !== undefined && owner !== id) (index.callableOwners ??= {})[id] = owner;
    }
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
      const applicable = [...gatesOf(flow.gates(node)), ...gatesOf(gates, true)];
      (index.flowCalls ??= []).push([from, to, relativePath(node.getSourceFile()), line, detail,
        applicable.length ? applicable : undefined]);
    };
    const eventReferences = suppliedCallbacks;
    const actionBySymbol = new Map([...actionSymbols].map(([id, symbol]) => [symbol, this.actions.get(id)]));
    const suppliedActionSites = new Set(this.actionUses.filter(({ node }) => suppliedCallbacks.has(node)).map(({ caller }) => caller));
    for (const event of eventSites) {
      const value = Node.isJsxAttribute(event.attribute) && jsxValue(event.attribute);
      if (value && !isFunction(value)) eventReferences.add(value);
      const owner = owners(event.site)[1] ?? fileIdOf(event.site);
      addFlowCall(owner, event.target, event.attribute, event.detail, event.gates);
      if (event.lookup) {
        const file = relativePath(event.attribute.getSourceFile());
        const line = startLine(event.attribute);
        (index.callIssues ??= {})[gateKey(owner, event.target, line)] = `${RENDER_LOOKUP_ISSUE} (${file}:${line})`;
      }
    }
    // An untraced callback still belongs to its JSX supplier for reverse impact.
    const tracedHandlers = new Set(eventSites.map(({ target }) => target));
    for (const targets of indirectCalls.values()) for (const { id } of targets) tracedHandlers.add(id);
    for (const { site, attribute, target, detail } of untracedEvents) {
      if (tracedHandlers.has(target)) continue;
      const owner = owners(site)[1] ?? fileIdOf(site);
      const line = startLine(attribute);
      addFlowCall(owner, target, attribute, detail);
      (index.callIssues ??= {})[gateKey(owner, target, line)] =
        `prop callback untraced (${relativePath(attribute.getSourceFile())}:${line})`;
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
      if (!route.router && route.type !== 'page' && route.type !== 'api') {
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
        router: route.router && { ...route.router, id: route.id,
          site: { file: relativePath(router!.routes[id - 1].site.getSourceFile()), line: startLine(router!.routes[id - 1].site) } },
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
            if (this.replacedInlineRenders.has(edge)) continue;
            const [from, to, line] = edge;
            const source = byGraphId.get(from);
            const target = byGraphId.get(to);
            if (source === undefined || target === undefined) continue;
            const combined = this.renderPairs.get(from + '\0' + to)?.filter(other => other[2] === line && !this.replacedInlineRenders.has(other))
              .map(other => conditions.get(other));
            if (combined?.includes(undefined)) continue;
            entries[renderSiteKey(source, target, line)] = combined?.includes('possible') ? 'possible' :
              combined?.includes('conditional') ? 'conditional' : decision;
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
    const addLookupIssue = (owner: string, tag: Node, opaque = false) => {
      const id = byGraphId.get(owner);
      if (id !== undefined) {
        const file = relativePath(tag.getSourceFile());
        const reason = `${RENDER_LOOKUP_ISSUE} (${file}:${startLine(tag)})`;
        const issues = opaque ? index.opaqueRenderLookupIssues ??= {} : index.renderLookupIssues ??= {};
        issues[id] ??= reason;
        return { file, reason };
      }
    };

    const traceLookupInputs = (roots: Iterable<Node>, issue: NonNullable<ReturnType<typeof addLookupIssue>>) => {
      type Members = (string | null)[];
      const seen = new Map<Node, Set<string>>();
      let budget = 160;
      const visit = (input: Node | undefined, members: Members = [], supplier?: SourceFile) => {
        if (!input || --budget < 0 || !projectFiles.has(input.getSourceFile())) return;
        const key = JSON.stringify(members);
        const prior = seen.get(input) ?? new Set<string>();
        if (prior.has(key)) return;
        prior.add(key);
        seen.set(input, prior);
        const id = byNode.get(input);
        if (!members.length && id !== undefined && index.symbols[id - 1].kind === 'component') {
          const uses = (index.scopedRenderValueIssues ??= {});
          const valueFile = relativePath(supplier ?? input.getSourceFile());
          if (!uses[id] || isTestFile(uses[id].file) || isTestFile(uses[id].valueFile)) uses[id] = { ...issue, valueFile };
          return;
        }
        const follow = (node: Node | undefined, path = members) => visit(node, path, supplier);
        const prop = flow.read(input);
        if (prop) {
          flow.values(prop).forEach(binding => visit(binding.value, members, binding.site.getSourceFile()));
          return;
        }
        if (Node.isPropertyAccessExpression(input)) {
          follow(input.getExpression(), [input.getName(), ...members]);
        } else if (Node.isElementAccessExpression(input)) {
          const selector = input.getArgumentExpression();
          for (const choice of selector ? finiteTemplateValues(selector) : [undefined]) {
            follow(input.getExpression(), [choice ?? null, ...members]);
          }
        } else if (Node.isIdentifier(input)) {
          const parent = input.getParent();
          const declarations = Node.isShorthandPropertyAssignment(parent)
            ? parent.getValueSymbol()?.getDeclarations() : declarationsOf(input);
          declarations?.forEach(declaration => follow(declaration));
        } else if (Node.isBindingElement(input)) {
          if (input.getDotDotDotToken()) return;
          const pattern = input.getParent();
          const property = input.getPropertyNameNode() ?? input.getNameNode();
          const name = Node.isArrayBindingPattern(pattern) ? String(pattern.getElements().indexOf(input)) :
            Node.isIdentifier(property) ? property.getText() : Node.isStringLiteral(property) ? property.getLiteralText() : undefined;
          const owner = pattern.getParent();
          if (name !== undefined) follow(Node.isParameterDeclaration(owner) ? owner : constValue(owner), [name, ...members]);
        } else if (Node.isParameterDeclaration(input)) {
          const callback = input.getParent();
          const call = throughWrappers(callback).getParent();
          if (Node.isCallExpression(call) && call.getArguments()[0] === throughWrappers(callback)) {
            const callee = call.getExpression();
            if (Node.isPropertyAccessExpression(callee) && ['map', 'flatMap', 'find', 'filter'].includes(callee.getName())) {
              follow(callee.getExpression(), [null, ...members]);
            }
          }
        } else if (Node.isCallExpression(input)) {
          // An opaque factory can use its arguments to produce the selected member.
          input.getArguments().forEach(argument => follow(argument, []));
        } else if (Node.isVariableDeclaration(input)) {
          follow(constValue(input));
        } else if (Node.isExportAssignment(input)) {
          follow(input.getExpression());
        } else if (Node.isArrayLiteralExpression(input)) {
          const [member, ...rest] = members;
          const elements = input.getElements();
          if (member == null || elements.some(Node.isSpreadElement)) {
            for (const element of elements) {
              if (Node.isSpreadElement(element)) follow(element.getExpression(), members);
              else follow(element, rest);
            }
          } else if (/^(?:0|[1-9]\d*)$/.test(member)) follow(elements[Number(member)], rest);
        } else if (Node.isObjectLiteralExpression(input)) {
          const [member, ...rest] = members;
          for (const property of [...input.getProperties()].reverse()) {
            if (Node.isSpreadAssignment(property)) {
              follow(property.getExpression(), members);
            } else if (member == null || property.getName() === member) {
              follow(property, rest);
              if (member != null) break;
            }
          }
        } else if (Node.isPropertyAssignment(input)) {
          follow(input.getInitializer());
        } else if (Node.isShorthandPropertyAssignment(input)) {
          follow(input.getNameNode());
        } else if (Node.isConditionalExpression(input)) {
          const predicate = valueNode(input.getCondition());
          if (!Node.isFalseLiteral(predicate)) follow(input.getWhenTrue());
          if (!Node.isTrueLiteral(predicate)) follow(input.getWhenFalse());
        } else follow(wrappedExpression(input));
      };
      for (const root of roots) visit(root);
    };
    for (const [owner, { tag, bindings }] of this.renderLookupIssues) {
      const issue = addLookupIssue(owner, tag);
      if (issue) traceLookupInputs(bindings, issue);
    }
    for (const { owner, tag, sources } of this.opaqueRenderLookups) {
      const issue = addLookupIssue(owner, tag, true);
      if (issue) traceLookupInputs(sources, issue);
    }
    const resolvedRenderSites = new Map<Node, Set<number>>();
    const renderExclusions = new Map<string, string[]>();
    const guardedRenders = new Map<QueryIndex['renderEdges'][number], { tag: Node; selection?: RenderSelection }>();
    const guardInputs = new Map<number, Map<RenderSite, number>>();
    const recordRenderInput = (from: number, to: number, site: RenderSite) => {
      const inputs = guardInputs.get(to) ?? new Map<RenderSite, number>();
      inputs.set(site, from);
      guardInputs.set(to, inputs);
    };
    const contextExcluded = new Set<string>();
    const contextAllowed = new Set<string>();
    const definitions = new Map([...components].map(([node, component]) => [component.id, node]));
    for (const edge of this.edges) {
      if (this.replacedInlineRenders.has(edge)) continue;
      const [from, to, line, conditional, layout, possible, detail, site, file] = edge;
      const source = byGraphId.get(from);
      const target = byGraphId.get(to);
      if (source === undefined || target === undefined) continue;
      const definition = definitions.get(from);
      const tag = Node.isCallExpression(site) ? site.getArguments()[0] : site?.getTagNameNode();
      const key = renderSiteKey(source, target, line);
      if (this.contextExcluded.size) (this.contextExcluded.has(edge) ? contextExcluded : contextAllowed).add(key);
      const previous = renderExclusions.get(key);
      const excluded = conditional && definition && tag && !layout ?
        flow.excludedRenderSuppliers(tag, definition).flatMap(supplier => siteKey(supplier) ?? []) : [];
      if (previous) renderExclusions.set(key, previous.filter(site => excluded.includes(site)));
      else renderExclusions.set(key, excluded);
      index.renderEdges.push(file ? [source, target, line, conditional, layout, possible, detail, site && siteKey(site), file] :
        site || detail ? [source, target, line, conditional, layout, possible, detail, site && siteKey(site)] :
        possible ? [source, target, line, conditional, layout, possible] : layout ?
          [source, target, line, conditional, layout] : [source, target, line, conditional]);
      if (site && tag && !layout && !historyOnly) {
        recordRenderInput(source, target, site);
        const selection = this.renderSelections.get(edge);
        if (conditional || selection) guardedRenders.set(index.renderEdges[index.renderEdges.length - 1], { tag, selection });
      }
      if (site && !possible && !historyOnly) {
        const targets = resolvedRenderSites.get(site) ?? new Set<number>();
        targets.add(target);
        resolvedRenderSites.set(site, targets);
      }
    }
    if (contextExcluded.size) index.contextRenderExclusions = [...contextExcluded].filter(key => !contextAllowed.has(key));
    const excludedSites = new Set<string>();
    for (const [key, sites] of renderExclusions) if (sites.length) {
      (index.renderExclusions ??= {})[key] = sites;
      for (const site of sites) excludedSites.add(site);
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

    type LazyTarget = { id: number; origin: 'imported' | 'loaded' };
    const dynamicBindings = new Map<Node, LazyTarget & { rendered: boolean }>();
    const lazyProperties = new Map<Node, LazyTarget>();
    const possibleLazyBindings = new Map<Node, Map<number, LazyTarget>>();
    const unresolvedLazyComponents = new Set<number>();
    const unresolvedDefaultComponents = new Set<number>();
    const opaqueBindings = new Set<Node>();
    const componentValues = new Set<number>();
    const componentProperties = new Map<Node, Set<number>>();
    const componentFactories = new Set<Node>();
    const wrapperEdges: QueryIndex['renderEdges'] = [];
    const lazyRender = (edge: QueryIndex['renderEdges'][number], site: RenderSite) => {
      edge[7] = siteKey(site);
      wrapperEdges.push(edge);
      recordRenderInput(edge[0], edge[1], site);
      const tag = Node.isCallExpression(site) ? site.getArguments()[0] : site.getTagNameNode();
      if (tag && edge[3]) guardedRenders.set(edge, { tag });
    };
    const markPossibleLazy = (choices: LazyTarget[], binding?: Node) => {
      if (binding && choices.length) {
        const targets = possibleLazyBindings.get(binding) ?? new Map<number, LazyTarget>();
        for (const choice of choices) targets.set(choice.id, choice);
        possibleLazyBindings.set(binding, targets);
      }
      for (const { id } of choices) unresolvedLazyComponents.add(id);
    };
    if (!historyOnly) for (const [binding, component] of components) {
      let value = unwrapValue(Node.isVariableDeclaration(binding) ? binding.getInitializer() :
        Node.isExportAssignment(binding) ? binding.getExpression() : undefined);
      if (!value) continue;
      const line = startLine(value);
      const wrapper = Node.isCallExpression(value);
      if (wrapper) {
        componentFactories.add(value);
        if (!isComponentWrapper(value)) continue;
        do {
          componentFactories.add(value);
          value = unwrapValue(value.getArguments()[0]);
        } while (isComponentWrapper(value));
        if (!Node.isIdentifier(value) && !Node.isPropertyAccessExpression(value)) continue;
      } else if (!Node.isIdentifier(value) || constValue(binding) === undefined) {
        continue;
      }
      for (const target of declarationsOf(value)) {
        const inner = components.get(target);
        if (inner && inner !== component && (wrapper || stableComponentBinding(target))) {
          wrapperEdges.push([byGraphId.get(component.id)!, byGraphId.get(inner.id)!, line, 0]);
        }
      }
    }
    if (!historyOnly) for (const [binding] of aliases) {
      if (!Node.isExportAssignment(binding)) continue;
      let value = unwrapValue(binding.getExpression());
      while (isComponentWrapper(value)) {
        componentFactories.add(value);
        value = unwrapValue(value.getArguments()[0]);
      }
    }
    const ignoredCollections = new Map<Node, boolean>();
    const propertyInIgnoredCollection = (property: Node) => {
      // Calls can retain a component argument even if their result is discarded.
      const initializer = Node.isPropertyAssignment(property) ? unwrapValue(property.getInitializer()) : undefined;
      if (Node.isCallExpression(initializer) || Node.isNewExpression(initializer)) return false;
      let value = property;
      let parent = value.getParent();
      while (parent && (Node.isArrayLiteralExpression(parent) || Node.isObjectLiteralExpression(parent) ||
          Node.isPropertyAssignment(parent) && parent.getInitializer() === value || wrappedExpression(parent) === value)) {
        value = parent;
        parent = value.getParent();
      }
      if (!Node.isVariableDeclaration(parent) || constValue(parent) !== value || parent.isExported()) return false;
      const cached = ignoredCollections.get(parent);
      if (cached !== undefined) return cached;
      const name = parent.getNameNode();
      const uses = Node.isIdentifier(name) ? name.findReferencesAsNodes() : [];
      const ignored = uses.length > 0 && uses.every(use => {
        let supplied: Node = use;
        let expression = supplied.getParent();
        while (expression && wrappedExpression(expression) === supplied) {
          supplied = expression;
          expression = supplied.getParent();
        }
        if (!Node.isJsxExpression(expression) || expression.getExpression() !== supplied ||
            !Node.isJsxAttribute(expression.getParent())) return false;
        return use.getAncestors().some(ancestor => Node.isJsxAttribute(ancestor) && !flow.mayRenderSlot(ancestor));
      });
      ignoredCollections.set(parent, ignored);
      return ignored;
    };
    const recordComponentDeclaration = (node: Node, property?: Node) => {
      if (Node.isVariableDeclaration(node)) opaqueBindings.add(node);
      const id = byNode.get(node);
      if (id === undefined || index.symbols[id - 1].kind !== 'component') return;
      if (property && propertyInIgnoredCollection(property)) return;
      componentValues.add(id);
      if (property) {
        const values = componentProperties.get(property) ?? new Set<number>();
        values.add(id);
        componentProperties.set(property, values);
      }
    };
    const recordComponentValue = (value: Node | undefined, property?: Node) => {
      if (!value) return;
      const wrapped = wrappedExpression(value);
      if (wrapped) recordComponentValue(wrapped, property);
      else if (Node.isConditionalExpression(value)) {
        recordComponentValue(value.getWhenTrue(), property);
        recordComponentValue(value.getWhenFalse(), property);
      } else if (Node.isArrayLiteralExpression(value)) {
        for (const element of value.getElements()) recordComponentValue(element, property);
      } else if (Node.isIdentifier(value) || Node.isPropertyAccessExpression(value)) {
        for (const declaration of declarationsOf(value)) recordComponentDeclaration(declaration, property);
      }
    };
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
    const routeComponents = new Set([
      ...index.routes.flatMap(route => [route.component, ...route.layouts ?? [], ...Object.values(route.handlers ?? {})]),
      ...Object.values(index.routeFiles!).map(([, , , component]) => component)
    ]);
    const canSelectLazyMember = (selector: Node, member: string, supplied: RenderSite | undefined) => {
      let budget = 32;
      const matchesProp = (prop: NonNullable<ReturnType<PropFlow['read']>>, at?: RenderSite): boolean => {
        if (--budget < 0) return false;
        const values = at ? [flow.value(at, prop)] : flow.values(prop);
        if (!values.length) {
          const id = byNode.get(prop.component);
          return id !== undefined && routeComponents.has(id);
        }
        return values.every(({ site, value }) => {
          if (value) return matches(value);
          if (Node.isCallExpression(site)) return false;
          return site.getAttributes().some(attribute => {
            const source = Node.isJsxSpreadAttribute(attribute) && flow.read(attribute.getExpression(), prop.name);
            return !!source && matchesProp(source);
          });
        });
      };
      const matches = (input: Node | undefined, at?: RenderSite): boolean => {
        if (!input || --budget < 0) return false;
        const prop = flow.read(input);
        if (prop) return matchesProp(prop, at);
        const value = valueNode(input);
        if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) return value.getLiteralText() === member;
        if (Node.isConditionalExpression(value)) {
          const condition = valueNode(value.getCondition());
          return !Node.isFalseLiteral(condition) && matches(value.getWhenTrue(), at) ||
            !Node.isTrueLiteral(condition) && matches(value.getWhenFalse(), at);
        }
        if (!Node.isCallExpression(value)) return false;
        if (readsUrlParameter(value)) return true;
        const fn = functionNode(value.getExpression());
        return !!fn && projectFiles.has(fn.getSourceFile()) &&
          executionSites(fn.getBody()).returned.some(({ node }) => matches(node, at));
      };
      return matches(selector, supplied);
    };
    const indexedComponent = (node: Node | undefined) => {
      const id = node && byNode.get(node);
      return !!id && index.symbols[id - 1].kind === 'component';
    };
    const orderedFiles = [...filesByRelative.keys()].sort();
    for (const relative of orderedFiles) {
      const file = filesByRelative.get(relative)!;
      const fileId = byGraphId.get(`file:${relative}`)!;
      const content = historyOnly ? '' : file.getFullText();
      const escapedIdentifiers = file.compilerNode.text.includes('\\u');
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
          for (const absolute of configuredPaths(file, root, specifier)) {
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
        let line: number | undefined;
        let found = false;
        for (const declaration of declarations) {
          const id = byNode.get(declaration);
          if (!id) continue;
          line ??= startLine(node);
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
            const returnedUse = !typeUse && !callbackUse && !executable && !jsx &&
              (symbol.kind === 'function' || symbol.kind === 'hook') && returnedValueUse(node);
            if (sameFile && !callbackUse && !executable && !jsx && !signature && referenceOwner !== id &&
              (referenceOwner !== undefined || symbol.kind !== 'constant' || symbol.typeOnly)) {
              recordGraph(id, line, typeUse ? GraphReferenceKind.TypeUse :
                returnedUse ? GraphReferenceKind.ReturnedUse : GraphReferenceKind.Use, referenceOwner);
            }
            moduleUse = !typeUse && !jsx && !signature && referenceOwner === undefined;
            referenceCaller = sameFile ? undefined : referenceOwner;
            if (sameFile) referenceOwner = undefined;
            else if (callbackUse) referenceKind = 'callback-argument';
            else if (jsx) referenceKind = 'jsx-use';
            else if (returnedUse) referenceKind = 'returned-use';
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
      const recordWorkspaceDependency = (node: Node, owner: number, module: string | undefined) => {
        if (!module) return;
        const gates = gatesOf(flow.gates(node));
        const dependencies = ((index.workspaceDependencies ??= {})[owner] ??= []);
        if (!gates.length && dependencies.some(entry => entry.module === module && !entry.gates)) return;
        dependencies.push(gates.length ? { module, gates } : { module });
      };
      const recordCall = (node: Node, expression: Node, owner: number, found: boolean) => {
        const binding = receiver(expression);
        if (!binding) return;
        const { root, members } = binding;
        const imported = packageBindings.get(root.getText());
        const declaration = imported || !found ? flow.symbol(root)?.getDeclarations()[0] : undefined;
        if (imported && declaration === imported.binding) {
          if (workspace?.isUnresolved(file, imported.module)) recordWorkspaceDependency(node, owner, imported.module);
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
        recordWorkspaceDependency(node, owner, workspace?.unresolvedBinding(expression));
        const targets = members.length ? declarationsOf(root).flatMap(target => byNode.get(target) ?? []) : [];
        for (const id of targets) recordGraph(id, startLine(node), GraphReferenceKind.MemberCall, owner, graphName('.' + members.join('.')));
        if (!targets.length && declaration?.getSourceFile() === file &&
            (Node.isParameterDeclaration(declaration) || Node.isVariableDeclaration(declaration) || Node.isBindingElement(declaration))) {
          index.unresolvedCalls![owner] = (index.unresolvedCalls![owner] ?? 0) + 1;
          routerCallSites?.set(node, owner);
          if (pages && pages.lifecycleNames.size && index.symbols[owner - 1]?.name.match(/^(?:getServerSideProps|getStaticProps|getStaticPaths|getInitialProps)$/)) {
            const sites = ((index.pagesObservedCalls ??= {})[owner] ??= []);
            sites.push([relative, startLine(node), expression.getText()]);
            const reasons = (index.pagesOwnerIssues![owner] ??= []);
            if (!reasons.includes('lifecycle calls on locals/params unresolved')) reasons.push('lifecycle calls on locals/params unresolved');
          }
        }
      };
      const selectedImports = new Map<Node, Set<string>>();
      const recordDynamic = (node: Node, specifier: Node | undefined, owner?: number) => {
        const selections = selectedImports.get(node);
        const target = dynamicExport(node);
        const { modules } = resolveDynamicModules(specifier, file, !!selections);
        if (selections) {
          const loader = node.getFirstAncestor(Node.isFunctionLikeDeclaration);
          const call = loader && throughWrappers(loader).getParent();
          if (Node.isCallExpression(call) && owner === byNode.get(lazyVariable(call)!)) owner = undefined;
        }
        for (const resolved of modules) {
          const exported = exports.get(resolved);
          const moduleId = byGraphId.get(`file:${relativePath(resolved)}`);
          const names = selections ?? (target ? [target.name] : []);
          for (const name of names) {
            const targets = exported?.get(name);
            if (!targets?.length) continue;
            if (moduleId !== undefined) (index.moduleImports![fileId] ??= []).push([moduleId, startLine(node), 'import', [[name]]]);
            for (const target of targets) {
              const id = byNode.get(target);
              if (id !== undefined) recordGraph(id, startLine(node), GraphReferenceKind.DynamicImport, owner);
            }
          }
        }
      };
      const componentIds = (targets: Node[]) => [...new Set(targets.flatMap(target => {
        const id = byNode.get(target);
        return id !== undefined && index.symbols[id - 1].kind === 'component' ? [id] : [];
      }))];
      const hasLazyImport = imports.some(entry => {
        const module = entry.getModuleSpecifierValue();
        return module === 'next/dynamic' || module === 'react' &&
          (!!entry.getDefaultImport() || !!entry.getNamespaceImport() || entry.getNamedImports().some(binding => binding.getName() === 'lazy'));
      });
      const recordLazyLoader = (node: import('ts-morph').CallExpression) => {
        if (!lazyFactory(node)) return;
        const loader = functionNode(node.getArguments()[0]);
        if (!loader || !projectFiles.has(loader.getSourceFile())) return;
        const binding = lazyVariable(node);
        const targets = loaderTargets(loader, projectFiles);
        const choices = new Map<number, LazyTarget>();
        let exact = targets.length > 0;
        for (const target of targets) {
          exact &&= !target.possible;
          if ('value' in target) {
            const declarations = declarationsOf(target.value);
            const ids = componentIds(declarations);
            for (const id of ids) choices.set(id, { id, origin: 'loaded' });
            const stable = declarations.length === 1 && stableComponentBinding(declarations[0]);
            if (ids.length && stable) componentFactories.add(target.promise);
            exact &&= stable;
            continue;
          }
          const { imported, name, selector, partialOnly } = target;
          const { modules, exact: exactModule } = resolveDynamicModules(imported.getArguments()[0], imported.getSourceFile(), true);
          exact &&= exactModule;
          if (partialOnly) {
            if (!historyOnly) for (const resolved of modules) {
              const declarations = exports.get(resolved);
              const all = [...declarations?.values() ?? []].flat();
              const candidates = name === undefined ? all : declarations?.get(name) ?? [];
              const local = componentIds(candidates.filter(candidate => candidate.getSourceFile() === resolved));
              // An unbound receiver preserves a diagnostic for a sole named
              // candidate. Namespace reads can identify a member directly.
              if (partialOnly === 'opaque' && componentIds(all.filter(candidate => candidate.getSourceFile() === resolved)).length !== 1) continue;
              if (name !== undefined || local.length === 1) {
                markPossibleLazy(local.map(id => ({ id, origin: 'imported' })));
              }
            }
            continue;
          }
          if (name === undefined) continue;
          const names = selectedImports.get(imported) ?? new Set<string>();
          names.add(name);
          selectedImports.set(imported, names);
          for (const resolved of modules) {
            for (const id of componentIds(exports.get(resolved)?.get(name) ?? [])) choices.set(id, { id, origin: 'imported' });
          }
          if (selector) {
            dynamicSelectors.add(selector.getNameNode());
            dynamicSelectors.add(throughWrappers(selector));
          }
        }
        if (historyOnly) return;
        const [choice] = choices.values();
        if (exact && choices.size === 1 && binding) {
          dynamicBindings.set(binding, { ...choice, rendered: false });
        } else {
          if (exact && choices.size === 1 && Node.isPropertyAssignment(throughWrappers(node).getParent())) {
            lazyProperties.set(node, choice);
          }
          markPossibleLazy([...choices.values()], binding);
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
      let lastLeadingPosition: number | undefined;
      let lastTrailingPosition: number | undefined;
      const scanNodeComments = (node: ts.Node) => {
        const start = node.getFullStart();
        // Parent and child nodes often share a boundary and therefore the same trivia.
        if (start !== lastLeadingPosition) {
          lastLeadingPosition = start;
          for (const comment of ts.getLeadingCommentRanges(content, start) ?? []) scanComment(comment);
        }
        if (node.end !== lastTrailingPosition) {
          lastTrailingPosition = node.end;
          for (const comment of ts.getTrailingCommentRanges(content, node.end) ?? []) scanComment(comment);
        }
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
          const symbol = typeOf(initializer).getProperty(property.getText());
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
          if (!historyOnly && !Node.isTaggedTemplateExpression(node)) {
            const parent = node.getParent();
            const property = Node.isPropertyAssignment(parent) && parent.getInitializer() === node ? parent : undefined;
            const args = node.getArguments();
            // The first argument supplies the component definition when this call creates its binding.
            for (const argument of componentFactories.has(node) ? args.slice(1) : args) recordComponentValue(argument, property);
            const assignment = throughWrappers(node).getParent();
            const first = unwrapValue(args[0]);
            if (Node.isExportAssignment(assignment) && !assignment.isExportEquals() &&
                !components.has(assignment) && !aliases.has(assignment) &&
                (Node.isIdentifier(first) || Node.isPropertyAccessExpression(first))) {
              for (const target of declarationsOf(first)) {
                const id = byNode.get(target);
                if (id !== undefined && index.symbols[id - 1].kind === 'component') unresolvedDefaultComponents.add(id);
              }
            }
          }
          const [owner, graphOwner, possible] = owners(node);
          if (hasLazyImport && Node.isCallExpression(node)) recordLazyLoader(node);
          if (Node.isCallExpression(node) && expression.getKind() === SyntaxKind.ImportKeyword) {
            const specifier = node.getArguments()[0];
            recordDynamic(node, specifier, graphOwner);
            if (Node.isStringLiteral(specifier) && workspace?.isUnresolved(file, specifier.getLiteralValue())) {
              recordWorkspaceDependency(node, graphOwner ?? fileId, specifier.getLiteralValue());
            }
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
          const found = Node.isCallExpression(node) && !!record(node, declarationsOf(expression),
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
          const owner = owners(node)[1];
          renderSites.push({ node, owner, line: startLine(node), file: relative });
          const module = workspace?.unresolvedBinding(node.getTagNameNode());
          recordWorkspaceDependency(node, owner ?? fileId, module);
        } else if (Node.isPropertyAssignment(node)) {
          const value = node.getInitializer();
          if (!historyOnly && value && !dynamicSelectors.has(value)) recordComponentValue(value, node);
        } else if (Node.isShorthandPropertyAssignment(node)) {
          const symbol = node.getValueSymbol();
          if (symbol) {
            const declarations = (symbol.getAliasedSymbol() ?? symbol).getDeclarations();
            if (!historyOnly) for (const declaration of declarations) recordComponentDeclaration(declaration, node);
            record(node, declarations, 'use');
          }
        } else if (Node.isElementAccessExpression(node)) {
          const key = node.getArgumentExpression();
          if (Node.isStringLiteral(key)) {
            const symbol = typeOf(node.getExpression()).getProperty(key.getLiteralText());
            if (symbol) record(key, (symbol.getAliasedSymbol() ?? symbol).getDeclarations(), 'use');
          }
        } else if (Node.isIdentifier(node) && (names.has(node.getText()) || localNames.has(node.getText()))) {
          const parent = node.getParent();
          if (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isExportSpecifier(parent) ||
              dynamicSelectors.has(node)) return;
          record(node, declarationsOf(node).filter(declaration =>
            declaration.compilerNode !== parent?.compilerNode || !byNode.has(declaration)), 'use');
        }
      }, {
        visitRaw: historyOnly || !/\/[/\*]/.test(content) ? undefined : scanNodeComments,
        filterRaw: node => {
          if (!ts.isIdentifier(node)) return true;
          // Use the source spelling, including Unicode escapes, just as the reference visitor does.
          const name = escapedIdentifiers ? node.getText(file.compilerNode) : node.text;
          return names.has(name) || localNames.has(name) || namespaces.has(name);
        }
      });
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
    // Collection lookups can pick a lazy loader through an object supplied as a prop.
    const renderByNode = lazyProperties.size ? new Map(renderSites.map(site => [site.node, site])) : undefined;
    if (dynamicBindings.size || possibleLazyBindings.size || lazyProperties.size) for (const site of renderSites) {
      if (!Node.isJsxOpeningElement(site.node) && !Node.isJsxSelfClosingElement(site.node)) continue;
      const tag = site.node.getTagNameNode();
      const declarations = declarationsOf(tag);
      const binding = declarations.map(node => dynamicBindings.get(node)).find(Boolean);
      const possible = new Map(declarations.flatMap(node => [...possibleLazyBindings.get(node) ?? []]));
      if (renderByNode && (Node.isPropertyAccessExpression(tag) || declarations.some(node => {
        const initializer = Node.isVariableDeclaration(node) && unwrapValue(node.getInitializer());
        return !!initializer && (Node.isElementAccessExpression(initializer) || Node.isPropertyAccessExpression(initializer));
      }))) {
        const traced = renderBindings(Node.isIdentifier(tag) ? declarations : [tag], projectFiles, indexedComponent, flow,
          node => lazyProperties.has(node));
        for (const choice of traced.targets) {
          const loader = lazyProperties.get(choice.target);
          const caller = choice.supply ? renderByNode.get(choice.supply.site) : site;
          const owner = caller?.owner;
          if (!loader || !caller || owner === undefined || owner === loader.id || index.symbols[owner - 1].kind !== 'component') continue;
          // The registry's members bound its outputs. An opaque selector can
          // further restrict its inputs, so require evidence for this member.
          if (choice.lookup && (choice.lookup.member === undefined ||
              !canSelectLazyMember(choice.lookup.selector, choice.lookup.member, choice.supply?.site))) continue;
          const conditional = Number(choice.conditional || !!conditionalAt(site.node));
          const detail = `${loader.origin} via ${tag.getText()}` + (choice.supply ? ` (prop ${choice.supply.name})` : '');
          lazyRender([owner, loader.id, caller.line, conditional, undefined, choice.possible ? true : undefined, detail], caller.node as RenderSite);
        }
      }
      if (!binding && !possible.size) continue;
      const owner = site.owner;
      const body = owner === undefined ? undefined : site.node.getAncestors().find(node => byNode.get(node) === owner);
      const conditional = conditionalAt(site.node, body);
      if (owner !== undefined && index.symbols[owner - 1].kind === 'component') {
        for (const { id, origin } of possible.values()) {
          if (owner !== id) lazyRender([owner, id, site.line, conditional, undefined, true, `${origin} via ${tag.getText()}`], site.node);
        }
      }
      if (!binding) continue;
      const { id, origin } = binding;
      if (owner !== undefined && index.symbols[owner - 1].kind === 'component' && owner !== id) {
        lazyRender([owner, id, site.line, conditional, undefined, undefined, `${origin} via ${tag.getText()}`], site.node);
        binding.rendered = true;
      } else {
        unresolvedLazyComponents.add(id);
        const refs = index.graphReferences![byGraphId.get(`file:${site.file}`)!] ??= [];
        refs.push([id, site.line, GraphReferenceKind.Render, owner, conditional]);
      }
    }
    for (const [binding, { id, rendered }] of dynamicBindings) {
      if (!rendered || opaqueBindings.has(binding)) unresolvedLazyComponents.add(id);
    }
    if (componentValues.size) {
      // Value references without a resolved render site can hide JSX behind a registry or callback.
      for (const [, target, , , , possible] of index.renderEdges) if (!possible) componentValues.delete(target);
      for (const route of index.routes) {
        if (route.component !== undefined) componentValues.delete(route.component);
        for (const layout of route.layouts ?? []) componentValues.delete(layout);
      }
      // A component can have both an indexed JSX path and an unresolved property-based render.
      if (componentProperties.size) for (const { node } of renderSites) {
        if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) continue;
        const tag = node.getTagNameNode();
        const reads = Node.isIdentifier(tag) ? declarationsOf(tag).flatMap(declaration => {
          let value = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
          while (value) {
            const wrapped = wrappedExpression(value);
            if (!wrapped) break;
            value = wrapped;
          }
          return Node.isPropertyAccessExpression(value) ? [value] : [];
        }) : [tag];
        for (const read of reads) for (const property of declarationsOf(read)) {
          for (const id of componentProperties.get(property) ?? []) {
            if (!resolvedRenderSites.get(node)?.has(id)) componentValues.add(id);
          }
        }
      }
    }
    for (const id of unresolvedLazyComponents) componentValues.add(id);
    for (const id of unresolvedDefaultComponents) componentValues.add(id);
    if (componentValues.size) index.dynamicRenderComponents = [...componentValues].sort((a, b) => a - b);
    // A wrapper definition does not resolve a separate opaque use of its inner component.
    index.renderEdges.push(...wrapperEdges);
    const unbound = [...unboundProcedures].filter(id => !boundProcedures.has(id));
    if (unbound.length) index.trpcUnbound = unbound;
    const componentById = new Map([...components.keys()].map(node => [byNode.get(node), node]));
    for (const [edge, { tag, selection }] of guardedRenders) {
      const [from, to, line, , , , , site] = edge;
      const component = componentById.get(from);
      const body = component && flow.bodyOf(component);
      if (!component || !body || !tag.getAncestors().includes(body)) continue;
      const guards = [...flow.branchConditions(tag, body)];
      if (!guards.length && !selection) continue;
      const paths: string[][] = [];
      const conditionalPaths: string[][] = [];
      const witnesses: string[][] = [];
      const evaluated = new Map<Node, RenderSite>();
      let budget = 2048;
      const inspect = (owner: Node | undefined, sites: string[]) => {
        if (--budget < 0) return;
        const state = evaluateRenderGuards(flow, guards, selection, evaluated);
        if (state.blocked) {
          (state.strict || !sites.length ? paths : conditionalPaths).push(sites);
          return;
        }
        if (sites.length && state.supported) witnesses.push(sites);
        if (!owner || sites.length >= 6 || !state.needed.has(owner) || evaluated.has(owner)) return;
        for (const [supplier, parent] of guardInputs.get(byNode.get(owner)!) ?? []) {
          if (budget <= 0) break;
          evaluated.set(owner, supplier);
          const outer = componentById.get(parent);
          inspect(outer, [...sites, siteKey(supplier)]);
          evaluated.delete(owner);
        }
      };
      inspect(component, []);
      const key = renderGuardKey(from, to, line, site);
      if (paths.length) (index.renderGuardPaths ??= {})[key] = paths;
      if (conditionalPaths.length) (index.renderConditionalPaths ??= {})[key] = conditionalPaths;
      if (witnesses.length) (index.renderWitnessPaths ??= {})[key] = witnesses;
      if (paths.length || conditionalPaths.length || witnesses.length) {
        if (site) excludedSites.add(site);
        for (const path of [...paths, ...conditionalPaths, ...witnesses]) for (const supplier of path) excludedSites.add(supplier);
      }
    }
    const scopes = new Set([
      ...Object.values(index.callGates ?? {}).flat(),
      ...Object.values(index.workspaceDependencies ?? {}).flatMap(dependencies => dependencies.flatMap(entry => entry.gates ?? [])),
      ...Object.values(index.flowIssues ?? {}).flatMap(issues => issues.flatMap(issue => issue.gates)),
      ...(index.flowCalls ?? []).flatMap(call => call[5] ?? []),
      ...index.fetches.flatMap(fetch => fetch.gates ?? []),
      ...(index.uncertainPropRequests ?? []).flatMap(request => request.gates ?? [])
    ].map(gate => gate.scope));
    for (const edge of index.renderEdges) {
      if (!scopes.has(edge[1]) && !suppliers.has(edge[1]) && edge[7] && !excludedSites.has(edge[7])) {
        if (edge[8]) edge[7] = undefined;
        else edge.length = edge[6] ? 7 : edge[5] ? 6 : edge[4] ? 5 : 4;
      }
    }
    if (router) (require('../frameworks/react-router/ModuleFacts') as typeof import('../frameworks/react-router/ModuleFacts'))
      .indexRouterFacts({ index, project: router, files, relative: relativePath, exports,
        symbol: node => byNode.get(node), owner: node => owners(node)[1], fileSymbol: file => byGraphId.get(`file:${file}`),
        handledCall: node => {
          const id = routerCallSites?.get(node);
          if (id === undefined || !routerCallSites?.delete(node)) return;
          // Router references carry their own coverage, including ambiguous or dynamic sites.
          if (--index.unresolvedCalls![id] === 0) delete index.unresolvedCalls![id];
        } });
    if (workspace) {
      const packages = files.flatMap(file => {
        const pkg = workspace.packageFor(file.getFilePath());
        return pkg ? [[relativePath(file), pkg.name] as const] : [];
      });
      if (packages.length) index.workspacePackages = Object.fromEntries(packages);
      if (workspace.discoveryLimited) index.workspaceDiscoveryLimited = true;
    }
    if (reactFacts) {
      const details: DetailFacts = index.detailFacts = {
        handlers: {}, symbols: {}, renders: {}, requests: [], untracedStateOwners: [], unresolvedJsxHandlers: []
      };
      const add = <K extends string | number>(table: Record<K, DetailFact[]>, key: K, row: DetailFact) =>
        (table[key] ??= []).push(row);
      for (const route of index.routes) {
        if (route.kind !== 'api' || route.pages || route.router) continue;
        const source = filesByRelative.get(route.file);
        const entries = source && exports.get(source);
        const methods = (route.methods ?? []).map(method => {
          const declarations = entries?.get(method);
          const { handlerFacts } = require('./HandlerFacts') as typeof import('./HandlerFacts');
          return [method, handlerFacts(declarations?.length === 1 ? declarations[0] : undefined,
            node => relativePath(node.getSourceFile()))] as const;
        });
        details.handlers[route.id] = Object.fromEntries(methods);
      }
      const apiRoutesByUrl = new Map<string, number[]>();
      for (const { kind, url, id } of index.routes) if (kind === 'api') {
        const ids = apiRoutesByUrl.get(url) ?? [];
        ids.push(id);
        apiRoutesByUrl.set(url, ids);
      }
      const indexedRequests = new Map<Node, Map<string, IndexedRequest>>();
      for (const { node, via, route, method, url, partial, propUrlUnknown } of this.fetches) {
        if (via !== 'fetch') continue;
        let matches = indexedRequests.get(node);
        if (!matches) indexedRequests.set(node, matches = new Map());
        const prior = matches.get(route);
        const partialUrl = !!(partial || propUrlUnknown);
        if (!prior || prior.partialUrl && !partialUrl) matches.set(route, { method, url, partialUrl });
      }
      const jsxFiles = new Set(renderSites.map(site => site.file));
      const react = new Map<SourceFile, ReactFacts>();
      const untracedStateOwners = new Set<number>();
      const scope = (node: Node) => {
        for (let parent = node.compilerNode.parent; parent; parent = parent.parent) {
          const id = graphOwners.get(parent);
          const kind = id === undefined ? undefined : index.symbols[id - 1].kind;
          if (kind === 'component' || kind === 'hook') return id;
        }
        return owners(node)[1];
      };
      for (const [relative, source] of filesByRelative) {
        const calls = factCalls.get(source);
        if (!calls?.length || !reactFacts.appliesTo(source, jsxFiles.has(relative))) continue;
        const collector = new reactFacts(source, relative, flow, scope,
          (owner, fact) => add(details.symbols, owner, fact), indexedRequests,
          (method, routes, fact) => {
            const candidates = routes.flatMap(route => apiRoutesByUrl.get(route) ?? []);
            if (candidates.length) details.requests.push([method, candidates, fact]);
          }, untracedStateOwners);
        if (collector.collect(calls)) react.set(source, collector);
      }
      const untracedHandlers = new Set<number>();
      for (const site of renderSites) {
        const { node, owner, file } = site;
        if (owner === undefined || !Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) continue;
        const supplier = react.get(node.getSourceFile());
        const targets = resolvedRenderSites.get(node);
        if (!supplier && !targets?.size) {
          if (node.compilerNode.attributes.properties.some(attr => ts.isJsxAttribute(attr) &&
            ts.isIdentifier(attr.name) && /^on[A-Z]/.test(attr.name.text))) untracedHandlers.add(scope(node) ?? owner);
          continue;
        }
        const from = scope(node) ?? owner;
        const rows = supplier?.render(node, from, index.symbols[from - 1].name, !!targets?.size, untracedHandlers) ?? [];
        if (!supplier) {
          // A matching render in an unsupported state source can still supply an open flag or callback.
          for (const attr of node.getAttributes()) {
            const name = Node.isJsxAttribute(attr) ? attr.getNameNode().getText() : '';
            if (name === 'onClick') untracedHandlers.add(from);
            if (Node.isJsxSpreadAttribute(attr) || name === 'open' || /^on(?!Click$)[A-Z]/.test(name)) {
              rows.push([file, startLine(attr), '<' + node.getTagNameNode().getText() + '> in ' +
                index.symbols[from - 1].name + ' ' + attr.getText(), 'prop supplier not traced to React state']);
            }
          }
        }
        for (const fact of rows) {
          add(details.symbols, from, fact);
          for (const target of targets ?? []) if (from !== target) add(details.renders, target, fact);
        }
      }
      details.unresolvedJsxHandlers = [...untracedHandlers];
      details.untracedStateOwners = [...untracedStateOwners];
    }
    return index;
  }
}
