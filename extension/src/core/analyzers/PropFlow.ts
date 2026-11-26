import { Node, SourceFile, SyntaxKind, ts, type Symbol } from 'ts-morph';
import { RENDER_LOOKUP_ISSUE } from '../../mcp/Index';
import { conditionalAt, returnsFromBranch, wrappedExpression } from './ArchitectureFacts';
import { startLine } from './SourceLines';
import { valueNode } from './StaticBindings';

export type JsxSite = import('ts-morph').JsxOpeningElement | import('ts-morph').JsxSelfClosingElement;
export type RenderSite = JsxSite | import('ts-morph').CallExpression;
export type Prop = { component: Node; name: string; fallback?: Node };
type SiteValue = { site: RenderSite; value?: Node; unknown?: boolean };
type BoundValue = SiteValue & { gates: PropGate[] };
type ForwardedSpread = { site: JsxSite; excluded: Set<string> };
type EventDelivery = boolean | 'possible';
type SlotUse = { site: Node; via: Node[]; conditional: boolean; lookup?: boolean };
type Literal = string | number | boolean | null;
export type PropConstraint = { prop: Prop; literal: Literal; equal: boolean };
export type PropGate = { component: Node; sites: RenderSite[]; partial?: boolean; uncertainSites?: RenderSite[]; unscoped?: true };

export function jsxValue(attribute: import('ts-morph').JsxAttribute) {
  const value = attribute.getInitializer();
  return Node.isJsxExpression(value) ? value.getExpression() : value;
}

function literal(node: Node | undefined): Literal | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isNumericLiteral(node)) return node.getLiteralValue();
  if (node?.getKind() === SyntaxKind.TrueKeyword) return true;
  if (node?.getKind() === SyntaxKind.FalseKeyword) return false;
  if (node?.getKind() === SyntaxKind.NullKeyword) return null;
}

export function constValue(node: Node) {
  if (!Node.isVariableDeclaration(node)) return;
  const list = node.compilerNode.parent;
  if (list.parent.kind === SyntaxKind.VariableStatement && (list.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const) {
    return node.getInitializer();
  }
}

const noDeclarations: Node[] = [];

export class PropFlow {
  private sites = new Map<Node, RenderSite[]>();
  private parameters = new Map<Node, Node>();
  private parameterFiles = new Set<SourceFile>();
  private props = new WeakMap<Node, Prop | null>();
  private symbolsByNode = new WeakMap<Node, Symbol | null>();
  private declarationsBySymbol = new WeakMap<Symbol, Node[]>();
  private declarationsByNode = new WeakMap<Node, Node[]>();
  private resolvedBindings = new Map<Node, Map<string, Map<Node | undefined, BoundValue[]>>>();
  private receiverIdentifiers = new Map<Node, Set<string>>();
  private identifiers = new Map<string, PropGate>();
  private forwardedEvents = new Map<Node, Map<string, EventDelivery>>();
  private forwardedSpreads = new Map<Node, ForwardedSpread[]>();
  private slots = new Map<Node, Map<string, SlotUse[]>>();

  constructor(private bodies: Map<Node, Node>, private targets: Map<Node, Node[]>, private files: Set<SourceFile>,
    private relativePath: (file: SourceFile) => string, private uncertainLookups: ReadonlySet<Node>) {
    for (const [component, body] of bodies) {
      const fn = body.getParent();
      if (Node.isArrowFunction(fn) || Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn)) {
        const param = fn.getParameters()[0];
        if (param) {
          this.parameters.set(param, component);
          this.parameterFiles.add(param.getSourceFile());
        }
      }
    }
    for (const [tag, definitions] of targets) {
      const site = tag.getParent();
      if (!Node.isJsxOpeningElement(site) && !Node.isJsxSelfClosingElement(site) && !Node.isCallExpression(site)) continue;
      for (const target of definitions) this.addSite(target, site);
    }
  }

  addSite(target: Node, site: RenderSite) {
    const entries = this.sites.get(target) ?? [];
    if (!entries.includes(site)) entries.push(site);
    this.sites.set(target, entries);
  }

  inputsOf(component: Node) {
    return this.sites.get(component) ?? [];
  }

  bodyOf(component: Node) {
    return this.bodies.get(component);
  }

  propsOwner(declaration: Node) {
    return this.parameters.get(declaration);
  }

  targetsOf(site: JsxSite) {
    return this.targets.get(site.getTagNameNode()) ?? [];
  }

  parametersAt(site: JsxSite) {
    return this.targetsOf(site).map(target => {
      const fn = this.bodies.get(target)?.getParent();
      if (Node.isArrowFunction(fn) || Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn)) {
        return fn.getParameters()[0]?.getNameNode();
      }
    });
  }

  lookupUncertain(site: JsxSite) {
    return this.uncertainLookups.has(site.getTagNameNode());
  }

  symbol(node: Node): Symbol | undefined {
    const cached = this.symbolsByNode.get(node);
    if (cached !== undefined) return cached ?? undefined;
    const symbol = node.getSymbol();
    this.symbolsByNode.set(node, symbol ?? null);
    return symbol;
  }

  declarations(node: Node): Node[] {
    const cached = this.declarationsByNode.get(node);
    if (cached) return cached;
    const symbol = this.symbol(node);
    const existing = symbol && this.declarationsBySymbol.get(symbol);
    const entries = existing ?? (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? noDeclarations;
    if (symbol && !existing) this.declarationsBySymbol.set(symbol, entries);
    this.declarationsByNode.set(node, entries);
    return entries;
  }

  read(node: Node | undefined, member?: string, remaining = 8): Prop | undefined {
    if (!node || member || remaining !== 8) return this.readProp(node, member, remaining);
    if (!this.parameterFiles.has(node.getSourceFile())) return;
    const cached = this.props.get(node);
    if (cached !== undefined) return cached ?? undefined;
    const prop = this.readProp(node, undefined, remaining);
    this.props.set(node, prop ?? null);
    return prop;
  }

  private readProp(node: Node | undefined, member: string | undefined, remaining: number): Prop | undefined {
    if (!node || remaining <= 0) return;
    const wrapped = wrappedExpression(node);
    if (wrapped) return this.read(wrapped, member, remaining - 1);
    if (!member && Node.isPropertyAccessExpression(node)) {
      return this.read(node.getExpression(), node.getName(), remaining - 1);
    }
    if (!member && Node.isElementAccessExpression(node)) {
      const key = node.getArgumentExpression();
      if (Node.isStringLiteral(key)) return this.read(node.getExpression(), key.getLiteralText(), remaining - 1);
    }
    if (!Node.isIdentifier(node)) return;
    for (const decl of this.declarations(node)) {
      if (!this.files.has(decl.getSourceFile())) continue;
      const alias = constValue(decl);
      if (alias) return this.read(alias, member, remaining - 1);
      if (member && Node.isParameterDeclaration(decl)) {
        const component = this.parameters.get(decl);
        if (component) return { component, name: member };
      }
      if (Node.isBindingElement(decl) && member && decl.getDotDotDotToken()) {
        const pattern = decl.getParent();
        const component = this.parameters.get(pattern.getParent());
        if (component && Node.isObjectBindingPattern(pattern) && !pattern.getElements().some(element =>
          !element.getDotDotDotToken() && (element.getPropertyNameNode() ?? element.getNameNode()).getText() === member)) {
          return { component, name: member };
        }
      }
      if (!member && Node.isBindingElement(decl) && !decl.getDotDotDotToken()) {
        const pattern = decl.getParent();
        if (!Node.isObjectBindingPattern(pattern)) continue;
        const owner = pattern.getParent();
        const name = decl.getPropertyNameNode() ?? decl.getNameNode();
        const key = Node.isStringLiteral(name) ? name.getLiteralText() : Node.isIdentifier(name) ? name.getText() : undefined;
        if (!key) continue;
        const component = this.parameters.get(owner);
        if (component) return { component, name: key, fallback: decl.getInitializer() };
        const from = constValue(owner);
        const prop = this.read(from, key, remaining - 1);
        if (prop) return { ...prop, fallback: decl.getInitializer() ?? prop.fallback };
      }
    }
  }

  private spreadValue(expr: Node, name: string, remaining: number): { value?: Node; unknown?: boolean } {
    if (!remaining) return { unknown: true };
    const wrapped = wrappedExpression(expr);
    if (wrapped) return this.spreadValue(wrapped, name, remaining - 1);
    if (Node.isObjectLiteralExpression(expr)) {
      let unknown = false;
      for (const property of [...expr.getProperties()].reverse()) {
        if (Node.isSpreadAssignment(property)) {
          const inner = this.spreadValue(property.getExpression(), name, remaining - 1);
          unknown ||= !!inner.unknown;
          if (inner.value) return { value: inner.value, unknown };
        } else if (Node.isComputedPropertyName(property.getNameNode())) unknown = true;
        else if (property.getName() === name) {
          return { value: Node.isPropertyAssignment(property) ? property.getInitializer() :
            Node.isShorthandPropertyAssignment(property) ? property.getNameNode() : property, unknown };
        }
      }
      return { unknown };
    }
    if (!Node.isIdentifier(expr)) return { unknown: true };
    for (const declaration of this.declarations(expr)) {
      const alias = constValue(declaration);
      if (alias) return this.spreadValue(alias, name, remaining - 1);
      const pattern = Node.isBindingElement(declaration) && declaration.getDotDotDotToken() ? declaration.getParent() : undefined;
      if (!Node.isObjectBindingPattern(pattern)) continue;
      if (pattern.getElements().some(element => !element.getDotDotDotToken() &&
          (element.getPropertyNameNode() ?? element.getNameNode()).getText() === name)) return {};
      const component = this.parameters.get(pattern.getParent());
      const sites = component && this.sites.get(component);
      if (!component || !sites?.length) return { unknown: true };
      const incoming = sites.map(site => this.value(site, { name }, remaining - 1, false));
      // A spread that may carry a value can override the local binding. Keep the
      // local value as a candidate unless all supplying sites prove its absence.
      return { unknown: incoming.some(site => site.unknown || !!site.value) };
    }
    return { unknown: true };
  }

  value(site: RenderSite, prop: Pick<Prop, 'name' | 'fallback'>, remaining = 8, missingUnknown = true): SiteValue {
    if (!remaining) return { site, unknown: true };
    if (Node.isCallExpression(site)) {
      const [, argument, ...children] = site.getArguments();
      if (prop.name === 'children' && children.length) {
        return children.length === 1 ? { site, value: children[0] } : { site, unknown: true };
      }
      const binding = argument && argument.getKind() !== SyntaxKind.NullKeyword
        ? this.spreadValue(argument, prop.name, remaining - 1) : undefined;
      return { site, value: binding?.value ?? prop.fallback,
        unknown: binding?.unknown || missingUnknown && !binding?.value && !prop.fallback };
    }
    let unknown = false;
    const attributes = site.getAttributes();
    for (let i = attributes.length - 1; i >= 0; i--) {
      const attr = attributes[i];
      if (Node.isJsxSpreadAttribute(attr)) {
        const spread = this.spreadValue(attr.getExpression(), prop.name, remaining - 1);
        unknown ||= !!spread.unknown;
        if (spread.value) return { site, value: spread.value, unknown };
      } else if (attr.getNameNode().getText() === prop.name) {
        return { site, value: jsxValue(attr) ?? attr, unknown };
      }
    }
    return { site, value: prop.fallback, unknown: unknown || missingUnknown && !prop.fallback };
  }

  values(prop: Prop): SiteValue[] {
    return (this.sites.get(prop.component) ?? []).map(site => this.value(site, prop));
  }

  excludedRenderSuppliers(node: Node, component: Node): RenderSite[] {
    const sites = this.sites.get(component);
    const body = this.bodies.get(component);
    if (!sites?.length || !body) return [];
    type Test = (site: RenderSite) => Literal | undefined;
    const compile = (input: Node): Test | undefined => {
      const expression = wrappedExpression(input) ?? input;
      if (expression !== input) return compile(expression);
      const prop = this.read(expression);
      if (prop?.component === component) return site => {
        const { value, unknown } = this.value(site, prop);
        if (!unknown) return Node.isJsxAttribute(value) ? true : literal(valueNode(value));
      };
      const constant = literal(expression);
      if (constant !== undefined) return () => constant;
      if (Node.isPrefixUnaryExpression(expression) && expression.getOperatorToken() === SyntaxKind.ExclamationToken) {
        const operand = compile(expression.getOperand());
        return site => {
          const value = operand?.(site);
          return value === undefined ? undefined : !value;
        };
      }
      if (!Node.isBinaryExpression(expression)) return;
      const operator = expression.getOperatorToken().getKind();
      if (operator !== SyntaxKind.EqualsEqualsEqualsToken && operator !== SyntaxKind.ExclamationEqualsEqualsToken &&
          operator !== SyntaxKind.AmpersandAmpersandToken && operator !== SyntaxKind.BarBarToken) return;
      const left = compile(expression.getLeft());
      const right = compile(expression.getRight());
      if (!left && !right) return;
      return site => {
        const a = left?.(site);
        const b = right?.(site);
        if (operator === SyntaxKind.AmpersandAmpersandToken) return a === undefined ? undefined : a ? b : a;
        if (operator === SyntaxKind.BarBarToken) return a === undefined ? undefined : a || b;
        if (a !== undefined && b !== undefined) return (a === b) === (operator === SyntaxKind.EqualsEqualsEqualsToken);
      };
    };
    const tests = [...this.branchConditions(node, body)].flatMap(({ expression, positive }) => {
      const test = compile(expression);
      return test ? [{ test, positive }] : [];
    });
    return tests.length ? sites.filter(site => tests.some(({ test, positive }) => {
      const value = test(site);
      return value !== undefined && Boolean(value) !== positive;
    })) : [];
  }

  bindings(prop: Prop): BoundValue[] {
    let names = this.resolvedBindings.get(prop.component);
    if (!names) this.resolvedBindings.set(prop.component, names = new Map());
    let fallbacks = names.get(prop.name);
    if (!fallbacks) names.set(prop.name, fallbacks = new Map());
    let bindings = fallbacks.get(prop.fallback);
    if (!bindings) {
      bindings = this.resolveBindings(prop, new Set(), { remaining: 256 });
      fallbacks.set(prop.fallback, bindings);
    }
    return bindings;
  }

  private resolveBindings(prop: Prop, pending: Set<Node>, budget: { remaining: number }): BoundValue[] {
    if (pending.size >= 6 || pending.has(prop.component)) return [];
    const seen = new Set(pending).add(prop.component);
    return this.values(prop).flatMap<BoundValue>(binding => {
      const limited = budget.remaining-- <= 0;
      const gate = { component: prop.component, sites: [binding.site], partial: binding.unknown || limited };
      if (limited) return [{ ...binding, value: undefined, unknown: true, gates: [gate] }];
      const forwarded = this.read(binding.value);
      if (!forwarded) return [{ ...binding, gates: [gate] }];
      const sources = this.resolveBindings(forwarded, seen, budget);
      if (!sources.length) return [{ ...binding, value: undefined, unknown: true, gates: [{ ...gate, partial: true }] }];
      return sources.map(source => ({
        ...source, unknown: !!binding.unknown || source.unknown, gates: [gate, ...source.gates]
      }));
    });
  }

  *branchConditions(node: Node, boundary?: Node) {
    for (let child = node, parent = node.getParent(); parent && child !== boundary; child = parent, parent = parent.getParent()) {
      let condition: Node | undefined;
      let positive = true;
      if (Node.isIfStatement(parent) && parent.getExpression() !== child) {
        condition = parent.getExpression();
        positive = parent.getThenStatement() === child;
      } else if (Node.isConditionalExpression(parent) && parent.getCondition() !== child) {
        condition = parent.getCondition();
        positive = parent.getWhenTrue() === child;
      } else if (Node.isBinaryExpression(parent) && parent.getRight() === child) {
        const operator = parent.getOperatorToken().getKind();
        if (operator === SyntaxKind.AmpersandAmpersandToken || operator === SyntaxKind.BarBarToken) {
          condition = parent.getLeft();
          positive = operator === SyntaxKind.AmpersandAmpersandToken;
        }
      }
      if (condition) yield { expression: condition, positive };
      if (boundary && Node.isBlock(parent)) for (const prior of parent.getStatements()) {
        if (prior === child) break;
        if (!Node.isIfStatement(prior)) continue;
        if (returnsFromBranch(prior.getThenStatement())) yield { expression: prior.getExpression(), positive: false };
        const other = prior.getElseStatement();
        if (other && returnsFromBranch(other)) yield { expression: prior.getExpression(), positive: true };
      }
    }
  }

  constraints(node: Node): PropConstraint[] {
    const result: PropConstraint[] = [];
    if (!this.parameterFiles.has(node.getSourceFile())) return result;
    for (const branch of this.branchConditions(node)) {
      const { positive } = branch;
      let expression = branch.expression;
      while (wrappedExpression(expression)) expression = wrappedExpression(expression)!;
      if (!Node.isBinaryExpression(expression)) continue;
      const operator = expression.getOperatorToken().getKind();
      if (operator !== SyntaxKind.EqualsEqualsEqualsToken && operator !== SyntaxKind.ExclamationEqualsEqualsToken) continue;
      for (const [input, tested] of [[expression.getLeft(), expression.getRight()], [expression.getRight(), expression.getLeft()]]) {
        const value = literal(tested);
        const prop = value !== undefined && this.read(input);
        if (prop) result.push({ prop, literal: value, equal: positive === (operator === SyntaxKind.EqualsEqualsEqualsToken) });
      }
    }
    return result;
  }

  gates(node: Node): PropGate[] {
    return this.constraints(node).map(({ prop, literal: expected, equal }) => {
      const key = JSON.stringify([prop.component.getSourceFile().getFilePath(), prop.component.getStart(), prop.name, expected, equal]);
      const cached = this.identifiers.get(key);
      if (cached) return cached;
      const uncertainSites: RenderSite[] = [];
      const sites = this.values(prop).flatMap(({ site, value, unknown }) => {
        const current = Node.isJsxAttribute(value) ? true : literal(value);
        if (unknown || current === undefined) {
          uncertainSites.push(site);
          return [site];
        }
        return (current === expected) === equal ? [site] : [];
      });
      const gate: PropGate = { component: prop.component, sites, uncertainSites: uncertainSites.length ? uncertainSites : undefined, unscoped: true };
      this.identifiers.set(key, gate);
      return gate;
    });
  }

  eventDelivery(site: JsxSite, name: string): EventDelivery {
    const targets = this.targetsOf(site);
    if (!targets.length) return true;
    let delivery: EventDelivery = false;
    for (const target of targets) {
      const seen = this.forwardedEvents.get(target) ?? new Map<string, EventDelivery>();
      this.forwardedEvents.set(target, seen);
      let forwarded = seen.get(name);
      if (forwarded === undefined) {
        forwarded = false;
        seen.set(name, false);
        for (const { site, excluded } of this.eventSpreads(target)) {
          if (excluded.has(name)) continue;
          forwarded = this.eventDelivery(site, name) || forwarded;
          if (forwarded === true) break;
        }
        seen.set(name, forwarded);
      }
      delivery = forwarded || delivery;
      if (delivery === true) break;
    }
    return delivery && this.lookupUncertain(site) ? 'possible' : delivery;
  }

  private eventSpreads(target: Node): ForwardedSpread[] {
    const cached = this.forwardedSpreads.get(target);
    if (cached) return cached;
    const entries: ForwardedSpread[] = [];
    this.forwardedSpreads.set(target, entries);
    const body = this.bodies.get(target);
    const fn = body?.getParent();
    if (!body || !Node.isFunctionDeclaration(fn) && !Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return entries;
    const props = fn.getParameters()[0];
    if (!props) return entries;
    for (const spread of body.getDescendantsOfKind(SyntaxKind.JsxSpreadAttribute)) {
      const site = spread.getParent()?.getParent();
      if (!Node.isJsxOpeningElement(site) && !Node.isJsxSelfClosingElement(site)) continue;
      const attributes = site.getAttributes();
      const later = attributes.slice(attributes.indexOf(spread) + 1);
      if (later.some(Node.isJsxSpreadAttribute)) continue;
      for (const declaration of this.declarations(spread.getExpression())) {
        const excluded = new Set(later.flatMap(attribute => Node.isJsxAttribute(attribute) ? attribute.getNameNode().getText() : []));
        if (declaration !== props) {
          if (!Node.isBindingElement(declaration) || !declaration.getDotDotDotToken()) continue;
          const pattern = declaration.getParent();
          if (!Node.isObjectBindingPattern(pattern) || pattern.getParent() !== props) continue;
          for (const element of pattern.getElements()) {
            if (!element.getDotDotDotToken()) excluded.add((element.getPropertyNameNode() ?? element.getNameNode()).getText());
          }
        }
        entries.push({ site, excluded });
      }
    }
    return entries;
  }

  private slotUses(component: Node) {
    const previous = this.slots.get(component);
    if (previous) return previous;
    const uses = new Map<string, SlotUse[]>();
    this.slots.set(component, uses);
    const body = this.bodies.get(component);
    if (!body) return uses;
    const add = (expr: Node, site: Node, via: Node[] = [], conditional = false, asComponent = false, lookup = false) => {
      // In JSX, logical and ternary operands can be selected as rendered nodes.
      if (Node.isConditionalExpression(expr)) {
        add(expr.getWhenTrue(), site, via, true, asComponent, lookup);
        add(expr.getWhenFalse(), site, via, true, asComponent, lookup);
        return;
      }
      if (Node.isBinaryExpression(expr)) {
        const operator = expr.getOperatorToken().getKind();
        if (operator === SyntaxKind.BarBarToken || operator === SyntaxKind.QuestionQuestionToken) {
          add(expr.getLeft(), site, via, true, asComponent, lookup);
        }
        if ([SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken].includes(operator)) {
          add(expr.getRight(), site, via, true, asComponent, lookup);
        }
        return;
      }
      const wrapped = wrappedExpression(expr);
      if (wrapped) return add(wrapped, site, via, conditional, asComponent, lookup);
      const prop = this.read(expr);
      if (prop?.component !== component) return;
      const key = asComponent ? 'tag:' + prop.name : prop.name;
      const sites = uses.get(key) ?? [];
      sites.push({ site, via, conditional: conditional || !!conditionalAt(expr, body), lookup });
      uses.set(key, sites);
    };
    body.forEachDescendant(node => {
      if (Node.isJsxExpression(node)) {
        const expr = node.getExpression();
        if (!expr) return;
        const parent = node.getParent();
        if (Node.isJsxAttribute(parent)) {
          const opening = parent.getParent()?.getParent();
          if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return;
          const name = parent.getNameNode().getText();
          for (const receiver of this.targetsOf(opening)) {
            for (const use of this.slotUses(receiver).get(name) ?? []) {
              add(expr, use.site, [receiver, ...use.via], use.conditional, false, use.lookup || this.lookupUncertain(opening));
            }
            for (const use of this.slotUses(receiver).get('tag:' + name) ?? []) {
              add(expr, use.site, [receiver, ...use.via], use.conditional, true, use.lookup || this.lookupUncertain(opening));
            }
          }
        } else if (Node.isJsxElement(parent)) {
          const opening = parent.getOpeningElement();
          if (this.targetsOf(opening).length) {
            for (const receiver of this.targetsOf(opening)) {
              for (const use of this.slotUses(receiver).get('children') ?? []) {
                add(expr, use.site, [receiver, ...use.via], use.conditional, false, use.lookup || this.lookupUncertain(opening));
              }
            }
          } else add(expr, node);
        } else if (Node.isJsxFragment(parent)) add(expr, node);
      } else if ((Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) &&
          !this.targetsOf(node).length) {
        add(node.getTagNameNode(), node, [], false, true);
      } else if (Node.isReturnStatement(node)) {
        const expr = node.getExpression();
        if (expr) add(expr, node);
      }
    });
    if (!Node.isBlock(body)) add(body, body);
    return uses;
  }

  private renderUses(site: JsxSite, name: string, attribute?: import('ts-morph').JsxAttribute, asComponent = false) {
    return this.targetsOf(site).flatMap(receiver => {
      const binding = attribute && this.value(site, { name });
      if (attribute && binding?.value !== jsxValue(attribute)) return [];
      return (this.slotUses(receiver).get(asComponent ? 'tag:' + name : name) ?? []).map(use => ({
        detail: (use.lookup || this.lookupUncertain(site) ? `${RENDER_LOOKUP_ISSUE}; ` : '') +
          `prop ${name} via ${[receiver, ...use.via].map(component =>
          Node.isVariableDeclaration(component) || Node.isFunctionDeclaration(component)
            ? component.getName() ?? 'default' : 'default').join(' > ')} (rendered at ${this.relativePath(use.site.getSourceFile())}:${startLine(use.site)})`,
        conditional: use.conditional, partial: !!binding?.unknown || !!use.lookup || this.lookupUncertain(site)
      }));
    });
  }

  /** Where a supplied JSX value is inserted, including named prop forwarding. */
  renderSlot(attribute: import('ts-morph').JsxAttribute, asComponent = false) {
    const site = attribute.getParent()?.getParent();
    if (!Node.isJsxOpeningElement(site) && !Node.isJsxSelfClosingElement(site)) return [];
    return this.renderUses(site, attribute.getNameNode().getText(), attribute, asComponent);
  }

  mayRenderSlot(attribute: import('ts-morph').JsxAttribute): boolean {
    const site = attribute.getParent()?.getParent();
    if (!Node.isJsxOpeningElement(site) && !Node.isJsxSelfClosingElement(site)) return true;
    const name = attribute.getNameNode().getText();
    const effective = this.value(site, { name });
    if (effective.value !== jsxValue(attribute) && !effective.unknown) return false;
    const targets = this.targetsOf(site);
    return !targets.length || targets.some(target => {
      const body = this.bodies.get(target);
      const fn = body?.getParent();
      if (!body || !Node.isArrowFunction(fn) && !Node.isFunctionDeclaration(fn) && !Node.isFunctionExpression(fn)) return true;
      let identifiers = this.receiverIdentifiers.get(target);
      if (!identifiers) {
        identifiers = new Set(body.getDescendantsOfKind(SyntaxKind.Identifier).map(node => node.getText()));
        if (Node.isIdentifier(body)) identifiers.add(body.getText());
        this.receiverIdentifiers.set(target, identifiers);
      }
      if (!Node.isArrowFunction(fn) && identifiers.has('arguments')) return true;
      const parameter = fn.getParameters()[0]?.getNameNode();
      if (!parameter) return false;
      if (Node.isIdentifier(parameter)) return identifiers.has(parameter.getText());
      if (!Node.isObjectBindingPattern(parameter)) return true;
      const elements = parameter.getElements();
      const selected = elements.find(element => {
        const key = element.getPropertyNameNode() ?? element.getNameNode();
        return !element.getDotDotDotToken() && (Node.isComputedPropertyName(key) ||
          (Node.isStringLiteral(key) ? key.getLiteralText() : key.getText()) === name);
      });
      if (Node.isComputedPropertyName(selected?.getPropertyNameNode())) return true;
      const binding = selected?.getNameNode() ?? elements.find(element => element.getDotDotDotToken())?.getNameNode();
      return !!binding && (!Node.isIdentifier(binding) || identifiers.has(binding.getText()));
    });
  }

  renderChildren(element: import('ts-morph').JsxElement) {
    // Element children take precedence over a children attribute or spread.
    return this.renderUses(element.getOpeningElement(), 'children');
  }
}
