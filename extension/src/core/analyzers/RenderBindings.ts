import { CallExpression, Node, SourceFile } from 'ts-morph';
import { declarationsOf } from './ArchitectureFacts';
import { packageMember, returnedValues } from './CallableFlow';

type RenderFunction = import('ts-morph').FunctionDeclaration | import('ts-morph').FunctionExpression |
  import('ts-morph').ArrowFunction;
type Step = { members: string[]; returns: boolean };

export function isComponentWrapper(node: Node | undefined): node is CallExpression {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  const name = packageMember(callee, 'react');
  return name === 'memo' || name === 'forwardRef' || /(?:^|\.)(?:memo|forwardRef)$/.test(callee.getText());
}

/** Follow the value behind a JSX binding through local factories and React memoization. */
export function renderBindings(declarations: Node[], files: Set<SourceFile>): RenderFunction[] {
  const seen = new Map<Node, Step[]>();
  let remaining = 40;
  const resolve = (node: Node | undefined, members: string[], returns: boolean): RenderFunction[] => {
    if (!node || remaining <= 0 || !files.has(node.getSourceFile())) return [];
    const steps = seen.get(node) ?? [];
    if (steps.some(step => step.returns === returns && step.members.length === members.length &&
        step.members.every((member, i) => member === members[i]))) return [];
    steps.push({ members, returns });
    seen.set(node, steps);
    remaining--;
    if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
      return returns ? returnedValues(node).flatMap(value => resolve(value, members, false)) : members.length ? [] : [node];
    }
    if (Node.isVariableDeclaration(node) || Node.isExportAssignment(node)) {
      return resolve(Node.isVariableDeclaration(node) ? node.getInitializer() : node.getExpression(), members, returns);
    }
    if (Node.isBindingElement(node)) {
      const pattern = node.getParent();
      const owner = pattern.getParent();
      const key = node.getPropertyNameNode() ?? node.getNameNode();
      if (Node.isObjectBindingPattern(pattern) && !node.getDotDotDotToken() &&
          (Node.isIdentifier(key) || Node.isStringLiteral(key))) {
        return resolve(owner, [Node.isIdentifier(key) ? key.getText() : key.getLiteralText(), ...members], returns);
      }
    }
    if (Node.isObjectLiteralExpression(node) && members.length) {
      const [key, ...rest] = members;
      // A spread or computed key can shadow the property being read.
      for (const property of [...node.getProperties()].reverse()) {
        if (Node.isSpreadAssignment(property)) return [];
        const name = property.getNameNode();
        if (Node.isComputedPropertyName(name)) return [];
        if ((Node.isStringLiteral(name) ? name.getLiteralText() : name.getText()) !== key) continue;
        if (Node.isPropertyAssignment(property)) return resolve(property.getInitializer(), rest, returns);
        if (Node.isShorthandPropertyAssignment(property)) {
          return property.getValueSymbol()?.getDeclarations().flatMap(target => resolve(target, rest, returns)) ?? [];
        }
        return [];
      }
    }
    if (Node.isPropertyAssignment(node)) return resolve(node.getInitializer(), members, returns);
    if (Node.isShorthandPropertyAssignment(node)) {
      return node.getValueSymbol()?.getDeclarations().flatMap(target => resolve(target, members, returns)) ?? [];
    }
    if (Node.isCallExpression(node) && !returns) {
      const expression = node.getExpression();
      const hook = packageMember(expression, 'react');
      if (hook === 'useCallback' || hook === 'useMemo') {
        return resolve(node.getArguments()[0], members, hook === 'useMemo');
      }
      if (members.length) return declarationsOf(expression).flatMap(target => resolve(target, members, true));
    }
    if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
      const targets = declarationsOf(node).flatMap(target => resolve(target, members, returns));
      if (!targets.length && Node.isPropertyAccessExpression(node)) {
        return resolve(node.getExpression(), [node.getName(), ...members], returns);
      }
      return targets;
    }
    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) ||
        Node.isNonNullExpression(node)) return resolve(node.getExpression(), members, returns);
    return [];
  };
  return declarations.flatMap(node => resolve(node, [], false));
}
