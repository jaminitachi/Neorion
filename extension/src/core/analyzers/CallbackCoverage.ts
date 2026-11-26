import { Node, SyntaxKind, type JsxAttribute, type JsxSpreadAttribute } from 'ts-morph';
import { wrappedExpression } from './ArchitectureFacts';
import { isFunction, packageMember, staticMember, type FunctionNode } from './CallableFlow';
import { constValue } from './PropFlow';

const enum Coverage {
  Covered,
  Unresolved
}

/** Prove every use of one value, starting from its creation or its definition. */
export class CallbackCoverage {
  private references = new WeakMap<Node, Node[]>();

  constructor(
    private readonly inProject: (node: Node) => boolean,
    private readonly isExported: (node: Node) => boolean,
    private readonly follows: (id: number, site: Node) => boolean,
    private readonly forwards: (id: number, factory: FunctionNode, path: string[]) => boolean,
    private readonly jsxParameters: (attribute: JsxAttribute) => (Node | undefined)[] | undefined,
    private readonly deliversEvent: (spread: JsxSpreadAttribute, name: string) => boolean
  ) {}

  inspect(id: number, expression: Node, path: string[], definition = false, factory = false) {
    const active = new Set<Node>();
    let budget = 512;
    const issues = new Set<Node>();
    const combine = (results: Coverage[]) => results.reduce((worst, result) => Math.max(worst, result), Coverage.Covered);
    const binding = (name: Node | undefined, members: string[], stored: boolean, eventProp = false): Coverage => {
      if (Node.isIdentifier(name)) {
        let references = this.references.get(name);
        if (!references) this.references.set(name, references = name.findReferencesAsNodes());
        const symbol = name.getSymbol();
        const uses = references.filter(use => {
          if (use === name || !this.inProject(use) || use.getFirstAncestor(Node.isTypeNode)) return false;
          const parent = use.getParent();
          const useSymbol = use.getSymbol();
          return useSymbol === symbol || factory && useSymbol?.getAliasedSymbol() === symbol ||
            Node.isShorthandPropertyAssignment(parent) && parent.getValueSymbol() === symbol ||
            Node.isExportSpecifier(parent) && parent.getLocalTargetSymbol() === symbol;
        });
        if (!uses.length) return stored ? Coverage.Unresolved : Coverage.Covered;
        return combine(uses.map(use => visit(use, members, stored, eventProp)));
      }
      if (!members.length) return Coverage.Unresolved;
      const [member, ...rest] = members;
      if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
        const elements = name.getElements();
        const selected = elements.find((element, index) => Node.isBindingElement(element) &&
          !element.getDotDotDotToken() && (Node.isArrayBindingPattern(name)
            ? String(index) === member : staticMember(element.getPropertyNameNode() ?? element.getNameNode()) === member));
        if (Node.isBindingElement(selected)) return binding(selected.getNameNode(), rest, stored, eventProp);
        if (elements.some(element => Node.isBindingElement(element) &&
            Node.isComputedPropertyName(element.getPropertyNameNode()))) return Coverage.Unresolved;
        const spread = elements.find(element => Node.isBindingElement(element) && element.getDotDotDotToken());
        if (Node.isBindingElement(spread)) return eventProp && Node.isObjectBindingPattern(name)
          ? binding(spread.getNameNode(), members, stored, eventProp) : Coverage.Unresolved;
        return stored ? Coverage.Unresolved : Coverage.Covered;
      }
      return Coverage.Unresolved;
    };
    const descend = (value: Node, members: string[], stored: boolean, eventProp: boolean): Coverage => {
      const parent = value.getParent();
      if (!parent) return Coverage.Unresolved;
      if (wrappedExpression(parent) === value || Node.isConditionalExpression(parent) && parent.getCondition() !== value) {
        return visit(parent, members, stored, eventProp);
      }
      if (Node.isVariableDeclaration(parent) && parent.getInitializer() === value) {
        if (!constValue(parent) || !factory && this.isExported(parent)) return Coverage.Unresolved;
        return binding(parent.getNameNode(), members, stored, eventProp);
      }
      if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === value ||
          Node.isElementAccessExpression(parent) && parent.getExpression() === value) {
        if (!members.length) return Coverage.Unresolved;
        const member = Node.isPropertyAccessExpression(parent) ? parent.getName() :
          staticMember(parent.getArgumentExpression(), false);
        if (member === undefined) return Coverage.Unresolved;
        if (member === members[0]) return visit(parent, members.slice(1), stored, eventProp);
        let receiver: Node = parent;
        let operation = receiver.getParent();
        while (operation && wrappedExpression(operation) === receiver) {
          receiver = operation;
          operation = receiver.getParent();
        }
        // A method can use the whole receiver, including unselected members.
        const method = Node.isCallExpression(operation) && operation.getExpression() === receiver ||
          Node.isTaggedTemplateExpression(operation) && operation.getTag() === receiver;
        return stored || method ? Coverage.Unresolved : Coverage.Covered;
      }
      if (Node.isCallExpression(parent)) {
        if (parent.getExpression() === value) {
          return !members.length && this.follows(id, parent) ? Coverage.Covered : Coverage.Unresolved;
        }
        if (parent.getArguments()[0] === value && packageMember(parent.getExpression(), 'react') === 'useCallback') {
          return visit(parent, members, stored, eventProp);
        }
        return Coverage.Unresolved;
      }
      if (Node.isJsxExpression(parent)) {
        const attribute = parent.getParent();
        if (!Node.isJsxAttribute(attribute)) return Coverage.Unresolved;
        const targets = this.jsxParameters(attribute);
        if (!targets) return Coverage.Unresolved;
        const event = !members.length && this.follows(id, attribute);
        if (!targets.length) return event ? Coverage.Covered : Coverage.Unresolved;
        if (!event && !this.follows(id, value)) return Coverage.Unresolved;
        const name = attribute.getNameNode().getText();
        return combine(targets.map(parameter => binding(parameter, [name, ...members], false, event)));
      }
      if (Node.isJsxSpreadAttribute(parent)) {
        return !stored && eventProp && members.length === 1 && this.deliversEvent(parent, members[0])
          ? Coverage.Covered : Coverage.Unresolved;
      }
      if (Node.isReturnStatement(parent) || Node.isArrowFunction(parent) && parent.getBody() === value) {
        const owner = Node.isArrowFunction(parent) ? parent : parent.getFirstAncestor(isFunction);
        if (!owner) return Coverage.Unresolved;
        let producer: Node = owner;
        for (let wrapper = producer.getParent(); wrapper && wrappedExpression(wrapper) === producer; wrapper = producer.getParent()) {
          producer = wrapper;
        }
        const memo = producer.getParent();
        if (Node.isCallExpression(memo) && memo.getArguments()[0] === producer &&
            packageMember(memo.getExpression(), 'react') === 'useMemo') return visit(memo, members, stored, eventProp);
        return this.forwards(id, owner, members) ? Coverage.Covered : Coverage.Unresolved;
      }
      if (Node.isShorthandPropertyAssignment(parent) || Node.isPropertyAssignment(parent) && parent.getInitializer() === value) {
        const member = staticMember(parent.getNameNode());
        const object = parent.getParent();
        return member !== undefined && Node.isObjectLiteralExpression(object)
          ? visit(object, [member, ...members], true) : Coverage.Unresolved;
      }
      if (Node.isArrayLiteralExpression(parent)) {
        // React reads the identities in a dependency list and does not
        // receive those values as callbacks.
        const call = parent.getParent();
        if (Node.isCallExpression(call) && call.getArguments()[1] === parent &&
            ['useCallback', 'useMemo', 'useEffect', 'useLayoutEffect', 'useInsertionEffect']
              .includes(packageMember(call.getExpression(), 'react') ?? '') &&
            !members.length && !stored) return Coverage.Covered;
        return visit(parent, [String(parent.getElements().findIndex(element => element === value)), ...members], true);
      }
      if (Node.isExpressionStatement(parent) && !stored && !definition) return Coverage.Covered;
      if (Node.isIfStatement(parent) && parent.getExpression() === value ||
          Node.isConditionalExpression(parent) && parent.getCondition() === value ||
          Node.isBinaryExpression(parent) && parent.getLeft() === value &&
            parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken ||
          Node.isPrefixUnaryExpression(parent) && parent.getOperatorToken() === SyntaxKind.ExclamationToken) {
        return stored ? Coverage.Unresolved : Coverage.Covered;
      }
      // Imports and barrels expose the same factory to the indexed project. A
      // re-export of an already created callback is an escape.
      if (factory && (Node.isImportSpecifier(parent) || Node.isImportClause(parent) ||
          Node.isExportSpecifier(parent) || Node.isExportAssignment(parent))) return Coverage.Covered;
      return Coverage.Unresolved;
    };
    const visit = (value: Node, members: string[], stored: boolean, eventProp = false): Coverage => {
      if (--budget < 0 || active.has(value)) {
        issues.add(value);
        return Coverage.Unresolved;
      }
      active.add(value);
      const previousIssues = issues.size;
      const result = descend(value, members, stored, eventProp);
      active.delete(value);
      if (result === Coverage.Unresolved && issues.size === previousIssues) issues.add(value);
      return result;
    };
    const result = definition && (Node.isFunctionDeclaration(expression) || Node.isMethodDeclaration(expression))
      ? binding(expression.getNameNode(), path, false) : visit(expression, path, false);
    if (result === Coverage.Unresolved && !issues.size) issues.add(expression);
    return issues;
  }
}
