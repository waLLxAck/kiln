import type { SkillRow, SpendRow, UnusedRow } from '../../../packages/usage/service';
import { totalTokens } from '../../../packages/usage/prices';

/** What the Usage page's skill filter chips show. */
export type SkillFilter = 'all' | 'unmanaged' | 'unapproved' | 'unused';
export type SortDir = 'asc' | 'desc';
export type Sort<K extends string> = { key: K; dir: SortDir };
export type SkillSortKey = 'title' | 'uses' | 'trend' | 'lastUsed' | 'activeDays' | 'projects' | 'tokens' | 'cost';
export type SpendSortKey = 'label' | 'input' | 'cached' | 'write' | 'output' | 'total' | 'cost' | 'count';

/** Skills a user may want to bring in: used, but not in the library. */
export const unmanaged = (row: SkillRow) => row.itemId === null;
/** Used, in the library, but not approved there. */
export const unapproved = (row: SkillRow) => row.itemId !== null && row.status !== 'approved';
export function filterSkills(rows: SkillRow[], filter: Exclude<SkillFilter, 'unused'>) {
  return filter === 'unmanaged' ? rows.filter(unmanaged) : filter === 'unapproved' ? rows.filter(unapproved) : rows;
}

const skillValue: Record<SkillSortKey, (row: SkillRow) => number | string> = {
  title: r => r.title.toLowerCase(), uses: r => r.uses, trend: r => r.uses - r.previous, lastUsed: r => r.lastUsed ?? '', activeDays: r => r.activeDays,
  projects: r => r.projects.length, tokens: r => totalTokens(r.attributed), cost: r => r.attributedCost ?? -1,
};
const spendValue: Record<SpendSortKey, (row: SpendRow) => number | string> = {
  label: r => r.label.toLowerCase(), input: r => r.tokens.input, cached: r => r.tokens.cached, write: r => r.tokens.cacheWrite + r.tokens.cacheWrite1h,
  output: r => r.tokens.output, total: r => totalTokens(r.tokens), cost: r => r.cost ?? -1, count: r => r.sessions ?? r.runs ?? 0,
};
function compare(a: number | string, b: number | string) { return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)); }
/** Sorted copy; ties keep the backend's order (uses, then name), so a column with equal values stays stable. */
export function sortSkills(rows: SkillRow[], sort: Sort<SkillSortKey>) {
  const value = skillValue[sort.key], sign = sort.dir === 'asc' ? 1 : -1;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => sign * compare(value(a.row), value(b.row)) || a.index - b.index).map(x => x.row);
}
export function sortSpend(rows: SpendRow[], sort: Sort<SpendSortKey>) {
  const value = spendValue[sort.key], sign = sort.dir === 'asc' ? 1 : -1;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => sign * compare(value(a.row), value(b.row)) || a.index - b.index).map(x => x.row);
}
export function sortUnused(rows: UnusedRow[]) { return [...rows].sort((a, b) => (a.lastUsed ?? '').localeCompare(b.lastUsed ?? '') || a.title.localeCompare(b.title)); }
/** Clicking a column: the same column flips direction; a new one starts descending for numbers and ascending for names. */
export function nextSort<K extends string>(current: Sort<K>, key: K, textKeys: K[]): Sort<K> {
  return current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: textKeys.includes(key) ? 'asc' : 'desc' };
}

/** 1234 as "1.2k", 3_400_000 as "3.4M", 2.1e9 as "2.1B". */
export function tokens(n: number) {
  const abs = Math.abs(n);
  const [div, unit] = abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'k'] : [1, ''];
  if (!unit) return String(Math.round(n));
  const value = n / div;
  return `${value.toFixed(Math.abs(value) < 10 ? 1 : 0).replace(/\.0$/, '')}${unit}`;
}
/** "$12.40", "$0.03", "<$0.01"; "—" when there is no estimate. */
export function dollars(value: number | null) {
  if (value === null) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value >= 1000 ? Math.round(value).toLocaleString('en-US') : value.toFixed(2)}`;
}
/** "+3", "−2", "" for no change; the trend is this window against the one before it. */
export function trend(row: Pick<SkillRow, 'uses' | 'previous'>) {
  const d = row.uses - row.previous;
  return d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '';
}
/** The last folder name of a project path, which is how people name projects. */
export const projectName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
/** "today", "yesterday", "5 days ago", then the date. */
export function lastUsed(value: string | null, today = Date.now()) {
  if (!value) return 'never';
  const days = Math.floor((new Date(new Date(today).toDateString()).getTime() - new Date(new Date(value).toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export const windowLabel = (days: number) => days ? `${days} days` : 'all time';
/** Log sizes: "840 KB", "12 MB", "5.4 GB". */
export function size(bytes: number) {
  const [div, unit] = bytes >= 1e9 ? [1e9, 'GB'] : bytes >= 1e6 ? [1e6, 'MB'] : [1e3, 'KB'];
  const value = bytes / div;
  return `${value.toFixed(value < 10 && unit === 'GB' ? 1 : 0)} ${unit}`;
}
