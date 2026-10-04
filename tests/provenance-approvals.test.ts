import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { DeploymentService } from '../packages/deployment/service';
import { revisionHash } from '../packages/domain/content';
import { portableSource, shareableAuthoring } from '../packages/domain/privacy';
import { initialiseRepository } from '../packages/git/standard';
import { Publisher } from '../packages/git/publish';
import { readJson, writeJson } from '../packages/storage/files';
import { writeWorkingFiles } from '../packages/storage/bundles';
import { authoringSchema, revisionSchema, type Approval, type Item, type PublishJob, type Revision } from '../packages/protocol/schema';

const skill = '---\nname: research\ndescription: Investigate a question carefully.\n---\nRead the evidence and cite the findings.\n';
const timestamp = '2026-09-19T12:00:00.000Z';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-provenance-'));
  const library = initialiseRepository({ parent: root, name: 'library' }).root;
  const local = path.join(root, 'first-machine');
  return { root, library, local };
}

/** Model an old library directly: current Kiln already sanitizes newly imported sources. */
function legacy(wb: Workbench, source: string, options: { version?: 1 | 2; description?: string; files?: Record<string, string>; trust?: Approval['trust']; revoked?: boolean; approved?: boolean } = {}) {
  const item = wb.create({ title: 'research', kind: 'skill', content: skill });
  const revision: Revision = { ...wb.getRevision(item.id), source, description: options.description ?? '', files: options.files ?? {}, parent: null, createdAt: timestamp };
  if (options.version === 1) delete revision.hashVersion;
  revision.hash = revisionHash(revision);
  writeJson(path.join(wb.itemDir(item.id), 'revisions', `${revision.hash}.json`), revision);
  writeWorkingFiles(path.join(wb.itemDir(item.id), 'files'), revision.files);
  const approval: Approval = { schemaVersion: 1, id: randomUUID(), itemId: item.id, revision: revision.hash, reviewer: 'Human', scope: 'Every machine', note: 'Reviewed these exact skill bytes', evidence: [], waivedChecks: 'Fixture', createdAt: timestamp, trust: options.trust ?? 'local', ...(options.revoked ? { revokedAt: '2026-09-20T12:00:00.000Z' } : {}) };
  if (options.approved !== false) writeJson(path.join(wb.canonical, 'approvals', `${approval.id}.json`), approval);
  const current: Item = { ...item, source, description: revision.description, revision: revision.hash, status: options.approved === false || options.trust === 'imported' || options.revoked ? 'captured' : 'approved', updatedAt: timestamp };
  writeJson(path.join(wb.itemDir(item.id), 'item.json'), current);
  return { item: current, revision, approval };
}

function sharedHistory(wb: Workbench, id: string) {
  return fs.readdirSync(path.join(wb.itemDir(id), 'revisions')).map(name => revisionSchema.parse(readJson(path.join(wb.itemDir(id), 'revisions', name))));
}

function assertPortableHistory(wb: Workbench, id: string) {
  for (const revision of sharedHistory(wb, id)) {
    assert.equal(portableSource(revision.source), revision.source, 'every shared history entry has portable provenance');
    assert.equal(revisionHash(revision), revision.hash, 'redaction never weakens revision integrity');
  }
}

function sharedFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${name}/`);
      else if (entry.name !== '.mutation.lock') files[name] = fs.readFileSync(path.join(dir, entry.name)).toString('base64');
    }
  };
  walk(root, '');
  return files;
}

test('legacy path-only cleanup preserves approval across machines and is idempotent for both hash versions', () => {
  const sources = ['local:/home/PRIVATE-USER/.agents/skills/research', '/home/PRIVATE-USER/.agents/skills/research', 'local:C:\\Users\\PRIVATE-USER\\.agents\\skills\\research', 'C:\\Users\\PRIVATE-USER\\.agents\\skills\\research', 'file:///home/PRIVATE-USER/.agents/skills/research', '\\\\PRIVATE-SERVER\\skills\\research', 'home:/home/PRIVATE-USER/skills/research', 'FILE:///home/PRIVATE-USER/skills/research', 'file:/home/PRIVATE-USER/skills/research', '~/skills/research', '\\skills\\research'];
  for (const version of [1, 2] as const) for (const source of sources) {
    const f = fixture(); let wb = new Workbench(f.library, f.local);
    try {
      const old = legacy(wb, source, { version });
      wb.close(); wb = new Workbench(f.library, f.local);
      const item = wb.getItem(old.item.id), current = wb.getRevision(item.id);
      assert.equal(item.source, 'local-import:research');
      assert.equal(item.status, 'approved', `${source}: provenance cleanup retains human approval`);
      assert.equal(current.content, skill);
      assert.deepEqual(current.files, old.revision.files);
      const approval = wb.approvals().find(a => a.id === old.approval.id)!;
      assert.ok(approval, 'the original approval record remains available');
      assert.equal(approval.revision, current.hash);
      assert.equal(approval.reviewer, 'Human');
      assert.equal(approval.trust, 'local');
      assertPortableHistory(wb, item.id);
      assert.doesNotMatch(JSON.stringify(Object.values(sharedFiles(wb.canonical)).map(bytes => Buffer.from(bytes, 'base64').toString('utf8'))), /PRIVATE-USER|PRIVATE-SERVER/);
      wb.close();
      const before = sharedFiles(path.join(f.library, 'workbench'));
      wb = new Workbench(f.library, f.local);
      assert.deepEqual(sharedFiles(wb.canonical), before, 'reopening a migrated library makes no more shared edits');
      const clone = path.join(f.root, 'second-checkout');
      fs.cpSync(f.library, clone, { recursive: true });
      const other = new Workbench(clone, path.join(f.root, 'second-machine'));
      try {
        assert.equal(other.getItem(item.id).status, 'approved');
        assert.equal(other.getItem(item.id).revision, item.revision, 'machines agree on the portable revision hash');
        const deployment = new DeploymentService(other);
        assert.equal(deployment.approvedRevision(item.id)?.hash, item.revision);
        const target = path.join(f.root, 'second-home'); fs.mkdirSync(target);
        other.enroll({ root: target, provider: 'codex', scope: 'personal', name: 'Second machine' });
        other.setInstall(item.id, 'codex', true);
        assert.equal(deployment.syncInstalls()[0].result, 'installed approved revision');
        assert.equal(fs.readFileSync(path.join(target, '.agents', 'skills', 'research', 'SKILL.md'), 'utf8'), skill);
        assertPortableHistory(other, item.id);
        for (const approval of other.approvals()) assert.equal(other.getRevision(approval.itemId, approval.revision).hash, approval.revision, 'trusted approvals are resolvable without the first machine’s private archive');
      } finally { other.close(); }
    } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('generated path descriptions are provenance, and the original source remains machine-private', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const source = 'local:/home/PRIVATE-USER/.agents/skills/research';
    const old = legacy(wb, source, { description: `Copy of ${source.slice('local:'.length)}` });
    wb.close(); wb = new Workbench(f.library, f.local);
    assert.equal(wb.getItem(old.item.id).status, 'approved');
    assert.equal(wb.getRevision(old.item.id).description, 'Copy of research');
    assert.equal(wb.origins({ ids: [old.item.id] })[old.item.id], source);
    assertPortableHistory(wb, old.item.id);
    for (const revision of sharedHistory(wb, old.item.id)) assert.doesNotMatch(JSON.stringify(revision), /PRIVATE-USER/);
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('cleanup migrates historical approvals while retaining a newer authored draft as unapproved', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const old = legacy(wb, 'local:/home/PRIVATE-USER/.agents/skills/research');
    const draft: Revision = { ...old.revision, parent: old.revision.hash, content: `${skill}\nUNREVIEWED CONTENT\n`, summary: 'An authored edit', createdAt: '2026-10-03T12:00:00.000Z' };
    draft.hash = revisionHash(draft);
    writeJson(path.join(wb.itemDir(old.item.id), 'revisions', `${draft.hash}.json`), draft);
    writeJson(path.join(wb.itemDir(old.item.id), 'item.json'), { ...old.item, revision: draft.hash, status: 'captured' });
    fs.writeFileSync(path.join(wb.itemDir(old.item.id), 'content.md'), draft.content);
    wb.close(); wb = new Workbench(f.library, f.local);
    const item = wb.getItem(old.item.id), current = wb.getRevision(item.id);
    assert.equal(item.status, 'captured');
    assert.equal(current.content, draft.content);
    assert.equal(wb.approvals().some(a => a.revision === current.hash), false, 'no human approval covers the authored change');
    const approved = new DeploymentService(wb).approvedRevision(item.id)!;
    assert.equal(approved.content, skill);
    assert.equal(current.parent, approved.hash, 'history parents follow the portable identity');
    assertPortableHistory(wb, item.id);
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('removing a private session attachment still requires fresh approval', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const old = legacy(wb, 'local:/home/PRIVATE-USER/.agents/skills/research', { files: { 'session.jsonl': Buffer.from('PRIVATE SESSION').toString('base64') } });
    wb.close(); wb = new Workbench(f.library, f.local);
    const item = wb.getItem(old.item.id), current = wb.getRevision(item.id);
    assert.equal(item.status, 'captured');
    assert.equal(current.files['session.jsonl'], undefined);
    assert.equal(wb.approvals().some(a => a.revision === current.hash && a.trust === 'local'), false);
    assert.equal(wb.getRevision(item.id, old.revision.hash).files['session.jsonl'], old.revision.files['session.jsonl'], 'the original private snapshot is retained locally');
    assertPortableHistory(wb, item.id);
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('revision evidence and item provenance follow source-only identity migration', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const old = legacy(wb, 'local:/home/PRIVATE-USER/.agents/skills/research');
    const trial = wb.prepareTrial({ id: old.item.id, revision: old.revision.hash, provider: 'manual', task: 'Check the skill', rubric: ['Cites evidence'], case: 'typical' }).trial;
    wb.finishTrial({ id: trial.id, judgement: 'pass', note: 'Checked', output: 'Evidence is cited' });
    writeJson(path.join(wb.canonical, 'approvals', `${old.approval.id}.json`), { ...old.approval, evidence: [trial.id], carriedFrom: old.revision.hash });
    const derived = wb.create({ title: 'An entry', kind: 'prompt', content: 'Derived result' });
    writeJson(path.join(wb.itemDir(derived.id), 'item.json'), { ...derived, origin: { itemId: old.item.id, revision: old.revision.hash } });
    writeJson(path.join(wb.itemDir(old.item.id), 'item.json'), { ...old.item, conflictHeads: [old.revision.hash] });
    wb.recordAnalysis({ schemaVersion: 1, id: randomUUID(), itemId: old.item.id, revision: old.revision.hash, provider: 'codex', model: 'Fixture', effort: '', startedAt: timestamp, finishedAt: timestamp, summary: 'Investigated', takeaway: 'Use evidence', skipped: '', counts: {}, created: [derived.id], collection: 'Personal' });
    wb.recordScore({ schemaVersion: 1, id: randomUUID(), itemId: old.item.id, revision: old.revision.hash, provider: 'codex', model: 'Fixture', effort: '', startedAt: timestamp, finishedAt: timestamp, score: 85, summary: 'Useful procedure', improvements: [] });
    wb.record('approved', 'Reviewed exact content', old.item.id, old.revision.hash);
    wb.close(); wb = new Workbench(f.library, f.local);
    const hash = wb.getItem(old.item.id).revision;
    const approval = wb.approvals().find(a => a.id === old.approval.id)!;
    assert.equal(approval.revision, hash);
    assert.deepEqual(approval.evidence, [trial.id]);
    assert.equal(approval.carriedFrom, hash);
    assert.equal(wb.trials().find(t => t.id === trial.id)!.revision, hash, 'approval evidence still describes the exact portable revision');
    assert.equal(wb.getItem(derived.id).origin!.revision, hash);
    assert.deepEqual(wb.getItem(old.item.id).conflictHeads, [hash]);
    assert.equal(wb.analyses(old.item.id)[0].revision, hash);
    assert.equal(wb.scores(old.item.id)[0].revision, hash);
    assert.equal(wb.activity().find(a => a.kind === 'approved' && a.itemId === old.item.id)!.revision, hash);
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('provenance migration preserves imported trust and revoked decisions', () => {
  for (const options of [{ trust: 'imported' as const }, { revoked: true }]) {
    const f = fixture(); let wb = new Workbench(f.library, f.local);
    try {
      const old = legacy(wb, 'local:/home/PRIVATE-USER/.agents/skills/research', options);
      wb.close(); wb = new Workbench(f.library, f.local);
      const current = wb.getItem(old.item.id), approval = wb.approvals(true).find(a => a.id === old.approval.id)!;
      assert.equal(current.status, 'captured');
      assert.equal(approval.trust, old.approval.trust);
      assert.equal(approval.revokedAt, old.approval.revokedAt);
      assert.equal(approval.revision, current.revision, 'historical decisions follow their sanitized revision');
      assert.equal(new DeploymentService(wb).approvedRevision(current.id), null);
      assertPortableHistory(wb, current.id);
    } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('a draft left by the old cleanup recovers its original approval only when the archived revision differs by provenance', () => {
  for (const edited of [false, true]) {
    const f = fixture(); let wb = new Workbench(f.library, f.local);
    try {
      const old = legacy(wb, 'local:/home/PRIVATE-USER/.agents/skills/research');
      const safe = authoringSchema.parse(shareableAuthoring(old.revision));
      const current: Revision = { ...old.revision, ...safe, hashVersion: 2, parent: old.revision.hash, summary: 'Moved private session data and machine provenance out of shared content', ...(edited ? { content: `${skill}\nUNREVIEWED CONTENT\n` } : {}) };
      current.hash = revisionHash(current);
      writeJson(path.join(wb.local, 'private-revisions', old.item.id, `${old.revision.hash}.json`), old.revision);
      fs.unlinkSync(path.join(wb.itemDir(old.item.id), 'revisions', `${old.revision.hash}.json`));
      writeJson(path.join(wb.itemDir(old.item.id), 'revisions', `${current.hash}.json`), current);
      writeJson(path.join(wb.itemDir(old.item.id), 'item.json'), { ...old.item, source: current.source, revision: current.hash, status: 'captured' });
      fs.writeFileSync(path.join(wb.itemDir(old.item.id), 'content.md'), current.content);
      wb.close(); wb = new Workbench(f.library, f.local);
      const repaired = wb.getItem(old.item.id);
      assert.equal(repaired.status, edited ? 'captured' : 'approved');
      assert.equal(wb.approvals().some(a => a.itemId === repaired.id && a.revision === repaired.revision && a.trust === 'local'), !edited);
      assertPortableHistory(wb, repaired.id);
      const approved = new DeploymentService(wb).approvedRevision(repaired.id)!;
      assert.equal(approved.content, skill);
      assert.equal(portableSource(approved.source), approved.source, 'the repaired approval does not depend on the private archive');
    } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

for (const action of ['approve', 'unapprove'] as const) test(`retrying a persisted ${action} job publishes portable provenance and the original decision`, async () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  const git = (...args: string[]) => execFileSync('git', ['-C', f.library, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    const origin = path.join(f.root, 'origin.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
    git('remote', 'add', 'origin', origin);
    const old = legacy(wb, 'local:/home/PRIVATE-USER/.agents/skills/research');
    git('add', '--', `workbench/items/${old.item.id}`, `workbench/approvals/${old.approval.id}.json`);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Existing legacy approval');
    git('push', '-u', 'origin', 'main');
    const approval = action === 'unapprove' ? { ...old.approval, revokedAt: '2026-10-03T12:00:00.000Z' } : old.approval;
    const item = { ...old.item, status: action === 'unapprove' ? 'captured' : 'approved' };
    writeJson(path.join(wb.canonical, 'approvals', `${approval.id}.json`), approval);
    writeJson(path.join(wb.itemDir(item.id), 'item.json'), item);
    const job: PublishJob = { id: randomUUID(), itemId: item.id, revision: old.revision.hash, title: item.title, action, status: 'failed', message: '', composer: '', commit: '', startedAt: timestamp, error: 'Offline before publishing' };
    const publish = path.join(wb.local, 'publish');
    writeJson(path.join(publish, 'jobs', `${job.id}.json`), job);
    const folder = `workbench/items/${item.id}`, files: Record<string, string> = {};
    const json = (file: string, value: unknown) => { files[file] = Buffer.from(JSON.stringify(value)).toString('base64'); };
    json(`${folder}/item.json`, item);
    json(`${folder}/revisions/${old.revision.hash}.json`, old.revision);
    json(`workbench/approvals/${approval.id}.json`, approval);
    files[`${folder}/content.md`] = Buffer.from(skill).toString('base64');
    writeJson(path.join(publish, 'snapshots', `${job.id}.json`), { files, replace: [folder] });
    wb.close(); wb = new Workbench(f.library, f.local);
    const publisher = new Publisher(wb, () => {}, null);
    const migrated = publisher.list().find(j => j.id === job.id)!;
    assert.equal(migrated.revision, wb.getItem(item.id).revision, 'the persisted retry follows its portable revision');
    publisher.retry(job.id); await publisher.idle();
    assert.equal(publisher.list().find(j => j.id === job.id)!.status, 'done', publisher.list().find(j => j.id === job.id)!.error);
    const clone = path.join(f.root, 'fresh-checkout');
    execFileSync('git', ['clone', '-c', 'core.autocrlf=false', origin, clone], { stdio: 'pipe' });
    assert.doesNotMatch(JSON.stringify(Object.values(sharedFiles(path.join(clone, 'workbench'))).map(bytes => Buffer.from(bytes, 'base64').toString('utf8'))), /PRIVATE-USER/);
    const other = new Workbench(clone, path.join(f.root, 'fresh-machine'));
    try {
      const current = other.getItem(item.id), decision = other.approvals(true).find(a => a.id === approval.id)!;
      assert.equal(current.status, action === 'approve' ? 'approved' : 'captured');
      assert.equal(decision.revision, current.revision);
      assert.equal(decision.revokedAt, approval.revokedAt);
      const approved = new DeploymentService(other).approvedRevision(item.id);
      if (action === 'approve') assert.equal(approved?.content, skill);
      else assert.equal(approved, null, 'withdrawing approval cannot be undone by provenance cleanup on another machine');
      assertPortableHistory(other, item.id);
    } finally { other.close(); }
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('publishing a migrated revision carries portable historical approvals and their exact trial evidence', async () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  const git = (...args: string[]) => execFileSync('git', ['-C', f.library, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    const origin = path.join(f.root, 'origin.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
    git('remote', 'add', 'origin', origin);
    const old = legacy(wb, 'local:/home/PRIVATE-USER/.agents/skills/research');
    const firstTrial = wb.prepareTrial({ id: old.item.id, revision: old.revision.hash, provider: 'manual', task: 'Check the first procedure', rubric: ['Cites evidence'], case: 'typical' }).trial;
    wb.finishTrial({ id: firstTrial.id, judgement: 'pass', note: 'Checked', output: 'First evidence' });
    writeJson(path.join(wb.canonical, 'approvals', `${old.approval.id}.json`), { ...old.approval, evidence: [firstTrial.id] });
    const next: Revision = { ...old.revision, parent: old.revision.hash, content: `${skill}\nCheck the strongest counterexample.\n`, createdAt: '2026-10-03T12:00:00.000Z', summary: 'A second reviewed procedure' };
    next.hash = revisionHash(next);
    writeJson(path.join(wb.itemDir(old.item.id), 'revisions', `${next.hash}.json`), next);
    writeJson(path.join(wb.itemDir(old.item.id), 'item.json'), { ...old.item, revision: next.hash });
    fs.writeFileSync(path.join(wb.itemDir(old.item.id), 'content.md'), next.content);
    const secondTrial = wb.prepareTrial({ id: old.item.id, revision: next.hash, provider: 'manual', task: 'Check the second procedure', rubric: ['Checks counterexamples'], case: 'boundary' }).trial;
    wb.finishTrial({ id: secondTrial.id, judgement: 'pass', note: 'Checked', output: 'Second evidence' });
    const secondApproval: Approval = { ...old.approval, id: randomUUID(), revision: next.hash, evidence: [secondTrial.id], createdAt: next.createdAt };
    writeJson(path.join(wb.canonical, 'approvals', `${secondApproval.id}.json`), secondApproval);
    git('add', '--', `workbench/items/${old.item.id}`, 'workbench/approvals', 'workbench/experiments');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Two legacy approvals with trial evidence');
    git('push', '-u', 'origin', 'main');
    wb.close(); wb = new Workbench(f.library, f.local);
    const publisher = new Publisher(wb, () => {}, null);
    const job = publisher.enqueue('approve', old.item.id, wb.getItem(old.item.id).revision);
    await publisher.idle();
    assert.equal(publisher.list().find(j => j.id === job.id)!.status, 'done', publisher.list().find(j => j.id === job.id)!.error);
    const clone = path.join(f.root, 'fresh-checkout');
    execFileSync('git', ['clone', '-c', 'core.autocrlf=false', origin, clone], { stdio: 'pipe' });
    assert.doesNotMatch(JSON.stringify(Object.values(sharedFiles(path.join(clone, 'workbench'))).map(bytes => Buffer.from(bytes, 'base64').toString('utf8'))), /PRIVATE-USER/);
    const other = new Workbench(clone, path.join(f.root, 'fresh-machine'));
    try {
      const approvals = other.approvals().filter(a => a.itemId === old.item.id && a.trust === 'local');
      assert.deepEqual(approvals.map(a => a.id).sort(), [old.approval.id, secondApproval.id].sort(), 'both human decisions reach the next machine');
      for (const approval of approvals) {
        const revision = other.getRevision(approval.itemId, approval.revision);
        assert.equal(portableSource(revision.source), revision.source);
        assert.equal(revision.content, approval.id === old.approval.id ? skill : next.content);
        const evidence = other.trials().filter(trial => approval.evidence.includes(trial.id));
        assert.equal(evidence.length, 1, 'the historical evidence is published alongside its approval');
        assert.equal(evidence[0].revision, approval.revision, 'each trial retains its exact approved revision');
        assert.equal(evidence[0].status, 'completed');
        assert.equal(evidence[0].judgement, 'pass');
      }
      assertPortableHistory(other, old.item.id);
    } finally { other.close(); }
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('provenance migration preserves existing deployment rollback and pending deployment plans', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const old = legacy(wb, 'local:/home/PRIVATE-USER/.agents/skills/research');
    const firstHome = path.join(f.root, 'first-home'); fs.mkdirSync(firstHome);
    const target = wb.enroll({ root: firstHome, provider: 'codex', scope: 'personal', name: 'Existing install' });
    let deployment = new DeploymentService(wb);
    const firstPlan = deployment.plan({ itemId: old.item.id, revision: old.revision.hash, targetId: target.id });
    const firstReceipt = deployment.apply({ planId: firstPlan.id, expectState: null, confirm: true });
    const next: Revision = { ...old.revision, parent: old.revision.hash, content: `${skill}\nCheck the strongest counterexample.\n`, createdAt: '2026-10-03T12:00:00.000Z' };
    next.hash = revisionHash(next);
    writeJson(path.join(wb.itemDir(old.item.id), 'revisions', `${next.hash}.json`), next);
    writeJson(path.join(wb.itemDir(old.item.id), 'item.json'), { ...old.item, revision: next.hash });
    fs.writeFileSync(path.join(wb.itemDir(old.item.id), 'content.md'), next.content);
    const secondApproval: Approval = { ...old.approval, id: randomUUID(), revision: next.hash, createdAt: next.createdAt };
    writeJson(path.join(wb.canonical, 'approvals', `${secondApproval.id}.json`), secondApproval);
    const secondPlan = deployment.plan({ itemId: old.item.id, revision: next.hash, targetId: target.id });
    const secondReceipt = deployment.apply({ planId: secondPlan.id, expectState: firstReceipt.hash, confirm: true });
    assert.equal(secondReceipt.previousRevision, old.revision.hash);
    const journalFile = path.join(wb.local, 'journals', `${secondReceipt.id}.json`);
    const journal = readJson(journalFile) as Record<string, unknown>;
    writeJson(journalFile, { ...journal, phase: 'switched' });
    const secondHome = path.join(f.root, 'second-home'); fs.mkdirSync(secondHome);
    const secondTarget = wb.enroll({ root: secondHome, provider: 'codex', scope: 'personal', name: 'Pending install' });
    const pending = deployment.plan({ itemId: old.item.id, revision: next.hash, targetId: secondTarget.id });
    wb.close(); wb = new Workbench(f.library, f.local); deployment = new DeploymentService(wb);
    assert.equal(deployment.recover().find(result => result.id === secondReceipt.id)!.status, 'completed');
    const migrated = deployment.receipts().find(r => r.id === secondReceipt.id)!;
    assert.equal(migrated.hash, secondReceipt.hash, 'redacting provenance changes no installed bytes');
    assert.equal(migrated.revision, wb.getItem(old.item.id).revision);
    assert.equal(wb.getRevision(old.item.id, migrated.previousRevision!).source, 'local-import:research');
    const applied = deployment.apply({ planId: pending.id, expectState: null, confirm: true });
    assert.equal(applied.revision, wb.getItem(old.item.id).revision);
    assert.equal(fs.readFileSync(path.join(secondHome, '.agents', 'skills', 'research', 'SKILL.md'), 'utf8'), next.content);
    const reversal = deployment.rollback({ receiptId: migrated.id, expectState: migrated.hash, confirm: true });
    assert.equal(reversal.revision, migrated.previousRevision);
    assert.equal(fs.readFileSync(path.join(firstHome, '.agents', 'skills', 'research', 'SKILL.md'), 'utf8'), skill);
    assertPortableHistory(wb, old.item.id);
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const oldCleanup of [false, true]) test(`an interrupted provenance migration retries without losing the approval of ${oldCleanup ? 'a draft left by the old cleanup' : 'an approved legacy revision'}`, () => {
  const f = fixture(); let wb: Workbench | undefined = new Workbench(f.library, f.local);
  const rename = fs.renameSync;
  try {
    const old = legacy(wb, 'local:/home/PRIVATE-USER/.agents/skills/research');
    if (oldCleanup) {
      const current: Revision = { ...old.revision, ...authoringSchema.parse(shareableAuthoring(old.revision)), hashVersion: 2, parent: old.revision.hash, summary: 'Moved private session data and machine provenance out of shared content' };
      current.hash = revisionHash(current);
      writeJson(path.join(wb.local, 'private-revisions', old.item.id, `${old.revision.hash}.json`), old.revision);
      fs.unlinkSync(path.join(wb.itemDir(old.item.id), 'revisions', `${old.revision.hash}.json`));
      writeJson(path.join(wb.itemDir(old.item.id), 'revisions', `${current.hash}.json`), current);
      writeJson(path.join(wb.itemDir(old.item.id), 'item.json'), { ...old.item, source: current.source, revision: current.hash, status: 'captured' });
    }
    const destination = path.join(wb.itemDir(old.item.id), 'item.json');
    wb.close(); wb = undefined;
    let failed = false;
    fs.renameSync = ((from, to) => {
      if (String(to) === destination && !failed) { failed = true; throw new Error('Injected migration interruption'); }
      return rename(from, to);
    }) as typeof fs.renameSync;
    wb = new Workbench(f.library, f.local);
    assert.ok(failed, 'failure reached the migration after its safe snapshot was written');
    assert.ok(wb.warnings.some(warning => warning.includes('Injected migration interruption')));
    assert.equal((readJson(path.join(wb.canonical, 'approvals', `${old.approval.id}.json`)) as Approval).revision, old.revision.hash, 'an interrupted item repair leaves its original approval reference intact for retry');
    fs.renameSync = rename;
    wb.close(); wb = undefined; wb = new Workbench(f.library, f.local);
    const item = wb.getItem(old.item.id), approval = wb.approvals().find(a => a.id === old.approval.id)!;
    assert.equal(item.status, 'approved');
    assert.equal(approval.revision, item.revision);
    assert.equal(wb.getRevision(item.id).content, skill);
    assertPortableHistory(wb, item.id);
    assert.equal(fs.existsSync(path.join(wb.itemDir(item.id), 'revisions', `${old.revision.hash}.json`)), false);
  } finally { fs.renameSync = rename; wb?.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
