import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentService, type AgentJob } from '../packages/agent/service';
import { runFinished, runNotice } from '../packages/agent/run-notice';
import type { RunInput } from '../packages/agent/codex';
import { Workbench } from '../packages/domain/workbench';

const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-run-notifications-')); return new Workbench(path.join(root, 'library'), path.join(root, 'private')); };
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), 'condition not reached'); };
/** A runner whose runs stay open until the test settles them, remembering which item each call was for. */
function heldRunner() {
  const calls: { input: RunInput; finish: (value: unknown) => void; fail: (error: Error) => void }[] = [];
  const runner = (input: RunInput) => new Promise<unknown>((finish, fail) => { calls.push({ input, finish, fail }); input.signal.addEventListener('abort', () => fail(new Error('Cancelled'))); });
  return { calls, runner };
}
const verdict = { output: 'Output', judgement: 'pass', note: 'Worked' };
const setup = (flag: boolean) => {
  const wb = fixture(); if (flag) wb.setExperiment({ id: 'runNotifications', enabled: true });
  const held = heldRunner(), finished: AgentJob[] = [];
  const service = new AgentService(wb, () => {}, held.runner, async () => []);
  service.onFinished = job => finished.push(structuredClone(job));
  const items = ['One', 'Two', 'Three', 'Four'].map(title => wb.create({ title, kind: 'prompt', content: `Try ${title}` }));
  return { wb, service, items, finished, calls: held.calls };
};

test('flag off: a third run is refused while two are running, as before', async () => {
  const { wb, service, items, calls } = setup(false);
  try {
    service.start({ id: items[0].id, kind: 'trial' }); service.start({ id: items[1].id, kind: 'trial' });
    assert.throws(() => service.start({ id: items[2].id, kind: 'trial' }), /Two agent runs are active/);
    assert.throws(() => service.chat({ itemId: items[2].id, message: 'Hello' }), /Two agent runs are active/);
    await until(() => calls.length === 2);
    assert.equal(service.queued, 0);
    for (const call of calls) call.finish(verdict);
    await until(() => service.running === 0);
  } finally { wb.close(); }
});

test('flag on: a third run waits in the queue and starts, in order, when a slot frees', async () => {
  const { wb, service, items, calls, finished } = setup(true);
  try {
    const first = service.start({ id: items[0].id, kind: 'trial' }); service.start({ id: items[1].id, kind: 'trial' });
    const third = service.start({ id: items[2].id, kind: 'trial', context: 'third' }), fourth = service.start({ id: items[3].id, kind: 'derive' });
    assert.equal(third.status, 'queued'); assert.equal(third.phase, 'Waiting for a free slot'); assert.equal(fourth.status, 'queued');
    assert.equal(service.running, 2); assert.equal(service.queued, 2);
    // A queued experiment already has its trial record, like a running one.
    assert.ok(third.trialId && wb.trials().some(t => t.id === third.trialId));
    await until(() => calls.length === 2);
    // The per-item rule: a queued run counts as active for its item.
    assert.equal(service.start({ id: items[2].id, kind: 'trial', context: 'third' }).id, third.id);
    assert.throws(() => service.start({ id: items[2].id, kind: 'trial', context: 'something else' }), /already active for this item/);
    calls[0].finish(verdict);
    await until(() => calls.length === 3);
    assert.match(calls[2].input.prompt, /User context: third/);
    assert.equal(service.list().find(j => j.id === third.id)!.status, 'running');
    assert.equal(service.list().find(j => j.id === fourth.id)!.status, 'queued');
    assert.equal(service.list().find(j => j.id === first.id)!.status, 'completed');
    calls[1].fail(new Error('Codex timed out after 15 minutes. Retry this run.'));
    await until(() => calls.length === 4);
    calls[2].finish(verdict); calls[3].finish({ name: 'four', description: 'A skill', skill: '---\nname: four\ndescription: A skill\n---\nDo it.', notes: '' });
    await until(() => service.running === 0);
    assert.deepEqual(service.list().map(j => j.status).sort(), ['completed', 'completed', 'completed', 'failed']);
    // Each run is announced exactly once, when it ends.
    assert.equal(finished.length, 4); assert.equal(new Set(finished.map(j => j.id)).size, 4);
    assert.equal(finished.find(j => j.status === 'failed')!.itemId, items[1].id);
  } finally { wb.close(); }
});

test('flag on: a queued run can be cancelled before it starts and never reaches the CLI', async () => {
  const { wb, service, items, calls, finished } = setup(true);
  try {
    service.start({ id: items[0].id, kind: 'trial' }); service.start({ id: items[1].id, kind: 'trial' });
    const queued = service.start({ id: items[2].id, kind: 'trial' });
    service.cancel(queued.id); service.cancel(queued.id);
    const job = service.list().find(j => j.id === queued.id)!;
    assert.equal(job.status, 'cancelled'); assert.ok(job.finishedAt); assert.equal(service.queued, 0);
    assert.equal(wb.trials().find(t => t.id === queued.trialId)!.status, 'cancelled');
    assert.deepEqual(finished.map(j => [j.id, j.status]), [[queued.id, 'cancelled']]);
    await until(() => calls.length === 2);
    calls[0].finish(verdict); calls[1].finish(verdict);
    await until(() => service.running === 0);
    assert.equal(calls.length, 2);
    // After cancelling, the item can be run again.
    assert.equal(service.start({ id: items[2].id, kind: 'trial' }).status, 'running');
    await until(() => calls.length === 3); calls[2].finish(verdict); await until(() => service.running === 0);
    assert.equal(finished.length, 4);
  } finally { wb.close(); }
});

test('flag on: a chat turn queues too, and a queued turn blocks another message about the same item', async () => {
  const { wb, service, items, calls } = setup(true);
  try {
    service.start({ id: items[0].id, kind: 'trial' }); service.start({ id: items[1].id, kind: 'trial' });
    const turn = service.chat({ itemId: items[2].id, message: 'What does this do?' });
    assert.equal(turn.status, 'queued');
    assert.throws(() => service.chat({ itemId: items[2].id, message: 'And again?' }), /Wait for the current reply/);
    await until(() => calls.length === 2);
    calls[0].finish(verdict);
    await until(() => calls.length === 3);
    assert.match(calls[2].input.prompt, /What does this do\?/);
    calls[1].finish(verdict); calls[2].finish('It summarises things.');
    await until(() => service.running === 0);
    assert.deepEqual((service.list().find(j => j.id === turn.id)!.result as { reply: string }).reply, 'It summarises things.');
  } finally { wb.close(); }
});

test('queued runs left behind by an app exit are marked interrupted and retryable, with their trial closed', async () => {
  const { wb, service, items, calls } = setup(true);
  try {
    service.start({ id: items[0].id, kind: 'trial' }); service.start({ id: items[1].id, kind: 'trial' });
    const queued = service.start({ id: items[2].id, kind: 'trial' });
    await until(() => calls.length === 2);
    const restarted = new AgentService(wb, () => {}, async () => verdict, async () => []);
    const job = restarted.list().find(j => j.id === queued.id)!;
    assert.equal(job.status, 'interrupted'); assert.match(job.phase, /Not started before Kiln closed/);
    assert.equal(wb.trials().find(t => t.id === queued.trialId)!.status, 'cancelled');
    assert.equal(restarted.queued, 0);
    // Only the first service's memory still holds the queue; empty it so its runs can wind down.
    service.cancel(queued.id);
    for (const call of calls) call.finish(verdict);
    await until(() => service.running === 0);
  } finally { wb.close(); }
});

test('notices name the kind of run and its result; user cancellations and interruptions stay silent', () => {
  const base = { id: 'a', itemId: 'i', revision: 'r', provider: 'codex', startedAt: '', phase: '', model: '', effort: '', steps: [] } as unknown as AgentJob;
  const title = (id: string) => ({ i: 'Try it as a seven-year-old', s: 'kid-explainer' } as Record<string, string>)[id];
  const notice = (job: Partial<AgentJob>) => runNotice(runFinished({ ...base, ...job } as AgentJob, title));
  assert.equal(notice({ kind: 'trial', status: 'completed', result: verdict as AgentJob['result'] })!.title, 'Experiment passed · Try it as a seven-year-old');
  assert.equal(notice({ kind: 'distill', status: 'completed', createdItemIds: ['1', '2', '3', '4', '5'], collection: 'Talk' })!.title, 'Distillation finished · 5 entries from Try it as a seven-year-old');
  assert.equal(notice({ kind: 'chat', status: 'completed', result: { reply: 'Private reply' } })!.title, 'Chat reply · Try it as a seven-year-old');
  assert.doesNotMatch(notice({ kind: 'chat', status: 'completed', result: { reply: 'Private reply' } })!.body, /Private reply/);
  assert.equal(notice({ kind: 'derive', status: 'completed', createdItemId: 's' })!.title, 'Skill draft ready · kid-explainer');
  assert.equal(notice({ kind: 'trial', status: 'failed', error: 'Codex timed out after 15 minutes. Retry this run.\nMore' })!.title, 'Run failed · Codex timed out after 15 minutes. Retry this run.');
  assert.equal(notice({ kind: 'trial', status: 'cancelled' }), null);
  assert.equal(notice({ kind: 'trial', status: 'interrupted' }), null);
  assert.equal(runFinished({ ...base, kind: 'chat', status: 'completed', itemId: 'gone' } as AgentJob, title).itemTitle, 'Chat reply');
});
