import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { threadId } from 'node:worker_threads';
import { Workbench } from '../packages/domain/workbench';
import { atomicWrite, LOCK_FOREIGN_MS, LOCK_MAX_AGE_MS, LOCK_UNREADABLE_MS, LOCK_WAIT_MS, staleLock, withLock } from '../packages/storage/files';

const busy = (error: unknown) => (error as { code?: string }).code === 'LIBRARY_BUSY';
function folder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-lock-'));
  return { root, lock: path.join(root, '.mutation.lock'), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
/** Writes a lock as another process would have, last touched `ageMs` ago. */
function leave(file: string, text: string, ageMs = 0) { fs.writeFileSync(file, text); const at = new Date(Date.now() - ageMs); fs.utimesSync(file, at, at); }
const record = (fields: Record<string, unknown>) => JSON.stringify({ host: os.hostname(), started: new Date().toISOString(), ...fields });
/** A PID that was running a moment ago and has exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid!;

test('an empty lock left by a crash is taken over once it is a few seconds old; a fresh one waits, then reports LIBRARY_BUSY', () => {
  const f = folder();
  try {
    leave(f.lock, '', LOCK_UNREADABLE_MS + 1000);
    assert.equal(withLock(f.root, () => 'ran'), 'ran');
    assert.equal(fs.existsSync(f.lock), false);
    leave(f.lock, '{"pid":');
    const started = Date.now();
    assert.throws(() => withLock(f.root, () => 'ran'), busy);
    assert.ok(Date.now() - started >= LOCK_WAIT_MS - 50, 'retried briefly before giving up');
    assert.equal(fs.readFileSync(f.lock, 'utf8'), '{"pid":', 'a lock that may still be written is left alone');
  } finally { f.close(); }
});

test('a lock from a process that has exited is taken over at once', () => {
  const f = folder();
  try { leave(f.lock, record({ pid: deadPid() })); assert.equal(withLock(f.root, () => 'ran'), 'ran'); }
  finally { f.close(); }
});

test('a lock from a running process holds until the maximum age, when the PID must belong to another program', () => {
  const f = folder();
  try {
    leave(f.lock, record({ pid: process.ppid }));
    assert.throws(() => withLock(f.root, () => 'ran'), busy);
    leave(f.lock, record({ pid: process.ppid }), LOCK_MAX_AGE_MS + 1000);
    assert.equal(withLock(f.root, () => 'ran'), 'ran');
  } finally { f.close(); }
});

test('stale lock rules: before this boot, EPERM, another machine, and an earlier process with this PID', () => {
  const at = Date.now(), live = process.ppid;
  assert.equal(staleLock(record({ pid: live }), at - os.uptime() * 1000 - 60_000, at), true, 'written before the machine started');
  const kill = process.kill;
  process.kill = (() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }) as typeof process.kill;
  try {
    assert.equal(staleLock(record({ pid: 4242 }), at, at), false);
    assert.equal(staleLock(record({ pid: 4242 }), at, at + LOCK_FOREIGN_MS + 1), true, 'EPERM: not one of ours, most likely a reused PID');
  } finally { process.kill = kill; }
  assert.equal(staleLock(record({ pid: live, host: 'another-machine' }), at, at), false);
  assert.equal(staleLock(record({ pid: live, host: 'another-machine' }), at, at + LOCK_FOREIGN_MS + 1), true);
  const thisStart = Date.now() - process.uptime() * 1000;
  assert.equal(staleLock(record({ pid: process.pid, processStart: thisStart - 3_600_000, threadId: threadId + 1 }), at, at), true, 'an earlier process had this PID');
  assert.equal(staleLock(record({ pid: process.pid, processStart: thisStart, threadId }), at, at), true, 'left by this thread after a failed release');
  assert.equal(staleLock(record({ pid: process.pid, processStart: thisStart, threadId: threadId + 1 }), at, at), false, 'held by another thread of this process');
  assert.equal(staleLock('', at, at + LOCK_UNREADABLE_MS + 1), true);
});

test('releasing removes only this lock, never one another process took over', () => {
  const f = folder();
  try {
    const theirs = record({ pid: process.ppid });
    withLock(f.root, () => { fs.writeFileSync(f.lock, theirs); });
    assert.equal(fs.readFileSync(f.lock, 'utf8'), theirs);
  } finally { f.close(); }
});

test('the library opens while another process holds it; start-up tidy-ups wait for the next start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-lock-open-'));
  const library = path.join(root, 'library'), local = path.join(root, 'private');
  try {
    new Workbench(library, local).close();
    const lock = path.join(library, 'workbench', '.mutation.lock');
    leave(lock, record({ pid: process.ppid }));
    const wb = new Workbench(library, local);
    try {
      assert.ok(wb.warnings.some(w => /tidy-up was skipped/.test(w)), wb.warnings.join('\n'));
      assert.throws(() => wb.create({ title: 'Blocked', kind: 'prompt', content: 'Text' }), busy);
      // The other process finished without removing its lock (it crashed): the next mutation goes ahead.
      leave(lock, record({ pid: deadPid() }));
      assert.equal(wb.create({ title: 'Saved', kind: 'prompt', content: 'Text' }).title, 'Saved');
    } finally { wb.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('atomicWrite retries a rename Windows refuses while a scanner holds the file', () => {
  const f = folder(), file = path.join(f.root, 'value.json'), rename = fs.renameSync;
  try {
    let refusals = 0;
    fs.renameSync = ((from, to) => { if (refusals < 2) { refusals++; throw Object.assign(new Error('operation not permitted'), { code: refusals === 1 ? 'EPERM' : 'EBUSY' }); } return rename(from, to); }) as typeof fs.renameSync;
    atomicWrite(file, 'first');
    assert.equal(refusals, 2); assert.equal(fs.readFileSync(file, 'utf8'), 'first');
    fs.renameSync = (() => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); }) as typeof fs.renameSync;
    assert.throws(() => atomicWrite(file, 'second'), /access denied/);
    fs.renameSync = (() => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); }) as typeof fs.renameSync;
    assert.throws(() => atomicWrite(file, 'third'), /no such file/);
  } finally { fs.renameSync = rename; }
  try {
    assert.equal(fs.readFileSync(file, 'utf8'), 'first');
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp')), [], 'temporary files are removed');
  } finally { f.close(); }
});

test('a folder watcher error is logged and the watcher re-armed, instead of ending the worker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-watch-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  try {
    const logged: string[] = []; wb.diagnostics = (event, fields) => logged.push(`${event}:${fields?.code}`);
    const watcher = (wb as unknown as { watcher: fs.FSWatcher }).watcher;
    watcher.emit('error', Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    assert.deepEqual(logged, ['workbench.watcherFailed:EPERM']);
    const end = Date.now() + 5000;
    while (!(wb as unknown as { watcher?: fs.FSWatcher }).watcher) { assert.ok(Date.now() < end, 'watcher re-armed'); await new Promise(resolve => setTimeout(resolve, 50)); }
    // Whatever changed while nothing watched is reconciled.
    assert.equal(wb.create({ title: 'After', kind: 'prompt', content: 'Text' }).title, 'After');
    assert.equal(wb.snapshot().items.length, 1);
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
