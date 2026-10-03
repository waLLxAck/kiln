import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Backend, type BackendOptions } from '../apps/desktop/backend';
import { deadline, longCalls, pureReads, READ_DEADLINE_MS } from '../apps/desktop/backend-routes';
import { initialiseRepository } from '../packages/git/standard';

/**
 * A stand-in worker speaking the backend protocol. `queued` is left waiting (never started) by the first worker only; `hang`
 * starts and never answers; `block` holds the thread; `crash` ends the worker. Each start is counted in `<local>/spawns`.
 */
const fake = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs'), path = require('node:path');
const counter = path.join(workerData.local, 'spawns'); fs.appendFileSync(counter, 'x');
const spawn = fs.readFileSync(counter, 'utf8').length;
if (workerData.root === 'unopenable') { parentPort.postMessage({ fatal: { code: 'LIBRARY_BUSY', message: 'Another process is updating this library.' } }); process.exit(1); }
setInterval(() => parentPort.postMessage({ heartbeat: true }), 30).unref();
setTimeout(() => parentPort.postMessage({ ready: true }), workerData.root === 'slow' ? 300 : 0);
parentPort.on('message', ({ id, method, args }) => {
  const name = method === 'rpc' ? args[0] : method;
  if (name === 'queued' && spawn === 1) return;
  parentPort.postMessage({ started: id });
  if (name === 'hang') return;
  if (name === 'crash') process.exit(3);
  if (name === 'block') { const until = Date.now() + args[1]; while (Date.now() < until); }
  if (name === 'late') { setTimeout(() => parentPort.postMessage({ id, data: 'late' }), args[1]); return; }
  parentPort.postMessage({ id, data: { name, spawn, root: workerData.root } });
});`;
function harness(root = 'library', options: BackendOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-backend-')), workerFile = path.join(dir, 'worker.cjs');
  fs.writeFileSync(workerFile, fake);
  const events: { event: string; fields?: Record<string, unknown> }[] = [];
  const backend = new Backend(root, dir, (event, fields) => events.push({ event, fields }), { node: '', script: '' }, { workerFile, tickMs: 20, stallMs: 200, restartDelays: [20, 20, 20], ...options });
  const spawns = () => fs.readFileSync(path.join(dir, 'spawns'), 'utf8').length;
  return { backend, events, spawns, close() { backend.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { assert.ok(Date.now() < end, 'timed out waiting'); await new Promise(resolve => setTimeout(resolve, 10)); } };
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('backend deadlines: reads get 30 s, long Git and network calls none, everything else two minutes', () => {
  assert.equal(deadline('items.read'), READ_DEADLINE_MS); assert.equal(deadline('snapshot'), READ_DEADLINE_MS);
  assert.equal(deadline('sync.pull'), null); assert.equal(deadline('repos.import'), null);
  assert.equal(deadline('items.update'), 120_000);
  for (const name of pureReads) assert.ok(!longCalls.has(name), name);
});

test('a call past its deadline fails with TIMEOUT and frees its slot; a late answer is only logged', async () => {
  const h = harness('library', { deadline: name => name === 'hang' || name === 'late' ? 150 : null });
  try {
    await h.backend.opened;
    const started = Date.now();
    await assert.rejects(h.backend.call('rpc', 'hang'), (error: Error & { code?: string }) => error.code === 'TIMEOUT' && error.message === 'Kiln took too long to answer');
    assert.ok(Date.now() - started < 1500);
    assert.equal(h.backend.status().pending, 0);
    assert.ok(h.events.some(e => e.event === 'backend.timeout' && e.fields?.method === 'hang' && e.fields?.started === true));
    await assert.rejects(h.backend.call('rpc', 'late', 300), code('TIMEOUT'));
    await until(() => h.events.some(e => e.event === 'backend.late'));
    assert.deepEqual(await h.backend.call('rpc', 'items.read'), { name: 'items.read', spawn: 1, root: 'library' });
  } finally { h.close(); }
});

test('a worker crash fails the calls it had begun, resends the rest and restarts the worker', async () => {
  const h = harness();
  try {
    await h.backend.opened;
    const hung = h.backend.call('rpc', 'hang'), waiting = h.backend.call('rpc', 'queued');
    await until(() => h.backend.status().running?.method === 'hang');
    const crashed = h.backend.call('rpc', 'crash');
    await assert.rejects(hung, code('BACKEND_RESTARTING'));
    await assert.rejects(crashed, code('BACKEND_RESTARTING'));
    assert.equal(h.backend.status().restarting, true);
    // Asked while the worker restarts: delivered to the new one.
    const during = h.backend.call('rpc', 'items.read');
    assert.deepEqual(await waiting, { name: 'queued', spawn: 2, root: 'library' });
    assert.deepEqual(await during, { name: 'items.read', spawn: 2, root: 'library' });
    assert.equal(h.spawns(), 2);
    assert.ok(h.events.some(e => e.event === 'backend.restarting' && e.fields?.rejected === 2 && e.fields?.resent === 1));
    assert.equal(h.backend.status().restarting, undefined);
  } finally { h.close(); }
});

test('a restarted worker opens the library attached last', async () => {
  const h = harness();
  try {
    await h.backend.opened;
    await h.backend.call('attach', '/other/library');
    await assert.rejects(h.backend.call('rpc', 'crash'), code('BACKEND_RESTARTING'));
    assert.deepEqual(await h.backend.call('rpc', 'items.read'), { name: 'items.read', spawn: 2, root: '/other/library' });
  } finally { h.close(); }
});

test('restarts are bounded: a library that cannot be opened stops with its own reason', async () => {
  const h = harness('unopenable');
  try {
    await assert.rejects(h.backend.opened, (error: Error & { code?: string }) => error.code === 'LIBRARY_BUSY' && /Another process/.test(error.message));
    assert.equal(h.spawns(), 4);
    await assert.rejects(h.backend.call('rpc', 'items.read'), code('LIBRARY_BUSY'));
    assert.ok(h.events.some(e => e.event === 'backend.stopped'));
  } finally { h.close(); }
});

test('backend.status names the running call, and startup while the library opens', async () => {
  const h = harness('slow');
  try {
    assert.equal(h.backend.status().running?.method, 'startup');
    // Calls made while the library opens are answered once it is open, and their deadlines start then.
    const early = h.backend.call('rpc', 'snapshot');
    await h.backend.opened;
    assert.equal((await early).name, 'snapshot');
    void h.backend.call('rpc', 'hang').catch(() => {});
    void h.backend.call('rpc', 'queued').catch(() => {});
    await until(() => h.backend.status().running?.method === 'hang');
    const status = h.backend.status();
    assert.equal(status.pending, 2); assert.ok(status.running!.ms >= 0); assert.equal(status.restarting, undefined);
    assert.ok(h.events.some(e => e.event === 'worker.ready'));
  } finally { h.close(); }
});

test('a worker stuck in synchronous work is logged as a stall naming the call, then as recovered', async () => {
  const h = harness();
  try {
    await h.backend.opened;
    assert.equal((await h.backend.call('rpc', 'block', 700)).name, 'block');
    const stall = h.events.find(e => e.event === 'worker.stall');
    assert.equal(stall?.fields?.method, 'block');
    assert.ok(Number(stall?.fields?.silentMs) >= 200);
    assert.ok(h.events.some(e => e.event === 'worker.recovered' && e.fields?.method === 'block' && Number(e.fields?.durationMs) >= 400));
  } finally { h.close(); }
});

/** A remote that accepts connections and never answers, so a fetch hangs until its timeout. */
async function silentRemote() {
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer(() => { /* Never answers. */ });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/library.git`, close() { for (const socket of sockets) socket.destroy(); server.close(); } };
}

test('real worker: identical reads asked together are read once, and reads do not wait behind a pull stuck on the network', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-backend-real-')), remote = await silentRemote();
  const created = initialiseRepository({ parent: root, name: 'library' }); assert.ok(created.committed, created.message);
  execFileSync('git', ['-C', created.root, 'remote', 'add', 'origin', remote.url], { windowsHide: true });
  const events: { event: string; fields?: Record<string, unknown> }[] = [];
  const backend = new Backend(created.root, path.join(root, 'private'), (event, fields) => events.push({ event, fields }), { node: process.execPath, script: '' }, { workerFile: path.resolve('apps/desktop/backend-worker.ts') });
  try {
    // Sent while the worker opens the library, so they arrive together.
    const snapshots = await Promise.all(Array.from({ length: 6 }, () => backend.call('rpc', 'snapshot')));
    assert.equal(new Set(snapshots.map(s => JSON.stringify(s))).size, 1);
    assert.ok(events.some(e => e.event === 'backend.coalesced' && e.fields?.method === 'snapshot' && e.fields?.count === 6), JSON.stringify(events.filter(e => e.event === 'backend.coalesced')));
    const item = await backend.call('rpc', 'items.create', { title: 'Example', kind: 'prompt', content: 'Text', files: {} });
    // The fetch holds the Git queue; the pull waits for it in the ordered queue.
    const fetching = backend.call('rpc', 'sync.fetch', { maxAgeMs: 0 }), pulling = backend.call('rpc', 'sync.pull');
    fetching.catch(() => {}); pulling.catch(() => {});
    await until(() => events.some(e => e.event === 'backend.started' && e.fields?.method === 'sync.pull'));
    const started = Date.now();
    const [detail, listed] = await Promise.all([backend.call('rpc', 'items.read', { id: item.id }), backend.call('rpc', 'items.list', {}), backend.call('rpc', 'snapshot'), backend.call('settings')]);
    const elapsed = Date.now() - started;
    assert.equal(detail.item.id, item.id); assert.equal(listed.length, 1);
    assert.ok(elapsed < 3000, `reads waited ${elapsed} ms behind the pull`);
    const status = backend.status();
    assert.ok(status.pending >= 2); assert.ok(['sync.fetch', 'sync.pull'].includes(status.running?.method ?? ''), JSON.stringify(status));
  } finally { backend.close(); remote.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
