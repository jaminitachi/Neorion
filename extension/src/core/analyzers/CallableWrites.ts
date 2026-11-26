import { Node, SyntaxKind, ts, type SourceFile } from 'ts-morph';
import { wrappedExpression } from './ArchitectureFacts';
import type { CallableReferences } from './CallableReferences';
import { visitKinds } from './CompilerWalk';

export function staticMember(node: Node | undefined, identifier = true): string | undefined {
  if (Node.isIdentifier(node) && identifier) return node.getText();
  if (Node.isStringLiteral(node) || Node.isNumericLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return String(node.getLiteralValue());
  }
}

export function bindingSelection<T extends Member>(binding: import('ts-morph').BindingElement, members: T[]): (T | string)[] | undefined {
  const pattern = binding.getParent();
  if (!binding.getDotDotDotToken()) {
    const name = Node.isArrayBindingPattern(pattern) ? String(pattern.getElements().indexOf(binding)) :
      staticMember(binding.getPropertyNameNode() ?? binding.getNameNode());
    if (name !== undefined) return [name, ...members];
    return;
  }
  const [member, ...rest] = members;
  if (!members.length) return;
  if (Node.isArrayBindingPattern(pattern)) {
    const index = Number(member);
    if (member === undefined) return [member, ...rest];
    if (String(index) === member && index >= 0 && Number.isInteger(index)) {
      return [String(index + pattern.getElements().indexOf(binding)), ...rest];
    }
    return;
  }
  if (pattern.getElements().some(element => {
    if (element === binding) return false;
    const name = element.getPropertyNameNode() ?? element.getNameNode();
    return Node.isComputedPropertyName(name) || staticMember(name) === member && member !== undefined;
  })) return;
  return members;
}

type Member = string | undefined;
type Write = { site: Node; path: Member[] };
type Parameter = import('ts-morph').ParameterDeclaration;
type ParameterWrite = Write & { parameter: Parameter; order: number };
type ProjectedWrite = Write & { depth: number; order: number };
type WriteSink = (binding: Node, path: Member[], site: Node) => void;
type ParameterSink = (parameter: Parameter, path: Member[], site: Node) => void;
const writeKinds = new Set([
  SyntaxKind.BinaryExpression, SyntaxKind.PrefixUnaryExpression, SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.DeleteExpression, SyntaxKind.ForInStatement, SyntaxKind.ForOfStatement, SyntaxKind.CallExpression
]);
const objectMutators = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']);
const reflectMutators = new Set(['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf']);
const arrayMutators = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift']);

function matchingPath(write: Member[], read: readonly Member[]) {
  return write.length <= read.length && write.every((member, index) =>
    member === undefined || read[index] === undefined || member === read[index]);
}

function sameWrite(write: Write, path: Member[], site: Node) {
  return write.site === site && write.path.length === path.length &&
    write.path.every((member, index) => member === path[index]);
}

function isWriteOperation(node: ts.Node) {
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    return op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken;
  }
  if (ts.isCallExpression(node)) {
    return ts.isPropertyAccessExpression(node.expression) &&
      (objectMutators.has(node.expression.name.text) || reflectMutators.has(node.expression.name.text) ||
       arrayMutators.has(node.expression.name.text));
  }
  return ts.isDeleteExpression(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
}

export function staticallyUnreachable(site: Node) {
  for (let child = site.compilerNode, parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && child !== parent.expression || ts.isConditionalExpression(parent) && child !== parent.condition) {
      const condition = ts.isIfStatement(parent) ? parent.expression : parent.condition;
      const positive = ts.isIfStatement(parent) ? parent.thenStatement : parent.whenTrue;
      if (condition.kind === SyntaxKind.FalseKeyword && child === positive ||
          condition.kind === SyntaxKind.TrueKeyword && child !== positive) return true;
    }
    if (ts.isBlock(parent) && ts.isStatement(child)) {
      for (const previous of parent.statements) {
        if (previous === child) break;
        if (ts.isReturnStatement(previous) || ts.isThrowStatement(previous) ||
            ts.isBreakStatement(previous) || ts.isContinueStatement(previous)) return true;
      }
    }
    if (ts.isFunctionLike(parent)) break;
  }
  return false;
}

/** Writes are keyed by the declaration of the receiver, including aliases to the same object. */
export class CallableWrites {
  private writes?: WeakMap<Node, Write[]>;
  private parameterWrites = new Map<Member, ParameterWrite[]>();
  private projected = new Map<Member, WeakMap<Node, ProjectedWrite[]>>();
  private parameterArguments = new WeakMap<Parameter, Node[]>();
  private readWrites = new WeakMap<Node, Node | null>();
  private arrayReceivers = new WeakMap<Node, Node>();
  private arrayWrites = new WeakMap<Node, boolean>();

  constructor(private files: Set<SourceFile>, private declarations: (node: Node) => Node[], private references: CallableReferences) {}

  private collect() {
    const writes = new WeakMap<Node, Write[]>();
    let order = 0;
    const addParameter: ParameterSink = (parameter, path, site) => {
      const member = path[path.length - 1];
      const entries = this.parameterWrites.get(member) ?? [];
      entries.push({ parameter, path, site, order: order++ });
      this.parameterWrites.set(member, entries);
    };
    const addWrite: WriteSink = (binding, path, site) => {
      const entries = writes.get(binding) ?? [];
      if (entries.some(entry => sameWrite(entry, path, site))) return;
      entries.push({ path, site });
      writes.set(binding, entries);
      if (path.length && Node.isParameterDeclaration(binding)) addParameter(binding, path, site);
    };
    const record = (target: Node, path: Member[], site: Node) => this.record(target, path, site, addWrite, addParameter);
    for (const file of this.files) visitKinds(file, writeKinds, node => {
      if (staticallyUnreachable(node)) return;
      if (Node.isBinaryExpression(node)) record(node.getLeft(), [], node);
      else if (Node.isForInStatement(node) || Node.isForOfStatement(node)) record(node.getInitializer(), [], node);
      else if (Node.isCallExpression(node)) this.mutatingCall(node, record);
      else if (Node.isDeleteExpression(node)) record(node.getExpression(), [], node);
      else if (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) record(node.getOperand(), [], node);
    }, { filterRaw: isWriteOperation });
    return writes;
  }

  forBinding(binding: Node, members: readonly Member[]) {
    const direct = (this.writes ??= this.collect()).get(binding)
      ?.find(write => matchingPath(write.path, members) && this.isWrite(write.site));
    if (direct || !members.length) return direct?.site;
    const keys = members.includes(undefined) ?
      new Set([...this.parameterWrites.keys(), ...this.projected.keys()]) : new Set([undefined, ...members]);
    let first: ProjectedWrite | undefined;
    for (const key of keys) {
      if (!this.parameterWrites.has(key) && !this.projected.has(key)) continue;
      for (const write of this.project(key).get(binding) ?? []) {
        if (!matchingPath(write.path, members) || !this.isWrite(write.site)) continue;
        if (!first || write.depth < first.depth || write.depth === first.depth && write.order < first.order) first = write;
      }
    }
    return first?.site;
  }

  private project(member: Member) {
    const cached = this.projected.get(member);
    if (cached) return cached;
    const writes = new WeakMap<Node, ProjectedWrite[]>();
    const seeds = this.parameterWrites.get(member) ?? [];
    let current = seeds.map(write => ({ ...write, depth: 0 }));
    const seen = new Map<Parameter, Write[]>();
    for (const { parameter, path, site } of seeds) {
      const entries = seen.get(parameter) ?? [];
      entries.push({ path, site });
      seen.set(parameter, entries);
    }
    // The terminal member survives argument projection, even through destructuring.
    // Resolve only groups that could change a callable read.
    for (let depth = 1; current.length; depth++) {
      const next: (ParameterWrite & ProjectedWrite)[] = [];
      for (const { parameter, path, site, order } of current) {
        const addParameter: ParameterSink = (target, projectedPath, origin) => {
          const entries = seen.get(target) ?? [];
          if (entries.some(entry => sameWrite(entry, projectedPath, origin))) return;
          // A recursive projection can keep adding prefixes to the same write.
          // Callable value resolution has a finite member budget.
          if (projectedPath.length > 64) return;
          entries.push({ path: projectedPath, site: origin });
          seen.set(target, entries);
          next.push({ parameter: target, path: projectedPath, site: origin, depth, order });
        };
        const addWrite: WriteSink = (binding, projectedPath, origin) => {
          const entries = writes.get(binding) ?? [];
          if (entries.some(entry => sameWrite(entry, projectedPath, origin))) return;
          entries.push({ path: projectedPath, site: origin, depth, order });
          writes.set(binding, entries);
          if (Node.isParameterDeclaration(binding)) addParameter(binding, projectedPath, origin);
        };
        for (const argument of this.argumentsAt(parameter)) this.record(argument, path, site, addWrite, addParameter);
      }
      current = next;
    }
    this.projected.set(member, writes);
    this.parameterWrites.delete(member);
    return writes;
  }

  private isWrite(site: Node) {
    const receiver = this.arrayReceivers.get(site);
    if (!receiver) return true;
    let array = this.arrayWrites.get(site);
    if (array === undefined) {
      const type = receiver.getType();
      array = type.isArray() || type.isTuple();
      this.arrayWrites.set(site, array);
    }
    return array;
  }

  forRead(node: Node) {
    if (Node.isIdentifier(node)) {
      for (const binding of this.declarations(node)) {
        const write = this.forBinding(binding, []);
        if (write) return write;
      }
      return;
    }
    const cached = this.readWrites.get(node);
    if (cached !== undefined) return cached ?? undefined;
    const write = this.readWrite(node);
    this.readWrites.set(node, write ?? null);
    return write;
  }

  private readWrite(node: Node) {
    if (!Node.isPropertyAccessExpression(node) && !Node.isElementAccessExpression(node) && !wrappedExpression(node)) return;
    const path: Member[] = [];
    let root = node;
    while (true) {
      const wrapped = wrappedExpression(root);
      if (wrapped) root = wrapped;
      else if (Node.isPropertyAccessExpression(root) || Node.isElementAccessExpression(root)) {
        path.unshift(Node.isPropertyAccessExpression(root) ? root.getName() : staticMember(root.getArgumentExpression(), false));
        root = root.getExpression();
      } else break;
    }
    if (!Node.isIdentifier(root)) return;
    for (const binding of this.declarations(root)) {
      const write = this.forBinding(binding, path);
      if (write) return write;
    }
  }

  private record(target: Node, path: Member[], site: Node, addWrite: WriteSink, addParameter: ParameterSink,
    seen = new Set<Node>()): void {
    if (seen.has(target)) return;
    seen.add(target);
    const inner = wrappedExpression(target);
    if (inner) return this.record(inner, path, site, addWrite, addParameter, seen);
    if (Node.isPropertyAccessExpression(target) || Node.isElementAccessExpression(target)) {
      const member = Node.isPropertyAccessExpression(target) ? target.getName() : staticMember(target.getArgumentExpression(), false);
      return this.record(target.getExpression(), [member, ...path], site, addWrite, addParameter, seen);
    }
    if (target.getKind() === SyntaxKind.ThisKeyword && path.length) {
      const method = target.getFirstAncestor(node => Node.isFunctionLikeDeclaration(node) && !Node.isArrowFunction(node));
      const parent = method?.getParent();
      const receiver = Node.isPropertyAssignment(parent) ? parent.getParent() : parent;
      if (Node.isObjectLiteralExpression(receiver)) addWrite(receiver, path, site);
      return;
    }
    if (Node.isIdentifier(target)) {
      const parent = target.getParent();
      const declarations = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol()?.getDeclarations() ?? [] :
        this.declarations(target);
      for (const binding of declarations) {
        addWrite(binding, path, site);
        if (path.length && Node.isVariableDeclaration(binding)) {
          const value = binding.getInitializer();
          if (value) this.record(value, path, site, addWrite, addParameter, seen);
        }
        if (path.length && Node.isBindingElement(binding)) {
          const declaration = binding.getParent().getParent();
          const value = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
          const selection = bindingSelection(binding, path);
          if (!selection || binding.getDotDotDotToken() && path.length < 2) continue;
          if (value) this.record(value, selection, site, addWrite, addParameter, seen);
          else if (Node.isParameterDeclaration(declaration)) {
            addParameter(declaration, selection, site);
          }
        }
      }
      return;
    }
    if (Node.isConditionalExpression(target)) {
      this.record(target.getWhenTrue(), path, site, addWrite, addParameter, new Set(seen));
      this.record(target.getWhenFalse(), path, site, addWrite, addParameter, seen);
    } else if (Node.isObjectLiteralExpression(target) || Node.isArrayLiteralExpression(target)) {
      const [member, ...rest] = path;
      if (Node.isObjectLiteralExpression(target)) for (const property of target.getProperties()) {
        const name = Node.isSpreadAssignment(property) ? undefined : staticMember(property.getNameNode());
        const value = Node.isPropertyAssignment(property) ? property.getInitializer() :
          Node.isShorthandPropertyAssignment(property) ? property.getNameNode() :
          Node.isSpreadAssignment(property) ? property.getExpression() : undefined;
        if (!value) continue;
        if (!path.length) this.record(value, [], site, addWrite, addParameter, new Set(seen));
        else if (Node.isSpreadAssignment(property) && rest.length) this.record(value, path, site, addWrite, addParameter, new Set(seen));
        else if (rest.length && (member === undefined || name === member)) this.record(value, rest, site, addWrite, addParameter, new Set(seen));
      }
      else target.getElements().forEach((element, index) => {
        if (!path.length || rest.length && (member === undefined || member === String(index))) {
          this.record(element, rest, site, addWrite, addParameter, new Set(seen));
        }
      });
    } else if (!path.length && Node.isSpreadElement(target)) {
      this.record(target.getExpression(), [], site, addWrite, addParameter, seen);
    } else if (!path.length && Node.isBinaryExpression(target) && target.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      this.record(target.getLeft(), [], site, addWrite, addParameter, seen);
    }
  }

  private argumentsAt(parameter: Parameter) {
    const previous = this.parameterArguments.get(parameter);
    if (previous) return previous;
    const fn = parameter.getParent();
    const parent = fn.getParent();
    const name = Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) ? fn.getNameNode() :
      Node.isVariableDeclaration(parent) && parent.getInitializer() === fn ? parent.getNameNode() : undefined;
    const args: Node[] = [];
    this.parameterArguments.set(parameter, args);
    if (!Node.isIdentifier(name) || !Node.isFunctionLikeDeclaration(fn)) return args;
    const index = fn.getParameters().indexOf(parameter);
    if (index < 0 || parameter.isRestParameter()) return args;
    for (const ref of this.references.calls(name)) {
      if (!this.files.has(ref.getSourceFile())) continue;
      const member = ref.getParent();
      const value = Node.isPropertyAccessExpression(member) && member.getNameNode() === ref ? member : ref;
      const call = value.getParent();
      if (!Node.isCallExpression(call) || call.getExpression() !== value || staticallyUnreachable(call)) continue;
      const inputs = call.getArguments();
      if (inputs[index] && !inputs.slice(0, index + 1).some(Node.isSpreadElement)) args.push(inputs[index]);
    }
    return args;
  }

  private mutatingCall(call: import('ts-morph').CallExpression, record: WriteSink) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    const name = callee.getName();
    const receiver = callee.getExpression();
    const object = Node.isIdentifier(receiver) && receiver.getText() === 'Object' && objectMutators.has(name);
    const reflect = Node.isIdentifier(receiver) && receiver.getText() === 'Reflect' && reflectMutators.has(name);
    if (object || reflect) {
      const [target, key] = call.getArguments();
      if (!target || !this.declarations(receiver).every(decl => !this.files.has(decl.getSourceFile()) &&
          decl.getSourceFile().isDeclarationFile())) return;
      if (name === 'assign' || name === 'defineProperties') {
        for (const source of call.getArguments().slice(1)) {
          if (!Node.isObjectLiteralExpression(source)) record(target, [undefined], call);
          else for (const property of source.getProperties()) {
            const member = Node.isSpreadAssignment(property) ? undefined : staticMember(property.getNameNode());
            record(target, [member], call);
          }
        }
      } else {
        const member = name === 'setPrototypeOf' ? undefined : staticMember(key, false);
        record(target, [member], call);
      }
    } else if (arrayMutators.has(name)) {
      // A method name alone does not establish an array write. Only ask the
      // checker when a direct or projected path could affect a read.
      this.arrayReceivers.set(call, receiver);
      record(receiver, [undefined], call);
    }
  }
}
