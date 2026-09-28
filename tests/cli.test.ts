import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { Workbench } from '../packages/domain/workbench';
import { parseArguments } from '../apps/cli/arguments';
import { SearchIndex } from '../packages/storage/search';
import { itemSchema, revisionSchema } from '../packages/protocol/schema';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-cli-test-'));
const library = path.join(root, 'library with spaces'), local = path.join(root, 'private');
const cli = process.env.KILN_TEST_CLI ?? path.join(root, 'workbench.cjs');
let first: string, second: string, archived: string;
before(() => {
  if (!process.env.KILN_TEST_CLI) buildSync({ entryPoints: ['apps/cli/main.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: cli, target: 'node22' });
  const wb = new Workbench(library, local);
  try {
    wb.saveCollections({ names: ['Game Design Practice', 'Empty collection'] });
    first = wb.create({ title: 'First exercise', kind: 'prompt', collection: 'Game Design Practice', content: 'Test puzzles with players.', files: { 'notes.txt': Buffer.from('Supporting notes').toString('base64') } }).id;
    second = wb.create({ title: 'Second exercise', kind: 'resource', collection: 'Game Design Practice', content: 'Balance puzzles carefully.' }).id;
    archived = wb.create({ title: 'Archived exercise', kind: 'prompt', collection: 'Game Design Practice', content: 'Older exercise.' }).id;
    wb.setMeta({ id: archived, expect: wb.getItem(archived).revision, status: 'archived' });
    wb.create({ title: 'Game Design Practice', kind: 'prompt', collection: 'Other', content: 'Game Design Practice puzzles.' });
    wb.create({ title: 'Similar collection', kind: 'prompt', collection: 'Game Design Practice extra', content: 'puzzles' });
    const trashed = wb.create({ title: 'Deleted exercise', kind: 'prompt', collection: 'Game Design Practice', content: 'puzzles' });
    wb.setMeta({ id: trashed.id, expect: trashed.revision, deleted: true });
  } finally { wb.close(); }
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
function run(args: string[]) {
  return spawnSync(process.execPath, [cli, '--library', library, '--local', local, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}
function data(args: string[]) {
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).data;
}

test('CLI filters exact collections before pagination and returns compact items', () => {
  const page = data(['items', 'list', '--collection', 'Game Design Practice', '--limit', '2']);
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.equal(page.nextOffset, 2);
  for (const item of page.items) assert.deepEqual(Object.keys(item).sort(), ['id', 'kind', 'title']);
  const next = data(['items', 'list', '--collection', 'Game Design Practice', '--limit', '2', '--offset', '2']);
  assert.equal(next.nextOffset, null);
  assert.deepEqual(new Set([...page.items, ...next.items].map(item => item.id)), new Set([first, second, archived]));
  assert.equal(data(['items', 'list', '--collection', 'Missing']).total, 0);
  assert.equal(data(['items', 'list', '--collection', 'game design practice']).total, 0);
});

test('CLI combines collection, content search and status; full lists expose metadata only', () => {
  const result = data(['items', 'list', '--collection', 'Game Design Practice', '--query', 'puzzles', '--status', 'captured', '--full']);
  assert.deepEqual(new Set(result.items.map((item: { id: string }) => item.id)), new Set([first, second]));
  for (const item of result.items) {
    assert.equal(item.collection, 'Game Design Practice');
    assert.equal(item.status, 'captured');
    assert.ok(item.revision);
    assert.equal(item.content, undefined);
    assert.equal(item.files, undefined);
  }
  assert.deepEqual(data(['items', 'list', '--collection', 'Game Design Practice', '--status', 'archived']).items.map((item: { id: string }) => item.id), [archived]);
});

test('CLI collection counts include empty and archived collections but exclude trash', () => {
  const { collections, unfiled } = data(['collections', 'list']);
  assert.deepEqual(collections.find((item: { name: string }) => item.name === 'Game Design Practice'), { name: 'Game Design Practice', count: 3, total: 3 });
  assert.deepEqual(collections.find((item: { name: string }) => item.name === 'Empty collection'), { name: 'Empty collection', count: 0, total: 0 });
  assert.equal(unfiled, 0);
});

test('CLI organises collections: subfolders, moves, renames and deletes that keep items, all without new revisions', () => {
  // A separate library, so the shared fixture above stays as the other tests expect.
  const own = path.join(root, 'organising');
  const call = (list: string[]) => spawnSync(process.execPath, [cli, '--library', own, '--local', local, ...list], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const ok = (list: string[]) => { const result = call(list); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout).data; };
  const wb = new Workbench(own, local);
  let skill: string, note: string, revision: string;
  try {
    skill = wb.create({ title: 'Review skill', kind: 'prompt', collection: 'Work', content: 'Review carefully.' }).id;
    note = wb.create({ title: 'Loose note', kind: 'prompt', collection: 'Work', content: 'A note.' }).id;
    revision = wb.getItem(skill).revision;
  } finally { wb.close(); }
  assert.equal(ok(['collections', 'create', '--name', 'Work/Reviews']).name, 'Work/Reviews');
  assert.deepEqual(ok(['items', 'move', skill, '--collection', 'Work/Reviews']).moved, [skill]);
  const listed = ok(['collections', 'list']);
  assert.deepEqual(listed.collections, [{ name: 'Work', count: 1, total: 2 }, { name: 'Work/Reviews', count: 1, total: 1 }]);
  assert.deepEqual(ok(['items', 'list', '--collection', 'Work']).items.map((i: { id: string }) => i.id), [note]);
  assert.equal(ok(['items', 'list', '--collection', 'Work', '--recursive']).total, 2);
  assert.equal(ok(['collections', 'rename', '--from', 'Work', '--to', 'Job']).to, 'Job');
  assert.equal(ok(['items', 'read', skill]).item.collection, 'Job/Reviews');
  const deleted = ok(['collections', 'delete', '--name', 'Job', '--keep-items']);
  assert.deepEqual(new Set(deleted.moved), new Set([skill, note])); assert.deepEqual(deleted.trashed, []);
  assert.deepEqual(ok(['collections', 'list']), { collections: [{ name: 'Reviews', count: 1, total: 1 }], unfiled: 1 });
  assert.deepEqual(ok(['items', 'list', '--unfiled']).items.map((i: { id: string }) => i.id), [note]);
  assert.deepEqual(ok(['items', 'move', skill, '--unfiled']).moved, [skill]);
  const read = ok(['items', 'read', skill]);
  assert.equal(read.item.collection, ''); assert.equal(read.revision, revision, 'organising never creates a revision');
  assert.deepEqual(ok(['collections', 'list']).collections, [{ name: 'Reviews', count: 0, total: 0 }], 'an emptied collection stays until it is deleted');
  const missing = call(['collections', 'delete', '--name', 'Nope', '--trash-items']);
  assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stderr).error.code, 'COLLECTION_NOT_FOUND');
});

test('CLI lists sources and what was made from them', () => {
  const own = path.join(root, 'sources');
  const call = (list: string[]) => spawnSync(process.execPath, [cli, '--library', own, '--local', local, ...list], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const ok = (list: string[]) => { const result = call(list); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout).data; };
  const wb = new Workbench(own, local);
  let source: string, entry: string;
  try {
    const created = wb.create({ title: 'Pasted chat', kind: 'source', content: 'Chat', collection: 'Design' }); source = created.id;
    entry = wb.createFrom({ id: source, revision: created.revision, author: 'Codex', item: { title: 'Compare designs', kind: 'technique', content: '1. Compare.', collection: 'Elsewhere' } }).id;
    wb.create({ title: 'Unrelated', kind: 'prompt', content: 'Other' });
  } finally { wb.close(); }
  assert.deepEqual(ok(['items', 'list', '--kind', 'source']).items, [{ id: source, title: 'Pasted chat', kind: 'source' }]);
  assert.deepEqual(ok(['items', 'list', '--from', source]).items.map((i: { id: string }) => i.id), [entry], 'found wherever the entry is filed');
  assert.deepEqual(ok(['items', 'read', source]).madeFrom, [{ id: entry, title: 'Compare designs', kind: 'technique' }]);
  assert.deepEqual(ok(['items', 'read', source, '--full']).madeFrom.map((i: { id: string }) => i.id), [entry]);
  assert.equal(ok(['items', 'read', entry, '--full']).item.collection, 'Elsewhere', 'a full read says where the item is filed now');
  assert.equal(ok(['items', 'read', entry]).madeFrom, undefined);
  assert.match(JSON.parse(call(['items', 'list', '--kind', 'sources']).stderr).error.message, /--kind must be one of/);
});

test('CLI reads selected IDs in one call, preserving order and single-read compatibility', () => {
  const batch = data(['items', 'read', second, first, '--full']);
  assert.deepEqual(batch.items.map((item: { itemId: string }) => item.itemId), [second, first]);
  assert.equal(batch.items[0].content, 'Balance puzzles carefully.');
  assert.equal(Buffer.from(batch.items[1].files['notes.txt'], 'base64').toString(), 'Supporting notes');
  const single = data(['items', 'read', first]);
  assert.equal(single.item.id, first);
  assert.equal(single.contentBytes, Buffer.byteLength('Test puzzles with players.'));
  assert.equal(single.content, undefined);
  assert.equal(data(['items', 'read', first, '--revision', single.revision, '--full']).itemId, first);
  assert.deepEqual(data(['items', 'read', second, first]).items.map((item: { item: { id: string } }) => item.item.id), [second, first]);
});

test('CLI batch failures return no partial content', () => {
  const result = run(['items', 'read', first, '00000000-0000-4000-8000-000000000000', '--full']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).ok, false);
});

test('CLI rejects unknown and misplaced flags before opening storage', () => {
  const missing = path.join(root, 'must not be created');
  const result = spawnSync(process.execPath, [cli, '--library', missing, 'items', 'list', '--collecton', 'Game Design Practice'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).error.message, /Unknown option: --collecton/);
  assert.equal(fs.existsSync(missing), false);
  for (const args of [
    ['items', 'list', '--file', 'draft.md'],
    ['items', 'list', '--collection'],
    ['items', 'list', '--collection', '--full'],
    ['items', 'list', '--query', 'a', '--query', 'b'],
    ['items', 'list', '--limit', '0'],
    ['items', 'list', '--limit', '501'],
    ['items', 'list', '--offset', '-1'],
    ['items', 'list', '--offset', '1.5'],
    ['items', 'read'],
    ['items', 'read', first, second, '--revision', 'hash'],
    ['items', 'read', ...Array(101).fill(first)],
    ['collections', 'list', 'extra'],
    ['collections', 'create'],
    ['collections', 'rename', '--from', 'A'],
    ['collections', 'delete', '--name', 'A'],
    ['collections', 'delete', '--name', 'A', '--keep-items', '--trash-items'],
    ['items', 'move', first],
    ['items', 'move', first, '--collection', 'A', '--unfiled'],
    ['items', 'move', '--collection', 'A'],
    ['items', 'list', '--unfiled', '--collection', 'A'],
    ['items', 'list', '--recursive'],
  ]) assert.throws(() => parseArguments(args), { code: 'INVALID_INPUT' }, args.join(' '));
});

test('CLI keeps global flags and JSON router operations available', () => {
  const parsed = parseArguments(['--library', library, 'git', 'sync', '--input', 'request.json', '--json']);
  assert.equal(parsed.option('library'), library);
  assert.equal(parsed.option('input'), 'request.json');
  assert.equal(parseArguments(['items', 'create', '--file', 'draft.md', '--author', 'CLI', '--key', 'key']).option('author'), 'CLI');
});

test('CLI help shows collection-first discovery and batch examples', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /kiln items list --collection "Game Design Practice"/);
  assert.match(result.stdout, /kiln items read <id1> <id2> --full/);
  assert.match(result.stdout, /collections list/);
});

test('search returns matches past 500 so later collection filters and totals stay correct', () => {
  const index = new SearchIndex(':memory:');
  try {
    const rows = Array.from({ length: 505 }, (_, n) => {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const item = itemSchema.parse({ schemaVersion: 1, id, title: `Puzzle ${n}`, kind: 'prompt', collection: n === 504 ? 'Game Design Practice' : 'Other', status: 'captured', revision: 'a'.repeat(64), favourite: false, order: n, createdAt: '2026-09-10', updatedAt: '2026-09-10', deletedAt: null, origin: null });
      return { item, load: () => revisionSchema.parse({ ...item, itemId: id, hash: item.revision, parent: null, author: 'Test', summary: '', content: 'puzzles' }) };
    });
    index.rebuild(rows);
    const matches = index.search('puzzles');
    assert.equal(matches.length, 505);
    assert.ok(matches.includes(rows[504].item.id));
  } finally { index.close(); }
});

test('items duplicates lists copies and items consolidate merges them through --input', () => {
  const content = '---\nname: research\ndescription: Investigate a question against primary sources.\n---\n\nRead the official docs and the source code, then write the findings to one Markdown file with a source for each claim.\n';
  const wb = new Workbench(library, local);
  let keep: { id: string; revision: string }, copy: { id: string; revision: string };
  try { keep = wb.create({ title: 'research', kind: 'skill', content }); copy = wb.create({ title: 'research (1)', kind: 'skill', content, collection: 'Imported skills' }); } finally { wb.close(); }
  const listed = JSON.parse(run(['items', 'duplicates']).stdout).data.groups as { ids: string[]; match: string; items: { title: string }[] }[];
  const group = listed.find(g => g.ids.includes(keep.id));
  assert.deepEqual(group?.ids.sort(), [keep.id, copy.id].sort()); assert.equal(group?.match, 'identical');
  assert.deepEqual(group?.items.map(i => i.title).sort(), ['research', 'research (1)']);
  const request = path.join(root, 'consolidate.json');
  fs.writeFileSync(request, JSON.stringify({ keep: keep.id, expect: keep.revision, merge: [{ id: copy.id, expect: copy.revision }] }));
  const result = run(['items', 'consolidate', '--input', request]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.merged, [copy.id]);
  assert.equal(JSON.parse(run(['items', 'duplicates']).stdout).data.groups.filter((g: { ids: string[] }) => g.ids.includes(keep.id)).length, 0);
  const stale = run(['items', 'consolidate', '--input', request]);
  assert.notEqual(stale.status, 0, 'the copy is in the trash now');
});

test('skills invocation turns model invocation off in the skill file; context start estimates what loads at session start', () => {
  assert.throws(() => parseArguments(['skills', 'invocation', 'id']), /--model on/);
  assert.throws(() => parseArguments(['skills', 'invocation', 'id', '--model', 'maybe']), /--model on/);
  assert.throws(() => parseArguments(['skills', 'invocation', '--model', 'off']), /one ID/);
  const content = '---\nname: triage\ndescription: Triage incoming bug reports.\n---\n\nSort by severity.\n';
  const wb = new Workbench(library, local);
  let item: { id: string; revision: string };
  try { item = wb.create({ title: 'triage', kind: 'skill', content }); wb.approve({ id: item.id, revision: item.revision, reviewer: 'tester', scope: 'test', note: 'ok', waivedChecks: 'test' }); } finally { wb.close(); }
  const result = data(['skills', 'invocation', item.id, '--model', 'off', '--expect', item.revision]);
  assert.equal(result.changed, true); assert.equal(result.approval, 'carried'); assert.deepEqual(result.invocation, { claude: false, codex: false });
  assert.match(data(['items', 'read', item.id, '--full']).content, /disable-model-invocation: true/);
  const home = path.join(root, 'cli-home'); fs.mkdirSync(path.join(home, '.claude', 'skills', 'triage'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'triage', 'SKILL.md'), content);
  const started = spawnSync(process.execPath, [cli, '--library', library, '--local', local, 'context', 'start'], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, KILN_HOME: home } });
  assert.equal(started.status, 0, started.stderr);
  const claude = JSON.parse(started.stdout).data.harnesses.find((h: { id: string }) => h.id === 'claude');
  assert.deepEqual(claude.skills.rows.map((r: { name: string; listed: boolean }) => [r.name, r.listed]), [['triage', true]]);
});
