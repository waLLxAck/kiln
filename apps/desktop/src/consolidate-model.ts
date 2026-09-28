import type { Approval, DuplicateGroup, Installation, Item, Usage } from '../../../packages/protocol/schema';

/*
 * The pure parts of consolidating duplicates (Consolidate.tsx): which copy to suggest keeping, the default tags, how the copies'
 * texts and files compare, and the one-line summary of what will happen. Kept free of React for unit tests.
 */

/** The group an item belongs to, if any. */
export const groupOf = (groups: DuplicateGroup[], id: string) => groups.find(g => g.ids.includes(id));
/** Ids of every item in a duplicate group, for `is:duplicate` and the library marker. */
export const duplicateIds = (groups: DuplicateGroup[]) => new Set(groups.flatMap(g => g.ids));

/**
 * The copy to suggest keeping: an approved current revision first, then any approval, a copy installed by Kiln here, a favourite,
 * the most used, and the most recently updated.
 */
export function suggestKeep(items: Item[], approvals: Approval[], installations: Installation[], usage: Usage): Item {
  const local = approvals.filter(a => a.trust === 'local');
  const score = (item: Item) => (local.some(a => a.itemId === item.id && a.revision === item.revision) ? 8 : 0) + (local.some(a => a.itemId === item.id) ? 4 : 0)
    + (installations.some(c => c.itemId === item.id && c.state === 'installed') ? 2 : 0) + (item.favourite ? 1 : 0);
  return [...items].sort((a, b) => score(b) - score(a) || (usage[b.id]?.used ?? 0) - (usage[a.id]?.used ?? 0) || b.updatedAt.localeCompare(a.updatedAt))[0];
}
/** Every copy's tags together, unless the kept item's current revision is approved: then its own (as the backend defaults). */
export function suggestTags(kept: Item, others: Item[], approved: boolean) {
  return approved ? [...kept.tags] : [...new Set([kept, ...others].flatMap(i => i.tags))].slice(0, 30);
}
export type FileState = 'same' | 'changed' | 'only-kept' | 'only-other';
/** Bundled files of the text being kept against another copy's, differing ones only. */
export function fileDifferences(kept: Record<string, string>, other: Record<string, string>): { name: string; state: FileState }[] {
  return [...new Set([...Object.keys(kept), ...Object.keys(other)])].sort().flatMap(name => {
    const state: FileState = !(name in other) ? 'only-kept' : !(name in kept) ? 'only-other' : kept[name] === other[name] ? 'same' : 'changed';
    return state === 'same' ? [] : [{ name, state }];
  });
}
/** Lines added and removed going from `before` to `after`, counted as a multiset so moved lines do not count. */
export function lineChanges(before: string, after: string) {
  const count = (text: string) => { const map = new Map<string, number>(); for (const line of text.replace(/\r\n?/g, '\n').split('\n')) map.set(line, (map.get(line) ?? 0) + 1); return map; };
  const a = count(before), b = count(after);
  let added = 0, removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  return { added, removed };
}
const quote = (title: string, from?: string) => `“${title}”${from ? ` (${from})` : ''}`;
/** "Keeps “research” (Development). “research” (Unfiled) moves to Trash. Saves a new draft revision: new text and tags." */
export function summary({ kept, merged, where, textChanged, tagsChanged, collectionChanged, approved }: { kept: Item; merged: Item[]; where: (item: Item) => string; textChanged: boolean; tagsChanged: boolean; collectionChanged: boolean; approved: boolean }) {
  const moved = merged.map(i => quote(i.title, where(i)));
  const parts = [`Keeps ${quote(kept.title, where(kept))}.`, `${moved.join(', ')} ${merged.length === 1 ? 'moves' : 'move'} to Trash, marked as merged.`];
  const changes = [textChanged ? 'its text' : '', tagsChanged ? 'its tags' : ''].filter(Boolean);
  if (changes.length) parts.push(`Saves a new draft revision with ${changes.join(' and ')}${approved ? '; the approved revision stays installed until you approve again' : ''}.`);
  else if (collectionChanged) parts.push('Files it in the chosen collection.');
  return parts.join(' ');
}
