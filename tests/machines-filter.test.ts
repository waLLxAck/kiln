import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applicable, attention, counts, filterSchema, isFiltered, matchesText, noFilter, preset, rowMatches, showsColumn, toggleState, type FilterRow, type MachinesFilter } from '../apps/desktop/src/machines-filter';

const rows: FilterRow[] = [
  { title: 'code-review', kind: 'skill', states: ['installed', 'changed', 'off'] },
  { title: 'research', kind: 'skill', states: ['external', 'installed', 'off'] },
  { title: 'fresh-eyes', kind: 'skill', states: ['unavailable', 'unavailable'] },
  { title: 'Release reviewer', kind: 'agent', states: ['outdated', 'unavailable'] },
];
const f = (over: Partial<MachinesFilter>): MachinesFilter => ({ ...noFilter, ...over });
const titles = (filter: MachinesFilter) => rows.filter(r => rowMatches(r, filter)).map(r => r.title);

test('state chips keep rows with any cell in any chosen state', () => {
  assert.deepEqual(titles(noFilter), ['code-review', 'research', 'fresh-eyes', 'Release reviewer']);
  assert.deepEqual(titles(f({ states: ['installed'] })), ['code-review', 'research']);
  assert.deepEqual(titles(f({ states: ['changed', 'outdated'] })), ['code-review', 'Release reviewer'], 'chips combine with OR');
  assert.deepEqual(titles(f({ states: attention })), ['code-review', 'research', 'Release reviewer']);
  assert.deepEqual(titles(f({ states: ['marked'] })), []);
});

test('name, kind and states all narrow together', () => {
  assert.deepEqual(titles(f({ text: 'REV' })), ['code-review', 'Release reviewer'], 'ignores case');
  assert.deepEqual(titles(f({ text: 'rel rev' })), ['Release reviewer'], 'every word must appear');
  assert.deepEqual(titles(f({ text: 'rev', kind: 'skill' })), ['code-review']);
  assert.deepEqual(titles(f({ text: 'rev', states: ['outdated'] })), ['Release reviewer']);
  assert.equal(matchesText('anything', '   '), true);
});

test('counts are cells per state and rows per preset among the rows the name and kind keep, whatever states are chosen', () => {
  const all = counts(rows, noFilter);
  assert.deepEqual(all.states, { installed: 2, changed: 1, outdated: 1, external: 1, marked: 0, off: 2, unavailable: 3 });
  assert.equal(all.all, 4);
  assert.equal(all.attention, 3);
  const skills = counts(rows, f({ kind: 'skill', states: ['installed'] }));
  assert.equal(skills.states.outdated, 0);
  assert.equal(skills.states.changed, 1);
  assert.equal(skills.all, 3);
  assert.equal(skills.attention, 2);
});

test('presets and toggling keep one canonical order', () => {
  assert.equal(preset(noFilter), 'all');
  assert.equal(preset(f({ states: ['outdated', 'external', 'changed'] })), 'attention');
  assert.equal(preset(f({ states: ['changed'] })), null);
  let filter = toggleState(noFilter, 'off');
  filter = toggleState(filter, 'installed');
  assert.deepEqual(filter.states, ['installed', 'off']);
  assert.deepEqual(toggleState(filter, 'off').states, ['installed']);
  assert.equal(preset(toggleState(f({ states: attention }), 'installed')), null);
});

test('a choice the view does not offer is ignored, and anything left is a filter', () => {
  const stored = f({ kind: 'agent', columns: 'projects' });
  assert.deepEqual(applicable(stored, { kinds: false, columns: true }), f({ columns: 'projects' }));
  assert.deepEqual(applicable(stored, { kinds: true, columns: false }), f({ kind: 'agent' }));
  assert.equal(isFiltered(applicable(stored, { kinds: false, columns: false })), false);
  assert.equal(isFiltered(f({ text: ' ' })), false);
  assert.equal(isFiltered(f({ text: 'x' })), true);
  assert.equal(isFiltered(f({ states: ['off'] })), true);
  assert.equal(showsColumn('all', true), true);
  assert.equal(showsColumn('personal', true), false);
  assert.equal(showsColumn('projects', true), true);
  assert.equal(showsColumn('projects', false), false);
});

test('the invocation filter keeps skills a model may invoke (mixed included) or only you can; other kinds drop out', () => {
  const skills: FilterRow[] = [{ title: 'a', kind: 'skill', states: [], invocation: 'model' }, { title: 'b', kind: 'skill', states: [], invocation: 'mixed' }, { title: 'c', kind: 'skill', states: [], invocation: 'user' }, { title: 'd', kind: 'agent', states: [] }];
  const kept = (invocation: MachinesFilter['invocation']) => skills.filter(r => rowMatches(r, f({ invocation }))).map(r => r.title);
  assert.deepEqual(kept('all'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(kept('model'), ['a', 'b']);
  assert.deepEqual(kept('user'), ['c']);
  assert.equal(isFiltered(f({ invocation: 'user' })), true);
  assert.equal(applicable(f({ invocation: 'user' }), { kinds: true, columns: true }).invocation, 'all', 'no skills to choose between');
  assert.equal(counts(skills, f({ invocation: 'model' })).all, 2);
});

test('the stored filter is checked on the way in', () => {
  assert.deepEqual(filterSchema.parse({ states: ['off', 'bogus', 'installed', 'off'], text: 'x', kind: 'skill', columns: 'personal' }), f({ states: ['installed', 'off'], text: 'x', kind: 'skill', columns: 'personal' }));
  assert.deepEqual(filterSchema.parse({ states: 'installed', kind: 'prompt', columns: 3, text: 'x'.repeat(500), invocation: 'nobody' }), noFilter);
  assert.equal(filterSchema.parse({ states: [], invocation: 'user' }).invocation, 'user');
  assert.throws(() => filterSchema.parse(null));
});
