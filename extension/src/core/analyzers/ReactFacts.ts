import { Node, SyntaxKind, ts, type CallExpression, type SourceFile } from 'ts-morph';
import type { DetailFact, FetchEntry } from '../../mcp/Index';
import { visitKinds } from './CompilerWalk';
import { expressionLabel, constInitializer, literalLabel, objectFields, unwrapFact } from './FactSyntax';
import { jsxValue, PropFlow, type JsxSite } from './PropFlow';
import { startLine } from './SourceLines';
import { functionNode, importBinding } from './StaticBindings';
import { jsxLabel } from './CallableFlow';

type IndexedRequest = Pick<FetchEntry, 'url' | 'method' | 'via' | 'partial' | 'propUrlUnknown'>;
type State = { name: string; setter: string; owner: number; writes: Write[]; effects: string[] };
type Write = { call: CallExpression; fn?: Node; label: string };
type Call = { node: CallExpression; fn?: Node };
type Request = { call: CallExpression; fn?: Node; method: string; url: string; via: string; body?: Node; partial?: boolean };
const callKind = new Set([SyntaxKind.CallExpression]);
const apiUrl = /^\/api(?:\/|$)/;

function enclosingFunction(node: Node) {
  return node.getFirstAncestor(parent => Node.isFunctionLikeDeclaration(parent) || Node.isFunctionExpression(parent));
}

function functionName(node: Node | undefined): string {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) return node.getName() ?? '<anonymous>';
  const declaration = node?.getParent();
  if (Node.isVariableDeclaration(declaration)) return declaration.getName();
  if (Node.isCallExpression(declaration) && importBinding(declaration.getExpression())?.module === 'react') {
    const binding = declaration.getParent();
    if (Node.isVariableDeclaration(binding)) return binding.getName();
  }
  return '<inline>';
}

function hookName(node: Node, packageName: string) {
  const origin = importBinding(node);
  return origin?.module === packageName ? origin.name : undefined;
}

function binding(node: Node | undefined) {
  if (Node.isShorthandPropertyAssignment(node?.getParent())) {
    return node?.getParentIfKindOrThrow(SyntaxKind.ShorthandPropertyAssignment).getValueSymbol()?.getDeclarations()[0];
  }
  return node?.getSymbol()?.getDeclarations()[0];
}

function resolveFunction(node: Node | undefined) {
  return functionNode(Node.isShorthandPropertyAssignment(node?.getParent()) ? binding(node) : node);
}

function expressionRoot(node: Node | undefined): Node | undefined {
  node = unwrapFact(node);
  if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) return expressionRoot(node.getExpression());
  if (Node.isBinaryExpression(node) && [SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken].includes(node.getOperatorToken().getKind())) {
    return expressionRoot(node.getLeft());
  }
  return Node.isIdentifier(node) ? node : undefined;
}

function earlyExitGuard(node: Node) {
  for (let statement: Node | undefined = node; statement; statement = statement.getParent()) {
    if (Node.isFunctionLikeDeclaration(statement) || Node.isFunctionExpression(statement)) break;
    const parent = statement.getParent();
    if (!Node.isBlock(parent)) continue;
    const siblings = parent.getStatements();
    for (let i = siblings.indexOf(statement as typeof siblings[number]) - 1; i >= 0; i--) {
      const prior = siblings[i];
      if (!Node.isIfStatement(prior) || prior.getElseStatement()) continue;
      const branch = prior.getThenStatement();
      const tail = Node.isBlock(branch) ? branch.getStatements().at(-1) : branch;
      if (Node.isReturnStatement(tail) || Node.isThrowStatement(tail)) return ' after guard ' + expressionLabel(prior.getExpression()) + ' exits';
    }
  }
  return '';
}

export class ReactFacts {
  static appliesTo(file: SourceFile) {
    const text = file.compilerNode.text;
    return text.includes('useState') || text.includes('useEffect') ||
      text.includes('useDropzone') || text.includes('XMLHttpRequest');
  }

  private states = new Map<Node, State>();
  private setters = new Map<Node, State>();
  private requests: Request[] = [];
  private writesByFunction = new Map<Node, Write[]>();
  private readonly directCalls: CallExpression[] = [];
  private readonly callsByFunction = new Map<Node, CallExpression[]>();
  private readonly effectCalls: CallExpression[] = [];
  private readonly dropzones: CallExpression[] = [];
  private readonly settersNames = new Set<string>();
  private readonly stateNames = new Set<string>();
  private readonly requestCandidates: Call[] = [];
  private readonly formAppends: CallExpression[] = [];
  private readonly xhrSends: Call[] = [];
  private readonly filters: CallExpression[] = [];

  constructor(private file: SourceFile, private relative: string, private flow: PropFlow,
    private ownerOf: (node: Node) => number | undefined,
    private addFact: (owner: number, fact: DetailFact) => void,
    private indexedRequests: ReadonlyMap<Node, IndexedRequest[]>,
    private addRequest: (request: Request, fact: DetailFact, owner: number) => void) {}

  collect() {
    const text = this.file.compilerNode.text;
    const hasXhr = text.includes('XMLHttpRequest');
    const imports = this.file.getImportDeclarations().filter(entry => ['react', 'react-dropzone'].includes(entry.getModuleSpecifierValue()));
    if (!imports.length && !hasXhr) return false;
    const maybeHooks = new Set(['useState', 'useEffect', 'useDropzone']);
    for (const entry of imports) for (const specifier of entry.getNamedImports()) {
      if (maybeHooks.has(specifier.getName())) maybeHooks.add(specifier.getAliasNode()?.getText() ?? specifier.getName());
    }
    const memberCandidates = new Set(['append', 'set', 'open', 'send', 'filter', ...maybeHooks]);
    visitKinds(this.file, callKind, node => {
      if (!Node.isCallExpression(node)) return;
      const expression = node.getExpression();
      const name = Node.isIdentifier(expression) ? expression.getText() : Node.isPropertyAccessExpression(expression) ? expression.getName() : '';
      if (!Node.isIdentifier(expression) && !memberCandidates.has(name) && !/^on[A-Z]/.test(name)) return;
      if (maybeHooks.has(name)) {
        const hook = hookName(expression, 'react');
        if (hook === 'useState') this.state(node);
        else if (hook === 'useEffect') this.effectCalls.push(node);
        else if (hookName(expression, 'react-dropzone') === 'useDropzone') this.dropzones.push(node);
      }
      const request = this.indexedRequests.has(node);
      if (Node.isIdentifier(expression) || /^on[A-Z]/.test(name)) this.directCalls.push(node);
      if (request || hasXhr && name === 'open') this.requestCandidates.push({ node, fn: enclosingFunction(node) });
      if (hasXhr && name === 'send') this.xhrSends.push({ node, fn: enclosingFunction(node) });
      if (name === 'append' || name === 'set') this.formAppends.push(node);
      if (name === 'filter') this.filters.push(node);
    }, { filterRaw: node => ts.isCallExpression(node) && (ts.isIdentifier(node.expression) ||
      ts.isPropertyAccessExpression(node.expression) &&
        (memberCandidates.has(node.expression.name.text) || /^on[A-Z]/.test(node.expression.name.text))) });
    for (const call of this.directCalls) this.recordStateAndPropCall(call);
    for (const call of this.requestCandidates) this.recordRequest(call);
    for (const request of this.requests) this.indexRequest(request);
    for (const effect of this.effectCalls) this.recordEffect(effect);
    for (const dropzone of this.dropzones) this.recordDropzone(dropzone);
    for (const node of this.filters) {
      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || !this.stateOf(callee.getExpression())) continue;
      this.add(this.ownerOf(node), node, functionName(enclosingFunction(node)) + ' reads state via ' + expressionLabel(node),
        'filter result evaluated at runtime');
    }
    return this.states.size > 0 || this.effectCalls.length > 0 || this.dropzones.length > 0;
  }

  private add(owner: number | undefined, node: Node, text: string, partial?: string) {
    if (owner !== undefined) this.addFact(owner, [this.relative, startLine(node), text, partial]);
  }

  private state(call: CallExpression) {
    const declaration = call.getParent();
    const owner = this.ownerOf(call);
    if (owner === undefined) return;
    const pattern = Node.isVariableDeclaration(declaration) && (declaration.compilerNode.parent.flags & ts.NodeFlags.Const)
      ? declaration.getNameNode() : undefined;
    const [value, update] = Node.isArrayBindingPattern(pattern) ? pattern.getElements() : [];
    if (!Node.isBindingElement(value) || !Node.isBindingElement(update) || !Node.isIdentifier(value.getNameNode()) ||
        !Node.isIdentifier(update.getNameNode()) || value.getInitializer() || update.getInitializer() ||
        value.getDotDotDotToken() || update.getDotDotDotToken()) {
      this.add(owner, call, 'useState binding', 'state and setter bindings unresolved');
      return;
    }
    const state = { name: value.getName(), setter: update.getName(), owner, writes: [], effects: [] };
    this.states.set(value, state);
    this.setters.set(update, state);
    this.settersNames.add(state.setter);
    this.stateNames.add(state.name);
    const initializer = call.getArguments()[0];
    const label = literalLabel(initializer);
    this.add(owner, call, 'state ' + state.name + ' ← useState(' + (label ?? expressionLabel(initializer)) + ')' +
      ' setter ' + state.setter, label === undefined ? 'state initial value unresolved' : undefined);
  }

  private stateOf(node: Node | undefined) {
    const root = expressionRoot(node);
    if (!root || !this.stateNames.has(root.getText())) return;
    const declaration = binding(root);
    return declaration && this.states.get(declaration);
  }

  private setterOf(node: Node | undefined) {
    if (!Node.isIdentifier(node) || !this.settersNames.has(node.getText())) return;
    const declaration = binding(node);
    return declaration && this.setters.get(declaration);
  }

  private recordStateAndPropCall(node: CallExpression) {
    const callee = node.getExpression();
    const setter = this.setterOf(callee);
    if (setter) {
      const fn = enclosingFunction(node);
      const write = { call: node, fn, label: expressionLabel(node) };
      setter.writes.push(write);
      if (fn) {
        const writes = this.writesByFunction.get(fn) ?? [];
        writes.push(write);
        this.writesByFunction.set(fn, writes);
      }
      this.add(setter.owner, node, 'set ' + setter.name + ' in ' + functionName(fn) + ' via ' + write.label,
        literalLabel(node.getArguments()[0]) === undefined ? 'setter value evaluated at runtime' : undefined);
      return;
    }
    const name = Node.isIdentifier(callee) ? callee.getText() : Node.isPropertyAccessExpression(callee) ? callee.getName() : '';
    if (/^on[A-Z]/.test(name) && this.flow.read(callee)) {
      this.add(this.ownerOf(node), node, functionName(enclosingFunction(node)) + ' calls prop ' + expressionLabel(node) + earlyExitGuard(node),
        'callback execution depends on the caller and control flow');
    }
  }

  private recordRequest({ node, fn }: Call) {
    const facts = this.indexedRequests.get(node);
    const callee = node.getExpression();
    if (facts?.length && facts.some(entry => entry.via === 'fetch')) {
      const options = node.getArguments()[1];
      const properties = objectFields(constInitializer(options) ?? options);
      const body = properties?.fields.find(field => field.key === 'body')?.value;
      for (const { method, url, partial, propUrlUnknown } of facts) {
        this.requests.push({ call: node, fn, method, url, via: 'fetch', body,
          partial: !!(method === '?' || partial || propUrlUnknown || properties?.opaque || options && !properties) });
      }
    } else if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'open') {
      const receiver = callee.getExpression();
      if (!builtInInstance(receiver, 'XMLHttpRequest')) return;
      const [method, url] = node.getArguments();
      if (!Node.isStringLiteral(method) || !Node.isStringLiteral(url) || !apiUrl.test(url.getLiteralText())) {
        this.add(this.ownerOf(node), node, 'XMLHttpRequest.open(' + expressionLabel(method) + ', ' + expressionLabel(url) + ')',
          'request method or URL unresolved');
        return;
      }
      const xhr = binding(receiver);
      const sends = this.xhrSends.filter(({ node, fn: enclosing }) => {
        const expression = node.getExpression();
        return enclosing === fn && Node.isPropertyAccessExpression(expression) && binding(expression.getExpression()) === xhr;
      });
      const send = sends.length === 1 && sends[0].node.getStart() > node.getStart() ? sends[0].node : undefined;
      this.requests.push({ call: node, fn, method: method.getLiteralText().toUpperCase(), url: url.getLiteralText(),
        via: send ? 'XMLHttpRequest.open → send' : 'XMLHttpRequest.open', body: send?.getArguments()[0], partial: !send });
    }
  }

  private indexRequest(request: Request) {
    const { call, fn, method, url, via, body } = request;
    const name = functionName(fn);
    let text = (name === '<inline>' && fn ? functionName(enclosingFunction(fn)) + ' ' + name : name) +
      ' → ' + method + ' ' + url + ' via ' + via;
    let partial = request.partial ? 'request binding unresolved' : undefined;
    const serialization = unwrapFact(constInitializer(body) ?? body);
    const stringify = Node.isCallExpression(serialization) ? serialization.getExpression() : undefined;
    if (Node.isCallExpression(serialization) && Node.isPropertyAccessExpression(stringify) &&
        stringify.getName() === 'stringify' && isGlobal(stringify.getExpression(), 'JSON')) {
      const payload = serialization.getArguments()[0];
      const properties = objectFields(constInitializer(payload) ?? payload);
      if (properties) {
        text += ' JSON fields { ' + properties.fields.map(({ key, value }) => {
          const state = this.stateOf(value);
          return key + ': ' + expressionLabel(value) + (state ? ' [state ' + state.name + ']' : '');
        }).join(', ') + ' }';
        if (properties.opaque) partial = 'request body keys unresolved';
        else if (properties.fields.some(({ value }) => literalLabel(value) === undefined)) partial ??= 'request values evaluated at runtime';
      } else partial = 'request body shape unresolved';
    } else if (body && builtInInstance(body, 'FormData')) {
      const form = binding(body);
      const fields = this.formAppends.flatMap(node => {
        if (node.getStart() > call.getStart()) return [];
        const callee = node.getExpression();
        if (!Node.isPropertyAccessExpression(callee) || binding(callee.getExpression()) !== form) return [];
        const [key, value] = node.getArguments();
        const branch = node.getFirstAncestor(Node.isIfStatement);
        const guard = branch && branch.getThenStatement().containsRange(node.getPos(), node.getEnd())
          ? ' if ' + expressionLabel(branch.getExpression()) : '';
        return [expressionLabel(key) + ': ' + expressionLabel(value) + guard];
      });
      text += ' FormData { ' + fields.join(', ') + ' }';
      partial ??= 'multipart values and execution order depend on runtime';
    } else if (body) {
      text += ' body ' + expressionLabel(body);
      partial ??= 'request body shape unresolved';
    }
    const owner = this.ownerOf(call);
    this.add(owner, call, text, partial);
    if (owner !== undefined) this.addRequest(request, [this.relative, startLine(call), text, partial], owner);
  }

  private recordEffect(effect: CallExpression) {
    const [callback, dependencies] = effect.getArguments().map(unwrapFact);
    const owner = this.ownerOf(effect);
    const fn = resolveFunction(callback);
    if (!Node.isArrayLiteralExpression(dependencies) || !fn) {
      this.add(owner, effect, 'useEffect dependencies ' + expressionLabel(dependencies), 'effect callback or dependencies unresolved');
      return;
    }
    const deps = dependencies.getElements();
    const calls = this.callsOf(fn);
    const effects: string[] = [];
    for (const node of calls) {
      const callee = node.getExpression();
      if (!Node.isIdentifier(callee) || this.setterOf(callee)) continue;
      const target = resolveFunction(callee);
      const requests = this.requests.filter(request => request.fn === fn && request.call === node || target && request.fn === target);
      if (target || requests.length) {
        effects.push(expressionLabel(callee) + (requests.length ? ' → ' +
          requests.map(({ method, url }) => method + ' ' + url).join(', ') : ''));
      }
    }
    const detail = 'useEffect ' + expressionLabel(dependencies) + (effects.length ? ' → ' + effects.join(', ') : '');
    this.add(owner, effect, detail, calls.length > effects.length || deps.some(Node.isSpreadElement)
      ? 'effect calls or dependencies unresolved' : undefined);
    for (const dep of deps) {
      const state = this.stateOf(dep);
      if (state && Node.isIdentifier(dep)) state.effects.push(detail + ' @' + startLine(effect));
    }
  }

  private recordDropzone(call: CallExpression) {
    const options = objectFields(call.getArguments()[0]);
    const onDrop = options?.fields.find(field => field.key === 'onDrop')?.value;
    const declaration = constInitializer(onDrop);
    const fn = Node.isCallExpression(declaration) && hookName(declaration.getExpression(), 'react') === 'useCallback'
      ? functionNode(declaration.getArguments()[0]) : resolveFunction(onDrop);
    const sends = this.localCalls(fn);
    const writes = fn ? this.writesByFunction.get(fn) ?? [] : [];
    const updates = writes.map(({ call, label }) => {
      // Follow the local values captured by an updater sufficiently to expose
      // literal queue statuses without treating its expression as a fixed result.
      const argument = call.getArguments()[0];
      const fields: string[] = [];
      if (argument) visitKinds(argument, new Set([SyntaxKind.Identifier]), node => {
        if (!Node.isIdentifier(node) || !Node.isSpreadElement(node.getParent())) return;
        const value = constInitializer(node);
        if (!Node.isCallExpression(value) || !value.getText().includes('status')) return;
        visitKinds(value, new Set([SyntaxKind.PropertyAssignment]), property => {
          if (Node.isPropertyAssignment(property) && property.getName() === 'status') {
            const status = literalLabel(property.getInitializer());
            if (status !== undefined) fields.push('status: ' + status);
          }
        });
      }, { filterRaw: node => ts.isIdentifier(node) && node.parent.kind === SyntaxKind.SpreadElement });
      return label + (fields.length ? ' (' + [...new Set(fields)].join(', ') + ')' : '');
    });
    this.add(this.ownerOf(call), call, 'useDropzone onDrop={' + expressionLabel(onDrop) + '}' +
      (updates.length || sends.length ? ' → ' + [...updates, ...sends].join(' → ') : ''),
    'drop handler coverage is limited to direct calls and setters');
  }

  private callsOf(fn: Node) {
    const cached = this.callsByFunction.get(fn);
    if (cached) return cached;
    const calls: CallExpression[] = [];
    const body = functionNode(fn)?.getBody();
    if (body) {
      if (Node.isCallExpression(body)) calls.push(body);
      visitKinds(body, callKind, node => {
        if (Node.isCallExpression(node)) calls.push(node);
      }, { skipNode: node => ts.isFunctionLike(node) || ts.isClassLike(node) });
    }
    this.callsByFunction.set(fn, calls);
    return calls;
  }

  private localCalls(fn: Node | undefined) {
    if (!fn) return [];
    return this.callsOf(fn).flatMap(node => {
      const callee = node.getExpression();
      const target = Node.isIdentifier(callee) && resolveFunction(callee);
      return target && target.getSourceFile() === this.file ? [expressionLabel(node)] : [];
    });
  }

  render(site: JsxSite, ownerName: string, indexedTarget: boolean) {
    const found: DetailFact[] = [];
    const stateProps = new Map<State, { attr: Node; props: string[]; computed: boolean }>();
    const tag = site.getTagNameNode().getText();
    const prefix = '<' + tag + '> in ' + ownerName + ' ';
    for (const attr of site.getAttributes()) {
      if (Node.isJsxSpreadAttribute(attr)) {
        found.push([this.relative, startLine(attr), prefix + 'spread {' + expressionLabel(attr.getExpression()) + '}', 'spread props unresolved']);
        continue;
      }
      const prop = attr.getNameNode().getText();
      const value = unwrapFact(jsxValue(attr));
      const state = this.stateOf(value);
      const setter = this.setterOf(value);
      if (state) {
        const entry = stateProps.get(state) ?? { attr, props: [], computed: false };
        entry.props.push(prop + '={' + expressionLabel(value) + '}');
        entry.computed ||= !Node.isIdentifier(value);
        stateProps.set(state, entry);
      } else if (setter) {
        found.push([this.relative, startLine(attr), prefix + prop + '={' + setter.setter + '} → state ' + setter.name]);
      } else if (prop === 'open' || /^on[A-Z]/.test(prop)) {
        const fn = resolveFunction(value);
        const writes = fn ? this.writesByFunction.get(fn) ?? [] : [];
        const calls = prop === 'onClick' ? this.localCalls(fn) : [];
        if (writes.length || calls.length) {
          const steps = writes.flatMap(write => {
            const state = this.setterOf(write.call.getExpression())!;
            const text = state.name + ' via ' + write.label + ' @' + startLine(write.call);
            return [text, ...state.effects];
          });
          const label = prop === 'onClick' ? '<' + jsxLabel(site) + '> in ' + ownerName + ' ' : prefix;
          const trail = (steps.length ? steps : calls).join(' → ');
          const otherCalls = steps.length && calls.length ? ' | calls ' + calls.join(', ') : '';
          found.push([this.relative, startLine(attr), label + prop + '={' + expressionLabel(value) + '} → ' + trail + otherCalls,
            calls.length || writes.some(({ call }) => literalLabel(call.getArguments()[0]) === undefined)
            ? 'callback calls or setter values depend on runtime' : undefined]);
        } else if (indexedTarget && prop !== 'onClick' && (value || prop === 'open')) {
          const literal = !value && prop === 'open' ? 'true' : literalLabel(value);
          found.push([this.relative, startLine(attr), prefix + prop + '={' + (literal ?? expressionLabel(value)) + '}',
            literal === undefined ? 'prop binding or callback handoff unresolved' : undefined]);
        }
      }
    }
    for (const [state, { attr, props, computed }] of stateProps) {
      // Keep a bounded witness per render. The owner's query lists additional setters.
      const updates = state.writes.slice(0, 3);
      const evidence = updates.map(write => functionName(write.fn) + ' → ' + state.setter +
        '(' + expressionLabel(write.call.getArguments()[0]) + ') @' + startLine(write.call));
      const more = state.writes.length - updates.length;
      const reason = more ? 'additional setter sites in owner facts' : !updates.length || computed ||
        updates.some(({ call }) => literalLabel(call.getArguments()[0]) === undefined)
        ? 'state handoff contains runtime expressions' : undefined;
      found.push([this.relative, startLine(attr), prefix + props.join(' ') + ' ← state ' + state.name +
        (evidence.length ? ' via ' + evidence.join(', ') : '') + (more ? ' (+' + more + ' setter sites)' : ''), reason]);
    }
    found.sort((a, b) => a[1] - b[1]);
    return found;
  }
}

function builtInInstance(receiver: Node, name: string) {
  const initializer = constInitializer(receiver);
  return Node.isNewExpression(initializer) && isGlobal(initializer.getExpression(), name);
}

function isGlobal(node: Node, name: string) {
  return Node.isIdentifier(node) && node.getText() === name &&
    (node.getSymbol()?.getDeclarations() ?? []).every(declaration => declaration.getSourceFile().isDeclarationFile());
}
