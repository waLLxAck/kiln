import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item } from '../packages/protocol/schema';
import { fieldRequests, pageStep, planUndo, progressLabel, pushUndo, rangeIds, runBatched, targetRow, typeAheadKey, typeAheadMatch, undoLabel, undoneLabel, UNDO_LIMIT, type UndoEntry } from '../apps/desktop/src/keyboard-undo';

const item = (id: string, extra: Partial<Item> = {}) => ({ id, title: id, revision: `rev-${id}`, status: 'captured', favourite: false, collection: '', deletedAt: null, ...extra }) as Item;

test('range selection runs from the anchor to the target in list order, either direction', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(rangeIds(ids, 1, 3), ['b', 'c', 'd']);
  assert.deepEqual(rangeIds(ids, 3, 1), ['b', 'c', 'd']);
  assert.deepEqual(rangeIds(ids, 2, 2), ['c']);
  assert.deepEqual(rangeIds(ids, -1, 2), []);
  assert.deepEqual(rangeIds(ids, 0, 9), []);
});

test('list keys move by one, to the ends, or by a page, and stay inside the list', () => {
  assert.equal(targetRow('ArrowDown', 0, 5, 3), 1);
  assert.equal(targetRow('ArrowDown', 4, 5, 3), 4);
  assert.equal(targetRow('ArrowUp', 0, 5, 3), 0);
  assert.equal(targetRow('Home', 3, 5, 3), 0);
  assert.equal(targetRow('End', 0, 5, 3), 4);
  assert.equal(targetRow('PageDown', 1, 5, 3), 4);
  assert.equal(targetRow('PageDown', 3, 5, 3), 4);
  assert.equal(targetRow('PageUp', 3, 5, 2), 1);
  assert.equal(targetRow('Enter', 0, 5, 3), null);
  assert.equal(targetRow('Home', 0, 0, 3), null);
  assert.equal(pageStep(400, 40), 9);
  assert.equal(pageStep(30, 40), 1);
  assert.equal(pageStep(400, 0), 1);
});

test('type-ahead jumps to the next title with the typed start, keeps a still-matching row and cycles on a repeated letter', () => {
  const titles = ['Alpha', 'beta', 'Bravo', 'Charlie', 'bingo'];
  assert.equal(typeAheadMatch(titles, 0, 'b'), 1);
  assert.equal(typeAheadMatch(titles, 1, 'b'), 2, 'one letter moves on from the current row');
  assert.equal(typeAheadMatch(titles, 4, 'b'), 1, 'and wraps around');
  assert.equal(typeAheadMatch(titles, 2, 'br'), 2, 'more letters keep the current row while it matches');
  assert.equal(typeAheadMatch(titles, 1, 'bi'), 4);
  assert.equal(typeAheadMatch(titles, 1, 'bb'), 2, 'repeating one letter cycles');
  assert.equal(typeAheadMatch(titles, 0, 'z'), -1);
  assert.equal(typeAheadMatch(titles, 0, 'charlie x'), -1);
  assert.equal(typeAheadMatch(['  Padded'], 0, 'p'), 0);
  assert.ok(typeAheadKey('a') && typeAheadKey('É') && typeAheadKey('7') && typeAheadKey(' '));
  assert.ok(!typeAheadKey('?') && !typeAheadKey('Enter') && !typeAheadKey('/'));
});

test('undo keeps the newest twenty actions', () => {
  let stack: UndoEntry[] = [];
  for (let n = 1; n <= UNDO_LIMIT + 5; n++) stack = pushUndo(stack, { id: n, label: `#${n}`, changes: [] });
  assert.equal(stack.length, 20);
  assert.equal(stack[0].id, 6);
  assert.equal(stack.at(-1)!.id, 25);
});

test('undo only touches items still as the action left them', () => {
  const entry: UndoEntry = { id: 1, label: 'Moved 4 items to Trash', changes: ['a', 'b', 'c', 'gone'].map(id => ({ id, field: 'deleted' as const, before: false, after: true })) };
  const items = [item('a', { deletedAt: '2026-09-27T10:00:00.000Z' }), item('b', { deletedAt: null }), item('c', { deletedAt: '2026-09-27T10:00:00.000Z', revision: 'edited' })];
  const plan = planUndo(entry, items);
  assert.deepEqual(plan.apply.map(c => [c.id, c.expect]), [['a', 'rev-a'], ['c', 'edited']]);
  assert.deepEqual(plan.skipped, ['b', 'gone'], 'restored by hand and purged items are skipped');
  const status = planUndo({ id: 2, label: '', changes: [{ id: 'a', field: 'status', before: 'approved', after: 'archived' }, { id: 'b', field: 'status', before: 'testing', after: 'archived' }] }, [item('a', { status: 'archived' }), item('b', { status: 'captured' })]);
  assert.deepEqual(status.apply.map(c => [c.id, c.before]), [['a', 'approved']]);
  const moves = planUndo({ id: 3, label: '', changes: [{ id: 'a', field: 'collection', before: '', after: 'Work' }, { id: 'b', field: 'collection', before: 'Old', after: 'Work' }] }, [item('a', { collection: 'Work' }), item('b', { collection: 'Elsewhere' })]);
  assert.deepEqual(moves.apply.map(c => c.id), ['a']);
  const favourite = planUndo({ id: 4, label: '', changes: [{ id: 'a', field: 'favourite', before: false, after: true }] }, [item('a', { favourite: true })]);
  assert.equal(favourite.apply.length, 1);
});

test('field changes become one meta call per item and one move per destination collection', () => {
  const requests = fieldRequests([
    { id: 'a', expect: 'r1', field: 'deleted', to: false },
    { id: 'b', expect: 'r2', field: 'status', to: 'approved' },
    { id: 'c', expect: 'r3', field: 'collection', to: '' },
    { id: 'd', expect: 'r4', field: 'collection', to: 'Work' },
    { id: 'e', expect: 'r5', field: 'collection', to: '' },
    { id: 'f', expect: 'r6', field: 'favourite', to: true },
  ]);
  assert.deepEqual(requests, [
    { method: 'items.meta', args: { id: 'a', expect: 'r1', deleted: false }, ids: ['a'] },
    { method: 'items.meta', args: { id: 'b', expect: 'r2', status: 'approved' }, ids: ['b'] },
    { method: 'items.meta', args: { id: 'f', expect: 'r6', favourite: true }, ids: ['f'] },
    { method: 'items.move', args: { ids: ['c', 'e'], collection: '' }, ids: ['c', 'e'] },
    { method: 'items.move', args: { ids: ['d'], collection: 'Work' }, ids: ['d'] },
  ]);
});

test('batches run a few at a time, in order, and carry on past failures', async () => {
  let inFlight = 0, most = 0; const started: number[] = [], progress: number[] = [];
  const tasks = Array.from({ length: 21 }, (_, n) => n);
  const result = await runBatched(tasks, async n => {
    started.push(n); inFlight++; most = Math.max(most, inFlight);
    await new Promise(resolve => setTimeout(resolve, (n * 7) % 5));
    inFlight--; if (n === 9) throw new Error('REVISION_CONFLICT: Reload this item before changing it.');
  }, { size: 8, onProgress: done => progress.push(done) });
  assert.equal(most, 8);
  assert.deepEqual(started, tasks, 'each batch starts in list order');
  assert.deepEqual(progress, [8, 16, 21]);
  assert.equal(result.succeeded.length, 20);
  assert.deepEqual(result.failed.map(f => f.task), [9]);
  const weighted: number[] = [];
  await runBatched([['a', 'b'], ['c']], async () => {}, { size: 1, weight: ids => ids.length, onProgress: done => weighted.push(done) });
  assert.deepEqual(weighted, [2, 3]);
});

test('toast and progress wording', () => {
  const three = [item('a'), item('b'), item('c')];
  assert.equal(undoLabel('deleted', true, three), 'Moved 3 items to Trash');
  assert.equal(undoLabel('deleted', false, [item('Notes')]), 'Restored “Notes”');
  assert.equal(undoLabel('status', 'archived', [item('Notes')]), 'Archived “Notes”');
  assert.equal(undoLabel('status', 'testing', three), 'Moved 3 items to testing');
  assert.equal(undoLabel('favourite', true, three), 'Added 3 items to favourites');
  assert.equal(undoLabel('collection', 'Work', three), 'Moved 3 items to “Work”');
  assert.equal(undoLabel('collection', '', [item('Notes')]), 'Moved “Notes” to no collection');
  assert.equal(progressLabel('deleted', true, 120, 300), 'Moving 120 of 300 to Trash…');
  assert.equal(progressLabel('status', 'archived', 1, 4, true), 'Undoing 1 of 4…');
  const entry: UndoEntry = { id: 1, label: 'Moved 3 items to Trash', changes: three.map(i => ({ id: i.id, field: 'deleted' as const, before: false, after: true })) };
  assert.equal(undoneLabel(entry, 3, 0), 'Undone: Moved 3 items to Trash');
  assert.equal(undoneLabel(entry, 2, 1), 'Undone: Moved 3 items to Trash; 1 item had changed since and was left as it is');
  assert.equal(undoneLabel(entry, 0, 3), 'Nothing undone: all 3 items have changed since “Moved 3 items to Trash”');
});
