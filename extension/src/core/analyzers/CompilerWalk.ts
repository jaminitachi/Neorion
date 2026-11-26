import { type Node, ts } from 'ts-morph';

// Match ts-morph's FunctionLikeDeclaration guard, whose kinds differ from ts.isFunctionLike.
export function isFunctionLikeDeclaration(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isConstructorDeclaration(node) || ts.isFunctionDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isMethodDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

interface WalkOptions {
  skip?: ReadonlySet<ts.Node>;
  filterRaw?: (node: ts.Node) => boolean;
  skipNode?: (node: ts.Node) => boolean;
  visitRaw?: (node: ts.Node) => void;
}

/** Walk the compiler children in ts-morph's descendant order for read-only analysis. */
export function visitKinds(root: Node, kinds: ReadonlySet<ts.SyntaxKind>, visitWrapped: (node: Node) => void,
  { skip, skipNode, filterRaw, visitRaw }: WalkOptions = {}) {
  // Use the existing project context so wrapped nodes keep their identity and checker.
  // ts-morph's public createWrappedNode creates a separate context.
  const { _getNodeFromCompilerNode: wrap } = root as Node & { _getNodeFromCompilerNode?(node: ts.Node): Node };
  if (typeof wrap !== 'function') {
    root.forEachDescendant((node, traversal) => {
      const compilerNode = node.compilerNode;
      visitRaw?.(compilerNode);
      if (skip?.has(compilerNode) || skipNode?.(compilerNode)) {
        traversal.skip();
        return;
      }
      if (kinds.has(node.getKind()) && (!filterRaw || filterRaw(node.compilerNode))) visitWrapped(node);
    });
    return;
  }

  const visit = (node: ts.Node) => {
    visitRaw?.(node);
    if (skip?.has(node) || skipNode?.(node)) return;
    if (kinds.has(node.kind) && (!filterRaw || filterRaw(node))) visitWrapped(wrap.call(root, node));
    node.forEachChild(visit);
  };
  root.compilerNode.forEachChild(visit);
}
