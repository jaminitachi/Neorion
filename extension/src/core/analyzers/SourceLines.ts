import type { Node, SourceFile, ts } from 'ts-morph';

const newlines = new WeakMap<ts.SourceFile, number[]>();

/** Count LF offsets strictly before the position, matching ts-morph's one-based lines. */
export function lineAt(file: SourceFile, position: number): number {
  const source = file.compilerNode;
  let offsets = newlines.get(source);
  if (!offsets) {
    offsets = [];
    for (let next = source.text.indexOf('\n'); next !== -1; next = source.text.indexOf('\n', next + 1)) {
      offsets.push(next);
    }
    newlines.set(source, offsets);
  }
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] < position) low = middle + 1;
    else high = middle;
  }
  return low + 1;
}

export function startLine(node: Node): number {
  return lineAt(node.getSourceFile(), node.getStart());
}

export function endLine(node: Node): number {
  return lineAt(node.getSourceFile(), node.getEnd());
}
