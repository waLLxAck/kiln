import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { initialiseRepository } from '../packages/git/standard';
import { GitQueue } from '../packages/git/queue';
import type { PullResult } from '../packages/git/sync';
import { buildReport, cellFor, summarise, targetLocations } from '../packages/fleet/model';
import { machineReportSchema, type Approval, type FleetView, type Item, type MachineReport, type Target } from '../packages/protocol/schema';

const skill = (name: string) => `---\nname: ${name}\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff. Verify claims.\n`;
const approveArgs = (item: { id: string; revision: string }) => ({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });

// Organisation commits (installs.json after an install) go out only when a test flushes them: on a timer they would land at a
// load-dependent moment in the middle of a test and change what GitHub has. The Git queue test below covers them racing reports.
process.env.KILN_ORGANISE_DELAY_MS = '3600000';
/** Two machines sharing one bare "GitHub": A created the library, B cloned it. Each has its own private data and home folder. */
function fleet(fetchEveryMs = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln fleet '));
  const origin = path.join(root, 'origin.git'); execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  const created = initialiseRepository({ parent: path.join(root, 'a'), name: 'library' }); assert.ok(created.committed, created.message);
  execFileSync('git', ['-C', created.root, 'remote', 'add', 'origin', origin], { windowsHide: true });
  // Windows runners check files out with CRLF (core.autocrlf), which makes Kiln's infrastructure look edited and blocks publishing;
  // both library copies must hold exactly what Kiln wrote or committed.
  execFileSync('git', ['-C', created.root, 'config', 'core.autocrlf', 'false'], { windowsHide: true });
  execFileSync('git', ['-C', created.root, 'push', '-q', '-u', 'origin', 'HEAD'], { windowsHide: true, stdio: 'ignore' });
  const machine = (name: string, library: string) => {
    const home = path.join(root, name, 'home'); fs.mkdirSync(home, { recursive: true });
    const wb = new Workbench(library, path.join(root, name, 'private'));
    const router = new Router(wb, { composer: null, fleet: { appVersion: '9.9.9', fetchEveryMs } });
    const git = (...args: string[]) => execFileSync('git', ['-C', library, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    return { home, library, wb, router, git, view: (fetch = true) => router.call('fleet.view', { fetch }) as Promise<FleetView> };
  };
  const a = machine('a', created.root);
  const clone = () => { const library = path.join(root, 'b', 'library'); execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, library], { windowsHide: true }); return machine('b', library); };
  const onGitHub = (id: string) => machineReportSchema.parse(JSON.parse(execFileSync('git', ['-C', origin, 'show', `main:workbench/machines/${id}.json`], { encoding: 'utf8' })));
  const clones: ReturnType<typeof machine>[] = [a];
  return { root, origin, a, clone: () => { const b = clone(); clones.push(b); return b; }, onGitHub, async close() {
    for (const m of clones) { m.router.fleet.stop(); m.router.flushOrganisation(); }
    await Promise.all(clones.map(async m => {
      await Promise.all([m.router.fleet.idle(), m.router.publisher.idle()]);
      await m.router.gitQueue.idle();
    }));
    for (const m of clones) m.wb.close();
    // Yield while removing so Windows can finish closing the directory watchers.
    await fs.promises.rm(root, { recursive: true, force: true });
  } };
}

test('fleet fixture cleanup waits for an already queued report before removing machine data', async () => {
  const f = fleet();
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  f.a.router.gitQueue.run(() => gate);
  f.a.router.call('fleet.report');
  const reporting = f.a.router.fleet.idle();
  const closing = f.close();
  release();
  await reporting;
  await closing;
  try { assert.equal(fs.existsSync(f.root), false, 'completed background work cannot recreate a removed fixture'); }
  finally { await fs.promises.rm(f.root, { recursive: true, force: true }); }
});

test('publisher idle waits for organisation metadata loading and the job it queues', async () => {
  const f = fleet();
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  try {
    const { a } = f;
    const item = a.wb.create({ title: 'Moved skill', kind: 'skill', content: skill('moved-skill') });
    a.router.approve(approveArgs(item)); await a.router.publisher.idle();
    a.git('commit', '--allow-empty', '-m', 'Advance HEAD beyond the cached metadata');
    const committed = a.router.publisher.committed, load = committed.load.bind(committed);
    committed.load = async wb => { await gate; await load(wb); };
    a.router.call('items.move', { ids: [item.id], collection: 'Reviews' });
    a.router.flushOrganisation();
    let settled = false;
    const idle = a.router.publisher.idle().then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'metadata loading is still publishing work');
    release(); await idle;
    const published = JSON.parse(execFileSync('git', ['-C', f.origin, 'show', `main:workbench/items/${item.id}/item.json`], { encoding: 'utf8' }));
    assert.equal(published.collection, 'Reviews', 'idle includes the job created by the metadata load');
  } finally { release(); await f.close(); }
});

test('machines report through GitHub, mark each other remotely, and the owner keeps and installs what was marked', async () => {
  const f = fleet();
  try {
    const { a } = f;
    const item = a.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    a.router.approve(approveArgs(item)); await a.router.publisher.idle();
    assert.equal(a.router.publisher.list()[0].status, 'done');
    const agents = a.wb.enroll({ name: 'Agents', root: a.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    const project = path.join(f.root, 'a', 'Projects', 'game'); fs.mkdirSync(project, { recursive: true });
    a.wb.enroll({ name: 'Game', root: project, provider: 'claude', scope: 'project', profile: 'Project' });
    a.router.call('skills.install', { itemId: item.id, targetId: agents.id, confirm: true });

    // A reports: portable keys, no paths, and only when something changed.
    const self = (await a.view()).self;
    a.router.call('fleet.report'); await a.router.fleet.idle();
    assert.equal(a.router.fleet.publishState().state, 'shared');
    const reportA = f.onGitHub(self.id);
    assert.equal(reportA.appVersion, '9.9.9');
    assert.deepEqual(reportA.locations.map(l => l.key), ['agents', 'project:game:claude']);
    assert.deepEqual(reportA.copies[item.id], { agents: { revision: item.revision, state: 'installed' } });
    const text = JSON.stringify(reportA);
    for (const secret of [f.root, a.home, project, os.homedir()]) assert.ok(!text.includes(secret), `report names no machine path (${secret})`);
    assert.equal(a.git('status', '--porcelain', '--', 'workbench/machines'), '', 'the checkout matches the committed report');
    const commits = a.git('rev-list', '--count', 'HEAD');
    a.router.call('fleet.report'); await a.router.fleet.idle();
    assert.equal(a.git('rev-list', '--count', 'HEAD'), commits, 'an unchanged report is not committed again');

    // B clones, sets up only Claude, and reports. A sees it after a fetch.
    const b = f.clone();
    b.router.call('fleet.rename', { name: 'Laptop' });
    b.wb.enroll({ name: 'Claude', root: b.home, provider: 'claude', scope: 'personal', profile: 'Personal' });
    await b.router.fleet.idle();
    const idB = (await b.view(false)).self.id;
    assert.notEqual(idB, self.id);
    assert.equal(f.onGitHub(idB).name, 'Laptop');
    const seen = await a.view();
    assert.equal(seen.source, 'upstream');
    assert.deepEqual(seen.machines.map(m => [m.name, m.locations.map(l => l.key)]), [['Laptop', ['claude']]]);

    // A marks the skill for B's Claude folder: a small commit to B's file only.
    await assert.rejects(async () => a.router.call('fleet.mark', { machineId: idB, itemId: item.id, location: 'codex', wanted: true }), /no such location/);
    a.router.call('fleet.mark', { machineId: idB, itemId: item.id, location: 'claude', wanted: true }); await a.router.fleet.idle();
    assert.deepEqual(f.onGitHub(idB).wanted, { [item.id]: ['claude'] });
    assert.equal(f.onGitHub(idB).name, 'Laptop', 'the rest of B’s report is untouched');
    assert.deepEqual((await a.view(false)).pending, []);

    // B changes something without pulling: the report goes on top of GitHub's branch, keeping A's request, and B's checkout is left alone.
    const before = b.git('rev-parse', 'HEAD');
    const other = path.join(f.root, 'b', 'Projects', 'site'); fs.mkdirSync(other, { recursive: true });
    b.wb.enroll({ name: 'Site', root: other, provider: 'codex', scope: 'project', profile: 'Project' });
    b.router.call('fleet.report'); await b.router.fleet.idle();
    assert.equal(b.router.fleet.publishState().state, 'shared');
    assert.equal(b.git('rev-parse', 'HEAD'), before, 'HEAD is untouched; the next pull fast-forwards over the report');
    const reportB = f.onGitHub(idB);
    assert.deepEqual(reportB.locations.map(l => l.key), ['claude', 'project:site']);
    assert.deepEqual(reportB.wanted, { [item.id]: ['claude'] });
    b.git('pull', '-q', '--ff-only');
    assert.equal(b.git('status', '--porcelain', '--', 'workbench/machines'), '');

    // On B, "Install everything marked for this machine" installs it.
    assert.deepEqual((await b.view(false)).wanted, { [item.id]: ['claude'] });
    const synced = await b.router.call('skills.sync') as { itemId: string; location?: string; result: string }[];
    assert.deepEqual(synced.map(r => [r.location, r.result]), [['claude', 'installed approved revision']]);
    assert.equal(fs.readFileSync(path.join(b.home, '.claude', 'skills', 'careful-review', 'SKILL.md'), 'utf8'), skill('careful-review'));
    assert.equal(b.wb.approvals().length, 1, 'sync never creates approvals');
    b.router.call('fleet.report'); await b.router.fleet.idle();
    assert.deepEqual(f.onGitHub(idB).copies[item.id], { claude: { revision: item.revision, state: 'installed' } });

    // A withdraws the request.
    a.router.call('fleet.mark', { machineId: idB, itemId: item.id, location: 'claude', wanted: false }); await a.router.fleet.idle();
    assert.deepEqual(f.onGitHub(idB).wanted, {});
    assert.deepEqual(f.onGitHub(idB).copies[item.id], { claude: { revision: item.revision, state: 'installed' } }, 'unmarking removes nothing');
  } finally { await f.close(); }
});

test('sync on the owner fetches first, so a mark pushed from elsewhere after its last fetch installs without a pull', async () => {
  const f = fleet();
  try {
    const { a } = f;
    const item = a.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    a.router.approve(approveArgs(item)); await a.router.publisher.idle();
    const b = f.clone();
    b.wb.enroll({ name: 'Agents', root: b.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    b.router.call('fleet.report'); await b.router.fleet.idle();
    const idB = (await b.view(false)).self.id;
    await a.view();
    a.router.call('fleet.mark', { machineId: idB, itemId: item.id, location: 'agents', wanted: true }); await a.router.fleet.idle();
    assert.deepEqual(f.onGitHub(idB).wanted, { [item.id]: ['agents'] });
    assert.deepEqual((await b.view(false)).wanted, {}, 'B has not fetched since the mark');

    const synced = await b.router.call('skills.sync') as { location?: string; result: string }[];
    assert.deepEqual(synced.map(r => [r.location, r.result]), [['agents', 'installed approved revision']]);
    assert.ok(fs.existsSync(path.join(b.home, '.agents', 'skills', 'careful-review', 'SKILL.md')));
  } finally { await f.close(); }
});

test('when this checkout and GitHub have both moved, reports and marks wait for the merge, then apply on the newer files', async () => {
  const f = fleet();
  try {
    const { a } = f;
    const item = a.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    a.router.approve(approveArgs(item)); await a.router.publisher.idle();
    const b = f.clone();
    b.wb.enroll({ name: 'Claude', root: b.home, provider: 'claude', scope: 'personal', profile: 'Personal' });
    b.router.call('fleet.report'); await b.router.fleet.idle();
    const idA = (await a.view(false)).self.id, idB = (await b.view(false)).self.id;
    a.wb.enroll({ name: 'Agents', root: a.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    a.router.call('fleet.report'); await a.router.fleet.idle();
    // B has a commit GitHub lacks (an approval whose push failed, say), and A marks the skill for B meanwhile.
    b.git('commit', '-q', '--allow-empty', '-m', 'Local work');
    await a.view(); await b.view();
    a.router.call('fleet.mark', { machineId: idB, itemId: item.id, location: 'claude', wanted: true }); await a.router.fleet.idle();
    b.router.call('fleet.mark', { machineId: idA, itemId: item.id, location: 'agents', wanted: true });
    const other = path.join(f.root, 'b', 'Projects', 'site'); fs.mkdirSync(other, { recursive: true });
    b.wb.enroll({ name: 'Site', root: other, provider: 'codex', scope: 'project', profile: 'Project' });
    b.router.call('fleet.report'); await b.router.fleet.idle();
    assert.equal(b.router.fleet.publishState().state, 'behind');
    assert.equal((await b.view(false)).pending.length, 1, 'the mark waits in private data');
    assert.deepEqual(f.onGitHub(idA).wanted, {});
    assert.equal(b.git('rev-list', '--count', '@{u}..HEAD'), '1', 'nothing extra was committed locally');
    // After the merge, both go out, and B keeps A's request.
    b.git('-c', 'pull.rebase=false', 'pull', '-q', '--no-edit');
    await b.router.call('git.sync', { action: 'fetch' }); await b.router.fleet.idle();
    assert.equal(b.router.fleet.publishState().state, 'shared');
    assert.deepEqual(f.onGitHub(idA).wanted, { [item.id]: ['agents'] });
    assert.deepEqual(f.onGitHub(idB).wanted, { [item.id]: ['claude'] });
    assert.deepEqual(f.onGitHub(idB).locations.map(l => l.key), ['claude', 'project:site']);
    assert.deepEqual((await b.view(false)).pending, []);
    // Marking needs an approval.
    const draft = a.wb.create({ title: 'Draft', kind: 'skill', content: skill('draft-skill') });
    assert.throws(() => a.router.call('fleet.mark', { machineId: idB, itemId: draft.id, location: 'claude', wanted: true }), /Approve this item/);
  } finally { await f.close(); }
});

test('Update all outdated uses the one update path: latest approval, drafts stay unapproved, edited copies are skipped and reported', async () => {
  const f = fleet();
  try {
    const { a } = f;
    const item = a.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    const agents = a.wb.enroll({ name: 'Agents', root: a.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    const claude = a.wb.enroll({ name: 'Claude', root: a.home, provider: 'claude', scope: 'personal', profile: 'Personal' });
    for (const target of [agents, claude]) a.router.call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
    const edited = path.join(a.home, '.claude', 'skills', 'careful-review', 'SKILL.md');
    fs.appendFileSync(edited, 'Edited by hand.\n');
    const v2 = a.wb.update({ id: item.id, expect: item.revision, summary: 'Second', value: { ...a.wb.authoring(item.id), content: skill('careful-review') + '\nCheck tests.\n' } });
    a.wb.approve(approveArgs(v2));
    let report = a.router.call('fleet.live') as MachineReport;
    assert.equal(report.copies[item.id].agents.state, 'outdated');
    assert.equal(report.copies[item.id].claude.state, 'changed');
    const v3 = a.wb.update({ id: item.id, expect: v2.revision, summary: 'Third', value: { ...a.wb.authoring(item.id), content: skill('careful-review') + '\nDraft only.\n' } });
    const [result, ...rest] = a.router.call('skills.updateOutdated') as { itemId: string; title: string; revision: string; approved: boolean; updated: { label: string }[]; skipped: { label: string; reason: string }[] }[];
    assert.equal(rest.length, 0, 'one entry per item with an outdated copy');
    assert.deepEqual({ itemId: result.itemId, title: result.title, revision: result.revision, approved: result.approved }, { itemId: item.id, title: 'Careful review', revision: v2.revision, approved: false });
    assert.deepEqual(result.updated.map(c => c.label), ['Agents']);
    assert.deepEqual(result.skipped.map(c => [c.label, c.reason]), [['Claude', 'edited outside Kiln']]);
    assert.match(fs.readFileSync(edited, 'utf8'), /Edited by hand/, 'an edited copy is never overwritten');
    report = a.router.call('fleet.live') as MachineReport;
    assert.deepEqual(report.copies[item.id].agents, { revision: v2.revision, state: 'installed' });
    assert.ok(!a.wb.approvals().some(x => x.revision === v3.revision), 'the newer draft stays unapproved');
    assert.deepEqual(a.router.call('skills.updateOutdated'), [], 'nothing left to update');
  } finally { await f.close(); }
});

test('a copy installed from an earlier revision with the same files is not outdated', async () => {
  const f = fleet();
  try {
    const { a } = f;
    const item = a.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    const agents = a.wb.enroll({ name: 'Agents', root: a.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    a.router.call('skills.install', { itemId: item.id, targetId: agents.id, confirm: true });
    // Only the tags change: a new revision, but the installed files are what it would write.
    const v2 = a.wb.update({ id: item.id, expect: item.revision, summary: 'Tagged', value: { ...a.wb.authoring(item.id), tags: ['review'] } });
    a.wb.approve(approveArgs(v2));
    const report = a.router.call('fleet.live') as MachineReport;
    assert.deepEqual(report.copies[item.id].agents, { revision: v2.revision, state: 'installed' });
    assert.deepEqual(a.router.call('skills.updateOutdated'), []);
  } finally { await f.close(); }
});

test('location keys and cells: project names, duplicate folders, agent clients, approvals and marks', () => {
  const target = (root: string, provider: Target['provider'], scope: Target['scope'], skillFolder?: '.codex/skills'): Target => ({ id: crypto.randomUUID(), name: root, root, provider, scope, profile: 'P', machine: 'local', ...(skillFolder ? { skillFolder } : {}) });
  const targets = [target('/home/u', 'claude', 'personal'), target('/home/u', 'codex', 'personal'), target('/home/u', 'codex', 'personal', '.codex/skills'), target('C:\\work\\api', 'codex', 'project'), target('C:\\work\\api', 'claude', 'project'), target('/srv/api', 'codex', 'project')];
  assert.deepEqual(targetLocations(targets, '/home/u').map(l => [l.key, l.label]), [['agents', 'Agents'], ['claude', 'Claude'], ['codex', 'Codex-specific'], ['project:api', 'api'], ['project:api (2):claude', 'api (2) · Claude'], ['project:api (2)', 'api (2)']]);
  const at = new Date().toISOString();
  const base = { schemaVersion: 1 as const, favourite: false, order: 0, createdAt: at, updatedAt: at, deletedAt: null, origin: null, description: '', tags: [], collection: 'Personal', source: '', licence: 'Unknown', status: 'approved' as const };
  const skillItem: Item = { ...base, id: crypto.randomUUID(), title: 'Skill', kind: 'skill', revision: 'a'.repeat(64) };
  const agentItem: Item = { ...base, id: crypto.randomUUID(), title: 'Agent', kind: 'agent', revision: 'b'.repeat(64), agent: { provider: 'claude', filename: 'agent.md' } };
  const approval = (itemId: string, revision: string): Approval => ({ schemaVersion: 1, id: crypto.randomUUID(), itemId, revision, reviewer: 'H', scope: 'S', note: '', evidence: [], waivedChecks: '', createdAt: at, trust: 'local' });
  const approvals = [approval(skillItem.id, 'c'.repeat(64)), approval(agentItem.id, agentItem.revision)];
  const identity = { id: crypto.randomUUID(), name: 'Desk', platform: 'linux' };
  const report = buildReport(identity, '1.0.0', { items: [skillItem, agentItem], approvals, targets, receipts: [], installations: [], home: '/home/u' }, { [skillItem.id]: ['claude'] }, at);
  const location = (key: string) => report.locations.find(l => l.key === key)!;
  const copied = { ...report, copies: { [skillItem.id]: { agents: { revision: 'd'.repeat(64), state: 'installed' as const } } } };
  assert.equal(cellFor(skillItem, 'c'.repeat(64), copied, location('agents')).state, 'outdated', 'installed but older than the latest approval');
  assert.equal(cellFor(skillItem, 'c'.repeat(64), copied, location('claude')).state, 'marked');
  assert.equal(cellFor(skillItem, undefined, copied, location('codex')).state, 'unavailable');
  assert.equal(cellFor(agentItem, agentItem.revision, copied, location('agents')).state, 'unavailable', 'a Claude agent does not go in the Agents folder');
  assert.equal(cellFor(agentItem, agentItem.revision, copied, location('project:api (2):claude')).state, 'off');
  assert.deepEqual(summarise([skillItem, agentItem], approvals, copied), { copies: 1, installed: 0, changed: 0, outdated: 1, external: 0, marked: 1 });
});

test('the Git queue runs one job at a time, in the order asked, and carries on after a failure', async () => {
  const queue = new GitQueue(); let active = 0, most = 0; const order: number[] = [];
  // Later jobs are quicker, so any overlap would finish them first.
  const job = (n: number, fail = false) => queue.run(async () => {
    active++; most = Math.max(most, active);
    await new Promise(resolve => setTimeout(resolve, 20 - n * 4));
    order.push(n); active--;
    if (fail) throw new Error('push rejected');
    return n;
  });
  const results = await Promise.allSettled([job(1), job(2, true), job(3), queue.run(() => 4)]);
  assert.deepEqual(results.map(r => r.status === 'fulfilled' ? r.value : 'failed'), [1, 'failed', 3, 4]);
  assert.deepEqual(order, [1, 2, 3]); assert.equal(most, 1);
  await queue.idle(); assert.equal(queue.pending, 0);
});

test('a report, an organisation commit, an approval and a background fetch and pull at once: all reach GitHub, one Git job at a time', async () => {
  const f = fleet();
  try {
    const { a } = f;
    const moved = a.wb.create({ title: 'Moved skill', kind: 'skill', content: skill('moved-skill') });
    a.router.approve(approveArgs(moved)); await a.router.publisher.idle();
    // Another machine reports, so GitHub is ahead of this checkout: an approval pushed without catching up first would be rejected.
    const b = f.clone();
    b.wb.enroll({ name: 'Claude', root: b.home, provider: 'claude', scope: 'personal', profile: 'Personal' });
    b.router.call('fleet.report'); await b.router.fleet.idle();
    const idB = (await b.view(false)).self.id;

    let active = 0, most = 0;
    const run = a.router.gitQueue.run.bind(a.router.gitQueue);
    a.router.gitQueue.run = <T,>(task: () => T | Promise<T>) => run(async () => { active++; most = Math.max(most, active); try { return await task(); } finally { active--; } });
    a.wb.enroll({ name: 'Agents', root: a.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    const fresh = a.wb.create({ title: 'Fresh skill', kind: 'skill', content: skill('fresh-skill') });
    // All at once, none awaited: the background fetch and pull, an approval, a move of a published item, and a machine report.
    const fetched = a.router.call('sync.fetch', { maxAgeMs: 0 }) as Promise<unknown>;
    const pulled = a.router.call('sync.pull') as Promise<PullResult>;
    a.router.approve(approveArgs(fresh));
    a.router.call('items.move', { ids: [moved.id], collection: 'Reviews' }); assert.ok(a.router.flushOrganisation());
    a.router.call('fleet.report');
    await fetched;
    assert.deepEqual(await pulled, { status: 'pulled', count: 1 });
    await a.router.publisher.idle(); await a.router.fleet.idle(); await a.router.gitQueue.idle();

    assert.equal(most, 1, 'no two Git jobs overlapped');
    for (const job of a.router.publisher.list()) assert.equal(job.status, 'done', `${job.title}: ${job.error ?? ''}`);
    assert.equal(a.router.fleet.publishState().state, 'shared');
    assert.equal(execFileSync('git', ['-C', f.origin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), a.git('rev-parse', 'HEAD'), 'GitHub has everything, and nothing waits here');
    const onGitHub = (file: string) => JSON.parse(execFileSync('git', ['-C', f.origin, 'show', `main:workbench/${file}`], { encoding: 'utf8' }));
    assert.equal(onGitHub(`items/${fresh.id}/item.json`).status, 'approved', 'the approval');
    assert.equal(onGitHub(`items/${moved.id}/item.json`).collection, 'Reviews', 'the organisation commit');
    assert.deepEqual(f.onGitHub((await a.view(false)).self.id).locations.map(l => l.key), ['agents'], 'this machine’s report');
    assert.deepEqual(f.onGitHub(idB).locations.map(l => l.key), ['claude'], 'the other machine’s report is kept');
    assert.equal(a.git('status', '--porcelain', '--', 'workbench/machines'), '');
  } finally { await f.close(); }
});

test('a machine report rides a recent background fetch, and fetches again when GitHub has moved since', async () => {
  const f = fleet(60_000);
  try {
    const { a } = f;
    a.wb.enroll({ name: 'Agents', root: a.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    await a.router.call('sync.fetch', { maxAgeMs: 0 });
    const checked = a.router.fetcher.status().checkedAt; assert.ok(checked);
    a.router.call('fleet.report'); await a.router.fleet.idle();
    assert.equal(a.router.fleet.publishState().state, 'shared');
    await a.view();
    assert.equal(a.router.fetcher.status().checkedAt, checked, 'neither the report nor Machines fetched again');

    // Timestamps are compared below; let the clock move so a fetch in the same millisecond can't hide.
    await new Promise(resolve => setTimeout(resolve, 20));
    // Another machine approves something; A's fetch no longer has it, so A's next push is rejected and rebuilt after a fetch.
    const b = f.clone();
    const theirs = b.wb.create({ title: 'From the laptop', kind: 'skill', content: skill('from-the-laptop') });
    b.router.approve(approveArgs(theirs)); await b.router.publisher.idle();
    a.wb.enroll({ name: 'Claude', root: a.home, provider: 'claude', scope: 'personal', profile: 'Personal' });
    a.router.call('fleet.report'); await a.router.fleet.idle();
    assert.equal(a.router.fleet.publishState().state, 'shared');
    assert.notEqual(a.router.fetcher.status().checkedAt, checked, 'fetched after the rejection');
    const self = (await a.view(false)).self.id;
    assert.deepEqual(f.onGitHub(self).locations.map(l => l.key), ['agents', 'claude']);
    assert.ok(execFileSync('git', ['-C', f.origin, 'show', `main:workbench/items/${theirs.id}/item.json`], { encoding: 'utf8' }), 'the laptop’s approval is still on GitHub');
  } finally { await f.close(); }
});
test('until reporting is started, nothing publishes a machine report: installs, identity, sync and pulls commit no machines file', async () => {
  // The desktop app never calls fleet.start while multi-machine is off (apps/desktop/src/features.ts).
  const f = fleet();
  try {
    const { a } = f;
    const item = a.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    a.router.approve(approveArgs(item)); await a.router.publisher.idle();
    const agents = a.wb.enroll({ name: 'Agents', root: a.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    a.router.call('skills.install', { itemId: item.id, targetId: agents.id, confirm: true });
    assert.ok(a.router.flushOrganisation(), 'installs.json goes to GitHub'); await a.router.publisher.idle();
    const self = a.router.call('fleet.identity') as { id: string; name: string };
    assert.ok(self.id && self.name);

    // Another machine clones and syncs: installs.json still installs there.
    const b = f.clone();
    b.wb.enroll({ name: 'Agents', root: b.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    const synced = await b.router.call('skills.sync') as { itemId: string; result: string }[];
    assert.deepEqual(synced.map(r => [r.itemId, r.result]), [[item.id, 'installed approved revision']]);
    await b.router.call('git.sync', { action: 'fetch' });
    await a.router.fleet.idle(); await b.router.fleet.idle(); await a.router.gitQueue.idle(); await b.router.gitQueue.idle();

    assert.equal(execFileSync('git', ['-C', f.origin, 'ls-tree', '--name-only', 'main', 'workbench/machines/'], { encoding: 'utf8' }).trim(), '', 'no report on GitHub');
    for (const m of [a, b]) assert.equal(m.git('log', '--oneline', '--', 'workbench/machines'), '', 'no report committed');
    assert.equal(a.router.fleet.publishState().state, 'idle');
  } finally { await f.close(); }
});
