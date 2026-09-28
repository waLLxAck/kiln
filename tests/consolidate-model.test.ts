import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Approval, Installation, Item } from '../packages/protocol/schema';
import { duplicateIds, fileDifferences, groupOf, lineChanges, suggestKeep, suggestTags, summary } from '../apps/desktop/src/consolidate-model';

const item = (id: string, extra: Partial<Item> = {}) => ({ id, title: 'research', kind: 'skill', revision: `rev-${id}`, tags: [], collection: '', favourite: false, updatedAt: `2026-09-2${id.length}T10:00:00.000Z`, ...extra }) as Item;
const approval = (itemId: string, revision: string) => ({ itemId, revision, trust: 'local' }) as Approval;

test('the suggested copy to keep is the approved one, then installed, favourite, most used and newest', () => {
  const a = item('a'), b = item('bb'), c = item('ccc');
  assert.equal(suggestKeep([a, b, c], [], [], {}).id, 'ccc', 'newest when nothing else differs');
  assert.equal(suggestKeep([a, b, c], [], [], { a: { copied: 0, used: 5 } }).id, 'a', 'then the most used');
  assert.equal(suggestKeep([a, b, c], [], [{ itemId: 'bb', state: 'installed' } as Installation], { a: { copied: 0, used: 5 } }).id, 'bb', 'a copy Kiln installed beats use');
  assert.equal(suggestKeep([a, b, c], [approval('a', 'old')], [{ itemId: 'bb', state: 'installed' } as Installation], {}).id, 'a', 'any approval beats an install');
  assert.equal(suggestKeep([a, b, c], [approval('a', 'old'), approval('ccc', 'rev-ccc')], [], {}).id, 'ccc', 'an approved current revision wins');
});

test('tags default to every copy’s, except for an approved kept item; files and lines compare plainly', () => {
  assert.deepEqual(suggestTags(item('a', { tags: ['x'] }), [item('b', { tags: ['y', 'x'] })], false), ['x', 'y']);
  assert.deepEqual(suggestTags(item('a', { tags: ['x'] }), [item('b', { tags: ['y'] })], true), ['x']);
  assert.deepEqual(fileDifferences({ a: '1', b: '2', c: '3' }, { b: '2', c: '4', d: '5' }), [{ name: 'a', state: 'only-kept' }, { name: 'c', state: 'changed' }, { name: 'd', state: 'only-other' }]);
  assert.deepEqual(lineChanges('one\ntwo\nthree', 'one\nthree\nfour'), { added: 1, removed: 1 });
  assert.deepEqual(lineChanges('a\r\nb', 'a\nb'), { added: 0, removed: 0 }, 'line endings do not count');
});

test('groups are found by member and the summary says what will happen', () => {
  const groups = [{ ids: ['a', 'b'], match: 'identical' as const, similarity: 1 }];
  assert.equal(groupOf(groups, 'b'), groups[0]);
  assert.equal(groupOf(groups, 'z'), undefined);
  assert.deepEqual([...duplicateIds(groups)], ['a', 'b']);
  const where = (i: Item) => i.id === 'a' ? 'Development' : 'Unfiled';
  assert.equal(summary({ kept: item('a'), merged: [item('b')], where, textChanged: false, tagsChanged: false, collectionChanged: false, approved: false }), 'Keeps “research” (Development). “research” (Unfiled) moves to Trash, marked as merged.');
  assert.match(summary({ kept: item('a'), merged: [item('b')], where, textChanged: true, tagsChanged: true, collectionChanged: false, approved: true }), /Saves a new draft revision with its text and its tags; the approved revision stays installed until you approve again\.$/);
  assert.match(summary({ kept: item('a'), merged: [item('b'), item('c')], where, textChanged: false, tagsChanged: false, collectionChanged: true, approved: false }), /move to Trash, marked as merged\. Files it in the chosen collection\.$/);
});
