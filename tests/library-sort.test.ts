import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item } from '../packages/protocol/schema';
import { arrangeItems, moveInOrder, nextSort, sortItems, sortLabel } from '../apps/desktop/src/library-sort';
const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`;
const item = (id: string, kind: Item['kind'], created: number, extra: Partial<Item> = {}) => ({ id, kind, title: id, status: 'captured', favourite: false, order: created, createdAt: at(created), updatedAt: at(created), ...extra }) as Item;
const items = [item('old-source', 'source', 1), item('prompt', 'prompt', 5, { updatedAt: at(6) }), item('skill', 'skill', 3, { updatedAt: at(9) }), item('new-source', 'source', 4)];
const ids = (list: Item[]) => list.map(i => i.id);
test('the default is recently added, not recently updated', () => {
  assert.deepEqual(ids(sortItems(items, null)), ['prompt', 'new-source', 'skill', 'old-source']);
  assert.deepEqual(ids(sortItems(items, { key: 'updatedAt', dir: 'desc' })), ['skill', 'prompt', 'new-source', 'old-source']);
});
test('sources lead inside a collection, sorted among themselves, and mix in across the library', () => {
  assert.deepEqual(ids(arrangeItems(items, null, {}, true)), ['new-source', 'old-source', 'prompt', 'skill']);
  assert.deepEqual(ids(arrangeItems(items, { key: 'title', dir: 'asc' }, {}, true)), ['new-source', 'old-source', 'prompt', 'skill']);
  assert.deepEqual(ids(arrangeItems(items, null, {}, false)), ['prompt', 'new-source', 'skill', 'old-source']);
});
test('most copied and most used count down, ties falling back to newest added', () => {
  const usage = { skill: { copied: 3, used: 3 }, 'old-source': { copied: 0, used: 7 }, prompt: { copied: 1, used: 1 } };
  assert.deepEqual(ids(sortItems(items, { key: 'copied', dir: 'desc' }, usage)), ['skill', 'prompt', 'new-source', 'old-source']);
  assert.deepEqual(ids(sortItems(items, { key: 'used', dir: 'desc' }, usage)), ['old-source', 'skill', 'prompt', 'new-source']);
  assert.deepEqual(ids(sortItems(items, { key: 'copied', dir: 'desc' }, {})), ids(sortItems(items, null)), 'nothing copied yet reads as recently added');
});
test('custom order follows the hand-set order, and a move never crosses the pinned sources', () => {
  const custom = arrangeItems(items, { key: 'order', dir: 'asc' }, {}, true);
  assert.deepEqual(ids(custom), ['old-source', 'new-source', 'skill', 'prompt']);
  assert.deepEqual(moveInOrder(custom, 'prompt', -1, true), ['old-source', 'new-source', 'prompt', 'skill']);
  assert.equal(moveInOrder(custom, 'skill', -1, true), null, 'a skill cannot move above the sources');
  assert.deepEqual(moveInOrder(custom, 'skill', -1, false), ['old-source', 'skill', 'new-source', 'prompt']);
  assert.equal(moveInOrder(custom, 'prompt', 1), null); assert.equal(moveInOrder(custom, 'missing', 1), null);
});
test('the sort pill names heading orders too', () => {
  assert.equal(sortLabel({ key: 'createdAt', dir: 'desc' }), 'Recently added');
  assert.equal(sortLabel(nextSort({ key: 'title', dir: 'asc' }, 'title')!), 'Title Z–A');
  assert.equal(sortLabel(nextSort(null, 'kind')!), 'Type');
  assert.equal(sortLabel({ key: 'order', dir: 'asc' }), 'Custom order');
});
