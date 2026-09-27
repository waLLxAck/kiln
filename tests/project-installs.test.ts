import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { WorkbenchError } from '../packages/domain/errors';
import { mergeProjects, projectKey, type KnownProject, type ProjectPreview } from '../packages/deployment/projects';
import type { Installation, Target } from '../packages/protocol/schema';

// Experimental projectInstalls ("Install into project folders").
const skill = (body: string) => `---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\n${body}\n`;
function fixture(on = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-project-installs-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  if (on) wb.setExperiment({ id: 'projectInstalls', enabled: true });
  const router = new Router(wb, { composer: null });
  const project = path.join(root, 'Web app'); fs.mkdirSync(project);
  const call = <T = any>(method: string, args: unknown = {}) => router.call(method, args) as T;
  const install = (itemId: string, location: string, extra: Record<string, unknown> = {}, where = project) => {
    const preview = call<ProjectPreview>('projects.preview', { itemId, root: where, location });
    return { preview, result: call('projects.install', { itemId, root: where, location, confirm: true, expect: { state: preview.state, current: preview.current }, ...extra }) };
  };
  return { root, wb, router, project, call, install, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const hasCode = (code: string) => (error: unknown) => error instanceof WorkbenchError && error.code === code;
const projectTargets = (wb: Workbench) => wb.targets().filter((t: Target) => t.scope === 'project');
const approve = (wb: Workbench, id: string) => wb.approve({ id, revision: wb.getItem(id).revision, reviewer: 'tester', scope: 'test', note: 'ok', waivedChecks: 'test' });

test('known projects merge the same folder by resolved path, case-insensitive only on Windows, most recent first', () => {
  const posix = mergeProjects([
    { root: '/work/app', source: 'installs', name: 'App', at: '2026-09-01T00:00:00.000Z' },
    { root: '/work/app/', source: 'experiments', at: '2026-09-20T00:00:00.000Z' },
    { root: '/work/lib/../app', source: 'config' },
    { root: '/work/App', source: 'config' },
    { root: '/work/old', source: 'experiments', at: '2026-01-01T00:00:00.000Z' },
    { root: 'relative/ignored', source: 'config' },
  ], 'linux');
  assert.deepEqual(posix.map(p => [p.root, p.name, p.sources.join('+'), p.lastUsed]), [
    ['/work/app', 'App', 'installs+experiments+config', '2026-09-20T00:00:00.000Z'],
    ['/work/old', 'old', 'experiments', '2026-01-01T00:00:00.000Z'],
    ['/work/App', 'App', 'config', null],
  ], 'a trailing slash or .. is the same folder; different case is a different folder off Windows; undated entries sort last');
  const windows = mergeProjects([{ root: 'C:\\Work\\App\\', source: 'experiments', at: '2026-09-02' }, { root: 'c:\\work\\app', source: 'config' }, { root: 'D:\\Other', source: 'installs', name: 'Other', at: '2026-09-01' }], 'win32');
  assert.deepEqual(windows.map(p => [p.root, p.sources.join('+')]), [['C:\\Work\\App', 'experiments+config'], ['D:\\Other', 'installs']]);
  assert.equal(projectKey('C:\\Work\\', 'win32'), projectKey('c:\\work', 'win32'));
  assert.notEqual(projectKey('/Work', 'linux'), projectKey('/work', 'linux'));
});

test('with the flag off every project-install operation refuses and nothing is enrolled', () => {
  const f = fixture(false);
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('One.') });
    for (const [method, args] of [['projects.known', {}], ['projects.preview', { itemId: item.id, root: f.project, location: 'claude' }], ['projects.install', { itemId: item.id, root: f.project, location: 'claude', confirm: true, expect: { state: 'absent', current: null } }], ['projects.forget', { root: f.project, confirm: true }]] as const)
      assert.throws(() => f.call(method, args), hasCode('CAPABILITY_UNSUPPORTED'), method);
    assert.equal(projectTargets(f.wb).length, 0);
    assert.equal(fs.existsSync(path.join(f.project, '.claude')), false);
  } finally { f.close(); }
});

test('installing into a project writes each location, enrols the folder once per client with a receipt, approves a draft, and stays out of installs.json', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('One.') });
    const first = f.install(item.id, 'claude');
    assert.equal(first.preview.state, 'absent'); assert.equal(first.preview.enrolled, false); assert.equal(first.preview.approved, false);
    assert.equal(first.preview.destination, path.join(f.project, '.claude', 'skills', 'careful-review'));
    assert.equal(projectTargets(f.wb).length, 1, 'enrolled on install, not on preview');
    assert.equal(fs.readFileSync(path.join(f.project, '.claude', 'skills', 'careful-review', 'SKILL.md'), 'utf8'), skill('One.'));
    assert.ok(f.wb.approvals().some(a => a.itemId === item.id && a.revision === item.revision && a.trust === 'local'), 'installing a draft approves exactly this revision, as for personal installs');
    const [claude] = projectTargets(f.wb);
    assert.deepEqual([claude.name, claude.provider, path.resolve(claude.root)], ['Web app', 'claude', path.resolve(f.project)]);
    const receipt = f.router.deployments.receipts().find(r => r.targetId === claude.id && r.status === 'applied');
    assert.equal(receipt?.destination, first.preview.destination);
    f.install(item.id, 'agents'); f.install(item.id, 'copilot');
    assert.ok(fs.existsSync(path.join(f.project, '.agents', 'skills', 'careful-review', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(f.project, '.github', 'skills', 'careful-review', 'SKILL.md')), 'Copilot project skills live in .github/skills');
    assert.deepEqual(projectTargets(f.wb).map(t => t.provider).sort(), ['claude', 'codex', 'copilot']);
    // The same folder spelled differently reuses the enrolled target; the install is recognised as already there.
    const again = f.call<ProjectPreview>('projects.preview', { itemId: item.id, root: `${f.project}${path.sep}`, location: 'claude' });
    assert.equal(again.enrolled, true); assert.equal(again.state, 'installed');
    f.install(item.id, 'claude', {}, `${f.project}${path.sep}`);
    assert.equal(projectTargets(f.wb).length, 3, 'no duplicate target for the same folder and client');
    assert.deepEqual(f.wb.installs(), {}, 'project installs are machine-specific and never recorded in installs.json');
    assert.equal(fs.existsSync(path.join(f.wb.canonical, 'installs.json')) ? Object.keys(JSON.parse(fs.readFileSync(path.join(f.wb.canonical, 'installs.json'), 'utf8'))).length : 0, 0);
    const copies = f.call<Installation[]>('deploy.installations', { itemId: item.id }).filter(i => i.scope === 'project');
    assert.deepEqual(copies.map(c => [c.location, c.state]).sort(), [['agents', 'installed'], ['claude', 'installed'], ['copilot', 'installed']]);
    const known = f.call<KnownProject[]>('projects.known', { recent: [{ path: f.project, at: '2020-01-01T00:00:00.000Z' }] });
    assert.equal(known.length, 1); assert.deepEqual(known[0].sources, ['installs', 'experiments']); assert.equal(known[0].targets.length, 3); assert.equal(known[0].managed, 3);
  } finally { f.close(); }
});

test('preview states and drift checks: an existing identical copy is adopted, a different one needs confirmation and is set aside', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('One.') }); approve(f.wb, item.id);
    const destination = path.join(f.project, '.agents', 'skills', 'careful-review');
    fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'SKILL.md'), skill('One.'));
    assert.equal(f.install(item.id, 'agents').preview.state, 'identical');
    assert.equal(f.call<ProjectPreview>('projects.preview', { itemId: item.id, root: f.project, location: 'agents' }).state, 'installed');
    // A folder changed between preview and install is not touched.
    const claudeCopy = path.join(f.project, '.claude', 'skills', 'careful-review');
    fs.mkdirSync(claudeCopy, { recursive: true }); fs.writeFileSync(path.join(claudeCopy, 'SKILL.md'), skill('Someone else.'));
    const preview = f.call<ProjectPreview>('projects.preview', { itemId: item.id, root: f.project, location: 'claude' });
    assert.equal(preview.state, 'differs');
    assert.throws(() => f.call('projects.install', { itemId: item.id, root: f.project, location: 'claude', confirm: true, expect: { state: preview.state, current: preview.current } }), hasCode('TARGET_UNMANAGED'), 'replacing needs confirmation');
    fs.appendFileSync(path.join(claudeCopy, 'SKILL.md'), 'More.\n');
    assert.throws(() => f.call('projects.install', { itemId: item.id, root: f.project, location: 'claude', replace: true, confirm: true, expect: { state: preview.state, current: preview.current } }), hasCode('TARGET_CHANGED'));
    assert.match(fs.readFileSync(path.join(claudeCopy, 'SKILL.md'), 'utf8'), /Someone else/);
    const { result } = f.install(item.id, 'claude', { replace: true }) as { result: { setAside: string } };
    assert.equal(fs.readFileSync(path.join(claudeCopy, 'SKILL.md'), 'utf8'), skill('One.'));
    assert.match(fs.readFileSync(path.join(result.setAside, 'SKILL.md'), 'utf8'), /Someone else/, 'the replaced folder is kept under private data');
    // Edited after Kiln installed it.
    fs.appendFileSync(path.join(claudeCopy, 'SKILL.md'), 'Local.\n');
    assert.equal(f.call<ProjectPreview>('projects.preview', { itemId: item.id, root: f.project, location: 'claude' }).state, 'drifted');
    assert.throws(() => f.call('projects.preview', { itemId: item.id, root: path.join(f.root, 'missing'), location: 'claude' }), hasCode('INVALID_PATH'));
    assert.throws(() => f.call('projects.preview', { itemId: item.id, root: f.wb.canonical, location: 'claude' }), hasCode('INVALID_TARGET'));
  } finally { f.close(); }
});

test('project copies take part in Update installs, and agent definitions go to the client folder in the project', () => {
  const f = fixture();
  try {
    f.wb.setExperiment({ id: 'installUpdates', enabled: true });
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('One.') });
    f.install(item.id, 'claude');
    f.wb.update({ id: item.id, expect: f.wb.getItem(item.id).revision, summary: 'Two', value: { ...f.wb.authoring(item.id), content: skill('Two.') } }); approve(f.wb, item.id);
    assert.equal(f.call<ProjectPreview>('projects.preview', { itemId: item.id, root: f.project, location: 'claude' }).state, 'older');
    assert.equal(f.call<Installation[]>('deploy.installations', { itemId: item.id }).find(i => i.scope === 'project')?.outdated, true);
    const update = f.call<{ updated: { label: string }[] }>('skills.update', { itemId: item.id });
    assert.deepEqual(update.updated.map(u => u.label), ['Web app']);
    assert.equal(fs.readFileSync(path.join(f.project, '.claude', 'skills', 'careful-review', 'SKILL.md'), 'utf8'), skill('Two.'));
    const agent = f.wb.create({ title: 'Reviewer', kind: 'agent', content: '---\nname: reviewer\ndescription: Review code\n---\nRead the diff.\n', agent: { provider: 'claude', filename: 'reviewer.md' } });
    const { preview } = f.install(agent.id, 'copilot');
    assert.equal(preview.location, null, 'the chosen skill location does not apply to agent definitions');
    assert.ok(fs.existsSync(path.join(f.project, '.claude', 'agents', 'reviewer.md')));
    assert.equal(projectTargets(f.wb).length, 1, 'the Claude target is shared by the skill and the agent definition');
  } finally { f.close(); }
});

test('forgetting a project refuses while Kiln-managed copies remain, then removes only the enrolment', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('One.') });
    f.install(item.id, 'claude'); f.install(item.id, 'agents');
    assert.throws(() => f.call('projects.forget', { root: f.project, confirm: true }), (error: unknown) => hasCode('COPIES_REMAIN')(error) && /2 copies.*Careful review/.test((error as Error).message));
    const [claude, codex] = ['claude', 'codex'].map(p => projectTargets(f.wb).find(t => t.provider === p)!);
    f.call('skills.remove', { itemId: item.id, targetId: claude.id, confirm: true });
    assert.throws(() => f.call('projects.forget', { root: f.project, confirm: true }), hasCode('COPIES_REMAIN'));
    f.call('skills.remove', { itemId: item.id, targetId: codex.id, confirm: true });
    const unrelated = path.join(f.project, 'README.md'); fs.writeFileSync(unrelated, 'kept');
    assert.deepEqual(f.call('projects.forget', { root: f.project, confirm: true }), { root: path.resolve(f.project), removed: 2 });
    assert.equal(projectTargets(f.wb).length, 0);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'kept');
    assert.throws(() => f.call('projects.forget', { root: f.project, confirm: true }), hasCode('TARGET_NOT_ENROLLED'));
    // Still offered from the other sources after forgetting.
    fs.writeFileSync(path.join(path.dirname(f.wb.local), 'config-projects.json'), JSON.stringify([f.project]));
    assert.deepEqual(f.call<KnownProject[]>('projects.known').map(p => [p.root, p.sources, p.targets.length]), [[path.resolve(f.project), ['config'], 0]]);
  } finally { f.close(); }
});
