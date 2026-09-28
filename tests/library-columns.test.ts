import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ORDER, gridTracks, isDefaultOrder, moveColumn, normalizeOrder, stepColumn, visibleColumns } from '../apps/desktop/src/library-columns';

test('Collection leads the default order and gives way while a collection is chosen', () => {
  assert.deepEqual(DEFAULT_ORDER, ['collection', 'title', 'status', 'installed', 'test', 'updatedAt']);
  assert.deepEqual(visibleColumns(DEFAULT_ORDER, true), ['title', 'status', 'installed', 'test', 'updatedAt']);
});
test('a stored order is repaired: unknown and repeated keys go, missing columns come back where the default has them', () => {
  assert.deepEqual(normalizeOrder(['title', 'title', 'nope', 'updatedAt', 'collection']), ['title', 'updatedAt', 'status', 'installed', 'test', 'collection']);
  assert.deepEqual(normalizeOrder(null), DEFAULT_ORDER);
  assert.deepEqual(normalizeOrder('broken'), DEFAULT_ORDER);
  assert.ok(isDefaultOrder(normalizeOrder([])));
});
test('moving a column puts it before the column at the drop index; dropping next to itself changes nothing', () => {
  assert.deepEqual(moveColumn(DEFAULT_ORDER, 'title', 0, false), ['title', 'collection', 'status', 'installed', 'test', 'updatedAt']);
  assert.deepEqual(moveColumn(DEFAULT_ORDER, 'collection', 6, false), ['title', 'status', 'installed', 'test', 'updatedAt', 'collection']);
  assert.deepEqual(moveColumn(DEFAULT_ORDER, 'updatedAt', 2, false), ['collection', 'title', 'updatedAt', 'status', 'installed', 'test']);
  assert.equal(moveColumn(DEFAULT_ORDER, 'status', 2, false), DEFAULT_ORDER);
  assert.equal(moveColumn(DEFAULT_ORDER, 'status', 3, false), DEFAULT_ORDER);
});
test('with Collection hidden, moves count only visible columns and Collection keeps its place', () => {
  // Visible: title, status, installed, test, updatedAt. Status to the front goes before Title, after the hidden Collection.
  assert.deepEqual(moveColumn(DEFAULT_ORDER, 'status', 0, true), ['collection', 'status', 'title', 'installed', 'test', 'updatedAt']);
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'title', -1, true), DEFAULT_ORDER);
});
test('Move left and Move right step one visible column and stop at the ends', () => {
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'title', -1, false), ['title', 'collection', 'status', 'installed', 'test', 'updatedAt']);
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'title', 1, false), ['collection', 'status', 'title', 'installed', 'test', 'updatedAt']);
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'updatedAt', 1, false), DEFAULT_ORDER);
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'collection', -1, false), DEFAULT_ORDER);
});
test('grid tracks follow the order, Title takes the flexible space, and narrow widths drop the same columns as the CSS', () => {
  const tracks = gridTracks(['title', 'collection', 'status']);
  assert.equal(tracks.full, 'minmax(180px, 1fr) minmax(100px, 200px) 150px');
  assert.equal(gridTracks(DEFAULT_ORDER).mid, 'minmax(100px, 200px) minmax(180px, 1fr) 150px 150px 110px');
  assert.equal(gridTracks(DEFAULT_ORDER).narrow, 'minmax(180px, 1fr) 150px 110px');
});
