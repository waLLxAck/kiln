import type { Item } from '../../../packages/protocol/schema';

/**
 * Where an item came from, short enough for a subtitle: an imported folder (with the home folder shown as ~), a path in an
 * imported skills repository, or a web address.
 */
export function sourceLabel(source: string, home = ''): string {
  if (!source.trim()) return 'captured in Kiln';
  const imported = source.match(/^local-import:(.+)$/s);
  if (imported) return `a folder named ${imported[1]}`;
  const local = source.match(/^local:(.+)$/s);
  if (local) {
    const folder = local[1], slash = (value: string) => value.replaceAll('\\', '/').toLowerCase();
    const base = slash(home).replace(/\/+$/, '');
    return base && (slash(folder) === base || slash(folder).startsWith(`${base}/`)) ? `~${folder.slice(base.length)}` : folder;
  }
  const repository = source.match(/^repository:(.+)$/s);
  if (repository) return `repository ${repository[1]}`;
  try { const url = new URL(source); if (url.protocol === 'https:' || url.protocol === 'http:') return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`; } catch { /* Not a web address. */ }
  return source;
}

/** Items grouped with every other item of the same kind and title, in the same place (the library or the trash). */
function titleGroups(items: Item[]) {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = `${item.deletedAt ? 'trash' : 'live'}\u0000${item.kind}\u0000${item.title.trim().toLowerCase()}`;
    groups.set(key, [...groups.get(key) ?? [], item]);
  }
  return [...groups.values()].filter(group => group.length > 1);
}
/** Items whose title another item of the same kind shares: the ones whose private origin is worth looking up. */
export const sharedTitleIds = (items: Item[]) => titleGroups(items).flat().map(item => item.id);

/**
 * Items that share their kind and title with another item, mapped to the source that tells them apart. `origins` holds the full
 * source recorded on this machine at import (the shared source keeps only the folder name). A group whose sources all read the
 * same gets no label.
 */
export function titleCollisions(items: Item[], home = '', origins: Record<string, string> = {}): Map<string, string> {
  const labels = new Map<string, string>();
  for (const group of titleGroups(items)) {
    const sources = group.map(item => sourceLabel(origins[item.id] ?? item.source, home));
    if (new Set(sources).size > 1) group.forEach((item, index) => labels.set(item.id, sources[index]));
  }
  return labels;
}
