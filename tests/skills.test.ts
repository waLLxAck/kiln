import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../packages/domain/workbench';
import { DeploymentService } from '../packages/deployment/service';
import { WorkbenchError } from '../packages/domain/errors';
import { AgentService } from '../packages/agent/service';

const skill = (name: string, body = 'Read the diff. Verify claims.') => `---\nname: ${name}\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\n${body}\n`;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-skills-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const deployment = new DeploymentService(wb);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const codex = wb.enroll({ name: 'Codex skills', root: home, provider: 'codex', scope: 'personal', profile: 'Personal' });
  const claude = wb.enroll({ name: 'Claude skills', root: home, provider: 'claude', scope: 'personal', profile: 'Personal' });
  return { root, wb, deployment, home, codex, claude, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const hasCode = (code: string) => (error: unknown) => error instanceof WorkbenchError && error.code === code;

test('Copilot personal and project skills use distinct folders and persist desired installs', () => {
  const f = fixture();
  try {
    const personal = f.wb.enroll({ name: 'Copilot', root: f.home, provider: 'copilot', scope: 'personal', profile: 'Personal' });
    const project = f.wb.enroll({ name: 'Copilot project', root: f.home, provider: 'copilot', scope: 'project', profile: 'Project' });
    const item = f.wb.create({ title: 'Review', kind: 'skill', content: skill('careful-review') });
    for (const [target, folder] of [[personal, '.copilot'], [project, '.github']] as const) {
      f.deployment.installSkill({ itemId: item.id, targetId: target.id, confirm: true });
      assert.equal(fs.readFileSync(path.join(f.home, folder, 'skills', 'careful-review', 'SKILL.md'), 'utf8'), skill('careful-review'));
    }
    assert.deepEqual(f.wb.installs()[item.id], ['copilot']);
    assert.equal(f.deployment.installations(item.id).filter(i => i.provider === 'copilot').length, 2);
    f.deployment.removeSkill({ itemId: item.id, targetId: project.id, confirm: true });
    assert.equal(fs.existsSync(path.join(f.home, '.copilot', 'skills', 'careful-review')), true);
  } finally { f.close(); }
});

test('one-click install approves, copies, records the desired install, and removal deletes only the copy', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    assert.equal(f.wb.approvals().length, 0);
    const result = f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    assert.equal(result.method, 'installed');
    const destination = path.join(f.home, '.agents', 'skills', 'careful-review');
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), skill('careful-review'));
    assert.equal(f.wb.approvals().length, 1, 'installing approved the revision');
    assert.deepEqual(f.wb.installs(), { [item.id]: ['codex'] });
    assert.equal(f.deployment.installations(item.id)[0].state, 'installed');
    // Installing again is a no-op rather than a second receipt.
    assert.equal(f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true }).method, 'unchanged');
    assert.equal(f.deployment.receipts().filter(r => r.status === 'applied').length, 1);
    const removed = f.deployment.removeSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    assert.equal(removed.method, 'uninstalled');
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(f.wb.installs(), {});
    assert.equal(f.wb.getItem(item.id).status, 'approved', 'the library keeps the skill and its approval');
  } finally { f.close(); }
});

test('an identical external copy is adopted instead of rewritten; a different one needs an explicit replace and is set aside', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    const destination = path.join(f.home, '.agents', 'skills', 'careful-review'); fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'SKILL.md'), skill('careful-review'));
    const before = fs.statSync(path.join(destination, 'SKILL.md')).mtimeMs;
    const found = f.deployment.installations(item.id)[0];
    assert.equal(found.state, 'external'); assert.equal(found.matches, true);
    assert.equal(f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true }).method, 'adopted');
    assert.equal(fs.statSync(path.join(destination, 'SKILL.md')).mtimeMs, before, 'adopting does not touch the files');
    assert.equal(f.deployment.installations(item.id)[0].state, 'installed');
    // Now the library moves on; the folder differs from the new revision.
    const next = f.wb.update({ id: item.id, expect: item.revision, summary: 'Sharpen', value: { ...f.wb.getRevision(item.id), content: skill('careful-review', 'Read the diff twice.') } });
    assert.equal(f.deployment.installSkill({ itemId: next.id, targetId: f.codex.id, confirm: true }).method, 'updated');
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), skill('careful-review', 'Read the diff twice.'));
    // Someone edits the installed copy by hand: Kiln refuses to overwrite silently.
    fs.writeFileSync(path.join(destination, 'SKILL.md'), 'edited by hand');
    assert.equal(f.deployment.installations(item.id)[0].state, 'drifted');
    assert.throws(() => f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true }), hasCode('TARGET_DRIFTED'));
    assert.throws(() => f.deployment.removeSkill({ itemId: item.id, targetId: f.codex.id, confirm: true }), hasCode('TARGET_DRIFTED'));
    const replaced = f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, replace: true, confirm: true });
    assert.ok(replaced.setAside && fs.existsSync(path.join(replaced.setAside, 'SKILL.md')), 'the hand-edited copy is kept, not deleted');
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), skill('careful-review', 'Read the diff twice.'));
  } finally { f.close(); }
});

test('a junction in the Claude folder is reported as linked, removal unlinks without touching the target, install replaces it with a copy', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    const real = path.join(f.home, '.agents', 'skills', 'careful-review'); fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'SKILL.md'), skill('careful-review'));
    const link = path.join(f.home, '.claude', 'skills', 'careful-review'); fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link, 'junction');
    const linked = f.deployment.installations(item.id).find(i => i.targetId === f.claude.id)!;
    assert.equal(linked.linked, true); assert.equal(linked.matches, true, 'the link is followed once to compare bytes');
    assert.equal(f.deployment.removeSkill({ itemId: item.id, targetId: f.claude.id, confirm: true }).method, 'unlinked');
    assert.equal(fs.existsSync(link), false); assert.equal(fs.existsSync(path.join(real, 'SKILL.md')), true);
    fs.symlinkSync(real, link, 'junction');
    assert.equal(f.deployment.installSkill({ itemId: item.id, targetId: f.claude.id, confirm: true }).method, 'installed');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), false, 'the junction became a real folder');
    assert.equal(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8'), skill('careful-review'));
  } finally { f.close(); }
});

test('scan lists unclaimed skill folders, import copies them into the library, and sync reproduces desired installs', () => {
  const f = fixture();
  try {
    const stray = path.join(f.home, '.agents', 'skills', 'stray-skill'); fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'SKILL.md'), skill('stray-skill'));
    fs.writeFileSync(path.join(stray, 'notes.md'), 'extra');
    fs.mkdirSync(path.join(f.home, '.agents', 'skills', 'no-skill-file'));
    const scan = f.deployment.scan(f.codex.id);
    assert.deepEqual(scan.entries.map(e => [e.name, e.hasSkillFile]), [['no-skill-file', false], ['stray-skill', true]]);
    const imported = f.deployment.importExternal({ targetId: f.codex.id, name: 'stray-skill' });
    assert.equal(imported.kind, 'skill'); assert.equal(imported.status, 'captured');
    assert.deepEqual(Object.keys(f.wb.getRevision(imported.id).files), ['notes.md']);
    assert.equal(f.deployment.scan(f.codex.id).entries.length, 1, 'the imported folder is now claimed');
    assert.equal(fs.existsSync(path.join(stray, 'SKILL.md')), true, 'the folder is left in place');
    // Desired state travels with the library: mark it installed for Claude, then sync fills the gap.
    f.wb.setInstall(imported.id, 'claude', true);
    assert.match(f.deployment.syncInstalls()[0].result, /No approved revision/);
    assert.equal(f.wb.approvals().length, 0);
    f.wb.approve({ id: imported.id, revision: imported.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });
    const report = f.deployment.syncInstalls();
    assert.deepEqual(report.map(r => r.result), ['installed approved revision']);
    assert.equal(fs.readFileSync(path.join(f.home, '.claude', 'skills', 'stray-skill', 'SKILL.md'), 'utf8'), skill('stray-skill'));
    assert.deepEqual(f.deployment.syncInstalls().map(r => r.result), ['already installed']);
  } finally { f.close(); }
});

test('purge is only allowed from the trash and removes the item with its approvals, experiments and desired installs', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Disposable', kind: 'skill', content: skill('disposable') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    f.wb.prepareTrial({ id: item.id, revision: item.revision, provider: 'manual', task: 'Try it', rubric: ['works'], case: 'typical' });
    assert.throws(() => f.wb.purge({ id: item.id, confirm: true }), hasCode('NOT_IN_TRASH'));
    f.wb.setMeta({ id: item.id, expect: item.revision, deleted: true });
    f.wb.purge({ id: item.id, confirm: true });
    assert.throws(() => f.wb.getItem(item.id), hasCode('ITEM_NOT_FOUND'));
    assert.equal(f.wb.approvals(true).length, 0); assert.equal(f.wb.trials(true).length, 0);
    assert.deepEqual(f.wb.installs(), {});
    assert.equal(fs.existsSync(path.join(f.home, '.agents', 'skills', 'disposable', 'SKILL.md')), true, 'installed copies are never deleted by purge');
    assert.equal(f.wb.snapshot().items.length, 0);
  } finally { f.close(); }
});

test('removing a skill location forgets the target and leaves installed files alone', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    f.wb.removeTarget({ id: f.codex.id, confirm: true });
    assert.equal(f.wb.targets().length, 1);
    assert.equal(fs.existsSync(path.join(f.home, '.agents', 'skills', 'careful-review', 'SKILL.md')), true);
    assert.throws(() => f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true }), hasCode('TARGET_NOT_ENROLLED'));
  } finally { f.close(); }
});

test('an agent drafts a skill from a prompt using the bundled writing guidance, linked to its source', async () => {
  const f = fixture();
  try {
    const source = f.wb.create({ title: 'Review checklist', kind: 'prompt', content: 'Check the diff for off-by-one errors and missing tests.' });
    let prompt = '', provider = '';
    const service = new AgentService(f.wb, () => {}, async input => { prompt = input.prompt; provider = input.folder; return { name: 'review-checklist', description: 'Use when reviewing a diff for off-by-one errors and missing tests.', skill: skill('review-checklist', 'Check for off-by-one errors.\nCheck for missing tests.'), notes: 'Kept the two checks from the source.' }; });
    const job = service.start({ id: source.id, kind: 'derive', provider: 'claude' });
    for (let i = 0; i < 200 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const finished = service.list().find(j => j.id === job.id)!;
    assert.equal(finished.status, 'completed', finished.error);
    assert.equal(finished.provider, 'claude');
    assert.match(prompt, /<kiln_guidance>[\s\S]*Context pointers[\s\S]*Skill mechanics[\s\S]*<\/kiln_guidance>/, 'writing-for-agents guidance travels with the prompt');
    assert.match(prompt, /untrusted content to be shaped/);
    assert.ok(fs.existsSync(path.join(provider, 'guidance.md')));
    const created = f.wb.getItem(finished.createdItemId!);
    assert.equal(created.kind, 'skill'); assert.equal(created.title, 'review-checklist'); assert.equal(created.status, 'captured');
    assert.deepEqual(created.origin, { itemId: source.id, revision: source.revision });
    assert.equal(f.wb.detail(created.id).validation.length, 0);
    assert.equal(f.wb.approvals().length, 0, 'drafting never approves');
  } finally { f.close(); }
});

test('compare shows file by file how an installed folder differs from the library revision without writing anything', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review'), files: { 'references/checklist.md': Buffer.from('- claims\n').toString('base64'), 'assets/logo.png': Buffer.from([137, 80, 78, 71]).toString('base64') } });
    const destination = path.join(f.home, '.agents', 'skills', 'careful-review'); fs.mkdirSync(path.join(destination, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'SKILL.md'), skill('careful-review', 'Read the diff twice.'));
    fs.writeFileSync(path.join(destination, 'scripts', 'extra.py'), 'print(1)\n');
    fs.writeFileSync(path.join(destination, 'logo.png'), '');
    const before = JSON.stringify(f.deployment.installations(item.id));
    const result = f.deployment.compare({ itemId: item.id, targetId: f.codex.id });
    assert.equal(result.exists, true); assert.equal(result.destination, destination);
    assert.deepEqual(result.files.map(file => [file.path, file.status, file.text]), [
      ['SKILL.md', 'changed', true], ['assets/logo.png', 'only_library', false], ['logo.png', 'only_installed', false], ['references/checklist.md', 'only_library', true], ['scripts/extra.py', 'only_installed', true],
    ]);
    const skillFile = result.files[0];
    assert.equal(skillFile.library, skill('careful-review')); assert.equal(skillFile.installed, skill('careful-review', 'Read the diff twice.'));
    const png = result.files[1]; assert.equal(png.library, null); assert.equal(png.librarySize, 4); assert.equal(png.installedSize, null);
    assert.equal(result.files[4].installed, 'print(1)\n');
    assert.equal(JSON.stringify(f.deployment.installations(item.id)), before, 'comparing changes nothing');
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), skill('careful-review', 'Read the diff twice.'));
    fs.rmSync(destination, { recursive: true });
    assert.equal(f.deployment.compare({ itemId: item.id, targetId: f.codex.id }).exists, false);
  } finally { f.close(); }
});

test('a dangling junction remains removable after the shared skill is deleted', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Review', kind: 'skill', content: skill('careful-review') });
    const real = path.join(f.home, '.agents', 'skills', 'careful-review');
    const link = path.join(f.home, '.claude', 'skills', 'careful-review');
    fs.mkdirSync(real, { recursive: true }); fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link, 'junction'); fs.rmdirSync(real);
    assert.equal(f.deployment.removeSkill({ itemId: item.id, targetId: f.claude.id, confirm: true }).method, 'unlinked');
    assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
  } finally { f.close(); }
});

test('shared skills and client-specific copies are detected separately and native installs survive sync', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Review', kind: 'skill', content: skill('careful-review') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    const nativeDir = path.join(f.home, '.codex/skills/careful-review');
    fs.mkdirSync(nativeDir, { recursive: true }); fs.writeFileSync(path.join(nativeDir, 'SKILL.md'), 'different');
    const found = f.deployment.installations(item.id);
    assert.equal(found.find(i => i.location === 'agents')?.matches, true);
    assert.equal(found.find(i => i.location === 'codex')?.matches, false);
    assert.equal(found.some(i => i.location === 'copilot'), false, 'no invented Copilot-specific copy');
    const native = f.wb.enroll({ name: 'Codex-specific', root: f.home, provider: 'codex', scope: 'personal', skillFolder: '.codex/skills' });
    assert.notEqual(native.id, f.codex.id);
    f.deployment.installSkill({ itemId: item.id, targetId: native.id, replace: true, confirm: true });
    assert.deepEqual(f.wb.installs()[item.id], ['codex', 'codex-native']);
    assert.equal(f.deployment.installations(item.id).length, 2, 'no duplicate paths');
    f.deployment.removeSkill({ itemId: item.id, targetId: native.id, confirm: true });
    assert.equal(fs.existsSync(path.join(f.home, '.agents/skills/careful-review/SKILL.md')), true);
    f.wb.setInstall(item.id, 'codex-native', true);
    f.deployment.syncInstalls();
    assert.equal(fs.readFileSync(path.join(nativeDir, 'SKILL.md'), 'utf8'), skill('careful-review'));
  } finally { f.close(); }
});

test('discovery cleans broken links and empty folders but refuses live links, changed folders and traversal', () => {
  const f = fixture();
  try {
    const root = path.join(f.home, '.claude/skills'); fs.mkdirSync(root, { recursive: true });
    const link = path.join(root, 'gone'); fs.symlinkSync(path.join(f.home, 'missing'), link, 'junction');
    const empty = path.join(root, 'empty'); fs.mkdirSync(empty);
    assert.equal(f.deployment.scan(f.claude.id).entries.find(e => e.name === 'gone')?.cleanup, 'link');
    f.deployment.cleanScanEntry({ targetId: f.claude.id, name: 'gone', confirm: true });
    assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
    fs.writeFileSync(path.join(empty, 'notes.txt'), 'keep');
    assert.throws(() => f.deployment.cleanScanEntry({ targetId: f.claude.id, name: 'empty', confirm: true }), hasCode('TARGET_CHANGED'));
    fs.unlinkSync(path.join(empty, 'notes.txt'));
    f.deployment.cleanScanEntry({ targetId: f.claude.id, name: 'empty', confirm: true });
    assert.equal(fs.existsSync(empty), false);
    fs.symlinkSync(f.home, link, 'junction');
    assert.throws(() => f.deployment.cleanScanEntry({ targetId: f.claude.id, name: 'gone', confirm: true }), hasCode('TARGET_CHANGED'));
    assert.throws(() => f.deployment.cleanScanEntry({ targetId: f.claude.id, name: '../escape', confirm: true }), hasCode('INVALID_PATH'));
  } finally { f.close(); }
});

test('bulk removal covers every selected location, preserves other items and backs up edits', () => {
  const f = fixture();
  try {
    const selected = f.wb.create({ title: 'Selected', kind: 'skill', content: skill('selected') });
    const other = f.wb.create({ title: 'Other', kind: 'skill', content: skill('other') });
    for (const item of [selected, other]) for (const target of [f.codex, f.claude]) f.deployment.installSkill({ itemId: item.id, targetId: target.id, confirm: true });
    const native = path.join(f.home, '.copilot/skills/selected'); fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, 'SKILL.md'), 'keep this external edit');
    const plan = f.deployment.previewRemoval({ itemIds: [selected.id] });
    assert.equal(plan.entries.length, 3);
    assert.equal(plan.entries.filter(e => e.method === 'backup').length, 1);
    const result = f.deployment.removeAllLocal({ planId: plan.id, confirm: true });
    assert.equal(result.complete, true);
    assert.equal(f.deployment.installations(selected.id).length, 0);
    assert.equal(f.deployment.installations(other.id).length, 2);
    assert.equal(f.wb.getItem(selected.id).status, 'approved');
    assert.equal(f.wb.installs()[selected.id], undefined);
    const backup = result.entries.find(e => e.method === 'backup')!.result!.split('backup: ')[1];
    assert.equal(fs.readFileSync(path.join(backup, 'SKILL.md'), 'utf8'), 'keep this external edit');
    assert.deepEqual(f.deployment.removeAllLocal({ planId: plan.id, confirm: true }), result, 'completed plans return the same result');
    f.deployment.syncInstalls();
    assert.equal(f.deployment.installations(selected.id).length, 0);
    fs.mkdirSync(native, { recursive: true }); fs.writeFileSync(path.join(native, 'SKILL.md'), 'new copy');
    f.deployment.removeAllLocal({ planId: plan.id, confirm: true });
    assert.equal(fs.readFileSync(path.join(native, 'SKILL.md'), 'utf8'), 'new copy', 'replaying a completed plan does not delete new files');
  } finally { f.close(); }
});

test('bulk removal skips changed copies, unlinks dangling aliases, and never accepts arbitrary paths', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Selected', kind: 'skill', content: skill('selected') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    const shared = path.join(f.home, '.agents/skills/selected');
    const link = path.join(f.home, '.claude/skills/selected'); fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(shared, link, 'junction');
    const plan = f.deployment.previewRemoval({ itemIds: [item.id] });
    fs.writeFileSync(path.join(shared, 'SKILL.md'), 'changed after preview');
    const result = f.deployment.removeAllLocal({ planId: plan.id, confirm: true });
    assert.equal(result.complete, false);
    assert.ok(result.entries.find(e => e.destination === shared)?.error);
    assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
    assert.equal(fs.readFileSync(path.join(shared, 'SKILL.md'), 'utf8'), 'changed after preview');
    const next = f.deployment.previewRemoval({ itemIds: [item.id] });
    const unrelated = path.join(f.home, 'unrelated'); fs.writeFileSync(unrelated, 'keep');
    next.entries[0].destination = unrelated;
    fs.writeFileSync(path.join(f.wb.local, 'removal-plans', `${next.id}.json`), JSON.stringify(next));
    assert.equal(f.deployment.removeAllLocal({ planId: next.id, confirm: true }).complete, false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  } finally { f.close(); }
});

test('bulk preview includes previously installed names after a skill is renamed', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Before', kind: 'skill', content: skill('before') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    f.wb.update({ id: item.id, expect: item.revision, summary: 'Rename', value: { ...f.wb.getRevision(item.id), title: 'After', content: skill('after') } });
    const plan = f.deployment.previewRemoval({ itemIds: [item.id] });
    assert.equal(plan.entries.length, 1);
    assert.equal(path.basename(plan.entries[0].destination), 'before');
    assert.equal(f.deployment.removeAllLocal({ planId: plan.id, confirm: true }).complete, true);
    assert.equal(fs.existsSync(path.join(f.home, '.agents/skills/before')), false);
    assert.equal(f.wb.getItem(item.id).title, 'After');
  } finally { f.close(); }
});

test('bulk unlink closes old ownership without deleting an external link target', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Review', kind: 'skill', content: skill('review') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.claude.id, confirm: true });
    const destination = path.join(f.home, '.claude/skills/review');
    fs.rmSync(destination, { recursive: true });
    const external = path.join(f.home, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'SKILL.md'), 'keep');
    fs.symlinkSync(external, destination, 'junction');
    const plan = f.deployment.previewRemoval({ itemIds: [item.id] });
    assert.equal(f.deployment.removeAllLocal({ planId: plan.id, confirm: true }).complete, true);
    assert.equal(fs.lstatSync(destination, { throwIfNoEntry: false }), undefined);
    assert.equal(fs.readFileSync(path.join(external, 'SKILL.md'), 'utf8'), 'keep');
    assert.equal(f.deployment.receipts().filter(r => r.destination === destination).at(-1)?.status, 'uninstalled');
  } finally { f.close(); }
});
