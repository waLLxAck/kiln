import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, DEFAULT_ORDER, clampWidth, gridColumns, gridTracks, isDefaultLayout, isDefaultOrder, moveColumn, normalizeHidden, normalizeOrder, normalizeWidths, parseLayout, resetWidth, resizeEdge, setHidden, setWidth, stepColumn, storedLayout, visibleColumns } from '../apps/desktop/src/library-columns';

test('Collection leads the default order and gives way while a collection is chosen', () => {
  assert.deepEqual(DEFAULT_ORDER, ['collection', 'title', 'status', 'model', 'installed', 'test', 'updatedAt']);
  assert.deepEqual(visibleColumns(DEFAULT_ORDER, true), ['title', 'status', 'model', 'installed', 'test', 'updatedAt']);
});
test('a stored order is repaired: unknown and repeated keys go, missing columns come back where the default has them', () => {
  assert.deepEqual(normalizeOrder(['title', 'title', 'nope', 'updatedAt', 'collection']), ['title', 'updatedAt', 'status', 'model', 'installed', 'test', 'collection']);
  assert.deepEqual(normalizeOrder(null), DEFAULT_ORDER);
  assert.deepEqual(normalizeOrder('broken'), DEFAULT_ORDER);
  assert.ok(isDefaultOrder(normalizeOrder([])));
});
test('moving a column puts it before the column at the drop index; dropping next to itself changes nothing', () => {
  assert.deepEqual(moveColumn(DEFAULT_ORDER, 'title', 0, false), ['title', 'collection', 'status', 'model', 'installed', 'test', 'updatedAt']);
  assert.deepEqual(moveColumn(DEFAULT_ORDER, 'collection', 7, false), ['title', 'status', 'model', 'installed', 'test', 'updatedAt', 'collection']);
  assert.deepEqual(moveColumn(DEFAULT_ORDER, 'updatedAt', 2, false), ['collection', 'title', 'updatedAt', 'status', 'model', 'installed', 'test']);
  assert.equal(moveColumn(DEFAULT_ORDER, 'status', 2, false), DEFAULT_ORDER);
  assert.equal(moveColumn(DEFAULT_ORDER, 'status', 3, false), DEFAULT_ORDER);
});
test('with Collection hidden, moves count only visible columns and Collection keeps its place', () => {
  // Visible: title, status, installed, model, test, updatedAt. Status to the front goes before Title, after the hidden Collection.
  assert.deepEqual(moveColumn(DEFAULT_ORDER, 'status', 0, true), ['collection', 'status', 'title', 'model', 'installed', 'test', 'updatedAt']);
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'title', -1, true), DEFAULT_ORDER);
});
test('Move left and Move right step one visible column and stop at the ends', () => {
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'title', -1, false), ['title', 'collection', 'status', 'model', 'installed', 'test', 'updatedAt']);
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'title', 1, false), ['collection', 'status', 'title', 'model', 'installed', 'test', 'updatedAt']);
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'updatedAt', 1, false), DEFAULT_ORDER);
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'collection', -1, false), DEFAULT_ORDER);
});
test('grid tracks follow the order, Title takes the flexible space, and narrow widths drop the same columns as the CSS', () => {
  const tracks = gridTracks(['title', 'collection', 'status']);
  assert.equal(tracks.full, 'minmax(180px, 1fr) minmax(80px, 200px) minmax(100px, 150px)');
  assert.equal(gridTracks(DEFAULT_ORDER).mid, 'minmax(80px, 200px) minmax(180px, 1fr) minmax(100px, 150px) minmax(96px, 124px) minmax(90px, 150px) minmax(80px, 110px)');
  assert.equal(gridTracks(DEFAULT_ORDER).narrow, 'minmax(180px, 1fr) minmax(100px, 150px) minmax(80px, 110px)');
});
test('set widths cap the tracks, so a narrow window squeezes columns toward their minimums instead of overflowing', () => {
  assert.equal(gridTracks(['collection', 'title', 'status'], { collection: 320, status: 110 }).full, 'minmax(80px, 320px) minmax(180px, 1fr) minmax(100px, 110px)');
  // Title never takes a width, even one smuggled into storage.
  assert.equal(gridTracks(['title'], { title: 500 }).full, 'minmax(180px, 1fr)');
});
test("widths are clamped to each column's bounds, and the default width is not kept as a setting", () => {
  assert.equal(clampWidth('status', 10), COLUMNS.status.min);
  assert.equal(clampWidth('status', 9999), COLUMNS.status.max);
  assert.equal(clampWidth('updatedAt', 120.6), 121);
  assert.deepEqual(setWidth({}, 'collection', 260), { collection: 260 });
  assert.deepEqual(setWidth({ collection: 260 }, 'collection', 5), { collection: COLUMNS.collection.min });
  assert.deepEqual(setWidth({ collection: 260, status: 100 }, 'collection', COLUMNS.collection.width), { status: 100 });
  assert.deepEqual(setWidth({}, 'title', 400), {});
  assert.deepEqual(resetWidth({ collection: 260, status: 100 }, 'status'), { collection: 260 });
  assert.deepEqual(resetWidth({ collection: 260 }, 'status'), { collection: 260 });
});
test('stored widths are repaired: unknown keys, Title, non-numbers and defaults go, the rest are clamped', () => {
  assert.deepEqual(normalizeWidths({ collection: 300, title: 400, nope: 100, status: 'wide', installed: Number.NaN, test: 5000, updatedAt: 110 }), { collection: 300, test: COLUMNS.test.max });
  assert.deepEqual(normalizeWidths(null), {});
  assert.deepEqual(normalizeWidths([120, 130]), {});
});
test('the layout reads the order-only format of 0.23.0, the current format, and anything broken as the default', () => {
  assert.deepEqual(parseLayout(['title', 'collection']), { order: ['title', 'collection', 'status', 'model', 'installed', 'test', 'updatedAt'], widths: {} });
  assert.deepEqual(parseLayout({ order: ['status', 'collection', 'title'], widths: { status: 200 } }), { order: ['status', 'collection', 'title', 'model', 'installed', 'test', 'updatedAt'], widths: { status: 200 } });
  assert.deepEqual(parseLayout({ widths: { collection: 90 } }), { order: DEFAULT_ORDER, widths: { collection: 90 } });
  for (const broken of [null, 'x', 7, { order: 'x', widths: 'y' }]) assert.ok(isDefaultLayout(parseLayout(broken)));
});
test('the default layout is not stored, an order alone is stored as 0.23.0 did, and widths store both', () => {
  assert.equal(storedLayout({ order: [...DEFAULT_ORDER], widths: {} }), null);
  const moved = moveColumn(DEFAULT_ORDER, 'title', 0, false);
  assert.deepEqual(storedLayout({ order: moved, widths: {} }), moved);
  assert.deepEqual(storedLayout({ order: [...DEFAULT_ORDER], widths: { status: 200 } }), { order: DEFAULT_ORDER, widths: { status: 200 } });
  // A round trip through JSON, as localStorage does.
  const layout = { order: moved, widths: { collection: 240, updatedAt: 90 } };
  assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(storedLayout(layout)))), layout);
  // Reset columns: the default order and no widths, so nothing is stored.
  assert.equal(storedLayout({ order: [...DEFAULT_ORDER], widths: resetWidth(resetWidth(layout.widths, 'collection'), 'updatedAt') }), null);
});
test('each column is resized from its edge away from Title; Title has no handle of its own', () => {
  assert.equal(resizeEdge(DEFAULT_ORDER, 'collection'), 'right');
  assert.equal(resizeEdge(DEFAULT_ORDER, 'status'), 'left');
  assert.equal(resizeEdge(DEFAULT_ORDER, 'updatedAt'), 'left');
  assert.equal(resizeEdge(DEFAULT_ORDER, 'title'), null);
  assert.equal(resizeEdge(['status', 'installed', 'title'], 'installed'), 'right');
  assert.equal(resizeEdge(['title', 'status'], 'collection'), null);
});
test("handles take their column's grid position at each window width, and none where the column is hidden", () => {
  const at = gridColumns(DEFAULT_ORDER);
  assert.deepEqual(at.collection, { full: 1, mid: 1, narrow: 0 });
  assert.deepEqual(at.model, { full: 4, mid: 4, narrow: 0 });
  assert.deepEqual(at.test, { full: 6, mid: 0, narrow: 0 });
  assert.deepEqual(at.updatedAt, { full: 7, mid: 6, narrow: 3 });
});
test('a 0.23.0 order without Invoked by gets it back where the default has it', () => {
  assert.deepEqual(normalizeOrder(['collection', 'title', 'status', 'installed', 'test', 'updatedAt']), DEFAULT_ORDER);
});
test('any column but Title can be hidden, keeps its place, and is stored with the layout', () => {
  const hidden = setHidden({ order: [...DEFAULT_ORDER], widths: {} }, 'model', true);
  assert.deepEqual(hidden.hidden, ['model']);
  assert.deepEqual(visibleColumns(hidden.order, false, hidden.hidden), ['collection', 'title', 'status', 'installed', 'test', 'updatedAt']);
  assert.equal(isDefaultLayout(hidden), false);
  assert.deepEqual(setHidden(hidden, 'title', true).hidden, ['model'], 'Title always shows');
  assert.deepEqual(setHidden(setHidden(hidden, 'collection', true), 'model', false), { order: DEFAULT_ORDER, widths: {}, hidden: ['collection'] });
  assert.deepEqual(setHidden(hidden, 'model', false), { order: DEFAULT_ORDER, widths: {} }, 'shown again: no hidden list left');
  // Moves skip hidden columns; stored and read back through JSON.
  assert.deepEqual(stepColumn(DEFAULT_ORDER, 'installed', 1, false, ['model']), ['collection', 'title', 'status', 'model', 'test', 'installed', 'updatedAt']);
  assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(storedLayout(hidden)))), hidden);
  assert.deepEqual(normalizeHidden(['test', 'title', 'nope', 'model', 'test']), ['model', 'test']);
  assert.ok(isDefaultLayout(parseLayout({ order: DEFAULT_ORDER, hidden: 'model' })));
});
