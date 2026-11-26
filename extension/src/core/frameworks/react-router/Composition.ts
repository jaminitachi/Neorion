import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { conditionalAt, declarationsOf } from '../../analyzers/ArchitectureFacts';
import { bindingOf, executionSites, functionNode, valueNode } from '../../analyzers/StaticBindings';
import { startLine } from '../../analyzers/SourceLines';
import type { Wrapper } from '../../../mcp/Index';
import { frameworkBinding } from './StaticConfig';

export const routerPackages = new Set(['react-router', 'react-router-dom', '@remix-run/react']);
export const redirectPackages = new Set([...routerPackages, '@remix-run/node', '@remix-run/server-runtime', '@remix-run/cloudflare', '@remix-run/deno']);

type Slot = { node: Node; wrappers: Wrapper[]; definitions: Node[]; conditional: boolean; possible: boolean };
type Location = (node: Node) => { file: string; line: number };

export function outletChains(definition: Node, slot: 'children' | 'outlet', files: Set<SourceFile>, locate: Location): Slot[] {
  const trace = (value: Node, mode: typeof slot, seen: ReadonlySet<Node>): Slot[] => {
    const fn = functionNode(value);
    if (!fn || !files.has(fn.getSourceFile()) || seen.has(fn) || seen.size >= 12) return [];
    const stack = new Set(seen).add(fn);
    const body = fn.getBody();
    const parameter = fn.getParameters()[0];
    const isChildProp = (node: Node) => {
      const binding = bindingOf(node);
      if (Node.isPropertyAccessExpression(node) && node.getName() === 'children') return bindingOf(node.getExpression()) === parameter;
      if (!Node.isBindingElement(binding) || (binding.getPropertyNameNode() ?? binding.getNameNode()).getText() !== 'children') return false;
      const container = binding.getParent().getParent();
      return container === parameter || Node.isVariableDeclaration(container) && bindingOf(container.getInitializer()) === parameter;
    };
    const results = executionSites(body);
    const walk = (node: Node | undefined, seen: Set<Node>): Slot[] => {
      if (!node || seen.has(node) || seen.size >= 36) return [];
      seen = new Set(seen).add(node);
      const direct = (): Slot[] => [{ node, wrappers: [], definitions: [], conditional: false, possible: false }];
      const conditional = (slots: Slot[]) => slots.map(slot => ({ ...slot, conditional: true }));
      if (mode === 'children' && isChildProp(node)) return direct();
      if (Node.isJsxExpression(node)) return walk(node.getExpression(), seen);
      if (Node.isJsxFragment(node)) return node.getJsxChildren().flatMap(child => walk(child, seen));
      if (Node.isConditionalExpression(node)) {
        const test = valueNode(node.getCondition());
        if (Node.isTrueLiteral(test)) return walk(node.getWhenTrue(), seen);
        if (Node.isFalseLiteral(test)) return walk(node.getWhenFalse(), seen);
        return conditional([...walk(node.getWhenTrue(), seen), ...walk(node.getWhenFalse(), seen)]);
      }
      if (Node.isBinaryExpression(node) &&
          [SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken].includes(node.getOperatorToken().getKind())) {
        const test = valueNode(node.getLeft());
        const operator = node.getOperatorToken().getKind();
        if (operator === SyntaxKind.AmpersandAmpersandToken && Node.isFalseLiteral(test)) return [];
        if (operator === SyntaxKind.AmpersandAmpersandToken && Node.isTrueLiteral(test)) return walk(node.getRight(), seen);
        if (operator === SyntaxKind.BarBarToken && Node.isTrueLiteral(test)) return [];
        return conditional([...walk(node.getLeft(), seen), ...walk(node.getRight(), seen)]);
      }
      if (Node.isCallExpression(node)) {
        const imported = frameworkBinding(node.getExpression());
        if (mode === 'outlet' && imported?.name === 'useOutlet' && routerPackages.has(imported.module)) return direct();
      }
      if (Node.isArrayLiteralExpression(node)) return node.getElements().flatMap(element => walk(element, seen));
      if (!Node.isJsxElement(node) && !Node.isJsxSelfClosingElement(node)) {
        const resolved = valueNode(node);
        return resolved !== node ? walk(resolved, seen) : [];
      }
      const tag = (Node.isJsxElement(node) ? node.getOpeningElement() : node).getTagNameNode();
      const imported = frameworkBinding(tag);
      if (mode === 'outlet' && imported?.name === 'Outlet' && routerPackages.has(imported.module)) return direct();
      const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
      const props = opening.getAttribute('children');
      const children = Node.isJsxElement(node) && node.getJsxChildren().length
        ? node.getJsxChildren().flatMap(child => walk(child, seen))
        : Node.isJsxAttribute(props) ? walk(props.getInitializer(), seen) : [];
      if (Node.isIdentifier(tag) && /^[a-z]/.test(tag.getText())) return children;
      const name = tag.getText();
      const target = declarationsOf(tag).find(candidate => files.has(candidate.getSourceFile()) && functionNode(candidate));
      const context = Node.isPropertyAccessExpression(tag) && tag.getName() === 'Provider';
      const knownForward = context || imported?.module === 'react' && ['Fragment', 'StrictMode', 'Suspense'].includes(imported.name);
      const site = locate(tag);
      const wrapper: Wrapper = {
        ...(target ? locate(target) : site), symbol: target?.getSymbol()?.getName() ?? name,
        conditional: false, provider: context || name.endsWith('Provider'),
        external: !target && imported && !imported.module.startsWith('.') ? imported.module : undefined
      };
      const add = (slot: Slot): Slot => ({ ...slot,
        wrappers: [{ ...wrapper, conditional: slot.conditional, possible: slot.possible || undefined }, ...slot.wrappers],
        definitions: target ? [target, ...slot.definitions] : slot.definitions });
      const nested = target && mode === 'outlet' ? trace(target, 'outlet', stack) : [];
      const forwarded = target && children.length ? trace(target, 'children', stack) : [];
      return [
        ...(nested || []).map(add),
        ...children.flatMap(child => {
          if (!forwarded || !forwarded.length) {
            if (target && functionNode(target)?.getParameters().length === 0) return [];
            return [add({ ...child, possible: child.possible || !knownForward })];
          }
          return forwarded.map(flow => add({ ...child, wrappers: [...flow.wrappers, ...child.wrappers],
            definitions: [...flow.definitions, ...child.definitions], conditional: child.conditional || flow.conditional,
            possible: child.possible || flow.possible }));
        })
      ];
    };
    return results.returned.flatMap(({ node, possible }) => walk(node, new Set()).map(slot => ({
      ...slot, conditional: slot.conditional || possible || !!conditionalAt(node, body)
    })));
  };
  return trace(definition, slot, new Set());
}
