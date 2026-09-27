import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentService } from '../packages/agent/service';
import type { RunInput } from '../packages/agent/codex';
import { TRIAL_LOOP_TIMEOUT_MS } from '../packages/agent/trial-loop';
import { Workbench } from '../packages/domain/workbench';

delete process.env.KILN_EXPERIMENTS;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-trial-loop-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  return { wb, close: () => { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const wait = async (service: AgentService) => { for (let i = 0; i < 300 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(service.running, 0); };
const trialLoop = (wb: Workbench, enabled: boolean) => wb.setExperiment({ id: 'trialLoop', enabled });

test('Claude Code experiments are labelled as Claude Code in the activity log, Codex ones as Codex', async () => {
  const { wb, close } = fixture();
  try {
    const item = wb.create({ title: 'Label', kind: 'prompt', content: 'Review this.', files: {} });
    const service = new AgentService(wb, () => {}, async () => ({ output: 'Fine.', judgement: 'pass', note: 'Worked' }), async () => []);
    service.start({ id: item.id, kind: 'trial', provider: 'claude' }); await wait(service);
    const activity = wb.activity();
    assert.match(activity.find(a => a.kind === 'trial_completed')!.message, /^Claude Code assessment: pass$/);
    assert.match(activity.find(a => a.kind === 'trial_prepared')!.message, /Claude Code CLI experiment/);
    assert.ok(!activity.some(a => /Codex/.test(a.message)), 'nothing about a Claude run mentions Codex');
    service.start({ id: item.id, kind: 'trial', provider: 'codex' }); await wait(service);
    assert.equal(wb.activity().filter(a => a.kind === 'trial_completed' && a.message === 'Codex assessment: pass').length, 1);
    assert.deepEqual(wb.trials().map(t => t.mode), ['codex', 'codex'], 'the stored mode is unchanged');
  } finally { close(); }
});

test('experiments and skill drafts get 15 minutes on both providers with trialLoop on, and the runner defaults with it off', async () => {
  const { wb, close } = fixture();
  try {
    const seen: { kind: string; timeout: number | undefined }[] = [];
    let kind = '';
    const service = new AgentService(wb, () => {}, async (input: RunInput) => {
      seen.push({ kind, timeout: input.timeoutMs });
      return kind === 'derive' ? { name: 'a-skill', description: 'Does a thing.', skill: '---\nname: a-skill\ndescription: Does a thing.\n---\n\nBody', notes: '' } : { output: 'Out', judgement: 'uncertain', note: 'Note' };
    }, async () => []);
    const item = wb.create({ title: 'Timeouts', kind: 'prompt', content: 'Do it.', files: {} });
    const run = async (k: 'trial' | 'derive', provider: 'codex' | 'claude') => { kind = `${k}:${provider}`; service.start({ id: item.id, kind: k, provider }); await wait(service); };
    for (const provider of ['codex', 'claude'] as const) { await run('trial', provider); await run('derive', provider); }
    assert.ok(seen.every(s => s.timeout === undefined), 'flag off: no timeout is passed, so Codex keeps 3 and Claude Code 5 minutes');
    seen.length = 0; trialLoop(wb, true);
    for (const provider of ['codex', 'claude'] as const) { await run('trial', provider); await run('derive', provider); }
    assert.deepEqual(seen.map(s => s.timeout), [TRIAL_LOOP_TIMEOUT_MS, TRIAL_LOOP_TIMEOUT_MS, TRIAL_LOOP_TIMEOUT_MS, TRIAL_LOOP_TIMEOUT_MS]);
    assert.equal(TRIAL_LOOP_TIMEOUT_MS, 15 * 60_000);
  } finally { close(); }
});

test('item chat context lists recent experiments only with trialLoop on, newest five and trimmed', async () => {
  const { wb, close } = fixture();
  try {
    let n = 0, context = '', prompt = '';
    const huge = 'x'.repeat(60_000);
    const service = new AgentService(wb, () => {}, async (input: RunInput) => {
      if (input.writable) { context = fs.readFileSync(path.join(input.workdir!, 'context.md'), 'utf8'); prompt = input.prompt; return 'Done.'; }
      n++; return { output: `OUTPUT-${n} ${huge}`, judgement: n % 2 ? 'fail' : 'pass', note: `NOTE-${n} ${'n'.repeat(5000)}` };
    }, async () => []);
    const item = wb.create({ title: 'Context', kind: 'prompt', content: 'Summarise the diff.', files: {} });
    for (let i = 0; i < 7; i++) { service.start({ id: item.id, kind: 'trial', provider: 'claude' }); await wait(service); }
    service.chat({ itemId: item.id, message: 'Improve it' }); await wait(service);
    assert.doesNotMatch(context, /Experiments on this item|OUTPUT-/, 'flag off: context.md is as before');
    assert.doesNotMatch(prompt, /recent experiments/);
    trialLoop(wb, true);
    service.chat({ itemId: item.id, message: 'Improve it', newSession: true }); await wait(service);
    assert.match(context, /## Experiments on this item \(newest 5 of 7\)/);
    assert.match(prompt, /recent experiments/);
    for (const k of [7, 6, 5, 4, 3]) assert.match(context, new RegExp(`OUTPUT-${k} `));
    for (const k of [1, 2]) assert.doesNotMatch(context, new RegExp(`OUTPUT-${k} |NOTE-${k} `));
    assert.match(context, /verdict: fail \(agent assessment\)/);
    assert.match(context, /the current revision/);
    assert.ok(context.length < 25_000, `context.md stays bounded (${context.length} characters)`);
  } finally { close(); }
});

test('a human judgement is recorded beside the agent assessment, never over it, and only with trialLoop on', async () => {
  const { wb, close } = fixture();
  try {
    const item = wb.create({ title: 'Judge', kind: 'prompt', content: 'Explain the change.', files: {} });
    const service = new AgentService(wb, () => {}, async () => ({ output: 'Explained.', judgement: 'uncertain', note: 'Probably fine' }), async () => []);
    service.start({ id: item.id, kind: 'trial', provider: 'claude' }); await wait(service);
    const agentTrial = wb.trials()[0];
    assert.throws(() => wb.judgeTrial({ id: agentTrial.id, judgement: 'pass' }), /CAPABILITY_UNSUPPORTED|Turn on/);
    trialLoop(wb, true);
    const first = wb.judgeTrial({ id: agentTrial.id, judgement: 'fail' });
    const review = wb.judgeTrial({ id: agentTrial.id, judgement: 'pass' });
    const trials = wb.trials();
    assert.equal(trials.find(t => t.id === agentTrial.id)!.judgement, 'uncertain', 'the agent assessment is untouched');
    assert.equal(trials.find(t => t.id === agentTrial.id)!.mode, 'codex');
    assert.ok(!trials.some(t => t.id === first.id), 'a newer verdict replaces the older one');
    assert.ok(wb.trials(true).some(t => t.id === first.id && t.deletedAt), 'the older verdict is kept, deleted');
    assert.deepEqual({ mode: review.mode, provider: review.provider, status: review.status, judgement: review.judgement, revision: review.revision, reference: review.outputReference }, { mode: 'manual', provider: 'manual', status: 'completed', judgement: 'pass', revision: item.revision, reference: `review-of:${agentTrial.id}` });
    assert.match(wb.activity().find(a => a.kind === 'trial_completed' && a.message.startsWith('Human judgement'))!.message, /^Human judgement: pass \(reviewed the Claude Code assessment\)$/);
    // The human verdict is approval evidence like any completed trial of the revision.
    const approval = wb.approve({ id: item.id, revision: item.revision, reviewer: 'Local user', scope: 'Current revision', evidence: [agentTrial.id, review.id], waivedChecks: 'No boundary case' });
    assert.deepEqual(approval.evidence, [agentTrial.id, review.id]);
    assert.throws(() => wb.judgeTrial({ id: review.id, judgement: 'pass' }), /agent experiment/);
    // An experiment of an earlier revision cannot be judged; deleting an experiment takes its judgement with it.
    const updated = wb.update({ id: item.id, expect: item.revision, value: { ...wb.getRevision(item.id), content: 'Explain the change clearly.' }, summary: 'Clearer' });
    assert.throws(() => wb.judgeTrial({ id: agentTrial.id, judgement: 'fail' }), /earlier revision/);
    assert.notEqual(updated.revision, item.revision);
    wb.deleteTrial({ id: agentTrial.id });
    assert.equal(wb.trials().length, 0);
  } finally { close(); }
});
