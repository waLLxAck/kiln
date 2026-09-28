import { parse } from 'yaml';
import { digest } from '../storage/files';
import type { DuplicateGroup, Item, Revision } from '../protocol/schema';

/**
 * Duplicate detection: which items look like copies of one another. Each revision is summarised once (revisions never change,
 * so the summary is cached by revision hash) and groups are built from those summaries alone, so a snapshot never re-reads
 * content. Two items are copies when they have the same kind and either the same text, or the same name with mostly the same
 * text (estimated from a small MinHash sketch of word triples).
 */
export type Signature = {
  /** Digest of the text with line endings normalised. */ text: string;
  /** Digest of the bundled files. */ files: string;
  /** Normalised names: the SKILL.md `name` and the title. */ names: string[];
  /** The smallest hashes of the text's word triples, ascending: a bottom-k MinHash sketch. */ sketch: number[];
  /** Characters of text, so tiny placeholder texts ("Imported photo.png") don't count as the same on their own. */ length: number;
};
const SKETCH_SIZE = 64;
/** Text overlap, 0 to 1, from which two items with the same name count as copies. */
export const SIMILAR = 0.5;
/** Same text alone makes copies only when there is enough of it; shorter texts also need the same bundled files. */
const SUBSTANTIAL = 200;
/** How much text is sketched; enough to tell versions apart without hashing megabytes. */
const SKETCH_CHARS = 100_000;

/** A name as it compares: lower case, "(1)" and "copy" suffixes of duplicated folders dropped, punctuation as hyphens. */
export function nameKey(name: string) {
  return name.trim().toLowerCase().replace(/(?:[\s_-]*\(\d+\)|[\s_-]+copy(?:[\s_-]*\d+)?)+$/, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}
function frontMatterName(content: string) {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!block) return '';
  try { const name = (parse(block) as { name?: unknown } | null)?.name; return typeof name === 'string' ? name : ''; } catch { return ''; }
}
/** FNV-1a, 32 bits: a fast, well spread hash for sketching; nothing here needs to resist collisions on purpose. */
function fnv(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}
export function sketch(text: string, size = SKETCH_SIZE) {
  const words = text.slice(0, SKETCH_CHARS).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const hashes = new Set<number>();
  if (words.length < 3) { if (words.length) hashes.add(fnv(words.join(' '))); }
  else for (let i = 0; i + 2 < words.length; i++) hashes.add(fnv(`${words[i]} ${words[i + 1]} ${words[i + 2]}`));
  return [...hashes].sort((a, b) => a - b).slice(0, size);
}
/** Estimated Jaccard overlap of two sketches: of the smallest hashes of their union, the share found in both. */
export function similarity(a: number[], b: number[], size = SKETCH_SIZE) {
  if (!a.length && !b.length) return 1;
  let i = 0, j = 0, taken = 0, both = 0;
  while (taken < size && (i < a.length || j < b.length)) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) i++;
    else if (i >= a.length || b[j] < a[i]) j++;
    else { both++; i++; j++; }
    taken++;
  }
  return taken ? both / taken : 0;
}
export function signature(revision: Pick<Revision, 'content' | 'files' | 'title' | 'kind'>): Signature {
  const text = revision.content.replace(/\r\n?/g, '\n');
  const names = [...new Set([revision.kind === 'skill' ? frontMatterName(text) : '', revision.title].map(nameKey).filter(Boolean))];
  return { text: digest(text), files: digest(revision.files), names, sketch: sketch(text), length: text.length };
}

const pairKey = (a: string, b: string) => a < b ? `${a}:${b}` : `${b}:${a}`;
/** Pairs marked as not duplicates, as a set of `a:b` keys in either order. */
export const distinctKeys = (pairs: [string, string][]) => new Set(pairs.map(([a, b]) => pairKey(a, b)));
const strength = { identical: 2, 'same-text': 1, similar: 0 } as const;
/** Live, shelved-free items that can be copies. Sources are left out: what was made from each points back at it. */
export const comparable = (item: Item) => !item.deletedAt && item.kind !== 'source' && item.status !== 'archived' && item.status !== 'rejected';

/**
 * Groups of likely copies. `signatures` holds each item's current revision summary (items without one are skipped);
 * `distinct` the pairs the user said are different. A group is connected by copy links, so A and C can share a group through B.
 */
export function duplicateGroups(items: Item[], signatures: Map<string, Signature>, distinct: Set<string> = new Set()): DuplicateGroup[] {
  const pool = items.filter(item => comparable(item) && signatures.has(item.id));
  const buckets = new Map<string, Item[]>();
  const add = (key: string, item: Item) => { const list = buckets.get(key); if (list) list.push(item); else buckets.set(key, [item]); };
  for (const item of pool) {
    const sig = signatures.get(item.id)!;
    add(`${item.kind}\u0000text\u0000${sig.text}`, item);
    for (const name of sig.names) add(`${item.kind}\u0000name\u0000${name}`, item);
  }
  const parent = new Map(pool.map(item => [item.id, item.id]));
  const root = (id: string): string => { let at = id; while (parent.get(at) !== at) at = parent.get(at)!; parent.set(id, at); return at; };
  const links: { a: string; b: string; match: DuplicateGroup['match']; similarity: number }[] = [], seen = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) {
      const a = bucket[i], b = bucket[j], key = pairKey(a.id, b.id);
      if (seen.has(key)) continue; seen.add(key);
      if (distinct.has(key)) continue;
      const x = signatures.get(a.id)!, y = signatures.get(b.id)!;
      let link: (typeof links)[number] | null = null;
      // The same short text with other files is a placeholder ("Imported photo.png") over different files: not a copy.
      if (x.text === y.text) { if (x.files === y.files || Math.min(x.length, y.length) >= SUBSTANTIAL) link = { a: a.id, b: b.id, match: x.files === y.files ? 'identical' : 'same-text', similarity: 1 }; }
      else if (x.names.some(name => y.names.includes(name))) { const overlap = similarity(x.sketch, y.sketch); if (overlap >= SIMILAR) link = { a: a.id, b: b.id, match: 'similar', similarity: overlap }; }
      if (link) { links.push(link); parent.set(root(a.id), root(b.id)); }
    }
  }
  const groups = new Map<string, DuplicateGroup>();
  const created = new Map(pool.map(item => [item.id, item.createdAt]));
  for (const link of links) {
    const key = root(link.a), group = groups.get(key);
    if (!group) { groups.set(key, { ids: [link.a, link.b], match: link.match, similarity: link.similarity }); continue; }
    for (const id of [link.a, link.b]) if (!group.ids.includes(id)) group.ids.push(id);
    if (strength[link.match] < strength[group.match]) group.match = link.match;
    group.similarity = Math.min(group.similarity, link.similarity);
  }
  return [...groups.values()].map(group => ({ ...group, similarity: Math.round(group.similarity * 100) / 100, ids: group.ids.sort((a, b) => created.get(a)!.localeCompare(created.get(b)!) || a.localeCompare(b)) }));
}
/**
 * The tags a consolidation gives the kept item unless told otherwise: every copy's tags together, except when the kept item's
 * current revision is approved, whose own tags then stay (new tags would save a new, unapproved revision).
 */
export function defaultTags(kept: Pick<Item, 'tags'>, merged: Pick<Item, 'tags'>[], approved: boolean) {
  if (approved) return [...kept.tags];
  return [...new Set([...kept.tags, ...merged.flatMap(item => item.tags)])].slice(0, 30);
}
