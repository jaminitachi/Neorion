import ranks from 'js-tiktoken/ranks/o200k_base';

const MAX_CACHED_PIECES = 65_536;
const MAX_CACHED_PIECE_LENGTH = 128;
let encodeRanks: Map<string, number> | undefined;

function loadEncodeRanks() {
  const table = new Map<string, number>();
  for (const line of ranks.bpe_ranks.split('\n')) {
    if (!line) continue;
    const [, offset, ...tokens] = line.split(' ');
    let rank = Number.parseInt(offset, 10);
    // Latin-1 maps each byte to one code unit, preserving arbitrary token bytes.
    for (const token of tokens) table.set(Buffer.from(token, 'base64').toString('latin1'), rank++);
  }
  return table;
}

/** Counts ordinary o200k_base tokens, as in Tiktoken.encode(text, [], []). */
export class TokenCounter {
  private readonly ranks = encodeRanks ??= loadEncodeRanks();
  private readonly pattern = new RegExp(ranks.pat_str, 'gu');
  private readonly pieceCounts = new Map<string, number>();

  count(text: string): number {
    let total = 0;
    for (const [piece] of text.matchAll(this.pattern)) {
      let count = this.pieceCounts.get(piece);
      if (count === undefined) {
        count = this.countPiece(Buffer.from(piece, 'utf8'));
        if (piece.length <= MAX_CACHED_PIECE_LENGTH && this.pieceCounts.size < MAX_CACHED_PIECES) {
          this.pieceCounts.set(piece, count);
        }
      }
      total += count;
    }
    return total;
  }

  private countPiece(bytes: Buffer): number {
    if (this.ranks.has(bytes.toString('latin1'))) return 1;

    // As in js-tiktoken, merge the lowest-ranked adjacent pair, taking the
    // leftmost pair when ranks tie. Each remaining part has a rank because
    // o200k_base contains all single bytes and every merge requires a rank.
    // Rescanning pairs on each merge takes up to quadratic time in the piece's byte length.
    const ends = Array.from(bytes, (_, index) => index + 1);
    while (ends.length > 1) {
      let bestRank = Infinity;
      let mergeAt = -1;
      for (let i = 0; i < ends.length - 1; i++) {
        const pair = bytes.toString('latin1', ends[i - 1] ?? 0, ends[i + 1]);
        const rank = this.ranks.get(pair);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          mergeAt = i;
        }
      }
      if (mergeAt < 0) break;
      ends.splice(mergeAt, 1);
    }
    return ends.length;
  }
}
