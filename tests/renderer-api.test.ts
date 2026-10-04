import { test } from 'node:test';
import assert from 'node:assert/strict';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('renderer reads share bounded readiness, preserve read budgets, and retry failures', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: string[] = [];
  let respond: (method: string) => Promise<unknown> = async () => true;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { kiln: { call: (method: string) => { calls.push(method); return respond(method); } } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { api } = await import('../apps/desktop/src/api');

  let release!: () => void;
  respond = method => method === 'desktop.ready' ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve(method);
  const first = api('snapshot');
  assert.equal(api('snapshot'), first);
  const fresh = api('snapshot', {}, { fresh: true });
  assert.notEqual(fresh, first);
  assert.equal(api('snapshot'), fresh);
  const jobs = api('agent.jobs');
  const providers = api('providers.detect');
  assert.deepEqual(calls, ['desktop.ready']);
  assert.equal(await api('backend.status'), 'backend.status');
  t.mock.timers.tick(30_000);
  await flush();
  assert.deepEqual(calls, ['desktop.ready', 'backend.status']);
  release();
  assert.deepEqual(await Promise.all([first, fresh, jobs, providers]), ['snapshot', 'snapshot', 'agent.jobs', 'providers.detect']);
  await api('snapshot');
  assert.equal(calls.filter(method => method === 'desktop.ready').length, 1);

  respond = () => new Promise(() => {});
  const late = api('snapshot');
  const timedOut = assert.rejects(late, /did not answer snapshot within 20 s/);
  await flush();
  t.mock.timers.tick(19_999);
  let settled = false;
  void late.catch(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await timedOut;
  respond = async method => method;
  assert.equal(await api('snapshot', {}, { fresh: true }), 'snapshot');
});

test('readiness timeout and rejection evict waiting reads so retry can succeed', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: string[] = [];
  let attempt = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { kiln: { call: async (method: string) => {
    calls.push(method);
    if (method === 'desktop.ready') {
      attempt++;
      if (attempt === 1) return new Promise(() => {});
      if (attempt === 2) throw new Error('Library busy');
    }
    return method;
  } } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { api } = await import(new URL('../apps/desktop/src/api.ts?retry', import.meta.url).href);
  const snapshot = assert.rejects(api('snapshot'), /could not finish opening the library within 120 s/);
  const jobs = assert.rejects(api('agent.jobs'), /could not finish opening the library within 120 s/);
  t.mock.timers.tick(120_000);
  await Promise.all([snapshot, jobs]);
  assert.deepEqual(calls, ['desktop.ready']);
  await assert.rejects(api('snapshot'), /Library busy/);
  assert.equal(await api('snapshot', {}, { fresh: true }), 'snapshot');
  assert.deepEqual(calls, ['desktop.ready', 'desktop.ready', 'desktop.ready', 'snapshot']);
});
