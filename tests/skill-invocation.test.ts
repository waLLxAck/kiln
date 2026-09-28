import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { WorkbenchError } from '../packages/domain/errors';
import { initialiseRepository } from '../packages/git/standard';
import { setModelInvocation } from '../packages/domain/invocation';

// Model invocation on or off from the library: a flag-only revision, its approval carried over, Kiln's copies updated.
const skill = '---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff.\n';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-invocation-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const router = new Router(wb, { composer: null });
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const codex = wb.enroll({ name: 'Codex skills', root: home, provider: 'codex', scope: 'personal', profile: 'Personal' });
  const claude = wb.enroll({ name: 'Claude skills', root: home, provider: 'claude', scope: 'personal', profile: 'Personal' });
  const agents = path.join(home, '.agents', 'skills', 'careful-review'), claudeCopy = path.join(home, '.claude', 'skills', 'careful-review');
  return { root, wb, router, home, codex, claude, agents, claudeCopy, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const hasCode = (code: string) => (error: unknown) => error instanceof WorkbenchError && error.code === code;
const approve = (wb: Workbench, id: string) => wb.approve({ id, revision: wb.getItem(id).revision, reviewer: 'tester', scope: 'Code review', note: 'ok', waivedChecks: 'fixture' });
const read = (file: string) => fs.readFileSync(file, 'utf8');

test('turning model invocation off saves a flag-only revision, carries the approval over and updates every managed copy', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'careful-review', kind: 'skill', content: skill });
    approve(f.wb, item.id);
    for (const target of [f.codex, f.claude]) f.router.call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
    const before = f.wb.getItem(item.id).revision;
    assert.deepEqual(f.wb.snapshot().invocation[item.id], { claude: true, codex: true, chars: '- careful-review: Review a change for correctness and clear evidence.'.length });

    const result = f.router.call('skills.invocation', { itemId: item.id, model: false, expect: before }) as ReturnType<Router['setInvocation']>;
    assert.equal(result.changed, true); assert.equal(result.approval, 'carried');
    assert.deepEqual(result.invocation, { claude: false, codex: false });
    const revision = f.wb.getRevision(item.id);
    assert.notEqual(revision.hash, before); assert.equal(revision.parent, before);
    assert.equal(revision.summary, 'Model invocation turned off');
    assert.equal(revision.content, skill.replace('evidence.\n---', 'evidence.\ndisable-model-invocation: true\n---'));
    assert.equal(Buffer.from(revision.files['agents/openai.yaml'], 'base64').toString(), 'policy:\n  allow_implicit_invocation: false\n');

    // The approval is Kiln's, carried from the earlier one, with its scope; the item is approved without asking the user.
    const carried = f.wb.approvals().find(a => a.revision === revision.hash)!;
    assert.equal(carried.reviewer, 'Kiln'); assert.equal(carried.carriedFrom, before); assert.equal(carried.scope, 'Code review');
    assert.match(carried.note, new RegExp(`Only the model-invocation flag changed from approved ${before.slice(0, 12)}`));
    assert.equal(f.wb.getItem(item.id).status, 'approved');

    // Both copies were rewritten through the update path: new receipts, bytes equal to the approved revision.
    assert.equal(result.update!.updated.length, 2); assert.deepEqual(result.update!.skipped, []);
    for (const folder of [f.agents, f.claudeCopy]) {
      assert.equal(read(path.join(folder, 'SKILL.md')), revision.content);
      assert.equal(read(path.join(folder, 'agents', 'openai.yaml')), 'policy:\n  allow_implicit_invocation: false\n');
    }
    const copies = f.router.deployments.installations(item.id);
    assert.equal(copies.length, 2);
    for (const copy of copies) { assert.equal(copy.state, 'installed'); assert.equal(copy.matches, true); assert.equal(copy.outdated, undefined); }
    assert.deepEqual(f.wb.snapshot().invocation[item.id], { claude: false, codex: false, chars: '- careful-review: Review a change for correctness and clear evidence.'.length });

    // Asking again changes nothing; turning it back on gives the original bytes.
    const again = f.router.setInvocation({ itemId: item.id, model: false });
    assert.equal(again.changed, false); assert.equal(f.wb.getItem(item.id).revision, revision.hash);
    const on = f.router.setInvocation({ itemId: item.id, model: true });
    assert.equal(on.approval, 'carried'); assert.equal(on.update!.updated.length, 2);
    assert.equal(read(path.join(f.agents, 'SKILL.md')), skill);
    assert.equal(fs.existsSync(path.join(f.agents, 'agents')), false, 'the openai.yaml Kiln added is gone, and its folder with it');
  } finally { f.close(); }
});

test('copies edited outside Kiln are skipped and named; a stale expect is refused', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'careful-review', kind: 'skill', content: skill });
    approve(f.wb, item.id);
    for (const target of [f.codex, f.claude]) f.router.installSkill({ itemId: item.id, targetId: target.id, confirm: true });
    fs.appendFileSync(path.join(f.claudeCopy, 'SKILL.md'), 'Local note.\n');
    const edited = read(path.join(f.claudeCopy, 'SKILL.md'));
    assert.throws(() => f.router.setInvocation({ itemId: item.id, model: false, expect: 'a'.repeat(64) }), hasCode('REVISION_CONFLICT'));
    const result = f.router.setInvocation({ itemId: item.id, model: false });
    assert.equal(result.update!.updated.length, 1);
    assert.deepEqual(result.update!.skipped.map(s => s.reason), ['edited outside Kiln']);
    assert.equal(read(path.join(f.claudeCopy, 'SKILL.md')), edited, 'the edited copy is untouched');
    assert.match(read(path.join(f.agents, 'SKILL.md')), /disable-model-invocation: true/);
  } finally { f.close(); }
});

test('on a draft newer than the approval the toggle edits the draft only; approving stays with the user', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'careful-review', kind: 'skill', content: skill });
    approve(f.wb, item.id);
    f.router.installSkill({ itemId: item.id, targetId: f.codex.id, confirm: true });
    f.wb.update({ id: item.id, expect: f.wb.getItem(item.id).revision, summary: 'More steps', value: { ...f.wb.authoring(item.id), content: skill + 'Check the tests.\n' } });
    const approvals = f.wb.approvals().length, installed = read(path.join(f.agents, 'SKILL.md'));
    const result = f.router.setInvocation({ itemId: item.id, model: false });
    assert.equal(result.approval, 'draft'); assert.equal(result.update, null);
    assert.equal(f.wb.approvals().length, approvals, 'no approval recorded');
    assert.equal(f.wb.getItem(item.id).status, 'captured');
    assert.equal(read(path.join(f.agents, 'SKILL.md')), installed, 'installed copies keep the approved revision');
    assert.match(f.wb.getRevision(item.id).content, /Check the tests\.\ndisable-model-invocation|disable-model-invocation: true\n---/);
  } finally { f.close(); }
});

test('a carried approval is refused when anything besides the flag changed, and only skills have the switch', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'careful-review', kind: 'skill', content: skill });
    approve(f.wb, item.id);
    const from = f.wb.getItem(item.id).revision;
    const next = setModelInvocation(f.wb.authoring(item.id), false);
    f.wb.update({ id: item.id, expect: from, summary: 'Flag and a word', value: { ...next, content: next.content.replace('Read the diff.', 'Read the whole diff.') } });
    assert.throws(() => f.wb.approveFlagChange({ id: item.id, revision: f.wb.getItem(item.id).revision, from }), hasCode('NOT_FLAG_ONLY'));
    assert.throws(() => f.wb.approveFlagChange({ id: item.id, revision: f.wb.getItem(item.id).revision, from: f.wb.getItem(item.id).revision }), hasCode('APPROVAL_REQUIRED'));
    const prompt = f.wb.create({ title: 'A prompt', kind: 'prompt', content: 'Do it.' });
    assert.throws(() => f.router.setInvocation({ itemId: prompt.id, model: false }), hasCode('NOT_A_SKILL'));
    assert.throws(() => f.router.setInvocation({ itemId: item.id }), /model/);
  } finally { f.close(); }
});

test('the carried approval is committed and pushed like any approval, so other machines get the flag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln invocation publish '));
  const created = initialiseRepository({ parent: root, name: 'library' }); assert.ok(created.committed, created.message);
  const git = (...args: string[]) => execFileSync('git', ['-C', created.root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const origin = path.join(root, 'origin.git'); execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  git('remote', 'add', 'origin', origin);
  const wb = new Workbench(created.root, path.join(root, 'private'));
  try {
    const router = new Router(wb, { composer: null });
    const item = wb.create({ title: 'careful-review', kind: 'skill', content: skill });
    router.approve({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });
    await router.publisher.idle();
    router.setInvocation({ itemId: item.id, model: false });
    await router.publisher.idle();
    const job = router.publisher.list()[0];
    assert.equal(job.status, 'done', job.error); assert.equal(job.action, 'approve');
    const revision = wb.getItem(item.id).revision;
    assert.equal(job.revision, revision);
    assert.match(git('show', `HEAD:workbench/items/${item.id}/content.md`), /disable-model-invocation: true/);
    assert.equal(git('show', `HEAD:workbench/items/${item.id}/files/agents/openai.yaml`), 'policy:\n  allow_implicit_invocation: false');
    assert.equal(execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD'), 'on GitHub');
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
