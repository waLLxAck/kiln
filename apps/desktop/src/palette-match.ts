// Matching and ordering for quick search. Pure, so it is unit-tested (tests/palette.test.ts).
import type { Usage } from '../../../packages/protocol/schema';

const words = (text: string) => [...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map(match => ({ word: match[0], at: match.index }));
const tokens = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/**
 * How well `query` matches `text`: lower is better, -1 for no match, 0 for an empty query. A plain substring ranks by its
 * position; otherwise every word typed must start a word of the text, so "go lib" finds "Go to Library". No scattered-letter
 * matching: it floods a short list of actions with noise.
 */
export function matchScore(text: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const at = text.toLowerCase().indexOf(needle);
  if (at >= 0) return at;
  const found = words(text), starts = tokens(needle).map(token => found.findIndex(({ word }) => word.startsWith(token)));
  return starts.every(index => index >= 0) ? 100 + starts.reduce((sum, index) => sum + index, 0) : -1;
}

/** The [start, end) ranges of `text` that `query` matched, for highlighting; empty when it matched elsewhere (content, tags). */
export function matchRanges(text: string, query: string): [number, number][] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const at = text.toLowerCase().indexOf(needle);
  if (at >= 0) return [[at, at + needle.length]];
  const found = words(text), ranges: [number, number][] = [];
  for (const token of tokens(needle)) { const word = found.find(({ word }) => word.startsWith(token)); if (!word) return []; ranges.push([word.at, word.at + token.length]); }
  return ranges.sort((a, b) => a[0] - b[0]).filter((range, i, all) => i === 0 || range[0] >= all[i - 1][1]);
}

/**
 * Search results in the order quick search shows them. The backend already decided what matches (title, content, tags); this
 * puts title hits first, best position first, then by how often each item was used. With no query, the most used come first.
 * Ties keep the backend's order.
 */
export function rankItems<T extends { id: string; title: string }>(items: T[], query: string, usage: Usage): T[] {
  const used = (item: T) => usage[item.id]?.used ?? 0;
  const score = (item: T) => { const title = matchScore(item.title, query); return title < 0 ? 1000 : title; };
  return items.map((item, index) => ({ item, index, score: score(item), used: used(item) }))
    .sort((a, b) => a.score - b.score || b.used - a.used || a.index - b.index)
    .map(entry => entry.item);
}
