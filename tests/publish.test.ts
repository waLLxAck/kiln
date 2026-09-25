import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { initialiseRepository } from '../packages/git/standard';
import { fallbackMessage, normaliseMessage } from '../packages/git/publish';
import { migrationPlan, applyMigration } from '../packages/git/migration';

const skill = (name: string) => `---\nname: ${name}\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff. Verify claims.\n`;
/** A standard Kiln repository with a bare "GitHub" next to it, so pushes are real but local. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln publish '));
  const local = path.join(root, 'private'); fs.mkdirSync(local);
  const created = initialiseRepository({ parent: root, name: 'library' }); assert.ok(created.committed, created.message);
  const library = created.root;
  const git = (...args: string[]) => execFileSync('git', ['-C', library, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const origin = path.join(root, 'origin.git'); execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  git('remote', 'add', 'origin', origin);
  const wb = new Workbench(library, local);
  return { root, library, local, origin, wb, git, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const approveArgs = (item: { id: string; revision: string }) => ({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });

test('approve commits only that item with the agent-written message and pushes it; other drafts stay local', async () => {
  const f = fixture();
  try {
    const composer = async (input: { title: string; diff: string }) => { assert.equal(input.title, 'Careful review'); return `Approve careful-review skill for code reviews.\n\nAdds the review procedure.`; };
    const router = new Router(f.wb, { composer });
    assert.ok(f.wb.repositoryState().ready);
    const approvedItem = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    const draft = f.wb.create({ title: 'Still a draft', kind: 'prompt', content: 'Not ready yet' });
    router.approve(approveArgs(approvedItem));
    await router.publisher.idle();
    const [job] = router.publisher.list();
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.composer, 'agent');
    assert.equal(f.git('log', '-1', '--format=%s'), 'Approve careful-review skill for code reviews');
    assert.match(f.git('log', '-1', '--format=%b'), /Adds the review procedure/);
    const committed = f.git('show', '--name-only', '--format=', 'HEAD');
    assert.match(committed, new RegExp(`workbench/items/${approvedItem.id}/item.json`));
    assert.match(committed, /workbench\/approvals\//);
    assert.doesNotMatch(committed, new RegExp(draft.id));
    assert.match(f.git('status', '--porcelain'), new RegExp(draft.id), 'the draft stays uncommitted');
    assert.equal(execFileSync('git', ['-C', f.origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), f.git('rev-parse', 'HEAD'), 'origin has the approval');
    assert.equal(f.wb.snapshot().git.ahead, 0);
  } finally { f.close(); }
});

test('a failing composer falls back to a plain message; unapprove pushes too', async () => {
  const f = fixture();
  try {
    const router = new Router(f.wb, { composer: async () => { throw new Error('codex offline'); } });
    const item = f.wb.create({ title: 'Fallback item', kind: 'skill', content: skill('fallback-item') });
    router.approve(approveArgs(item)); await router.publisher.idle();
    assert.equal(router.publisher.list()[0].composer, 'fallback');
    assert.equal(f.git('log', '-1', '--format=%s'), fallbackMessage({ action: 'approve', title: 'Fallback item', revision: item.revision }));
    router.unapprove({ id: item.id, revision: item.revision }); await router.publisher.idle();
    const [job] = router.publisher.list();
    assert.equal(job.action, 'unapprove'); assert.equal(job.status, 'done', job.error);
    assert.match(f.git('log', '-1', '--format=%s'), /^Withdraw approval of "Fallback item"/);
    assert.equal(f.git('rev-list', '--count', 'origin/main..HEAD'), '0');
  } finally { f.close(); }
});

test('a push that cannot reach GitHub leaves the approval local, reports why, and retry pushes it', async () => {
  const f = fixture();
  try {
    f.git('remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
    const router = new Router(f.wb, { composer: null });
    const item = f.wb.create({ title: 'Offline approval', kind: 'skill', content: skill('offline-approval') });
    router.approve(approveArgs(item)); await router.publisher.idle();
    let [job] = router.publisher.list();
    assert.equal(job.status, 'failed'); assert.ok(job.error); assert.ok(job.commit, 'the commit exists even though the push failed');
    assert.equal(f.wb.approvals().length, 1, 'approval is still recorded');
    assert.equal(f.wb.snapshot().git.ahead, 2, 'the initial commit and the approval both wait for the first push');
    f.git('remote', 'set-url', 'origin', f.origin);
    router.publisher.retry(job.id); await router.publisher.idle();
    [job] = router.publisher.list();
    assert.equal(job.status, 'done', job.error);
    assert.equal(f.wb.snapshot().git.ahead, 0);
  } finally { f.close(); }
});

test('installing an unapproved skill approves and publishes it once', async () => {
  const f = fixture();
  try {
    const router = new Router(f.wb, { composer: null });
    const home = path.join(f.root, 'agent home'); fs.mkdirSync(home);
    const target = f.wb.enroll({ name: 'Codex', root: home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    const item = f.wb.create({ title: 'Installed directly', kind: 'skill', content: skill('installed-directly') });
    router.call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
    await router.publisher.idle();
    assert.equal(router.publisher.list().length, 1);
    assert.equal(router.publisher.list()[0].status, 'done');
    router.call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
    await router.publisher.idle();
    assert.equal(router.publisher.list().length, 1, 'reinstalling an approved revision does not publish again');
  } finally { f.close(); }
});

test('a library without a GitHub remote is not ready and approvals stay local', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln not ready '));
  let wb: Workbench | undefined;
  try {
    wb = new Workbench(path.join(root, 'plain library'), path.join(root, 'private'));
    assert.deepEqual(wb.repositoryState(), { standard: false, dedicated: false, git: false, remote: false, ready: false });
    const router = new Router(wb, { composer: null });
    const item = wb.create({ title: 'Local only', kind: 'skill', content: skill('local-only') });
    router.approve(approveArgs(item)); await router.publisher.idle();
    assert.equal(router.publisher.list().length, 0);
  } finally { wb?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('skills import from another folder, Git repository or not, without touching the library layout', () => {
  const f = fixture();
  try {
    const source = path.join(f.root, 'my skills'); fs.mkdirSync(path.join(source, 'review'), { recursive: true }); fs.mkdirSync(path.join(source, 'nested', 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(source, 'review', 'SKILL.md'), skill('review'));
    fs.writeFileSync(path.join(source, 'nested', 'deploy', 'SKILL.md'), skill('deploy'));
    let plan = migrationPlan(f.library, source);
    assert.equal(plan.count, 2); assert.equal(plan.commit, 'working-tree'); assert.equal(plan.pending, 2);
    const result = applyMigration(f.wb, plan.hash, source);
    assert.equal(result.imported, 2);
    assert.ok(f.wb.listItems().every(i => i.source.startsWith('local-import:')));
    plan = migrationPlan(f.library, source);
    assert.equal(plan.unchanged, 2, 'repeating the import changes nothing');
    assert.equal(migrationPlan(f.library).count, 0, 'the library itself has no legacy skills');
  } finally { f.close(); }
});

test('commit messages keep a single subject within 72 characters', () => {
  const input = { action: 'approve' as const, title: 'X', revision: 'a'.repeat(64) };
  assert.equal(normaliseMessage('```\nAdd thing.\n```', input), 'Add thing');
  assert.equal(normaliseMessage('   ', input), 'Approve "X" (aaaaaaaa)');
  const long = normaliseMessage('word '.repeat(30) + '\n\nBody line', input);
  assert.ok(long.split('\n')[0].length <= 72); assert.match(long, /\n\nBody line$/);
});

test('a skills repository that adopted the Kiln layout in place is an import source, not a ready Kiln repository', () => {
  const f = fixture();
  try {
    assert.ok(f.wb.repositoryState().dedicated, 'a repository Kiln created is dedicated');
    // Give it the shape of a migrated skills repo: a legacy skills tree tracked beside the Kiln layout, and no dedicated flag.
    fs.mkdirSync(path.join(f.library, 'mine', 'review'), { recursive: true }); fs.writeFileSync(path.join(f.library, 'mine', 'review', 'SKILL.md'), skill('review'));
    const manifest = JSON.parse(fs.readFileSync(path.join(f.library, 'kiln.json'), 'utf8')); delete manifest.dedicated; fs.writeFileSync(path.join(f.library, 'kiln.json'), JSON.stringify(manifest));
    f.git('add', '.'); f.git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'legacy skills');
    f.wb.invalidateGit();
    const state = f.wb.repositoryState();
    assert.equal(state.standard, true); assert.equal(state.dedicated, false); assert.equal(state.ready, false);
    assert.equal(migrationPlan(f.library).count, 1, 'its skills can still be imported');
  } finally { f.close(); }
});

test('creating a repository reuses a folder prepared earlier that never reached GitHub', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln reuse '));
  try {
    const first = initialiseRepository({ parent: root, name: 'my-kiln' }); assert.ok(first.committed);
    const again = initialiseRepository({ parent: root, name: 'my-kiln' });
    assert.equal(again.root, first.root); assert.ok(again.committed); assert.match(again.message, /Reusing/);
    fs.mkdirSync(path.join(root, 'other')); fs.writeFileSync(path.join(root, 'other', 'notes.txt'), 'x');
    assert.throws(() => initialiseRepository({ parent: root, name: 'other' }), /FOLDER_EXISTS|not an empty Kiln repository/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('publishing snapshots only the reviewed revision despite earlier drafts and edits during composition', async () => {
  const f = fixture(); let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), composing = new Promise<void>(resolve => started = resolve);
  try {
    const router = new Router(f.wb, { composer: async () => { started(); await gate; return 'Approve exact reviewed revision'; } });
    let item = f.wb.create({ title: 'Exact snapshot', kind: 'prompt', content: 'PRIVATE EARLY DRAFT', files: { 'private.txt': Buffer.from('early secret').toString('base64') } });
    const early = item.revision;
    item = f.wb.update({ id: item.id, expect: item.revision, value: { ...f.wb.getRevision(item.id), content: 'REVIEWED', files: { 'approved.txt': Buffer.from('reviewed bytes').toString('base64') } } });
    const reviewed = item.revision;
    router.approve(approveArgs(item)); await composing;
    const draft = f.wb.update({ id: item.id, expect: reviewed, value: { ...f.wb.getRevision(item.id), title: 'PRIVATE TITLE', content: 'PRIVATE LATER DRAFT', files: { 'later.txt': Buffer.from('later secret').toString('base64') } } });
    release(); await router.publisher.idle();
    assert.equal(router.publisher.list()[0].status, 'done', router.publisher.list()[0].error);
    const base = `workbench/items/${item.id}`;
    assert.equal(f.git('show', `HEAD:${base}/content.md`), 'REVIEWED');
    assert.equal(JSON.parse(f.git('show', `HEAD:${base}/item.json`)).revision, reviewed);
    const paths = f.git('ls-tree', '-r', '--name-only', 'HEAD');
    assert.ok(!paths.includes(early) && !paths.includes(draft.revision));
    assert.ok(!paths.includes('private.txt') && !paths.includes('later.txt'));
    assert.equal(f.wb.getRevision(item.id).content, 'PRIVATE LATER DRAFT');
    const clone = path.join(f.root, 'verify-approved'); execFileSync('git', ['clone', f.library, clone], { stdio: 'pipe' });
    assert.match(execFileSync(process.execPath, ['.kiln/validate.mjs'], { cwd: clone, encoding: 'utf8' }), /Validated 1 items/);
  } finally { release(); f.close(); }
});
