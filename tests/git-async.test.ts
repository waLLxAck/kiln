import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { initialiseRepository } from '../packages/git/standard';
import { runRaw } from '../packages/git/run';
import { GitQueue } from '../packages/git/queue';

const posix = process.platform !== 'win32';
const skill = (name: string) => `---\nname: ${name}\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff. Verify claims.\n`;
const approveArgs = (item: { id: string; revision: string }) => ({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; !check(); await sleep(20)) if (Date.now() > end) throw new Error('Timed out waiting');
}

/**
 * A `git` first on PATH that logs every call and passes it to the real one. With FAKE_GIT_HANG set, `push` instead starts a
 * helper that holds stdout open (as git-remote-https can) and then hangs itself.
 */
function fakeGit(root: string) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const log = path.join(root, 'git.log'), helper = path.join(root, 'helper.pid');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
for arg; do
  if [ "$arg" = push ]; then
    printf 'env GIT_TERMINAL_PROMPT=%s GCM_INTERACTIVE=%s\\n' "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE" >> "$FAKE_GIT_LOG"
    if [ -n "$FAKE_GIT_HANG" ]; then sleep 60 & echo $! > "$FAKE_GIT_HELPER"; sleep 60; fi
  fi
done
exec "$FAKE_GIT_REAL" "$@"
`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, FAKE_GIT_LOG: process.env.FAKE_GIT_LOG, FAKE_GIT_REAL: process.env.FAKE_GIT_REAL, FAKE_GIT_HELPER: process.env.FAKE_GIT_HELPER, FAKE_GIT_HANG: process.env.FAKE_GIT_HANG, KILN_GIT_NETWORK_TIMEOUT_MS: process.env.KILN_GIT_NETWORK_TIMEOUT_MS };
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GIT_LOG: log, FAKE_GIT_REAL: real, FAKE_GIT_HELPER: helper });
  return {
    lines: () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } },
    clear: () => fs.rmSync(log, { force: true }),
    helper: () => { try { return Number(fs.readFileSync(helper, 'utf8').trim()) || 0; } catch { return 0; } },
    restore: () => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; },
  };
}
/** A ready library (standard repository with a local bare "GitHub"), its workbench and router. */
function library(root: string) {
  const created = initialiseRepository({ parent: root, name: 'library' }); assert.ok(created.committed, created.message);
  const origin = path.join(root, 'origin.git'); execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  execFileSync('git', ['-C', created.root, 'remote', 'add', 'origin', origin], { windowsHide: true });
  const wb = new Workbench(created.root, path.join(root, 'private'));
  return { wb, router: new Router(wb, { composer: null, describer: null }), library: created.root };
}

test('a run settles when the process exits, even while a helper it started still holds stdout open', { skip: !posix }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln run '));
  const pid = path.join(root, 'helper.pid');
  try {
    const started = Date.now();
    await assert.rejects(runRaw('sh', ['-c', 'sleep 30 & echo $! > "$0"; echo partial; exit 3', pid]), (error: Error & { code?: number; stdout?: string }) => error.code === 3 && error.stdout === 'partial\n');
    assert.ok(Date.now() - started < 3000, `settled after ${Date.now() - started} ms`);
    process.kill(Number(fs.readFileSync(pid, 'utf8')), 'SIGKILL');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a timed-out run kills the whole process tree and settles', { skip: !posix }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln run '));
  const pid = path.join(root, 'helper.pid');
  try {
    const started = Date.now();
    await assert.rejects(runRaw('sh', ['-c', 'sleep 30 & echo $! > "$0"; sleep 30', pid], { timeoutMs: 300 }), (error: Error & { killed?: boolean }) => error.killed === true && /did not finish/.test(error.message));
    assert.ok(Date.now() - started < 4000, `settled after ${Date.now() - started} ms`);
    await until(() => !alive(Number(fs.readFileSync(pid, 'utf8'))), 2000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the Git queue gives up on a task past its deadline, and later tasks still run', async () => {
  const queue = new GitQueue(100);
  const stuck = queue.run(() => new Promise(() => {}));
  const next = queue.run(() => 'next');
  await assert.rejects(stuck, (error: Error & { code?: string }) => error.code === 'GIT_TIMEOUT');
  assert.equal(await next, 'next');
});

test('a push that hangs blocks neither reads nor the event loop, never prompts for credentials, and gives up', { skip: !posix }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln hanging '));
  const fake = fakeGit(root);
  let wb: Workbench | undefined;
  try {
    const side = library(root); wb = side.wb;
    const item = side.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    process.env.FAKE_GIT_HANG = '1'; process.env.KILN_GIT_NETWORK_TIMEOUT_MS = '1500';
    const started = Date.now();
    side.router.approve(approveArgs(item));
    await until(() => fake.helper() > 0);
    assert.equal(side.router.publisher.list()[0].status, 'pushing');
    // The thread is free: a timer fires on time, and an unrelated read answers at once.
    const tick = Date.now(); await sleep(20); assert.ok(Date.now() - tick < 500, `timer late by ${Date.now() - tick} ms`);
    const read = Date.now();
    const detail = side.router.call('items.read', { id: item.id }) as { item: { id: string } };
    assert.equal(detail.item.id, item.id); assert.ok(Date.now() - read < 1000);
    assert.ok(side.wb.snapshot().items.some(i => i.id === item.id));
    await side.router.publisher.idle();
    const [job] = side.router.publisher.list();
    assert.equal(job.status, 'failed'); assert.match(job.error ?? '', /did not answer in time/);
    assert.ok(job.commit, 'committed locally before the push');
    assert.ok(Date.now() - started < 10_000, `gave up after ${Date.now() - started} ms`);
    await until(() => !alive(fake.helper()), 3000);
    const push = fake.lines().find(line => / push /.test(line)) ?? '';
    assert.match(push, /-c credential\.interactive=never/); assert.match(push, /http\.lowSpeedLimit=/);
    assert.ok(fake.lines().includes('env GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never'), 'push runs without prompts');
  } finally { fake.restore(); wb?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('starring an item that was never published starts no Git process; starring a published one is still published', { skip: !posix }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln star '));
  const fake = fakeGit(root);
  let wb: Workbench | undefined;
  try {
    const side = library(root); wb = side.wb;
    const published = side.wb.create({ title: 'Published', kind: 'skill', content: skill('published-skill') });
    side.router.approve(approveArgs(published)); await side.router.publisher.idle();
    assert.equal(side.router.publisher.list()[0].status, 'done');
    const drafts = Array.from({ length: 5 }, (_, i) => side.wb.create({ title: `Draft ${i}`, kind: 'prompt', content: `Draft words ${i}` }));
    fake.clear();
    for (const draft of drafts) side.router.call('items.meta', { id: draft.id, expect: draft.revision, favourite: true });
    side.router.call('items.update', { id: drafts[0].id, expect: side.wb.getItem(drafts[0].id).revision, summary: 'Edit', value: { ...side.wb.authoring(drafts[0].id), content: 'Edited draft' } });
    assert.equal(side.router.flushOrganisation(), null);
    await sleep(100);
    assert.deepEqual(fake.lines(), [], 'no Git process for drafts');

    const item = side.wb.getItem(published.id);
    side.router.call('items.meta', { id: item.id, expect: item.revision, favourite: true });
    assert.ok(side.router.flushOrganisation(), 'a published favourite is organisation');
    await side.router.publisher.idle();
    const job = side.router.publisher.list().find(j => j.action === 'organise');
    assert.equal(job?.status, 'done', job?.error);
    assert.equal(JSON.parse(execFileSync('git', ['-C', side.library, 'show', `HEAD:workbench/items/${item.id}/item.json`], { encoding: 'utf8' })).favourite, true);
  } finally { fake.restore(); wb?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
