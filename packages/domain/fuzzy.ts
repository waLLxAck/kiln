/** Typo-tolerant matching on titles and tags, for when full-text search finds nothing. Kept free of storage so it can be tested. */

/** Edit distance where swapping two neighbouring letters counts once ("reveiw" is one edit from "review"). */
export function editDistance(a: string, b: string, limit = Infinity): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [], previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j], before[j - 2] + 1);
    }
    // Every cell is over the limit, and no later row can come back under it (a transposition reaches two rows back, and the
    // row before this one can be at most one lower), so stop here.
    if (current.every(value => value > limit)) return limit + 1;
    before = previous; previous = current;
  }
  return previous[b.length];
}
/** Short words must be exact: one wrong letter in a three-letter word matches half the library. */
const allowance = (token: string) => token.length <= 3 ? 0 : token.length <= 6 ? 1 : 2;
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** How far a query word is from the closest title or tag word (a prefix of that word counts, so half-typed words match), or null. */
function tokenCost(token: string, candidates: string[]): number | null {
  const limit = allowance(token);
  let best: number | null = null;
  for (const word of candidates) {
    if (word.startsWith(token)) return 0;
    const cost = Math.min(editDistance(token, word, limit), word.length > token.length ? editDistance(token, word.slice(0, token.length), limit) : Infinity);
    if (cost <= limit && (best === null || cost < best)) best = cost;
  }
  return best;
}
/** Items whose title or tags contain every query word within a small number of typos, closest first. */
export function closeMatches<T extends { title: string; tags: string[] }>(query: string, items: T[]): T[] {
  const tokens = words(query);
  if (!tokens.length) return [];
  const scored: { item: T; cost: number; index: number }[] = [];
  items.forEach((item, index) => {
    const candidates = [...words(item.title), ...item.tags.flatMap(words)];
    let cost = 0;
    for (const token of tokens) { const c = tokenCost(token, candidates); if (c === null) return; cost += c; }
    scored.push({ item, cost, index });
  });
  return scored.sort((a, b) => a.cost - b.cost || a.index - b.index).map(s => s.item);
}
