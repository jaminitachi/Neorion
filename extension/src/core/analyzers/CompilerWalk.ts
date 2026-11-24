import type { Node, ts } from 'ts-morph';

interface WalkOptions {
  skip?: ReadonlySet<ts.Node>;
  visitRaw?: (node: ts.Node) => void;
}

/** Walk the compiler children in ts-morph's descendant order for read-only analysis. */
export function visitKinds(root: Node, kinds: ReadonlySet<ts.SyntaxKind>, visitWrapped: (node: Node) => void,
  { skip, visitRaw }: WalkOptions = {}) {
  // Use the existing project context so wrapped nodes keep their identity and checker.
  // ts-morph's public createWrappedNode creates a separate context.
  const { _getNodeFromCompilerNode: wrap } = root as Node & { _getNodeFromCompilerNode?(node: ts.Node): Node };
  if (typeof wrap !== 'function') {
    root.forEachDescendant((node, traversal) => {
      const compilerNode = node.compilerNode;
      visitRaw?.(compilerNode);
      if (skip?.has(compilerNode)) {
        traversal.skip();
        return;
      }
      if (kinds.has(node.getKind())) visitWrapped(node);
    });
    return;
  }

  const visit = (node: ts.Node) => {
    visitRaw?.(node);
    if (skip?.has(node)) return;
    if (kinds.has(node.kind)) visitWrapped(wrap.call(root, node));
    node.forEachChild(visit);
  };
  root.compilerNode.forEachChild(visit);
}
