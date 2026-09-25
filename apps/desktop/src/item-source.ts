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
export function titleCollisions(items: Item[], home = '', origins: Record<string, string> = {}): Map<string, { label: string; full: string }> {
  const labels = new Map<string, { label: string; full: string }>();
  for (const group of titleGroups(items)) {
    const sources = group.map(item => sourceLabel(origins[item.id] ?? item.source, home));
    if (new Set(sources).size < 2) continue;
    // Long folder names (such as synced/<uuid>) are cut short, unless that would make two labels read the same.
    const short = sources.map(shortenSegments), labelsFor = new Set(short).size === new Set(sources).size ? short : sources;
    group.forEach((item, index) => labels.set(item.id, { label: labelsFor[index], full: sources[index] }));
  }
  return labels;
}
/** Every path segment over 16 characters becomes its first 8 and an ellipsis: `synced/be0098eb-8b95-…` reads `synced/be0098eb…`. */
export const shortenSegments = (label: string) => label.split(/([\\/])/).map(part => part.length > 16 ? `${part.slice(0, 8)}…` : part).join('');

/** "A", "A and B", "A, B and C". */
export const joinAnd = (parts: string[]) => parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
