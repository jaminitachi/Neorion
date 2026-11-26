import { Node, SourceFile, SyntaxKind, type CallExpression, type ParameterDeclaration, type PropertyAssignment } from 'ts-morph';
import { conditionalAt, declarationsOf, isPackageSpecifier, wrappedExpression } from './ArchitectureFacts';
import { isFunction, packageMember, returnedValues } from './CallableFlow';
import { constValue, type PropFlow, type RenderSite } from './PropFlow';
import { functionNode, importBinding, valueNode } from './StaticBindings';
import { isTypeOnlyExport } from './RuntimeExports';

const allArrayElements = Symbol('all array elements');
type Member = string | null | typeof allArrayElements;
export type RenderCertainty = { possible: boolean; conditional: boolean; contextExcluded?: true };
type ArrayBinding = { parameter: ParameterDeclaration; receiver: Node; outer?: ArrayBinding };
type Supply = { site: RenderSite; name: string };
type Lookup = { selector: Node; member?: string };
type RenderChoice = RenderCertainty & { lookup?: Lookup };
type Step = RenderChoice & { members: Member[]; returns: boolean; binding?: ArrayBinding; supply?: Supply };
enum Resolution { Unknown, Empty, External, Local }

export function isComponentWrapper(node: Node | undefined): node is CallExpression {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  const name = packageMember(callee, 'react');
  return name === 'memo' || name === 'forwardRef' || /(?:^|\.)(?:memo|forwardRef)$/.test(callee.getText());
}

/** Find a locally implemented HOC that returns or renders its component argument. */
export function forwardedComponent(call: CallExpression, files: Set<SourceFile>):
  { argument: Node; sites: { node: Node; conditional: number }[] } | undefined {
  const factory = functionNode(call.getExpression());
  const parameter = factory?.getParameters()[0];
  const argument = call.getArguments()[0];
  if (!factory || !parameter || !argument || !files.has(factory.getSourceFile())) return;
  const values = returnedValues(factory);
  if (values.length !== 1) return;
  const guarded = conditionalAt(values[0], factory);
  const returned = valueNode(values[0]);
  const name = parameter.getNameNode();
  const symbol = name.getSymbol();
  if (!symbol) return;
  if (Node.isIdentifier(name) && name.findReferences().some(reference =>
    reference.getReferences().some(use => use.isWriteAccess() && use.getNode() !== name))) return;
  if (Node.isIdentifier(returned) && returned.getSymbol() === symbol) {
    return { argument, sites: [{ node: argument, conditional: guarded }] };
  }
  const component = functionNode(returned);
  if (!component || !files.has(component.getSourceFile())) return;
  const returns = returnedValues(component);
  const sites: { node: Node; conditional: number }[] = [];
  const inspect = (node: Node, conditional: number) => {
    const wrapped = wrappedExpression(node);
    if (wrapped) return inspect(wrapped, conditional);
    if (Node.isConditionalExpression(node)) {
      inspect(node.getWhenTrue(), 1);
      inspect(node.getWhenFalse(), 1);
      return;
    }
    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
      inspect(node.getRight(), 1);
      return;
    }
    const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
    if (Node.isJsxOpeningElement(opening) || Node.isJsxSelfClosingElement(opening)) {
      const tag = opening.getTagNameNode();
      if (tag.getSymbol() === symbol) sites.push({ node: tag, conditional });
      if (!Node.isIdentifier(tag) || !/^[a-z]/.test(tag.compilerNode.text)) return;
    }
    if (Node.isJsxElement(node) || Node.isJsxFragment(node)) {
      for (const child of node.getJsxChildren()) {
        const value = Node.isJsxExpression(child) ? child.getExpression() : child;
        if (value) inspect(value, conditional);
      }
    }
  };
  for (const value of returns) inspect(value, guarded || Number(returns.length > 1) || conditionalAt(value, component));
  if (sites.length) return { argument, sites };
}

export function preferRenderBinding(candidate: RenderCertainty, existing: RenderCertainty): boolean {
  if (candidate.contextExcluded !== existing.contextExcluded) return !candidate.contextExcluded;
  if (candidate.possible !== existing.possible) return !candidate.possible;
  return !candidate.conditional && existing.conditional;
}

function lookupKey(node: Node | undefined, remaining = 8): string | undefined {
  if (!node || !remaining) return;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isNumericLiteral(node)) return String(node.getLiteralValue());
  if (Node.isPrefixUnaryExpression(node)) {
    const operand = node.getOperand();
    const operator = node.getOperatorToken();
    if (Node.isNumericLiteral(operand) && (operator === SyntaxKind.PlusToken || operator === SyntaxKind.MinusToken)) {
      return String(operator === SyntaxKind.MinusToken ? -operand.getLiteralValue() : operand.getLiteralValue());
    }
  }
  const wrapped = wrappedExpression(node);
  if (wrapped) return lookupKey(wrapped, remaining - 1);
  if (Node.isIdentifier(node)) {
    const declarations = declarationsOf(node);
    if (declarations.length === 1) return lookupKey(constValue(declarations[0]), remaining - 1);
  }
}

const elementMethods = new Set(['find', 'findLast', 'at']);
const arrayMethods = new Set(['filter', 'slice', 'toSorted', 'toReversed', 'sort', 'reverse', 'concat']);
const transformMethods = new Set(['map', 'flatMap']);
const isReducer = (method: string) => method === 'reduce' || method === 'reduceRight';

function builtin(node: Node, name: string) {
  return Node.isIdentifier(node) && node.compilerNode.text === name &&
    declarationsOf(node).some(declaration => declaration.getSourceFile().compilerNode.hasNoDefaultLib);
}

/** Resolve a context predicate when its provider has no consumer in this app. */
export function unprovidedContextTruth(files: Set<SourceFile>, isAppSource: (file: SourceFile) => boolean) {
  const checked = new Map<Node, boolean>();
  const references = (node: import('ts-morph').Identifier) => node.findReferencesAsNodes().filter(use => {
    const parent = use.getParent();
    return use !== node && files.has(use.getSourceFile()) && !Node.isImportSpecifier(parent) && !Node.isImportClause(parent) &&
      !Node.isExportSpecifier(parent) && !use.getAncestors().some(Node.isTypeNode);
  });
  const mountedProvider = (node: Node, seen: Set<Node>): boolean => {
    if (isAppSource(node.getSourceFile()) || seen.size >= 8) return true;
    const owner = node.getFirstAncestor(Node.isFunctionLikeDeclaration);
    const name = Node.isFunctionDeclaration(owner) && owner.getNameNode();
    if (!name || !Node.isIdentifier(name)) return true;
    if (seen.has(name)) return false;
    const pending = new Set(seen).add(name);
    return references(name).some(use => mountedProvider(use, pending));
  };
  const isUnprovided = (name: import('ts-morph').Identifier) => {
    const cached = checked.get(name);
    if (cached !== undefined) return cached;
    const result = references(name).every(use => {
      const parent = use.getParent();
      if (Node.isCallExpression(parent) && packageMember(parent.getExpression(), 'react') === 'useContext') return true;
      const provider = Node.isPropertyAccessExpression(parent) && parent.getName() === 'Provider' ? parent : use;
      const tag = provider.getParent();
      if (Node.isJsxOpeningElement(tag) || Node.isJsxSelfClosingElement(tag) || Node.isJsxClosingElement(tag)) {
        return tag.getTagNameNode() === provider && !mountedProvider(use, new Set());
      }
      return false;
    });
    checked.set(name, result);
    return result;
  };
  const returned = (call: Node | undefined) => {
    if (!Node.isCallExpression(call)) return;
    const fn = functionNode(call.getExpression());
    if (!fn || !files.has(fn.getSourceFile())) return;
    const [value, extra] = returnedValues(fn);
    return !extra && value && !conditionalAt(value, fn) ? valueNode(value) : undefined;
  };
  return (condition: Node): boolean | undefined => {
    const test = returned(valueNode(condition));
    if (!Node.isCallExpression(test) || !builtin(test.getExpression(), 'Boolean')) return;
    const [member] = test.getArguments();
    if (!Node.isPropertyAccessExpression(member)) return;
    const source = valueNode(member.getExpression());
    const context = Node.isCallExpression(source) && packageMember(source.getExpression(), 'react') === 'useContext'
      ? source : returned(source);
    if (!Node.isCallExpression(context) || packageMember(context.getExpression(), 'react') !== 'useContext') return;
    const [argument] = context.getArguments();
    if (!argument) return;
    const [binding] = declarationsOf(argument);
    if (!Node.isVariableDeclaration(binding) || !files.has(binding.getSourceFile())) return;
    const name = binding.getNameNode();
    const initializer = valueNode(binding.getInitializer());
    if (!Node.isIdentifier(name) || !Node.isCallExpression(initializer) ||
        packageMember(initializer.getExpression(), 'react') !== 'createContext') return;
    const defaults = valueNode(initializer.getArguments()[0]);
    if (!Node.isObjectLiteralExpression(defaults) || defaults.getProperties().some(Node.isSpreadAssignment)) return;
    const property = defaults.getProperty(member.getName());
    const value = Node.isPropertyAssignment(property) ? valueNode(property.getInitializer()) : undefined;
    const truth = Node.isStringLiteral(value) || Node.isNumericLiteral(value) ? Boolean(value.getLiteralValue()) :
      Node.isTrueLiteral(value) ? true : Node.isFalseLiteral(value) || Node.isNullLiteral(value) ? false : undefined;
    if (truth !== undefined && isUnprovided(name)) return truth;
  };
}

function stateCall(node: Node | undefined): node is CallExpression {
  return Node.isCallExpression(node) && packageMember(node.getExpression(), 'react') === 'useState';
}

function destructuredState(node: Node | undefined) {
  if (!Node.isBindingElement(node)) return;
  const pattern = node.getParent();
  const owner = pattern.getParent();
  if (!Node.isArrayBindingPattern(pattern) || !Node.isVariableDeclaration(owner) ||
      pattern.getElements()[0] !== node || node.getDotDotDotToken()) return;
  const state = valueNode(owner.getInitializer());
  if (stateCall(state)) return state;
}

function collectionCall(node: Node, remaining = 12) {
  if (!remaining || !Node.isCallExpression(node)) return;
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return;
  const method = callee.getName();
  const receiver = callee.getExpression();
  if ((method === 'values' || method === 'entries') && builtin(receiver, 'Object')) {
    return { kind: 'object' as const, method, receiver: node.getArguments()[0] };
  }
  if (method === 'from' && builtin(receiver, 'Array')) {
    const [source, callback] = node.getArguments();
    return callback ? { kind: 'transform' as const, method, receiver: source, callback } :
      { kind: 'array' as const, method, receiver: source };
  }
  if ((arrayMethods.has(method) || elementMethods.has(method)) && isArrayExpression(receiver, remaining - 1)) {
    return { kind: elementMethods.has(method) ? 'element' as const : 'array' as const, method, receiver };
  }
  if (transformMethods.has(method) && isArrayExpression(receiver, remaining - 1)) {
    return { kind: 'transform' as const, method, receiver, callback: node.getArguments()[0] };
  }
}

function isArrayExpression(node: Node, remaining = 12): boolean {
  const type = node.getType().getNonNullableType();
  if (type.isArray() || type.isTuple()) return true;
  if (!remaining) return false;
  const collection = collectionCall(node, remaining);
  if (collection && collection.kind !== 'element') return true;
  const value = valueNode(node);
  if (value && value !== node) return isArrayExpression(value, remaining - 1);
  let state: CallExpression | undefined;
  if (Node.isIdentifier(value)) {
    state = declarationsOf(value).map(destructuredState).find(Boolean);
  } else if (Node.isElementAccessExpression(value) && lookupKey(value.getArgumentExpression()) === '0') {
    const receiver = valueNode(value.getExpression());
    if (stateCall(receiver)) state = receiver;
  }
  const initial = state?.getArguments()[0];
  return !!initial && isArrayExpression(initial, remaining - 1);
}

function callbackArray(parameter: ParameterDeclaration) {
  const fn = parameter.getParent();
  if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return;
  let callback: Node = fn;
  for (let parent = callback.getParent(); parent && wrappedExpression(parent) === callback; parent = callback.getParent()) {
    callback = parent;
  }
  const call = callback.getParent();
  if (!Node.isCallExpression(call) || call.getArguments()[0] !== callback) return;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return;
  const method = callee.getName();
  const reduce = isReducer(method);
  if ((!transformMethods.has(method) && !reduce) || fn.getParameters()[Number(reduce)] !== parameter) return;
  const receiver = callee.getExpression();
  if (isArrayExpression(receiver)) return { receiver, possible: method !== 'map' };
}

function tupleAt(receiver: Node, argument: Node | undefined): string | undefined {
  const type = receiver.getType();
  const key = lookupKey(argument);
  if (!type.isTuple() || key === undefined || !/^-?(?:0|[1-9]\d*)$/.test(key)) return;
  const index = Number(key);
  if (index >= 0) return key;
  const length = type.getProperty('length')?.getTypeAtLocation(receiver).getLiteralValue();
  if (typeof length === 'number') return String(length + index);
}

function arrayContaining(property: PropertyAssignment) {
  let object: Node = property.getParent();
  for (let parent = object.getParent(); parent && wrappedExpression(parent) === object; parent = object.getParent()) {
    object = parent;
  }
  const array = object.getParent();
  return Node.isArrayLiteralExpression(array) ? { array, object } : undefined;
}

function externalImport(node: Node, files: Set<SourceFile>): boolean {
  const binding = importBinding(node);
  if (!binding || !isPackageSpecifier(binding.module)) return false;
  const source = binding.declaration.getModuleSpecifierSourceFile();
  if (source) return !files.has(source) && source.isInNodeModules();
  const paths = node.getSourceFile().getProject().getCompilerOptions().paths ?? {};
  return !Object.keys(paths).some(pattern => {
    const star = pattern.indexOf('*');
    return star < 0 ? pattern === binding.module :
      binding.module.startsWith(pattern.slice(0, star)) && binding.module.endsWith(pattern.slice(star + 1));
  });
}

/** Follow the value behind a JSX binding through lookups, local factories and React memoization. */
export function renderBindings(declarations: Node[], files: Set<SourceFile>,
  indexedComponent: (node: Node) => boolean, flow?: PropFlow, indexedLoader?: (node: Node) => boolean,
  contextTruth?: (condition: Node) => boolean | undefined) {
  const seen = new Map<Node, { step: Step; resolution: Resolution }[]>();
  const targets = new Map<Supply | undefined, Map<Node, RenderChoice>>();
  const supplies = new Map<RenderSite, Map<string, Supply>>();
  let unresolvedLookup = false;
  let unresolvedProp = false;
  const opaqueLookups = new Set<Node>();
  const register = (node: Node, { supply, possible, conditional, lookup, contextExcluded }: Step) => {
    let scoped = targets.get(supply);
    if (!scoped) targets.set(supply, scoped = new Map());
    const prior = scoped.get(node);
    const choice = { possible, conditional, lookup, contextExcluded };
    if (!prior || preferRenderBinding(choice, prior)) scoped.set(node, choice);
    return Resolution.Local;
  };
  const resolve = (node: Node | undefined, step: Step, remaining: number): Resolution => {
    if (!node || remaining <= 0) return Resolution.Unknown;
    const { members, returns, possible, conditional, binding, supply, lookup, contextExcluded } = step;
    if (!files.has(node.getSourceFile())) {
      return !returns && !members.length && node.getSourceFile().isInNodeModules() &&
        (Node.isVariableDeclaration(node) || Node.isClassDeclaration(node) || isFunction(node)) ?
        Resolution.External : Resolution.Unknown;
    }
    const steps = seen.get(node) ?? [];
    const prior = steps.find(({ step: previous }) => previous.binding === binding && previous.supply === supply &&
        previous.returns === returns && previous.possible === possible &&
        previous.conditional === conditional && previous.contextExcluded === contextExcluded &&
        previous.lookup?.selector === lookup?.selector &&
        previous.lookup?.member === lookup?.member && previous.members.length === members.length &&
        previous.members.every((member, i) => member === members[i]));
    if (prior) return prior.resolution;
    const current = { step, resolution: Resolution.Unknown };
    steps.push(current);
    seen.set(node, steps);
    const candidates = { best: Resolution.Unknown, unknown: false };
    const traced = trace(node, step, (value, change) => {
      const result = resolve(value, change ? { ...step, ...change } : step, remaining - 1);
      candidates.best = Math.max(candidates.best, result);
      candidates.unknown ||= result === Resolution.Unknown;
      return result !== Resolution.Unknown;
    });
    // External imports prove coverage only when every candidate was traced.
    if (typeof traced === 'number') current.resolution = traced;
    else if (!candidates.unknown || candidates.best !== Resolution.External) {
      current.resolution = candidates.best || (traced ? Resolution.Empty : Resolution.Unknown);
    }
    return current.resolution;
  };
  const trace = (node: Node, step: Step, next: (value: Node | undefined, change?: Partial<Step>) => boolean): Resolution | boolean | void => {
    const { members, returns, possible, conditional, binding, supply, lookup } = step;
    if (isFunction(node) && returns) {
      const values = returnedValues(node);
      for (const value of values) {
        next(value, { returns: false, conditional: conditional || values.length > 1 || !!conditionalAt(value, node) });
      }
      return;
    }
    if (!returns && !members.length && (isFunction(node) && !Node.isMethodDeclaration(node) || Node.isClassDeclaration(node))) {
      return register(node, step);
    }
    if (Node.isVariableDeclaration(node) || Node.isExportAssignment(node)) {
      return next(Node.isVariableDeclaration(node) ? node.getInitializer() : node.getExpression());
    }
    if (Node.isParameterDeclaration(node)) {
      for (let current = binding; current; current = current.outer) {
        if (current.parameter === node) {
          return next(current.receiver, { members: [allArrayElements, ...members], binding: current.outer });
        }
      }
      const array = callbackArray(node);
      return next(array?.receiver, { members: [allArrayElements, ...members], possible: possible || !!array?.possible });
    }
    if (Node.isBindingElement(node)) {
      const pattern = node.getParent();
      const owner = pattern.getParent();
      const key = node.getPropertyNameNode() ?? node.getNameNode();
      if (Node.isObjectBindingPattern(pattern) && !node.getDotDotDotToken() &&
          (Node.isIdentifier(key) || Node.isStringLiteral(key))) {
        return next(owner, { members: [Node.isIdentifier(key) ? key.compilerNode.text : key.getLiteralText(), ...members] });
      }
      if (Node.isArrayBindingPattern(pattern)) {
        const index = pattern.getElements().indexOf(node);
        if (node.getDotDotDotToken()) return next(owner, { members: [null, ...members.slice(1)], possible: true });
        // Destructuring an ordinary array can pick up a value from a runtime element.
        const value = Node.isVariableDeclaration(owner) && owner.getInitializer();
        const tuple = !value || value.getType().isTuple() || stateCall(valueNode(value));
        return next(owner, { members: [tuple ? String(index) : null, ...members] });
      }
    }
    if (Node.isArrayLiteralExpression(node) && members.length) {
      const [key, ...rest] = members;
      if (typeof key === 'string' && !/^(?:0|[1-9]\d*)$/.test(key)) return true;
      let index = typeof key === 'string' ? Number(key) : Infinity;
      let spread = false;
      for (const element of node.getElements()) {
        if (Node.isSpreadElement(element)) {
          // Later offsets depend on the length of each preceding spread.
          const offset = typeof key === 'string' ? spread ? null : String(index) : key;
          next(element.getExpression(), { members: [offset, ...rest], possible: possible || key !== allArrayElements });
          spread = true;
        } else {
          const unknownIndex = key === null || spread;
          if (key === allArrayElements || unknownIndex || index === 0) {
            next(element, { members: rest, possible: possible || key !== allArrayElements && unknownIndex });
          }
          if (index-- === 0) return Node.isOmittedExpression(element);
        }
      }
      return !node.getElements().length || typeof key === 'string' && !spread;
    }
    if (Node.isObjectLiteralExpression(node) && members.length) {
      const [key, ...rest] = members;
      if (key === allArrayElements) return;
      const properties = node.getProperties();
      const covered = new Set<string>();
      let uncertain = possible || key === null;
      for (let i = properties.length - 1; i >= 0; i--) {
        const property = properties[i];
        if (Node.isSpreadAssignment(property)) {
          next(property.getExpression(), { possible: true });
          uncertain = true;
          continue;
        }
        const name = property.getNameNode();
        const member = Node.isIdentifier(name) ? name.compilerNode.text :
          lookupKey(Node.isComputedPropertyName(name) ? name.getExpression() : name);
        if (member !== undefined && (covered.has(member) || key !== null && member !== key)) continue;
        next(property, { members: rest, possible: uncertain || member === undefined,
          lookup: lookup && key === null && lookup.member === undefined ? { ...lookup, member } : lookup });
        if (member === undefined) uncertain = true;
        else if (key !== null) return;
        else covered.add(member);
      }
      return;
    }
    if (Node.isPropertyAssignment(node) || Node.isPropertyDeclaration(node)) return next(node.getInitializer());
    if (Node.isShorthandPropertyAssignment(node)) {
      node.getValueSymbol()?.getDeclarations().forEach(target => next(target));
      return;
    }
    if (Node.isCallExpression(node) && !returns) {
      const expression = node.getExpression();
      if (!members.length && indexedLoader?.(node)) return register(node, step);
      const collection = collectionCall(node);
      if (collection?.kind === 'element') {
        const key = collection.method === 'at' ? tupleAt(collection.receiver, node.getArguments()[0]) : undefined;
        return next(collection.receiver, { members: [key ?? null, ...members], possible: possible || key === undefined });
      }
      if (collection && members.length) {
        const [, ...rest] = members;
        if (collection.kind === 'object') {
          if (collection.method === 'values') return next(collection.receiver, { members: [null, ...rest], possible: true });
          const [entry, ...value] = rest;
          // Object.entries yields [key, value]; only the value can be a component.
          if (entry === undefined || entry === '0') return true;
          if (entry === '1' || entry === null || entry === allArrayElements) {
            return next(collection.receiver, { members: [null, ...value], possible: true });
          }
          return;
        }
        if (collection.kind === 'transform') {
          const callback = functionNode(collection.callback);
          if (!callback || !files.has(callback.getSourceFile())) return;
          const [parameter] = callback.getParameters();
          const arrayBinding = parameter && collection.receiver ? { parameter, receiver: collection.receiver, outer: binding } : binding;
          const values = returnedValues(callback);
          for (const value of values) {
            const choice = { possible: true, conditional: conditional || values.length > 1 || !!conditionalAt(value, callback),
              binding: arrayBinding };
            const type = collection.method === 'flatMap' ? value.getType() : undefined;
            const array = type && isArrayExpression(value);
            if (array || type?.isAny() || type?.isUnknown() ||
                type?.getUnionTypes().some(member => member.isArray() || member.isTuple())) {
              next(value, { ...choice, members: [allArrayElements, ...rest] });
            }
            if (!array) next(value, { ...choice, members: rest });
          }
          return;
        }
        next(collection.receiver, { members: [null, ...rest], possible: true });
        if (collection.method === 'concat') for (const argument of node.getArguments()) {
          const value = Node.isSpreadElement(argument) ? argument.getExpression() : argument;
          const lookup = Node.isSpreadElement(argument) || isArrayExpression(value) ? [null, ...rest] : rest;
          next(value, { members: lookup, possible: true });
        }
        return;
      }
      const hook = packageMember(expression, 'react');
      if (hook === 'useState' && members.length) {
        const [key, ...rest] = members;
        if (key !== '0' && key !== null && key !== allArrayElements) return true;
        const initial = node.getArguments()[0];
        const initialize = functionNode(initial);
        return next(initialize ?? initial, { members: rest, possible: true, returns: !!initialize });
      }
      if (hook === 'useCallback' || hook === 'useMemo') {
        return next(node.getArguments()[0], { returns: hook === 'useMemo' });
      }
      const resolved = next(expression, { returns: true });
      if (!resolved && !members.length && !isComponentWrapper(node) && hook !== 'lazy' &&
          !packageMember(expression, 'next/dynamic')) opaqueLookups.add(node);
      return;
    }
    if (Node.isConditionalExpression(node)) {
      const choice = contextTruth?.(node.getCondition());
      const yes = step.contextExcluded || (choice === false ? true : undefined);
      const no = step.contextExcluded || (choice === true ? true : undefined);
      next(node.getWhenTrue(), { conditional: true, contextExcluded: yes });
      next(node.getWhenFalse(), { conditional: true, contextExcluded: no });
      return;
    }
    if (Node.isBinaryExpression(node)) {
      const operator = node.getOperatorToken().getKind();
      if (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken) {
        next(node.getLeft(), { conditional: true });
      }
      if (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken ||
          operator === SyntaxKind.AmpersandAmpersandToken) {
        return next(node.getRight(), { conditional: true });
      }
    }
    if (Node.isElementAccessExpression(node)) {
      const selector = node.getArgumentExpression();
      const key = lookupKey(selector);
      const resolved = next(node.getExpression(), { members: [key ?? null, ...members],
        lookup: indexedLoader && key === undefined && selector ? { selector } : lookup });
      if (!resolved) opaqueLookups.add(node);
      return resolved;
    }
    if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
      if (!returns && !members.length && externalImport(node, files)) return Resolution.External;
      if (Node.isIdentifier(node) && members.length &&
          node.getSymbol()?.getDeclarations().some(Node.isNamespaceImport)) {
        const source = importBinding(node)?.declaration.getModuleSpecifierSourceFile();
        if (source && files.has(source)) {
          const [key, ...rest] = members;
          if (key === allArrayElements) return;
          const choice = { ...step, members: rest, possible: possible || key === null };
          let known = false;
          for (const symbol of source.getExportSymbols()) {
            if (key !== null && key !== symbol.getName() || isTypeOnlyExport(source, symbol)) continue;
            for (const declaration of (symbol.getAliasedSymbol() ?? symbol).getDeclarations()) {
              if (!returns && !rest.length && indexedComponent(declaration)) {
                register(declaration, choice);
                known = true;
              } else next(declaration, choice);
            }
          }
          return known ? Resolution.Local : undefined;
        }
      }
      const prop = flow && !supply && members.length ? flow.read(node) : undefined;
      if (flow && prop) {
        const bindings = flow.values(prop);
        unresolvedProp ||= !bindings.length;
        for (const { site, value, unknown } of bindings) {
          let names = supplies.get(site);
          if (!names) supplies.set(site, names = new Map());
          let source = names.get(prop.name);
          if (!source) names.set(prop.name, source = { site, name: prop.name });
          const uncertain = !!unknown || (Node.isJsxOpeningElement(site) || Node.isJsxSelfClosingElement(site)) &&
            flow.lookupUncertain(site);
          const resolved = next(value, { supply: source, possible: possible || uncertain });
          unresolvedProp ||= uncertain || !resolved;
        }
        return;
      }
      const declarations = declarationsOf(node);
      const typeMember = declarations.some(target => Node.isPropertySignature(target) || Node.isPropertyDeclaration(target));
      if (Node.isPropertyAccessExpression(node) && (!declarations.length || typeMember ||
          declarations.some(target => Node.isPropertyAssignment(target) || Node.isShorthandPropertyAssignment(target)))) {
        // Resolve literal properties against the object so access through a
        // dynamic outer lookup retains that lookup's uncertainty.
        const guarded = conditional || node.hasQuestionDotToken();
        const key = node.getName();
        if (next(node.getExpression(), { members: [key, ...members], conditional: guarded })) return;
        let resolved = false;
        for (const target of declarations) {
          resolved = next(target, { possible: true, conditional: guarded }) || resolved;
          const siblings = Node.isPropertyAssignment(target) && arrayContaining(target);
          if (!siblings) continue;
          for (const element of siblings.array.getElements()) {
            if (element === siblings.object) continue;
            const spread = Node.isSpreadElement(element);
            const lookup: Member[] = spread ? [allArrayElements, key, ...members] : [key, ...members];
            resolved = next(spread ? element.getExpression() : element,
              { members: lookup, possible: true, conditional: guarded }) || resolved;
          }
        }
        unresolvedLookup ||= typeMember && !resolved;
        return;
      }
      declarations.forEach(target => next(target));
      return;
    }
    next(wrappedExpression(node));
  };
  const initial = { members: [], returns: false, possible: false, conditional: false };
  declarations.forEach(node => resolve(node, initial, 40));
  return {
    targets: [...targets].flatMap(([supply, scoped]) =>
      [...scoped].map(([target, certainty]) => ({ target, supply, ...certainty }))),
    unresolvedLookup: unresolvedLookup || unresolvedProp,
    opaqueLookups
  };
}
