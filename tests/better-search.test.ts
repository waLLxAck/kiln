import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { WorkbenchError } from '../packages/domain/errors';
import { closeMatches, editDistance } from '../packages/domain/fuzzy';
import { SearchIndex } from '../packages/storage/search';
import { rankItems } from '../apps/desktop/src/library-sort';
import { matchCommands } from '../apps/desktop/src/palette-commands';
import type { Item } from '../packages/protocol/schema';

function workbench(on = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-better-search-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  if (on) wb.setExperiment({ id: 'betterSearch', enabled: true });
  return { root, wb, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const unsupported = (error: unknown) => error instanceof WorkbenchError && error.code === 'CAPABILITY_UNSUPPORTED';
/** Items whose body mentions the word far more often come first in the library's own order, so only ranking can put the title hit first. */
function library(wb: Workbench) {
  const body = wb.create({ title: 'Weekly notes', kind: 'prompt', content: 'Deploy on Friday. Deploy the deploy script. Deploy notes.' });
  const titled = wb.create({ title: 'Deploy checklist', kind: 'prompt', content: 'Steps before shipping.' });
  return { body, titled };
}

test('ranked search puts a title match above a body match; plain search keeps the library order', () => {
  const f = workbench();
  try {
    const { body, titled } = library(f.wb);
    assert.deepEqual(f.wb.search('deploy').map(i => i.id), [body.id, titled.id], 'plain search is unchanged: library order');
    const ranked = f.wb.rankedSearch('deploy');
    assert.deepEqual(ranked.items.map(i => i.id), [titled.id, body.id]);
    assert.equal(ranked.total, 2); assert.equal(ranked.close, false);
    assert.deepEqual(f.wb.rankedSearch('dep').items.map(i => i.id), [titled.id, body.id], 'prefixes still match while typing');
  } finally { f.close(); }
});

test('ranked search matches descriptions, plain search still does not', () => {
  const f = workbench();
  try {
    const item = f.wb.create({ title: 'Plain title', kind: 'prompt', description: 'Mentions zanzibar only here', content: 'Nothing to see.' });
    assert.deepEqual(f.wb.rankedSearch('zanzibar').items.map(i => i.id), [item.id]);
    assert.equal(f.wb.search('zanzibar').length, 0);
  } finally { f.close(); }
});

test('with nothing exact, ranked search falls back to close matches on titles and tags', () => {
  const f = workbench();
  try {
    const review = f.wb.create({ title: 'code-review', kind: 'skill', content: '---\nname: code-review\ndescription: Review code.\n---\n\nRead it.\n' });
    f.wb.create({ title: 'Unrelated', kind: 'prompt', content: 'Something else entirely.', tags: ['planning'] });
    const tagged = f.wb.create({ title: 'Kickoff', kind: 'prompt', content: 'Start.', tags: ['planning'] });
    assert.equal(f.wb.search('reveiw').length, 0);
    const result = f.wb.rankedSearch('reveiw');
    assert.equal(result.close, true);
    assert.deepEqual(result.items.map(i => i.id), [review.id]);
    const byTag = f.wb.rankedSearch('kikoff');
    assert.deepEqual(byTag.items.map(i => i.id), [tagged.id]);
    const none = f.wb.rankedSearch('zzzzqqq');
    assert.deepEqual(none, { items: [], total: 0, close: false });
  } finally { f.close(); }
});

test('ranked search limits results but reports the total, and hides archived items unless asked', () => {
  const f = workbench();
  try {
    for (let n = 0; n < 5; n++) f.wb.create({ title: `Puzzle ${n}`, kind: 'prompt', content: 'puzzles' });
    const limited = f.wb.rankedSearch('puzzle', { limit: 3 });
    assert.equal(limited.items.length, 3); assert.equal(limited.total, 5);
    const first = f.wb.listItems()[0];
    f.wb.setMeta({ id: first.id, expect: first.revision, status: 'archived' });
    assert.equal(f.wb.rankedSearch('puzzle').total, 4);
    assert.equal(f.wb.rankedSearch('puzzle', { archived: true }).total, 5);
    assert.equal(f.wb.rankedSearch('').total, 4, 'an empty query lists the library');
  } finally { f.close(); }
});

test('with the flag off, ranked search refuses and items.list is exactly as before', async () => {
  const f = workbench(false);
  try {
    const { body, titled } = library(f.wb);
    const router = new Router(f.wb, { composer: null });
    assert.throws(() => f.wb.rankedSearch('deploy'), unsupported);
    await assert.rejects(async () => router.call('items.search', { query: 'deploy' }), unsupported);
    assert.deepEqual((await router.call('items.list', { query: 'deploy' }) as Item[]).map(i => i.id), [body.id, titled.id]);
    f.wb.setExperiment({ id: 'betterSearch', enabled: true });
    assert.deepEqual((await router.call('items.list', { query: 'deploy' }) as Item[]).map(i => i.id), [body.id, titled.id], 'the flag never changes items.list');
    assert.deepEqual(((await router.call('items.search', { query: 'deploy', limit: 1 })) as { items: Item[]; total: number }).total, 2);
  } finally { f.close(); }
});

test('a search index written by an older Kiln is replaced safely, and an older Kiln can still open the new file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-search-index-'));
  const file = path.join(root, 'search.sqlite');
  try {
    // The five-column table earlier builds created, with a stale row.
    const old = new DatabaseSync(file);
    old.exec('PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE IF NOT EXISTS items USING fts5(id UNINDEXED,title,tags,collection,content);');
    old.prepare('INSERT INTO items VALUES(?,?,?,?,?)').run('stale', 'Stale title', '', '', 'stale');
    old.close();
    const index = new SearchIndex(file);
    const id = '00000000-0000-4000-8000-000000000001';
    const item = { schemaVersion: 1, id, title: 'Fresh title', kind: 'prompt', description: 'described', tags: [], collection: '', source: '', licence: 'Unknown', status: 'captured', revision: 'a'.repeat(64), favourite: false, order: 1, createdAt: '2026-09-27', updatedAt: '2026-09-27', deletedAt: null, origin: null } as unknown as Item;
    index.rebuild([{ item, load: () => ({ content: 'fresh body' }) as never }]);
    assert.deepEqual(index.search('fresh'), [id]);
    assert.deepEqual(index.search('stale'), []);
    assert.deepEqual(index.search('described', true), [id]);
    index.close();
    // What an older build does on start: create its table if missing, clear it and insert five columns. It must not fail.
    const older = new DatabaseSync(file);
    older.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE IF NOT EXISTS items USING fts5(id UNINDEXED,title,tags,collection,content);');
    older.exec('DELETE FROM items'); older.prepare('INSERT INTO items VALUES(?,?,?,?,?)').run(id, 'Fresh title', '', '', 'fresh body');
    assert.equal((older.prepare('SELECT id FROM items WHERE items MATCH ?').all('"fresh"*') as { id: string }[]).length, 1);
    older.close();
    // And the new build opens it again afterwards.
    const again = new SearchIndex(file);
    again.rebuild([{ item, load: () => ({ content: 'fresh body' }) as never }]);
    assert.deepEqual(again.search('fresh'), [id]);
    again.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a workbench reopened on an old index file searches normally', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-better-search-'));
  const open = () => new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  try {
    const wb = open(); wb.setExperiment({ id: 'betterSearch', enabled: true });
    const { titled } = library(wb);
    const file = path.join(wb.local, 'search.sqlite'); wb.close();
    const db = new DatabaseSync(file); db.exec('DROP TABLE IF EXISTS entries; CREATE VIRTUAL TABLE items USING fts5(id UNINDEXED,title,tags,collection,content);'); db.close();
    const reopened = open();
    try { assert.equal(reopened.rankedSearch('deploy').items[0].id, titled.id); assert.equal(reopened.search('checklist')[0].id, titled.id); } finally { reopened.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('typo tolerance grows with word length and counts a swapped pair once', () => {
  assert.equal(editDistance('reveiw', 'review'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  const items = [{ title: 'code-review', tags: [] }, { title: 'Cat facts', tags: [] }, { title: 'Deployment runbook', tags: ['ops'] }];
  assert.deepEqual(closeMatches('reveiw', items).map(i => i.title), ['code-review']);
  assert.deepEqual(closeMatches('cot', items), [], 'three letters must be exact');
  assert.deepEqual(closeMatches('deploymnet runbok', items).map(i => i.title), ['Deployment runbook']);
  assert.deepEqual(closeMatches('depl', items).map(i => i.title), ['Deployment runbook'], 'a prefix counts');
  assert.deepEqual(closeMatches('reveiw ops', items), [], 'every word must match');
});

test('a limited edit distance stops early and agrees with the full one up to the limit', () => {
  assert.equal(editDistance('abcdefgh', 'zyxwvuts', 1), 2, 'over the limit after the first rows');
  const words = ['review', 'reveiw', 'rveiew', 'deploy', 'depolyment', 'kitten', 'sitting', 'abcd', 'badc', 'acbd', 'ca', 'abc', '', 'runbook', 'runbok'];
  for (const a of words) for (const b of words) for (const limit of [0, 1, 2, 3]) {
    assert.equal(Math.min(editDistance(a, b, limit), limit + 1), Math.min(editDistance(a, b), limit + 1), `${a} → ${b} within ${limit}`);
  }
});

test('relevance order keeps collection sources leading, and commands match by word prefix', () => {
  const make = (id: string, kind: Item['kind']) => ({ id, kind }) as Item;
  const items = [make('a', 'prompt'), make('b', 'source'), make('c', 'prompt')];
  assert.deepEqual(rankItems(items, ['c', 'a', 'b']).map(i => i.id), ['c', 'a', 'b']);
  assert.deepEqual(rankItems(items, ['c', 'a', 'b'], true).map(i => i.id), ['b', 'c', 'a']);
  assert.deepEqual(rankItems(items, ['c']).map(i => i.id), ['c', 'a', 'b'], 'unranked items keep their place after ranked ones');
  assert.deepEqual(matchCommands('set').map(c => c.id), ['settings']);
  assert.deepEqual(matchCommands('go act').map(c => c.id), ['activity']);
  assert.equal(matchCommands('').length, 7);
});
