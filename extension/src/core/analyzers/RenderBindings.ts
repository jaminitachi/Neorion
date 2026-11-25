import { Node, SourceFile } from 'ts-morph';
import { declarationsOf, wrappedExpression } from './ArchitectureFacts';
import { packageMember, returnedValues } from './CallableFlow';
import { constValue } from './PropFlow';

type RenderFunction = import('ts-morph').FunctionDeclaration | import('ts-morph').FunctionExpression |
  import('ts-morph').ArrowFunction;
type Target = RenderFunction | import('ts-morph').ClassDeclaration;
type Member = string | null;
type Step = { members: Member[]; returns: boolean; possible: boolean };

function lookupKey(node: Node | undefined, remaining = 8): string | undefined {
  if (!node || !remaining) return;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isNumericLiteral(node)) return String(node.getLiteralValue());
  const wrapped = wrappedExpression(node);
  if (wrapped) return lookupKey(wrapped, remaining - 1);
  if (Node.isIdentifier(node)) {
    const declarations = declarationsOf(node);
    if (declarations.length === 1) return lookupKey(constValue(declarations[0]), remaining - 1);
  }
}

/** Follow the value behind a JSX binding through local factories and React memoization. */
export function renderBindings(declarations: Node[], files: Set<SourceFile>): { target: Target; possible: boolean }[] {
  const seen = new Map<Node, Step[]>();
  const targets = new Map<Target, boolean>();
  const resolve = (node: Node | undefined, members: Member[], returns: boolean, possible: boolean, remaining: number): void => {
    if (!node || remaining <= 0 || !files.has(node.getSourceFile())) return;
    const steps = seen.get(node) ?? [];
    if (steps.some(step => step.returns === returns && step.possible === possible && step.members.length === members.length &&
        step.members.every((member, i) => member === members[i]))) return;
    steps.push({ members, returns, possible });
    seen.set(node, steps);
    const next = (value: Node | undefined, path = members, invoke = returns, uncertain = possible) =>
      resolve(value, path, invoke, uncertain, remaining - 1);
    if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
      if (returns) returnedValues(node).forEach(value => next(value, members, false));
      else if (!members.length) targets.set(node, (targets.get(node) ?? true) && possible);
      return;
    }
    if (Node.isClassDeclaration(node) && !returns && !members.length) {
      targets.set(node, (targets.get(node) ?? true) && possible);
      return;
    }
    if (Node.isVariableDeclaration(node) || Node.isExportAssignment(node)) {
      return next(Node.isVariableDeclaration(node) ? node.getInitializer() : node.getExpression());
    }
    if (Node.isBindingElement(node)) {
      const pattern = node.getParent();
      const owner = pattern.getParent();
      const key = node.getPropertyNameNode() ?? node.getNameNode();
      if (Node.isObjectBindingPattern(pattern) && !node.getDotDotDotToken() &&
          (Node.isIdentifier(key) || Node.isStringLiteral(key))) {
        return next(owner, [Node.isIdentifier(key) ? key.compilerNode.text : key.getLiteralText(), ...members]);
      }
    }
    if (Node.isObjectLiteralExpression(node) && members.length) {
      const [key, ...rest] = members;
      const properties = node.getProperties();
      const covered = new Set<string>();
      let uncertain = possible || key === null;
      for (let i = properties.length - 1; i >= 0; i--) {
        const property = properties[i];
        if (Node.isSpreadAssignment(property)) {
          next(property.getExpression(), members, returns, true);
          uncertain = true;
          continue;
        }
        const name = property.getNameNode();
        const member = Node.isIdentifier(name) ? name.compilerNode.text :
          lookupKey(Node.isComputedPropertyName(name) ? name.getExpression() : name);
        if (member !== undefined && (covered.has(member) || key !== null && member !== key)) continue;
        next(property, rest, returns, uncertain || member === undefined);
        if (member === undefined) uncertain = true;
        else if (key !== null) return;
        else covered.add(member);
      }
      return;
    }
    if (Node.isPropertyAssignment(node)) return next(node.getInitializer());
    if (Node.isShorthandPropertyAssignment(node)) {
      node.getValueSymbol()?.getDeclarations().forEach(target => next(target));
      return;
    }
    if (Node.isCallExpression(node) && !returns) {
      const expression = node.getExpression();
      const hook = packageMember(expression, 'react');
      if (hook === 'useCallback' || hook === 'useMemo') {
        return next(node.getArguments()[0], members, hook === 'useMemo');
      }
      if (members.length) declarationsOf(expression).forEach(target => next(target, members, true));
      return;
    }
    if (Node.isElementAccessExpression(node)) {
      const key = lookupKey(node.getArgumentExpression());
      return next(node.getExpression(), [key ?? null, ...members]);
    }
    if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
      const declarations = declarationsOf(node);
      if (Node.isPropertyAccessExpression(node) && (!declarations.length ||
          declarations.some(target => Node.isPropertyAssignment(target) || Node.isShorthandPropertyAssignment(target)))) {
        // Resolve literal properties against the object so access through a
        // dynamic outer lookup retains that lookup's uncertainty.
        return next(node.getExpression(), [node.getName(), ...members]);
      }
      declarations.forEach(target => next(target));
      return;
    }
    next(wrappedExpression(node));
  };
  declarations.forEach(node => resolve(node, [], false, false, 40));
  return [...targets].map(([target, possible]) => ({ target, possible }));
}
