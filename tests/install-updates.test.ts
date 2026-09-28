import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../packages/domain/workbench';
import { DeploymentService } from '../packages/deployment/service';
import { WorkbenchError } from '../packages/domain/errors';

// Update installed copies, and keep changes made outside Kiln.
const skill = (body: string) => `---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\n${body}\n`;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-install-updates-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const deployment = new DeploymentService(wb);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const codex = wb.enroll({ name: 'Codex skills', root: home, provider: 'codex', scope: 'personal', profile: 'Personal' });
  const claude = wb.enroll({ name: 'Claude skills', root: home, provider: 'claude', scope: 'personal', profile: 'Personal' });
  const agents = path.join(home, '.agents', 'skills', 'careful-review'), claudeCopy = path.join(home, '.claude', 'skills', 'careful-review');
  return { root, wb, deployment, home, codex, claude, agents, claudeCopy, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const hasCode = (code: string) => (error: unknown) => error instanceof WorkbenchError && error.code === code;
const edit = (wb: Workbench, id: string, content: string, summary = 'Edited') => wb.update({ id, expect: wb.getItem(id).revision, summary, value: { ...wb.authoring(id), content } });
const approve = (wb: Workbench, id: string) => wb.approve({ id, revision: wb.getItem(id).revision, reviewer: 'tester', scope: 'test', note: 'ok', waivedChecks: 'test' });
const copy = (f: ReturnType<typeof fixture>, id: string, destination: string) => f.deployment.installations(id).find(i => i.destination === destination);

test('an installed copy behind a newer approval is outdated; drafts, edited and external copies are not', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('Version one.') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    assert.equal(copy(f, item.id, f.agents)?.outdated, undefined, 'freshly installed');
    edit(f.wb, item.id, skill('Version two.'));
    assert.equal(copy(f, item.id, f.agents)?.outdated, undefined, 'an unapproved draft is not what Update writes');
    assert.equal(copy(f, item.id, f.agents)?.state, 'installed');
    approve(f.wb, item.id);
    assert.equal(copy(f, item.id, f.agents)?.state, 'installed');
    assert.equal(copy(f, item.id, f.agents)?.outdated, true, 'installed, then a newer revision was approved');
    // An identical external copy of the approved revision stays "found".
    fs.mkdirSync(f.claudeCopy, { recursive: true }); fs.writeFileSync(path.join(f.claudeCopy, 'SKILL.md'), skill('Version two.'));
    const external = copy(f, item.id, f.claudeCopy)!;
    assert.equal(external.state, 'external'); assert.equal(external.matches, true); assert.equal(external.outdated, undefined);
    // Edited outside Kiln stays drifted, never outdated.
    fs.appendFileSync(path.join(f.agents, 'SKILL.md'), 'Local note.\n');
    assert.equal(copy(f, item.id, f.agents)?.state, 'drifted');
    assert.equal(copy(f, item.id, f.agents)?.outdated, undefined);
  } finally { f.close(); }
});

test('Update installs the approved revision over unchanged copies with a new receipt and skips edited ones', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('Version one.') });
    for (const target of [f.codex, f.claude]) f.deployment.installSkill({ itemId: item.id, targetId: target.id, confirm: true });
    const before = f.deployment.receipts().length;
    fs.appendFileSync(path.join(f.claudeCopy, 'SKILL.md'), 'Local note.\n');
    const edited = fs.readFileSync(path.join(f.claudeCopy, 'SKILL.md'), 'utf8');
    edit(f.wb, item.id, skill('Version two.')); approve(f.wb, item.id);
    const approved = f.wb.getItem(item.id).revision;
    const result = f.deployment.updateInstalls({ itemId: item.id });
    assert.equal(result.approved, false);
    assert.deepEqual(result.updated.map(u => u.label), ['Agents']);
    assert.deepEqual(result.skipped.map(s => [s.label, s.reason]), [['Claude', 'edited outside Kiln']]);
    assert.equal(fs.readFileSync(path.join(f.agents, 'SKILL.md'), 'utf8'), skill('Version two.'));
    assert.equal(fs.readFileSync(path.join(f.claudeCopy, 'SKILL.md'), 'utf8'), edited, 'the edited copy is untouched');
    const receipt = f.deployment.receipts().at(-1)!;
    assert.equal(f.deployment.receipts().length, before + 1);
    assert.equal(receipt.revision, approved); assert.equal(receipt.destination, f.agents); assert.equal(receipt.status, 'applied');
    assert.ok(receipt.previousFiles, 'the replaced copy is kept in the receipt for rollback');
    const now = copy(f, item.id, f.agents)!;
    assert.equal(now.state, 'installed'); assert.equal(now.outdated, undefined); assert.equal(now.receiptId, receipt.id);
    // Running it again changes nothing.
    const again = f.deployment.updateInstalls({ itemId: item.id });
    assert.equal(again.updated.length, 0); assert.equal(again.current, 1);
    assert.equal(f.deployment.receipts().length, before + 1);
  } finally { f.close(); }
});

test('Update all outdated goes item by item through the same update; given copies limit it to those', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('Version one.') });
    for (const target of [f.codex, f.claude]) f.deployment.installSkill({ itemId: item.id, targetId: target.id, confirm: true });
    const other = f.wb.create({ title: 'Other', kind: 'skill', content: skill('Other.').replace('careful-review', 'other-skill') });
    f.deployment.installSkill({ itemId: other.id, targetId: f.codex.id, confirm: true });
    edit(f.wb, item.id, skill('Version two.')); approve(f.wb, item.id);
    // Only the Agents copy of the first item is asked for: Claude stays behind, the other item isn't touched.
    const one = f.deployment.updateOutdated({ copies: [{ itemId: item.id, targetId: f.codex.id }] });
    assert.deepEqual(one.map(r => [r.title, r.updated.map(u => u.label), r.skipped.length, r.approved]), [['Careful review', ['Agents'], 0, false]]);
    assert.equal(copy(f, item.id, f.claudeCopy)?.outdated, true);
    const rest = f.deployment.updateOutdated();
    assert.deepEqual(rest.map(r => [r.title, r.updated.map(u => u.label), r.current]), [['Careful review', ['Claude'], 1]]);
    assert.deepEqual(f.deployment.updateOutdated(), []);
  } finally { f.close(); }
});

test('Approve & update installs approves exactly the revision the user saw, then updates', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('Version one.') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    const seen = edit(f.wb, item.id, skill('Version two.')).revision;
    edit(f.wb, item.id, skill('Version three.'));
    assert.throws(() => f.deployment.updateInstalls({ itemId: item.id, approve: true, expect: seen }), hasCode('REVISION_CONFLICT'));
    assert.equal(f.wb.approvals().length, 1, 'nothing approved on a conflict');
    const result = f.deployment.updateInstalls({ itemId: item.id, approve: true, expect: f.wb.getItem(item.id).revision });
    assert.equal(result.approved, true); assert.equal(result.revision, f.wb.getItem(item.id).revision);
    assert.equal(result.updated.length, 1);
    assert.equal(fs.readFileSync(path.join(f.agents, 'SKILL.md'), 'utf8'), skill('Version three.'));
  } finally { f.close(); }
});

test('Keep these changes saves the edited copy as a draft of the same item, and approving adopts the folder as it is', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('Version one.'), files: { 'notes.md': Buffer.from('old').toString('base64') } });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    const first = f.wb.getItem(item.id).revision;
    fs.writeFileSync(path.join(f.agents, 'SKILL.md'), skill('Edited in the folder.'));
    fs.mkdirSync(path.join(f.agents, 'scripts')); fs.writeFileSync(path.join(f.agents, 'scripts', 'check.sh'), 'echo ok\n');
    fs.rmSync(path.join(f.agents, 'notes.md'));
    assert.equal(copy(f, item.id, f.agents)?.state, 'drifted');
    const stat = fs.statSync(path.join(f.agents, 'SKILL.md'));
    const kept = f.deployment.keepCopy({ itemId: item.id, targetId: f.codex.id, expect: first });
    assert.equal(kept.exact, true); assert.deepEqual(kept.ignored, []);
    assert.equal(kept.summary, 'Kept changes from the Agents copy');
    const draft = f.wb.getRevision(item.id);
    assert.equal(draft.hash, kept.revision); assert.equal(draft.parent, first); assert.equal(draft.summary, kept.summary);
    assert.equal(draft.content, skill('Edited in the folder.'));
    assert.deepEqual(Object.keys(draft.files), ['scripts/check.sh']);
    assert.equal(draft.title, 'Careful review', 'the item keeps its title and metadata');
    assert.equal(f.wb.approvals().some(a => a.revision === kept.revision), false, 'kept changes are a draft');
    assert.equal(f.wb.listItems().length, 1, 'no new item');
    assert.equal(copy(f, item.id, f.agents)?.state, 'drifted', 'still edited until approved');
    // Keeping again from the old revision is a conflict, not an overwrite.
    assert.throws(() => f.deployment.keepCopy({ itemId: item.id, targetId: f.codex.id, expect: first }), hasCode('REVISION_CONFLICT'));
    const adopted = f.deployment.approveKept({ itemId: item.id, targetId: f.codex.id, expect: kept.revision });
    assert.equal(adopted.method, 'adopted'); assert.equal(adopted.approved, true);
    const now = copy(f, item.id, f.agents)!;
    assert.equal(now.state, 'installed'); assert.equal(now.matches, true); assert.equal(now.receiptId, adopted.receipt.id);
    assert.equal(adopted.receipt.revision, kept.revision);
    const after = fs.statSync(path.join(f.agents, 'SKILL.md'));
    assert.equal(after.ino, stat.ino, 'the folder was not moved or rewritten'); assert.equal(after.mtimeMs, stat.mtimeMs);
    assert.equal(fs.existsSync(path.join(f.wb.local, 'replaced')), false, 'nothing was set aside');
    assert.deepEqual(f.wb.installs()[item.id], ['codex']);
    assert.equal(f.deployment.approveKept({ itemId: item.id, targetId: f.codex.id, expect: kept.revision }).method, 'unchanged');
  } finally { f.close(); }
});

test('a differing external copy can be kept; approval refuses when the folder changed after keeping', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('Version one.') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    fs.mkdirSync(f.claudeCopy, { recursive: true }); fs.writeFileSync(path.join(f.claudeCopy, 'SKILL.md'), skill('Written by hand.'));
    fs.writeFileSync(path.join(f.claudeCopy, '.DS_Store'), 'x');
    assert.equal(copy(f, item.id, f.claudeCopy)?.matches, false);
    const kept = f.deployment.keepCopy({ itemId: item.id, targetId: f.claude.id, expect: f.wb.getItem(item.id).revision });
    assert.equal(kept.summary, 'Kept changes from the Claude copy');
    assert.deepEqual(kept.ignored, ['.DS_Store']); assert.equal(kept.exact, false, 'ignored files keep the folder from matching');
    assert.throws(() => f.deployment.approveKept({ itemId: item.id, targetId: f.claude.id, expect: kept.revision }), hasCode('TARGET_CHANGED'));
    assert.equal(f.wb.approvals().some(a => a.revision === kept.revision), false, 'nothing approved when the folder does not match');
    fs.rmSync(path.join(f.claudeCopy, '.DS_Store'));
    const adopted = f.deployment.approveKept({ itemId: item.id, targetId: f.claude.id, expect: kept.revision });
    assert.equal(adopted.method, 'adopted');
    assert.equal(copy(f, item.id, f.claudeCopy)?.state, 'installed');
    assert.equal(fs.readFileSync(path.join(f.claudeCopy, 'SKILL.md'), 'utf8'), skill('Written by hand.'));
    // The Agents copy Kiln installed earlier is now behind the kept revision, and Update brings it along.
    assert.equal(copy(f, item.id, f.agents)?.outdated, true);
    assert.deepEqual(f.deployment.updateInstalls({ itemId: item.id }).updated.map(u => u.label), ['Agents']);
    assert.equal(fs.readFileSync(path.join(f.agents, 'SKILL.md'), 'utf8'), skill('Written by hand.'));
  } finally { f.close(); }
});

test('a kept copy is exact only when nothing was left out, even an ignored folder holding no files', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('Version one.') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    fs.writeFileSync(path.join(f.agents, 'SKILL.md'), skill('Edited in the folder.'));
    fs.mkdirSync(path.join(f.agents, 'node_modules'));
    const kept = f.deployment.keepCopy({ itemId: item.id, targetId: f.codex.id, expect: f.wb.getItem(item.id).revision });
    assert.deepEqual(kept.ignored, ['node_modules']); assert.equal(kept.exact, false, 'an ignored entry was not kept, so the folder is not the revision');
    assert.equal(f.wb.getRevision(item.id, kept.revision).content, skill('Edited in the folder.'));
    fs.rmdirSync(path.join(f.agents, 'node_modules')); fs.writeFileSync(path.join(f.agents, 'SKILL.md'), skill('Edited again.'));
    const again = f.deployment.keepCopy({ itemId: item.id, targetId: f.codex.id, expect: kept.revision });
    assert.deepEqual(again.ignored, []); assert.equal(again.exact, true);
  } finally { f.close(); }
});

test('keeping refuses links inside the copy, a renamed skill and a copy that already matches', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('Version one.') });
    f.deployment.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    const expect = f.wb.getItem(item.id).revision;
    assert.throws(() => f.deployment.keepCopy({ itemId: item.id, targetId: f.codex.id, expect }), hasCode('NOTHING_TO_KEEP'));
    const outside = path.join(f.root, 'secret.txt'); fs.writeFileSync(outside, 'private');
    fs.symlinkSync(outside, path.join(f.agents, 'secret.txt'));
    assert.throws(() => f.deployment.keepCopy({ itemId: item.id, targetId: f.codex.id, expect }), hasCode('SYMLINK_REJECTED'));
    fs.rmSync(path.join(f.agents, 'secret.txt'));
    fs.writeFileSync(path.join(f.agents, 'SKILL.md'), skill('Renamed.').replace('name: careful-review', 'name: other-name'));
    assert.throws(() => f.deployment.keepCopy({ itemId: item.id, targetId: f.codex.id, expect }), hasCode('NAME_CHANGED'));
    assert.equal(f.wb.getItem(item.id).revision, expect, 'nothing was saved');
  } finally { f.close(); }
});

test('an agent definition edited in place can be kept and adopted', () => {
  const f = fixture();
  try {
    const agent = (body: string) => `---\nname: reviewer\ndescription: Review code\n---\n${body}\n`;
    const item = f.wb.create({ title: 'Reviewer', kind: 'agent', content: agent('Read the diff.'), agent: { provider: 'claude', filename: 'reviewer.md' } });
    f.deployment.installSkill({ itemId: item.id, targetId: f.claude.id, confirm: true });
    const file = path.join(f.home, '.claude', 'agents', 'reviewer.md');
    fs.writeFileSync(file, agent('Read the diff twice.'));
    const kept = f.deployment.keepCopy({ itemId: item.id, targetId: f.claude.id, expect: f.wb.getItem(item.id).revision });
    assert.equal(kept.summary, 'Kept changes from the Claude copy'); assert.equal(kept.exact, true);
    assert.equal(f.wb.getRevision(item.id).content, agent('Read the diff twice.'));
    assert.equal(f.deployment.approveKept({ itemId: item.id, targetId: f.claude.id, expect: kept.revision }).method, 'adopted');
    assert.equal(f.deployment.installations(item.id)[0].state, 'installed');
  } finally { f.close(); }
});
