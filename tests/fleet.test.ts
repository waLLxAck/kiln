import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { initialiseRepository } from '../packages/git/standard';
import { buildReport, cellFor, summarise, targetLocations } from '../packages/fleet/model';
import { machineReportSchema, type Approval, type FleetView, type Item, type MachineReport, type Target } from '../packages/protocol/schema';

const skill = (name: string) => `---\nname: ${name}\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff. Verify claims.\n`;
const approveArgs = (item: { id: string; revision: string }) => ({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });

/** Two machines sharing one bare "GitHub": A created the library, B cloned it. Each has its own private data and home folder. */
function fleet() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln fleet '));
  const origin = path.join(root, 'origin.git'); execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  const created = initialiseRepository({ parent: path.join(root, 'a'), name: 'library' }); assert.ok(created.committed, created.message);
  execFileSync('git', ['-C', created.root, 'remote', 'add', 'origin', origin], { windowsHide: true });
  execFileSync('git', ['-C', created.root, 'push', '-q', '-u', 'origin', 'HEAD'], { windowsHide: true, stdio: 'ignore' });
  const machine = (name: string, library: string) => {
    const home = path.join(root, name, 'home'); fs.mkdirSync(home, { recursive: true });
    const wb = new Workbench(library, path.join(root, name, 'private'));
    const router = new Router(wb, { composer: null, fleet: { appVersion: '9.9.9', fetchEveryMs: 0 } });
    const git = (...args: string[]) => execFileSync('git', ['-C', library, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    return { home, library, wb, router, git, view: (fetch = true) => router.call('fleet.view', { fetch }) as Promise<FleetView> };
  };
  const a = machine('a', created.root);
  const clone = () => { const library = path.join(root, 'b', 'library'); execFileSync('git', ['clone', '-q', origin, library], { windowsHide: true }); return machine('b', library); };
  const onGitHub = (id: string) => machineReportSchema.parse(JSON.parse(execFileSync('git', ['-C', origin, 'show', `main:workbench/machines/${id}.json`], { encoding: 'utf8' })));
  const clones: ReturnType<typeof machine>[] = [a];
  return { root, origin, a, clone: () => { const b = clone(); clones.push(b); return b; }, onGitHub, close() { for (const m of clones) { m.router.fleet.stop(); m.wb.close(); } fs.rmSync(root, { recursive: true, force: true }); } };
}

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
    const synced = b.router.call('skills.sync') as { itemId: string; location?: string; result: string }[];
    assert.deepEqual(synced.map(r => [r.location, r.result]), [['claude', 'installed approved revision']]);
    assert.equal(fs.readFileSync(path.join(b.home, '.claude', 'skills', 'careful-review', 'SKILL.md'), 'utf8'), skill('careful-review'));
    assert.equal(b.wb.approvals().length, 1, 'sync never creates approvals');
    b.router.call('fleet.report'); await b.router.fleet.idle();
    assert.deepEqual(f.onGitHub(idB).copies[item.id], { claude: { revision: item.revision, state: 'installed' } });

    // A withdraws the request.
    a.router.call('fleet.mark', { machineId: idB, itemId: item.id, location: 'claude', wanted: false }); await a.router.fleet.idle();
    assert.deepEqual(f.onGitHub(idB).wanted, {});
    assert.deepEqual(f.onGitHub(idB).copies[item.id], { claude: { revision: item.revision, state: 'installed' } }, 'unmarking removes nothing');
  } finally { f.close(); }
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

    const synced = b.router.call('skills.sync') as { location?: string; result: string }[];
    assert.deepEqual(synced.map(r => [r.location, r.result]), [['agents', 'installed approved revision']]);
    assert.ok(fs.existsSync(path.join(b.home, '.agents', 'skills', 'careful-review', 'SKILL.md')));
  } finally { f.close(); }
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
    b.router.call('git.sync', { action: 'fetch' }); await b.router.fleet.idle();
    assert.equal(b.router.fleet.publishState().state, 'shared');
    assert.deepEqual(f.onGitHub(idA).wanted, { [item.id]: ['agents'] });
    assert.deepEqual(f.onGitHub(idB).wanted, { [item.id]: ['claude'] });
    assert.deepEqual(f.onGitHub(idB).locations.map(l => l.key), ['claude', 'project:site']);
    assert.deepEqual((await b.view(false)).pending, []);
    // Marking needs an approval.
    const draft = a.wb.create({ title: 'Draft', kind: 'skill', content: skill('draft-skill') });
    assert.throws(() => a.router.call('fleet.mark', { machineId: idB, itemId: draft.id, location: 'claude', wanted: true }), /Approve this item/);
  } finally { f.close(); }
});

test('outdated copies update to the latest approval without approving drafts', async () => {
  const f = fleet();
  try {
    const { a } = f;
    const item = a.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    const agents = a.wb.enroll({ name: 'Agents', root: a.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    a.router.call('skills.install', { itemId: item.id, targetId: agents.id, confirm: true });
    const v2 = a.wb.update({ id: item.id, expect: item.revision, summary: 'Second', value: { ...a.wb.authoring(item.id), content: skill('careful-review') + '\nCheck tests.\n' } });
    a.wb.approve(approveArgs(v2));
    let report = a.router.call('fleet.live') as MachineReport;
    assert.equal(report.copies[item.id].agents.state, 'outdated');
    const v3 = a.wb.update({ id: item.id, expect: v2.revision, summary: 'Third', value: { ...a.wb.authoring(item.id), content: skill('careful-review') + '\nDraft only.\n' } });
    assert.deepEqual((a.router.call('fleet.update') as { result: string }[]).map(r => r.result), ['installed approved revision']);
    report = a.router.call('fleet.live') as MachineReport;
    assert.deepEqual(report.copies[item.id].agents, { revision: v2.revision, state: 'installed' });
    assert.ok(!a.wb.approvals().some(x => x.revision === v3.revision), 'the newer draft stays unapproved');
  } finally { f.close(); }
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
