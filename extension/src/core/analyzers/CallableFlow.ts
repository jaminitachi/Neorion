import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import { declarationsOf, wrappedExpression } from './ArchitectureFacts';
import { constValue, JsxSite } from './PropFlow';

export type FunctionNode = import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression |
  import('ts-morph').FunctionDeclaration | import('ts-morph').MethodDeclaration;

export function isFunction(node: Node | undefined): node is FunctionNode {
  return Node.isArrowFunction(node) || Node.isFunctionExpression(node) ||
    Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node);
}

export function returnedValues(fn: FunctionNode): Node[] {
  const body = fn.getBody();
  if (!body) return [];
  if (!Node.isBlock(body)) return [body];
  const values: Node[] = [];
  body.forEachDescendant((node, traversal) => {
    if (Node.isFunctionLikeDeclaration(node) || Node.isClassDeclaration(node)) traversal.skip();
    if (Node.isReturnStatement(node)) {
      const expression = node.getExpression();
      if (expression) values.push(expression);
    }
  });
  return values;
}

function packageOrigin(node: Node) {
  const root = Node.isPropertyAccessExpression(node) ? node.getExpression() : node;
  for (const declaration of root.getSymbol()?.getDeclarations() ?? []) {
    if (!Node.isImportSpecifier(declaration) && !Node.isNamespaceImport(declaration) && !Node.isImportClause(declaration)) continue;
    const module = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue();
    if (!module) continue;
    if (Node.isImportSpecifier(declaration) && root === node) return { module, name: declaration.getName() };
    if (Node.isPropertyAccessExpression(node) && !Node.isImportSpecifier(declaration)) return { module, name: node.getName() };
    if (Node.isImportClause(declaration)) return { module, name: 'default' };
  }
}

export function packageMember(node: Node, module: string) {
  const origin = packageOrigin(node);
  if (origin?.module === module) return origin.name;
}

function selectedMembers(selector: Node | undefined): string[] | undefined {
  if (!isFunction(selector)) return;
  const parameter = selector.getParameters()[0];
  const values = returnedValues(selector);
  if (!parameter || values.length !== 1) return;
  let expression = values[0];
  const members: string[] = [];
  while (true) {
    const wrapped = wrappedExpression(expression);
    if (wrapped) expression = wrapped;
    else if (Node.isPropertyAccessExpression(expression)) {
      members.unshift(expression.getName());
      expression = expression.getExpression();
    } else break;
  }
  if (Node.isIdentifier(expression) && declarationsOf(expression).includes(parameter)) return members;
}

type Target = { fn: FunctionNode; via: string[] };
export class CallableFlow {
  private targets = new WeakMap<Node, Target[]>();
  private returns = new WeakMap<FunctionNode, Node[]>();
  private packageOrigins = new WeakMap<Node, ReturnType<typeof packageOrigin> | null>();

  constructor(private files: Set<SourceFile>, private declarations = declarationsOf) {}

  private packageOf(node: Node) {
    const cached = this.packageOrigins.get(node);
    if (cached !== undefined) return cached ?? undefined;
    const origin = packageOrigin(node);
    this.packageOrigins.set(node, origin ?? null);
    return origin;
  }

  private storeInitializer(node: Node | undefined, remaining = 8): FunctionNode | undefined {
    if (!node || !remaining) return;
    const wrapped = wrappedExpression(node);
    if (wrapped) return this.storeInitializer(wrapped, remaining - 1);
    if (isFunction(node)) return node;
    if (!Node.isCallExpression(node)) return;
    const origin = this.packageOf(node.getExpression());
    if (origin && (origin.module === 'zustand/middleware' || origin.module === 'zustand/middleware/immer') &&
        ['persist', 'devtools', 'subscribeWithSelector', 'combine', 'immer'].includes(origin.name)) {
      return this.storeInitializer(node.getArguments()[origin.name === 'combine' ? 1 : 0], remaining - 1);
    }
  }

  /** Resolve function values through immutable bindings, returned objects and Zustand selectors. */
  resolve(expression: Node): Target[] {
    if (isFunction(expression)) return [{ fn: expression, via: [] }];
    const cached = this.targets.get(expression);
    if (cached) return cached;
    const seen = new Map<Node, Set<string>>();
    let budget = 64;
    const resolve = (node: Node | undefined, members: string[], invoke: number, via: string[]): Target[] => {
      if (!node || budget-- <= 0 || !this.files.has(node.getSourceFile())) return [];
      const key = invoke + ':' + (members.length ? JSON.stringify(members) : '');
      const states = seen.get(node);
      if (states?.has(key)) return [];
      if (states) states.add(key);
      else seen.set(node, new Set([key]));
      const next = (value: Node | undefined, path = members, calls = invoke, trail = via) => resolve(value, path, calls, trail);
      const wrapped = wrappedExpression(node);
      if (wrapped) return next(wrapped);
      if (isFunction(node)) {
        if (!invoke) return members.length ? [] : [{ fn: node, via }];
        let values = this.returns.get(node);
        if (!values) this.returns.set(node, values = returnedValues(node));
        return values.flatMap(value => next(value, members, invoke - 1));
      }
      if (Node.isVariableDeclaration(node)) return next(constValue(node));
      if (Node.isPropertyAssignment(node)) return next(node.getInitializer());
      if (Node.isShorthandPropertyAssignment(node)) {
        return node.getValueSymbol()?.getDeclarations().flatMap(decl => next(decl)) ?? [];
      }
      if (Node.isBindingElement(node) && !node.getDotDotDotToken()) {
        const pattern = node.getParent();
        const name = node.getPropertyNameNode() ?? node.getNameNode();
        if (Node.isObjectBindingPattern(pattern) && (Node.isIdentifier(name) || Node.isStringLiteral(name))) {
          return next(pattern.getParent(), [Node.isStringLiteral(name) ? name.getLiteralText() : name.getText(), ...members]);
        }
      }
      if (Node.isObjectLiteralExpression(node) && members.length) {
        const [name, ...rest] = members;
        for (const property of [...node.getProperties()].reverse()) {
          if (Node.isSpreadAssignment(property) || Node.isComputedPropertyName(property.getNameNode())) return [];
          if (property.getName() === name) return next(property, rest);
        }
      }
      if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
        const key = Node.isElementAccessExpression(node) ? node.getArgumentExpression() : undefined;
        const name = Node.isPropertyAccessExpression(node) ? node.getName() : Node.isStringLiteral(key) ? key.getLiteralText() : undefined;
        if (name && (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node))) {
          const selected = next(node.getExpression(), [name, ...members]);
          if (selected.length) return selected;
        }
        return this.declarations(node).filter(decl => !Node.isPropertySignature(decl) && !Node.isMethodSignature(decl))
          .flatMap(decl => next(decl));
      }
      if (!Node.isCallExpression(node)) return [];
      const callee = node.getExpression();
      const args = node.getArguments();
      const origin = this.packageOf(callee);
      const hook = origin?.module === 'react' ? origin.name : undefined;
      if (hook === 'useMemo' || hook === 'useCallback') return next(args[0], members, invoke + (hook === 'useMemo' ? 1 : 0));

      const factory = Node.isCallExpression(callee) && !callee.getArguments().length ? callee.getExpression() : callee;
      const creation = invoke && (factory === callee ? origin : this.packageOf(factory));
      if (creation && ['zustand', 'zustand/vanilla', 'zustand/traditional'].includes(creation.module) &&
          ['create', 'default', 'createStore', 'createWithEqualityFn'].includes(creation.name)) {
        const initializer = this.storeInitializer(args[0]);
        return next(initializer, members, invoke);
      }

      // Evaluate the selector against an actual Zustand binding. Local calls may
      // return a nested object or function, but do not supply selector semantics.
      const path = selectedMembers(args[0]);
      if (path && this.declarations(callee).some(decl => this.storeFactory(constValue(decl)))) {
        return next(callee, [...path, ...members], invoke + 1, [...via, callee.getText()]);
      }
      if (!members.length && !invoke && !Node.isIdentifier(callee) && !Node.isPropertyAccessExpression(callee)) return [];
      return next(callee, members, invoke + 1, [...via, callee.getText()]);
    };
    const result = resolve(expression, [], 0, []);
    this.targets.set(expression, result);
    return result;
  }

  private storeFactory(node: Node | undefined) {
    if (!Node.isCallExpression(node)) return false;
    const callee = node.getExpression();
    const factory = Node.isCallExpression(callee) && !callee.getArguments().length ? callee.getExpression() : callee;
    const origin = this.packageOf(factory);
    return !!origin && (origin.module === 'zustand' || origin.module === 'zustand/traditional') &&
      ['create', 'default', 'createWithEqualityFn'].includes(origin.name);
  }
}

export function jsxLabel(site: JsxSite): string {
  const element = site.getParent();
  const labels = new Set<string>();
  const add = (text: string) => {
    const label = text.trim().replace(/\s+/g, ' ');
    if (label && label.length <= 70) labels.add(label);
  };
  if (Node.isJsxElement(element) && element.getOpeningElement() === site) {
    for (const child of element.getJsxChildren()) {
      if (Node.isJsxText(child)) add(child.getText());
      else if (Node.isJsxExpression(child)) {
        const visit = (node: Node | undefined) => {
          if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) add(node.getLiteralText());
          else if (Node.isConditionalExpression(node)) {
            visit(node.getWhenTrue());
            visit(node.getWhenFalse());
          }
        };
        visit(child.getExpression());
      }
    }
  }
  return site.getTagNameNode().getText() + (labels.size ? ' ' + [...labels].join(' / ') : '');
}

export function jsxRefContainer(site: JsxSite) {
  for (const ancestor of site.getAncestors()) {
    if (!Node.isJsxElement(ancestor)) continue;
    const opening = ancestor.getOpeningElement();
    const hidden = opening.getAttribute('aria-hidden') ?? opening.getAttribute('hidden');
    if (!Node.isJsxAttribute(hidden) || ['false', '{false}'].includes(hidden.getInitializer()?.getText() ?? '')) continue;
    return `inside <${opening.getTagNameNode().getText()} ${hidden.getNameNode().getText()}>`;
  }
  return '';
}

export function sectionLabels(site: JsxSite): string {
  for (const ancestor of site.getAncestors()) {
    if (!Node.isJsxElement(ancestor)) continue;
    for (const child of ancestor.getJsxChildren()) {
      if (!Node.isJsxElement(child)) continue;
      const tag = child.getOpeningElement().getTagNameNode().getText();
      if (!/^(?:h[1-6]|\w*(?:Heading|Title|Trigger|Summary))$/.test(tag)) continue;
      const label = child.getDescendantsOfKind(SyntaxKind.JsxText).map(text => text.getText().trim()).filter(Boolean).join(' ');
      if (label && label.length <= 70) return label;
    }
  }
  return '';
}

export function useRefBinding(binding: Node) {
  return declarationsOf(binding).find(decl => {
    const value = constValue(decl);
    // Binding identity prevents a same-named ref in another scope from matching.
    return Node.isCallExpression(value) && packageMember(value.getExpression(), 'react') === 'useRef';
  });
}

export function refBinding(expression: Node | undefined) {
  if (Node.isPropertyAccessExpression(expression) && expression.getName() === 'current') {
    return useRefBinding(expression.getExpression());
  }
}

export function callbackRefWrites(expression: Node): { binding: Node; assignment: Node; key?: string }[] {
  if (!isFunction(expression)) return [];
  const parameter = expression.getParameters()[0];
  if (!parameter) return [];
  const writes: { binding: Node; assignment: Node; key?: string }[] = [];
  const visit = (node: Node) => {
    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      const input = node.getRight();
      const binding = refBinding(node.getLeft());
      if (binding && Node.isIdentifier(input) && declarationsOf(input).includes(parameter)) {
        writes.push({ binding, assignment: node });
      }
      return;
    }
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'set') return;
    const [key, value] = node.getArguments();
    if (!key || !Node.isIdentifier(value) || !declarationsOf(value).includes(parameter)) return;
    const binding = refBinding(callee.getExpression());
    if (binding) writes.push({ binding, assignment: node, key: key.getText() });
  };
  const body = expression.getBody();
  if (body) {
    visit(body);
    body.forEachDescendant((node, traversal) => {
      if (Node.isFunctionLikeDeclaration(node)) traversal.skip();
      else visit(node);
    });
  }
  return writes;
}
