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

/** With nothing typed, quick search lists the most used items first; ties keep the backend's order. Typed queries keep the backend's relevance order, the same as the library's search. */
export function mostUsed<T extends { id: string }>(items: T[], usage: Usage): T[] {
  const used = (item: T) => usage[item.id]?.used ?? 0;
  return items.map((item, index) => ({ item, index, used: used(item) })).sort((a, b) => b.used - a.used || a.index - b.index).map(entry => entry.item);
}

/** A leading `>` asks for actions only; the rest is what they are matched against. */
export const parsePaletteQuery = (query: string) => query.startsWith('>') ? { actionsOnly: true, text: query.slice(1).trim() } : { actionsOnly: false, text: query.trim() };

/**
 * How well an action matches: its label first (lower is better), else label and keywords together at 500 so "new capture" finds
 * "Capture…" (keywords "new add paste"); -1 for no match. `match` replaces the label when it holds an item's title.
 */
export function actionScore(action: { label: string; match?: string; keywords?: string }, query: string) {
  const label = matchScore(action.match ?? action.label, query);
  if (label >= 0) return label;
  return action.keywords && matchScore(`${action.match ?? action.label} ${action.keywords}`, query) >= 0 ? 500 : -1;
}

/**
 * The row Enter acts on before any arrow key: the top item, unless no item title matches and the best action's label does, so
 * typing a command's words ("go sett") leaves it ready even though content matches still list items above it. Actions follow items.
 */
export function preferredRow(titles: string[], bestAction: { label: string; match?: string } | undefined, query: string) {
  const q = query.trim();
  return q && !titles.some(title => matchScore(title, q) >= 0) && bestAction && matchScore(bestAction.match ?? bestAction.label, q) >= 0 ? titles.length : 0;
}
