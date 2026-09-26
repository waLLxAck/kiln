import type { Installation, Item, ProviderId } from '../../../packages/protocol/schema';
import type { SkillLocation } from '../../../packages/providers/skill-locations';

export type LibraryFilters = {
  provider: 'any' | ProviderId;
  location: 'any' | SkillLocation;
  state: 'any' | 'managed' | 'external' | 'linked' | 'changed';
  scope: 'any' | 'personal' | 'project';
  tag: string;
  /** ID of a source: only items made from it. */
  source: string;
};
export type LibraryFilterKey = keyof LibraryFilters;
export const emptyLibraryFilters: LibraryFilters = { provider: 'any', location: 'any', state: 'any', scope: 'any', tag: '', source: '' };
export const activeFilterCount = (filters: LibraryFilters) => Object.entries(filters).filter(([key, value]) => value !== emptyLibraryFilters[key as LibraryFilterKey]).length;

/** One optional filter dimension: added to the filter row on demand, shown as a pill like the built-in ones. Tag options come from the items. */
export type FilterDimension = { key: LibraryFilterKey; name: string; hint: string; options: { value: string; label: string; hint?: string }[] };
const sameCopy = 'Combined with other copy filters, all must match the same copy.';
export const filterDimensions: FilterDimension[] = [
  { key: 'provider', name: 'Provider', hint: 'Native agent definitions or client-specific skill copies. Shared skills in .agents belong to the Agents location and are not counted here.', options: [
    { value: 'codex', label: 'Codex-specific' }, { value: 'claude', label: 'Claude-specific' }, { value: 'copilot', label: 'Copilot-specific' }] },
  { key: 'location', name: 'Location', hint: `Folder that holds a copy of the item. ${sameCopy}`, options: [
    { value: 'agents', label: 'Shared Agents', hint: 'The shared .agents/skills folder; this does not say which clients have loaded it.' }, { value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex-specific' }, { value: 'copilot', label: 'Copilot-specific' }] },
  { key: 'state', name: 'Copy state', hint: `How a local copy relates to the library. ${sameCopy}`, options: [
    { value: 'managed', label: 'Managed by Kiln', hint: 'Installed by Kiln and tracked.' }, { value: 'external', label: 'External copy', hint: 'Found in a skill folder but not installed by Kiln.' }, { value: 'linked', label: 'Link or junction' }, { value: 'changed', label: 'Different or missing content', hint: 'The copy no longer matches the library revision.' }] },
  { key: 'scope', name: 'Scope', hint: `Personal folders or enrolled project folders. ${sameCopy}`, options: [{ value: 'personal', label: 'Personal' }, { value: 'project', label: 'Project' }] },
  { key: 'tag', name: 'Tag', hint: 'Only items carrying one tag', options: [] },
  { key: 'source', name: 'Source', hint: 'Only items made from one source, in whatever collection they are filed', options: [] },
];

export function matchesLibraryFilters(item: Item, copies: Installation[], filters: LibraryFilters) {
  if (filters.tag && !item.tags.includes(filters.tag)) return false;
  if (filters.source && item.origin?.itemId !== filters.source) return false;
  const copyFilters = filters.location !== 'any' || filters.state !== 'any' || filters.scope !== 'any';
  if (!copyFilters && filters.provider === 'any') return true;
  if (!copyFilters && item.kind === 'agent') return item.agent?.provider === filters.provider;
  return copies.some(copy => {
    if (copy.itemId !== item.id) return false;
    // A provider filter names client-specific content, not inferred runtime access to shared skills.
    if (filters.provider !== 'any' && (item.kind === 'agent' ? item.agent?.provider !== filters.provider : copy.location !== filters.provider)) return false;
    if (filters.location !== 'any' && copy.location !== filters.location) return false;
    if (filters.scope !== 'any' && copy.scope !== filters.scope) return false;
    if (filters.state === 'managed' && copy.state !== 'installed') return false;
    if (filters.state === 'external' && copy.state !== 'external') return false;
    if (filters.state === 'linked' && !copy.linked) return false;
    if (filters.state === 'changed' && copy.matches) return false;
    return true;
  });
}
