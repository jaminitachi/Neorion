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
  const projectNode = root as Node & { _getNodeFromCompilerNode(node: ts.Node): Node };
  const visit = (node: ts.Node) => {
    visitRaw?.(node);
    if (skip?.has(node)) return;
    if (kinds.has(node.kind)) visitWrapped(projectNode._getNodeFromCompilerNode(node));
    node.forEachChild(visit);
  };
  root.compilerNode.forEachChild(visit);
}
