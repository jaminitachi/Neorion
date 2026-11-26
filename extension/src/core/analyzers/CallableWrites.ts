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
  private writes = new Map<Node, Write[]>();
  private parameterWrites: [Parameter, Write][] = [];
  private parameterArguments = new Map<Parameter, Node[]>();

  constructor(private files: Set<SourceFile>, private declarations: (node: Node) => Node[], private references: CallableReferences) {
    for (const file of files) visitKinds(file, writeKinds, node => {
      if (!isWriteOperation(node.compilerNode) || staticallyUnreachable(node)) return;
      if (Node.isBinaryExpression(node)) this.record(node.getLeft(), [], node);
      else if (Node.isForInStatement(node) || Node.isForOfStatement(node)) this.record(node.getInitializer(), [], node);
      else if (Node.isCallExpression(node)) this.mutatingCall(node);
      else if (Node.isDeleteExpression(node)) this.record(node.getExpression(), [], node);
      else if (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) this.record(node.getOperand(), [], node);
    }, { filterRaw: isWriteOperation });
    for (const [parameter, { path, site }] of this.parameterWrites) {
      for (const argument of this.argumentsAt(parameter)) this.record(argument, path, site);
    }
  }

  forBinding(binding: Node, members: string[]) {
    return this.writes.get(binding)?.find(write => matchingPath(write.path, members))?.site;
  }

  forRead(node: Node) {
    if (Node.isIdentifier(node)) {
      for (const binding of this.declarations(node)) {
        const write = this.forBinding(binding, []);
        if (write) return write;
      }
      return;
    }
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
      const write = this.writes.get(binding)?.find(write => matchingPath(write.path, path));
      if (write) return write.site;
    }
  }

  private addWrite(binding: Node, path: Member[], site: Node) {
    const writes = this.writes.get(binding) ?? [];
    if (writes.some(write => write.site === site && write.path.length === path.length &&
        write.path.every((member, index) => member === path[index]))) return;
    const write = { site, path };
    writes.push(write);
    this.writes.set(binding, writes);
    if (path.length && Node.isParameterDeclaration(binding)) this.parameterWrites.push([binding, write]);
  }

  private record(target: Node, path: Member[], site: Node, seen = new Set<Node>()): void {
    if (seen.has(target)) return;
    seen.add(target);
    const inner = wrappedExpression(target);
    if (inner) return this.record(inner, path, site, seen);
    if (Node.isPropertyAccessExpression(target) || Node.isElementAccessExpression(target)) {
      const member = Node.isPropertyAccessExpression(target) ? target.getName() : staticMember(target.getArgumentExpression(), false);
      return this.record(target.getExpression(), [member, ...path], site, seen);
    }
    if (target.getKind() === SyntaxKind.ThisKeyword && path.length) {
      const method = target.getFirstAncestor(node => Node.isFunctionLikeDeclaration(node) && !Node.isArrowFunction(node));
      const parent = method?.getParent();
      const receiver = Node.isPropertyAssignment(parent) ? parent.getParent() : parent;
      if (Node.isObjectLiteralExpression(receiver)) this.addWrite(receiver, path, site);
      return;
    }
    if (Node.isIdentifier(target)) {
      const parent = target.getParent();
      const declarations = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol()?.getDeclarations() ?? [] :
        this.declarations(target);
      for (const binding of declarations) {
        this.addWrite(binding, path, site);
        if (path.length && Node.isVariableDeclaration(binding)) {
          const value = binding.getInitializer();
          if (value) this.record(value, path, site, seen);
        }
        if (path.length && Node.isBindingElement(binding)) {
          const declaration = binding.getParent().getParent();
          const value = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
          const selection = bindingSelection(binding, path);
          if (!selection || binding.getDotDotDotToken() && path.length < 2) continue;
          if (value) this.record(value, selection, site, seen);
          else if (Node.isParameterDeclaration(declaration)) {
            this.parameterWrites.push([declaration, { path: selection, site }]);
          }
        }
      }
      return;
    }
    if (Node.isConditionalExpression(target)) {
      this.record(target.getWhenTrue(), path, site, new Set(seen));
      this.record(target.getWhenFalse(), path, site, seen);
    } else if (Node.isObjectLiteralExpression(target) || Node.isArrayLiteralExpression(target)) {
      const [member, ...rest] = path;
      if (Node.isObjectLiteralExpression(target)) for (const property of target.getProperties()) {
        const name = Node.isSpreadAssignment(property) ? undefined : staticMember(property.getNameNode());
        const value = Node.isPropertyAssignment(property) ? property.getInitializer() :
          Node.isShorthandPropertyAssignment(property) ? property.getNameNode() :
          Node.isSpreadAssignment(property) ? property.getExpression() : undefined;
        if (!value) continue;
        if (!path.length) this.record(value, [], site, new Set(seen));
        else if (Node.isSpreadAssignment(property) && rest.length) this.record(value, path, site, new Set(seen));
        else if (rest.length && (member === undefined || name === member)) this.record(value, rest, site, new Set(seen));
      }
      else target.getElements().forEach((element, index) => {
        if (!path.length || rest.length && (member === undefined || member === String(index))) {
          this.record(element, rest, site, new Set(seen));
        }
      });
    } else if (!path.length && Node.isSpreadElement(target)) {
      this.record(target.getExpression(), [], site, seen);
    } else if (!path.length && Node.isBinaryExpression(target) && target.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      this.record(target.getLeft(), [], site, seen);
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
    for (const ref of this.references.uses(name)) {
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

  private mutatingCall(call: import('ts-morph').CallExpression) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    const name = callee.getName();
    const receiver = callee.getExpression();
    const [target, key] = call.getArguments();
    const object = Node.isIdentifier(receiver) && receiver.getText() === 'Object' && objectMutators.has(name);
    const reflect = Node.isIdentifier(receiver) && receiver.getText() === 'Reflect' && reflectMutators.has(name);
    if ((object || reflect) && target &&
        this.declarations(receiver).every(decl => !this.files.has(decl.getSourceFile()) && decl.getSourceFile().isDeclarationFile())) {
      if (name === 'assign' || name === 'defineProperties') {
        for (const source of call.getArguments().slice(1)) {
          if (!Node.isObjectLiteralExpression(source)) this.record(target, [undefined], call);
          else for (const property of source.getProperties()) {
            const member = Node.isSpreadAssignment(property) ? undefined : staticMember(property.getNameNode());
            this.record(target, [member], call);
          }
        }
      } else {
        const member = name === 'setPrototypeOf' ? undefined : staticMember(key, false);
        this.record(target, [member], call);
      }
    } else if (arrayMutators.has(name)) {
      const type = receiver.getType();
      if (type.isArray() || type.isTuple()) this.record(receiver, [undefined], call);
    }
  }
}
