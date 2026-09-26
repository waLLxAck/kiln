import { WorkbenchError } from './errors';

/**
 * Collections are folders written as paths: "Game Design/Puzzles" is a subfolder of "Game Design". An empty name means the item
 * is unfiled and shows only under the whole library. Parents are implied by their subfolders, so no list has to store them.
 * Shared by the workbench and the desktop sidebar; keep it free of Node imports.
 */
export const MAX_COLLECTION_LENGTH = 80;
/** Trims each level and rejects empty ones: " Game Design / Puzzles " becomes "Game Design/Puzzles". */
export function collectionPath(name: string) {
  const parts = name.split('/').map(part => part.trim());
  if (!parts.every(Boolean)) throw new WorkbenchError('INVALID_COLLECTION', name.trim() ? `“${name.trim()}” has an empty folder level. Use / only between names.` : 'Name the collection.');
  const value = parts.join('/');
  if (value.length > MAX_COLLECTION_LENGTH) throw new WorkbenchError('INVALID_COLLECTION', `Collection paths are limited to ${MAX_COLLECTION_LENGTH} characters.`);
  return value;
}
export const parentOf = (name: string) => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
export const leafOf = (name: string) => name.slice(name.lastIndexOf('/') + 1);
export const depthOf = (name: string) => name ? name.split('/').length - 1 : 0;
/** True for the collection itself and every folder below it. */
export const isWithin = (name: string, ancestor: string) => name === ancestor || name.startsWith(ancestor + '/');
/** "A/B/C" → ["A", "A/B"]. */
export function ancestorsOf(name: string) {
  const parts = name.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}
/** Where `name` ends up when the folder `from` becomes `to`; subfolders travel with it. An empty `to` lifts them to the top level. */
export function relocate(name: string, from: string, to: string) {
  if (name === from) return to;
  if (!name.startsWith(from + '/')) return name;
  const rest = name.slice(from.length + 1);
  return to ? `${to}/${rest}` : rest;
}
/** Adds implied parents, drops the unfiled name and orders the list as a tree: each folder follows its parent, siblings keep their first-seen order. */
export function collectionTree(names: Iterable<string>) {
  const seen = new Set<string>();
  for (const name of names) if (name) for (const part of [...ancestorsOf(name), name]) seen.add(part);
  const children = new Map<string, string[]>();
  for (const name of seen) { const parent = parentOf(name), siblings = children.get(parent); if (siblings) siblings.push(name); else children.set(parent, [name]); }
  const ordered: string[] = [];
  const walk = (parent: string) => { for (const child of children.get(parent) ?? []) { ordered.push(child); walk(child); } };
  walk('');
  return ordered;
}
