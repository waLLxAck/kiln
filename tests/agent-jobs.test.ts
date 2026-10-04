import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentService, type AgentJob } from '../packages/agent/service';
import { jobSignature } from '../packages/agent/job-summary';
import { capture } from '../packages/agent/process';
import { runClaude } from '../packages/agent/claude';
import type { RunInput } from '../packages/agent/codex';
import { detectProviders, findExecutable } from '../packages/providers/service';
import { Workbench } from '../packages/domain/workbench';

const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-agent-jobs-')); return { root, wb: new Workbench(path.join(root, 'library'), path.join(root, 'private')) }; };
const until = async (check: () => boolean, ms = 4000) => { for (const end = Date.now() + ms; !check() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(check(), 'condition not reached'); };
const verdict = { output: 'A long output only the open run needs. '.repeat(50), judgement: 'pass', note: 'Worked' };
const windows = process.platform === 'win32';

/**
 * A command on PATH that runs `script` with this Node. `node.js` alone is not executable everywhere, so POSIX gets a shell wrapper and
 * Windows an npm-style `.cmd` shim, the two shapes real CLIs arrive in.
 */
function command(bin: string, name: string, script: string) {
  const js = path.join(bin, `${name}.js`); fs.writeFileSync(js, script);
  if (windows) { const file = path.join(bin, `${name}.cmd`); fs.writeFileSync(file, `@"${process.execPath}" "${js}" %*\r\n`); return file; }
  const file = path.join(bin, name); fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`); fs.chmodSync(file, 0o755); return file;
}
/** A CLI that starts a helper sharing its output pipes (outside its process group, so a group kill misses it) and then never finishes. */
const lingering = (pidFile: string, before = '') => `
const { spawn } = require('node:child_process'), fs = require('node:fs');
const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
${before}
setInterval(() => {}, 1000);
`;
const killHelper = (pidFile: string) => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* Already gone. */ } };

test('a CLI whose helper keeps the output pipes open still settles on cancel and on timeout', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-lingering-')), pidFile = path.join(bin, 'helper.pid');
  try {
    const script = path.join(bin, 'cli.js'); fs.writeFileSync(script, lingering(pidFile, "process.stdout.write('started\\n');"));
    const controller = new AbortController(), started = Date.now();
    const cancelled = capture(process.execPath, [script], { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const result = await cancelled;
    assert.equal(result.cancelled, true); assert.match(result.stdout, /started/);
    assert.ok(Date.now() - started < 8000, `cancel settled after ${Date.now() - started} ms`);
    killHelper(pidFile);
    const timed = Date.now(), late = await capture(process.execPath, [script], { timeoutMs: 300 });
    assert.equal(late.timedOut, true); assert.ok(Date.now() - timed < 8000, `timeout settled after ${Date.now() - timed} ms`);
  } finally { killHelper(pidFile); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('a Claude Code run is found by a PATH lookup alone and settles when cancelled although its helper holds stdout', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-claude-bin-')), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-claude-run-'));
  const marker = path.join(bin, 'spawned.log'), pidFile = path.join(bin, 'helper.pid'), saved = process.env.PATH;
  // Codex and Copilot note every start: a Claude run must not start them, not even for --version.
  for (const name of ['codex', 'copilot']) command(bin, name, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n'); console.log('${name} 1.0.0');`);
  command(bin, 'claude', "if (process.argv.includes('--version')) { console.log('claude 2.0.0'); process.exit(0); }\n" + lingering(pidFile, "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake', session_id: 's-1' }) + '\\n');"));
  process.env.PATH = bin;
  try {
    assert.equal(path.basename(findExecutable('claude') ?? '', windows ? '.cmd' : ''), 'claude');
    const controller = new AbortController(), events: string[] = [];
    const run = runClaude({ folder, prompt: 'Hello', images: [], signal: controller.signal, onEvent: event => { events.push(event.type); if (event.type === 'system') setTimeout(() => controller.abort(), 100); } });
    await assert.rejects(run, /Cancelled/);
    assert.deepEqual(events, ['system']);
    assert.equal(fs.existsSync(marker), false, 'no other client was started');
    // Settings still reads versions, without blocking, and only once per executable.
    if (!windows) {
      const first = await detectProviders(), second = await detectProviders();
      assert.equal(first.find(p => p.id === 'codex')?.version, 'codex 1.0.0'); assert.equal(second.find(p => p.id === 'codex')?.version, 'codex 1.0.0');
      assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n').sort(), ['codex --version', 'copilot --version']);
    }
  } finally { process.env.PATH = saved; killHelper(pidFile); fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('agent.jobs lists summaries without steps or bulky results; agent.job returns the full record', async () => {
  const { wb } = fixture();
  try {
    const service = new AgentService(wb, () => {}, async input => {
      input.onEvent({ type: 'thread.started', thread_id: 'thread-1' });
      for (let i = 0; i < 40; i++) input.onEvent({ type: 'item.completed', item: { id: `cmd-${i}`, type: 'command_execution', command: `step ${i}`, aggregated_output: 'x'.repeat(2000), exit_code: 0 } });
      return verdict;
    }, async () => [{ slug: 'gpt-test', name: 'GPT Test', description: '', defaultEffort: 'high', efforts: ['high'] }]);
    const item = wb.create({ title: 'Prompt', kind: 'prompt', content: 'Try it' });
    const started = service.start({ id: item.id, kind: 'trial' });
    await until(() => service.running === 0);
    const [summary] = service.list(), full = service.job({ id: started.id });
    assert.equal('steps' in summary, false); assert.equal(summary.stepCount, full.steps.length); assert.ok(summary.stepCount > 40);
    assert.deepEqual(summary.lastStep, full.steps.at(-1));
    assert.deepEqual(summary.result, { judgement: 'pass' }, 'only what lists show of the result');
    assert.equal((full.result as typeof verdict).output, verdict.output);
    assert.equal(jobSignature(summary), jobSignature(full), 'a summary and its record have the same signature');
    assert.equal(summary.status, 'completed'); assert.ok(summary.lastActivityAt); assert.equal(summary.model, 'gpt-test');
    assert.ok(JSON.stringify(service.list()).length * 10 < JSON.stringify(full).length, 'the list is a small fraction of the record');
    assert.throws(() => service.job({ id: randomUUID() }), /no longer on this machine/);
    // Progress is batched, and the record on disk ends complete.
    const saved = JSON.parse(fs.readFileSync(path.join(wb.local, 'agent-jobs', `${started.id}.json`), 'utf8')) as AgentJob;
    assert.deepEqual(saved.steps, full.steps); assert.equal(saved.status, 'completed');
  } finally { wb.close(); }
});

test('a failed final save frees the slot: the queued run starts, every run is announced and nothing rejects unhandled', async () => {
  const { wb } = fixture(), logs: string[] = [], unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const calls: { input: RunInput; finish: (value: unknown) => void }[] = [];
    const service = new AgentService(wb, event => logs.push(event), input => new Promise(finish => calls.push({ input, finish })), async () => []);
    const finished: string[] = []; service.onFinished = job => finished.push(job.id);
    const items = ['One', 'Two', 'Three'].map(title => wb.create({ title, kind: 'prompt', content: `Try ${title}` }));
    const [first, , third] = items.map(item => service.start({ id: item.id, kind: 'trial' }));
    assert.equal(third.status, 'queued');
    await until(() => calls.length === 2);
    // Windows can refuse the rename while Defender or the indexer holds the record: here a folder takes its name.
    const record = path.join(wb.local, 'agent-jobs', `${first.id}.json`);
    fs.rmSync(record); fs.mkdirSync(path.join(record, 'locked'), { recursive: true });
    calls.find(call => path.basename(call.input.folder) === first.id)!.finish(verdict);
    await until(() => calls.length === 3);
    assert.equal(service.running, 2, 'the finished run gave up its slot');
    for (const call of calls.slice(1)) call.finish(verdict);
    await until(() => service.running === 0 && finished.length === 3);
    assert.deepEqual(service.list().map(j => j.status), ['completed', 'completed', 'completed']);
    assert.ok(logs.includes('agent.save.failed'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); wb.close(); }
});

test('a model catalog that hangs can be cancelled, and a failed one is not kept', async (t) => {
  const { wb } = fixture();
  try {
    let asked = 0; const ran: string[] = [];
    const service = new AgentService(wb, () => {}, async input => { ran.push(input.folder); return verdict; }, () => { asked++; return new Promise<never>(() => {}); });
    const item = wb.create({ title: 'Prompt', kind: 'prompt', content: 'Try it' });
    const job = service.start({ id: item.id, kind: 'trial' });
    await until(() => asked === 1);
    service.cancel(job.id);
    await until(() => service.running === 0);
    assert.equal(service.list()[0].status, 'cancelled'); assert.deepEqual(ran, [], 'the CLI never started');

    let calls = 0;
    const flaky = new AgentService(wb, () => {}, async () => verdict, async () => { calls++; if (calls === 1) throw new Error('codex not signed in'); return [{ slug: 'gpt-test', name: 'GPT Test', description: '', defaultEffort: 'high', efforts: ['high'] }]; });
    assert.deepEqual(await flaky.models(), []);
    assert.deepEqual(await flaky.models(), [], 'a failure is not asked again at once');
    assert.equal(calls, 1);
    const now = Date.now(); t.mock.method(Date, 'now', () => now + 31_000);
    assert.equal((await flaky.models())[0].slug, 'gpt-test', 'and is asked again shortly after');
    assert.equal((await flaky.models())[0].slug, 'gpt-test'); assert.equal(calls, 2, 'a list that loaded is kept');
  } finally { wb.close(); }
});

test('old finished runs move to an archive that chat history and agent.job still read', () => {
  const { wb } = fixture();
  try {
    const folder = path.join(wb.local, 'agent-jobs'); fs.mkdirSync(folder, { recursive: true });
    const item = wb.create({ title: 'Prompt', kind: 'prompt', content: 'Try it' }), old = new Date(Date.now() - 90 * 86_400_000);
    const record = (index: number, kind: AgentJob['kind'], startedAt: string): AgentJob => ({ id: randomUUID(), itemId: item.id, revision: item.revision, kind, provider: 'codex', status: 'completed', startedAt, finishedAt: startedAt, phase: 'Completed', model: '', effort: '', steps: [{ id: 's', at: startedAt, kind: 'status', text: `run ${index}` }], ...(kind === 'chat' ? { conversationId: randomUUID(), question: `Question ${index}`, result: { reply: `Reply ${index}` } } : {}) });
    const jobs = [
      ...Array.from({ length: 230 }, (_, i) => record(i, 'chat', new Date(old.getTime() - i * 60_000).toISOString())),
      record(999, 'distill', new Date(old.getTime() - 999 * 60_000).toISOString()),
      ...Array.from({ length: 5 }, (_, i) => record(1000 + i, 'chat', new Date(Date.now() - i * 60_000).toISOString())),
    ];
    for (const job of jobs) fs.writeFileSync(path.join(folder, `${job.id}.json`), JSON.stringify(job));
    const service = new AgentService(wb, () => {}, async () => ({}), async () => []);
    const kept = fs.readdirSync(folder).filter(name => name.endsWith('.json'));
    assert.equal(kept.length, 201, 'the newest 200 plus the latest run of each item and kind');
    assert.ok(kept.includes(`${jobs[230].id}.json`), 'the only distillation of the item stays');
    assert.equal(fs.readdirSync(path.join(folder, 'archive', item.id)).length, 35);
    assert.equal(service.chatHistory({ itemId: item.id }).length, 235, 'chat history still has every turn');
    const archived = jobs[229];
    assert.equal((service.job({ id: archived.id }).result as { reply: string }).reply, 'Reply 229');
  } finally { wb.close(); }
});
