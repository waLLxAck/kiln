import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, Installation } from '../packages/protocol/schema';
import { emptyLibraryFilters, matchesLibraryFilters } from '../apps/desktop/src/library-filters';
const item = { id: 'a', kind: 'skill', tags: ['review'], favourite: true } as Item;
const copies = [
  { itemId: 'a', location: 'agents', provider: 'codex', scope: 'personal', state: 'installed', linked: false, matches: true },
  { itemId: 'a', location: 'copilot', provider: 'copilot', scope: 'project', state: 'external', linked: true, matches: false },
] as Installation[];
test('provider filters distinguish native copies from shared access and combine on one copy', () => {
  assert.equal(matchesLibraryFilters(item, copies.slice(0, 1), { ...emptyLibraryFilters, provider: 'codex' }), false);
  assert.equal(matchesLibraryFilters(item, copies, { ...emptyLibraryFilters, provider: 'copilot', scope: 'project', state: 'linked' }), true);
  assert.equal(matchesLibraryFilters(item, copies, { ...emptyLibraryFilters, provider: 'copilot', scope: 'personal' }), false);
  assert.equal(matchesLibraryFilters(item, copies, { ...emptyLibraryFilters, location: 'agents', state: 'changed' }), false);
  assert.equal(matchesLibraryFilters(item, copies, { ...emptyLibraryFilters, tag: 'review' }), true);
  assert.equal(matchesLibraryFilters(item, copies, { ...emptyLibraryFilters, tag: 'other' }), false);
});
test('uninstalled native agents match provider but do not invent a local copy', () => {
  const agent = { ...item, kind: 'agent', agent: { provider: 'copilot', filename: 'review.md' } } as Item;
  assert.equal(matchesLibraryFilters(agent, [], { ...emptyLibraryFilters, provider: 'copilot' }), true);
  assert.equal(matchesLibraryFilters(agent, [], { ...emptyLibraryFilters, provider: 'copilot', scope: 'personal' }), false);
});
