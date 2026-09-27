import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { initialiseRepository } from '../packages/git/standard';
import { conflicts, finishMerge, mergeFetched, resolveItemConflict } from '../packages/git/conflicts';
import type { PullResult } from '../packages/git/sync';
import type { Item } from '../packages/protocol/schema';

process.env.KILN_ORGANISE_DELAY_MS = '20';
const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff. Verify claims.${extra}\n`;
const approveArgs = (item: { id: string; revision: string }) => ({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });
const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Side = ReturnType<typeof open>;
function open(library: string, local: string) {
  const wb = new Workbench(library, local);
  const router = new Router(wb, { composer: null, describer: null });
  return { wb, router, library, git: (...args: string[]) => run(library, ...args) };
}
/** One library pushed to a bare local "GitHub", and a second machine that cloned it. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln sync '));
  const created = initialiseRepository({ parent: root, name: 'library' }); assert.ok(created.committed, created.message);
  const origin = path.join(root, 'origin.git'); execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  run(created.root, 'config', 'core.autocrlf', 'false'); run(created.root, 'remote', 'add', 'origin', origin); run(created.root, 'push', '-u', 'origin', 'HEAD');
  const a = open(created.root, path.join(root, 'private-a'));
  const other = path.join(root, 'other'); execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, other], { windowsHide: true });
  const b = open(other, path.join(root, 'private-b'));
  return { root, origin, a, b, close() { a.wb.close(); b.wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
async function publish(side: Side, title: string, name: string, collection = 'Personal') {
  const item = side.wb.create({ title, kind: 'skill', content: skill(name), collection });
  side.router.approve(approveArgs(item)); await side.router.publisher.idle();
  const job = side.router.publisher.list()[0]; assert.equal(job.status, 'done', job.error);
  return side.wb.getItem(item.id);
}
async function edit(side: Side, item: Item, extra: string) {
  return side.router.call('items.update', { id: item.id, expect: side.wb.getItem(item.id).revision, summary: 'Draft', value: { ...side.wb.authoring(item.id), content: skill(side.wb.getRevision(item.id).content.match(/name: (\S+)/)![1], extra) } }) as Item;
}
async function catchUp(side: Side) { await side.router.fetcher.fetch(); return side.router.call('sync.pull') as PullResult; }
/** Every byte and modification time under an item folder, to prove a draft was not touched. */
function folderState(dir: string) {
  const state: Record<string, string> = {};
  const walk = (folder: string) => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const full = path.join(folder, entry.name); if (entry.isDirectory()) walk(full); else state[path.relative(dir, full)] = `${fs.readFileSync(full).toString('base64')}@${fs.statSync(full).mtimeMs}`; } };
  walk(dir); return state;
}

test('behind counts commits another machine pushed, after a background fetch', async () => {
  const w = world();
  try {
    assert.equal(w.a.wb.snapshot().git.behind, 0);
    await publish(w.b, 'From the laptop', 'from-the-laptop');
    assert.equal(w.a.wb.snapshot().git.behind, 0, 'nothing is known before a fetch');
    const status = await w.a.router.call('sync.fetch', { maxAgeMs: 0 }) as { error: string; fetchedAt: string | null };
    assert.equal(status.error, ''); assert.ok(status.fetchedAt);
    assert.equal(w.a.wb.snapshot().git.behind, 1);
    assert.equal(w.a.wb.snapshot().git.ahead, 0);
    // A recent attempt is not repeated.
    const again = await w.a.router.call('sync.fetch', { maxAgeMs: 60_000 }) as { checkedAt: string };
    assert.equal(again.checkedAt, (w.a.router.call('sync.status') as { checkedAt: string }).checkedAt);
  } finally { w.close(); }
});

test('an unreachable GitHub is recorded quietly and never throws', async () => {
  const w = world();
  try {
    w.a.git('remote', 'set-url', 'origin', path.join(w.root, 'missing.git'));
    const status = await w.a.router.call('sync.fetch') as { error: string; fetching: boolean };
    assert.ok(status.error, 'the failure is kept for the top bar'); assert.equal(status.fetching, false);
  } finally { w.close(); }
});

test('a pull beside drafts of other items keeps every draft byte-identical', async () => {
  const w = world();
  try {
    const published = await publish(w.a, 'Published here', 'published-here');
    assert.equal((await catchUp(w.b)).status, 'pulled');
    const draft = w.a.wb.create({ title: 'Brand new draft', kind: 'prompt', content: 'Only on this machine' });
    await edit(w.a, published, '\nA local edit.');
    const before = { draft: folderState(w.a.wb.itemDir(draft.id)), edited: folderState(w.a.wb.itemDir(published.id)) };
    const incoming = await publish(w.b, 'Made on the laptop', 'made-on-the-laptop');
    const result = await catchUp(w.a);
    assert.deepEqual(result, { status: 'pulled', count: 1 });
    assert.deepEqual(folderState(w.a.wb.itemDir(draft.id)), before.draft);
    assert.deepEqual(folderState(w.a.wb.itemDir(published.id)), before.edited);
    assert.ok(w.a.wb.snapshot().items.some(i => i.id === incoming.id), 'the pulled item shows at once');
    assert.equal(w.a.wb.getItem(published.id).status, 'captured', 'the local edit is still a draft');
    assert.equal(w.a.wb.snapshot().git.behind, 0);
  } finally { w.close(); }
});

test('a pull that would touch an item with a draft here is refused and names it', async () => {
  const w = world();
  try {
    const shared = await publish(w.a, 'Shared skill', 'shared-skill');
    await catchUp(w.b);
    await edit(w.a, shared, '\nEdited on the desktop.');
    const before = folderState(w.a.wb.itemDir(shared.id)), head = w.a.git('rev-parse', 'HEAD');
    const theirs = await edit(w.b, w.b.wb.getItem(shared.id), '\nEdited on the laptop.');
    w.b.router.approve(approveArgs(theirs)); await w.b.router.publisher.idle();
    const result = await catchUp(w.a);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.status === 'blocked' && result.items, [{ id: shared.id, title: 'Shared skill' }]);
    assert.deepEqual(folderState(w.a.wb.itemDir(shared.id)), before);
    assert.equal(w.a.git('rev-parse', 'HEAD'), head);
    assert.throws(() => mergeFetched(w.a.wb), (error: Error & { code?: string }) => error.code === 'GIT_DIRTY' && /“Shared skill”/.test(error.message));
    assert.throws(() => w.a.git('rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'no merge was started');
    assert.deepEqual(folderState(w.a.wb.itemDir(shared.id)), before);
  } finally { w.close(); }
});

test('an item approved here still pulls: bookkeeping-only changes to item.json are not drafts', async () => {
  const w = world();
  try {
    const shared = await publish(w.a, 'Approved here', 'approved-here');
    await catchUp(w.b);
    assert.ok(w.a.git('status', '--porcelain').includes(`${shared.id}/item.json`), 'approving leaves item.json differing from the published copy');
    const theirs = await edit(w.b, w.b.wb.getItem(shared.id), '\nImproved on the laptop.');
    w.b.router.approve(approveArgs(theirs)); await w.b.router.publisher.idle();
    assert.deepEqual(await catchUp(w.a), { status: 'pulled', count: 1 });
    assert.equal(w.a.wb.getItem(shared.id).revision, theirs.revision);
    assert.equal(w.a.wb.getItem(shared.id).status, 'approved');
  } finally { w.close(); }
});

test('Merge from GitHub runs beside drafts and commits neither the drafts nor their activity', async () => {
  const w = world();
  try {
    w.a.git('remote', 'set-url', 'origin', path.join(w.root, 'missing.git'));
    await w.a.router.approve(approveArgs(w.a.wb.create({ title: 'Local approval', kind: 'skill', content: skill('local-approval') }))); await w.a.router.publisher.idle();
    assert.equal(w.a.router.publisher.list()[0].status, 'failed');
    w.a.git('remote', 'set-url', 'origin', w.origin);
    const incoming = await publish(w.b, 'From GitHub', 'from-github');
    const draft = w.a.wb.create({ title: 'Secret draft', kind: 'prompt', content: 'Private working notes' });
    const before = folderState(w.a.wb.itemDir(draft.id));
    assert.equal((await catchUp(w.a)).status, 'diverged');
    const result = mergeFetched(w.a.wb);
    assert.deepEqual(result.paths, []);
    finishMerge(w.a.wb);
    assert.deepEqual(folderState(w.a.wb.itemDir(draft.id)), before);
    const merged = w.a.git('diff', '--name-only', 'HEAD^1', 'HEAD');
    assert.match(merged, new RegExp(incoming.id));
    assert.doesNotMatch(merged, new RegExp(draft.id));
    const tracked = w.a.git('ls-files', 'workbench/activity').split('\n').filter(Boolean);
    assert.ok(tracked.every(file => JSON.parse(fs.readFileSync(path.join(w.a.library, file), 'utf8')).itemId !== draft.id), 'draft activity stays local');
    assert.match(w.a.git('status', '--porcelain'), new RegExp(draft.id), 'the draft is still uncommitted');
  } finally { w.close(); }
});

test('organisation of published items is committed alone: never drafts, never draft content', async () => {
  const w = world();
  try {
    const first = await publish(w.a, 'First', 'first-skill'), second = await publish(w.a, 'Second', 'second-skill'), edited = await publish(w.a, 'Edited', 'edited-skill');
    const draft = w.a.wb.create({ title: 'Draft only', kind: 'prompt', content: 'Draft words' });
    await edit(w.a, edited, '\nUnapproved change.');
    const head = w.a.git('rev-parse', 'HEAD');
    // A reorder touching every row, a move of several items and a new collection in quick succession make one commit.
    w.a.router.call('items.reorder', { ids: [second.id, draft.id, first.id, edited.id] });
    w.a.router.call('items.move', { ids: [first.id, draft.id, edited.id], collection: 'Reviews' });
    w.a.router.call('collections.create', { name: 'Later' });
    await new Promise(resolve => setTimeout(resolve, 80));
    await w.a.router.publisher.idle();
    const jobs = w.a.router.publisher.list().filter(j => j.action === 'organise');
    assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'done', jobs[0].error);
    assert.equal(w.a.git('rev-list', '--count', `${head}..HEAD`), '1', 'one commit');
    const files = w.a.git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
    assert.deepEqual(files, [`workbench/items/${first.id}/item.json`, `workbench/items/${second.id}/item.json`, 'workbench/workbench.json'].sort());
    assert.match(w.a.git('log', '-1', '--format=%s'), /^Organise library: 2 items, collections$/);
    assert.equal(JSON.parse(w.a.git('show', `HEAD:workbench/items/${first.id}/item.json`)).collection, 'Reviews');
    assert.equal(run(w.origin, 'rev-parse', 'HEAD'), w.a.git('rev-parse', 'HEAD'), 'pushed');
    const status = w.a.git('status', '--porcelain');
    assert.doesNotMatch(status, new RegExp(`${first.id}/item.json`), 'the committed file matches the working one');
    assert.match(status, new RegExp(draft.id)); assert.match(status, new RegExp(`${edited.id}/content.md`));
    assert.equal(JSON.parse(w.a.git('show', `HEAD:workbench/items/${edited.id}/item.json`)).revision, edited.revision, 'the draft revision stays local');
    // Nothing new to publish: no further job.
    w.a.router.call('items.move', { ids: [first.id], collection: 'Reviews' });
    assert.equal(w.a.router.flushOrganisation(), null);
  } finally { w.close(); }
});

test('an organisation push that fails offline shows as failed until a later one reaches GitHub', async () => {
  const w = world();
  try {
    const item = await publish(w.a, 'Moved offline', 'moved-offline');
    w.a.git('remote', 'set-url', 'origin', path.join(w.root, 'missing.git'));
    w.a.router.call('items.move', { ids: [item.id], collection: 'Travel' });
    assert.ok(w.a.router.flushOrganisation()); await w.a.router.publisher.idle();
    const [failed] = w.a.router.publisher.list();
    assert.equal(failed.action, 'organise'); assert.equal(failed.status, 'failed'); assert.ok(failed.commit, 'committed locally');
    w.a.git('remote', 'set-url', 'origin', w.origin);
    w.a.router.call('items.move', { ids: [item.id], collection: 'Home' });
    assert.ok(w.a.router.flushOrganisation()); await w.a.router.publisher.idle();
    assert.ok(w.a.router.publisher.list().every(j => j.status === 'done'), 'the earlier failure is superseded');
    assert.equal(run(w.origin, 'rev-parse', 'HEAD'), w.a.git('rev-parse', 'HEAD'));
    assert.equal(JSON.parse(run(w.origin, 'show', `HEAD:workbench/items/${item.id}/item.json`)).collection, 'Home');
  } finally { w.close(); }
});

test('desired installs of published items are published by themselves', async () => {
  const w = world();
  try {
    const item = await publish(w.a, 'Installed skill', 'installed-skill');
    const home = path.join(w.root, 'agent home'); fs.mkdirSync(home);
    const target = w.a.wb.enroll({ name: 'Codex', root: home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    const head = w.a.git('rev-parse', 'HEAD');
    w.a.router.call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
    assert.ok(w.a.router.flushOrganisation());
    await w.a.router.publisher.idle();
    assert.equal(w.a.git('rev-list', '--count', `${head}..HEAD`), '1');
    assert.deepEqual(w.a.git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), ['workbench/installs.json']);
    assert.deepEqual(Object.keys(JSON.parse(w.a.git('show', 'HEAD:workbench/installs.json'))), [item.id]);
  } finally { w.close(); }
});

test('Approve & install after keeping publishes the desired install when the kept revision was already approved', async () => {
  const w = world();
  try {
    const item = await publish(w.a, 'Kept skill', 'kept-skill');
    const home = path.join(w.root, 'agent home'); fs.mkdirSync(home);
    const target = w.a.wb.enroll({ name: 'Claude', root: home, provider: 'claude', scope: 'personal', profile: 'Personal' });
    const folder = path.join(home, '.claude', 'skills', 'kept-skill'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), skill('kept-skill', '\nWritten by hand.'));
    const kept = w.a.router.call('deploy.keepCopy', { itemId: item.id, targetId: target.id, expect: item.revision }) as { revision: string };
    w.a.router.approve(approveArgs({ id: item.id, revision: kept.revision })); await w.a.router.publisher.idle();
    const head = w.a.git('rev-parse', 'HEAD');
    const adopted = w.a.router.call('deploy.approveKept', { itemId: item.id, targetId: target.id, expect: kept.revision }) as { approved: boolean };
    assert.equal(adopted.approved, false, 'already approved, so no approve job carries installs.json');
    assert.ok(w.a.router.flushOrganisation());
    await w.a.router.publisher.idle();
    assert.equal(w.a.git('rev-list', '--count', `${head}..HEAD`), '1');
    assert.deepEqual(w.a.git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), ['workbench/installs.json']);
    assert.deepEqual(Object.keys(JSON.parse(w.a.git('show', 'HEAD:workbench/installs.json'))), [item.id]);
  } finally { w.close(); }
});

/** Both machines approve different revisions of one item; this machine's approval never reached GitHub. */
async function divergedApprovals(w: ReturnType<typeof world>) {
  const shared = await publish(w.a, 'Contested', 'contested');
  await catchUp(w.b);
  w.a.git('remote', 'set-url', 'origin', path.join(w.root, 'missing.git'));
  const ours = await edit(w.a, shared, '\nDesktop wording.');
  w.a.router.approve(approveArgs(ours)); await w.a.router.publisher.idle();
  w.a.git('remote', 'set-url', 'origin', w.origin);
  const theirs = await edit(w.b, w.b.wb.getItem(shared.id), '\nLaptop wording.');
  w.b.router.approve(approveArgs(theirs)); await w.b.router.publisher.idle();
  assert.equal((await catchUp(w.a)).status, 'diverged');
  const result = mergeFetched(w.a.wb);
  assert.ok(result.items.some(i => i.id === shared.id), 'the item conflicts');
  return { id: shared.id, ours, theirs };
}

test('resolving a conflict with an approved side keeps its trusted approval', async () => {
  const w = world();
  try {
    const { id, theirs } = await divergedApprovals(w);
    resolveItemConflict(w.a.wb, { id, choice: 'theirs' });
    const item = w.a.wb.getItem(id);
    assert.equal(item.revision, theirs.revision); assert.equal(item.status, 'approved');
    assert.ok(w.a.wb.approvals().some(a => a.itemId === id && a.revision === theirs.revision && a.trust === 'local'));
    assert.equal(conflicts(w.a.wb).items.length, 0);
  } finally { w.close(); }
});

test('finishing a merge commits only the conflict records about the items it conflicted on', async () => {
  const w = world();
  try {
    const { id } = await divergedApprovals(w);
    // A record left behind by an earlier, abandoned merge, about an item this merge never touched.
    const other = w.a.wb.create({ title: 'Untouched draft', kind: 'prompt', content: 'Working notes' });
    w.a.wb.record('conflict_resolved', 'Selected ours after comparing diverging revisions', other.id);
    resolveItemConflict(w.a.wb, { id, choice: 'theirs' });
    finishMerge(w.a.wb);
    const committed = w.a.git('diff', '--name-only', 'HEAD^1', 'HEAD', '--', 'workbench/activity').split('\n').filter(Boolean).map(file => JSON.parse(fs.readFileSync(path.join(w.a.library, file), 'utf8')) as { kind: string; itemId: string | null });
    assert.deepEqual(committed.filter(r => r.kind === 'conflict_resolved').map(r => r.itemId), [id]);
    assert.ok(committed.every(r => r.itemId !== other.id), 'the stray record stays local');
    assert.match(w.a.git('status', '--porcelain', '--untracked-files=all', '--', 'workbench/activity'), /\?\? workbench\/activity\//, 'and uncommitted');
  } finally { w.close(); }
});

test('an approval that is not trusted here is not kept', async () => {
  const w = world();
  try {
    const { id, theirs } = await divergedApprovals(w);
    // Treat GitHub's approval as imported: shown as history, never trusted.
    for (const approval of w.a.wb.approvals().filter(a => a.revision === theirs.revision)) fs.writeFileSync(path.join(w.a.wb.canonical, 'approvals', `${approval.id}.json`), JSON.stringify({ ...approval, trust: 'imported' }, null, 2) + '\n');
    resolveItemConflict(w.a.wb, { id, choice: 'theirs' });
    assert.equal(w.a.wb.getItem(id).status, 'captured');
  } finally { w.close(); }
});

