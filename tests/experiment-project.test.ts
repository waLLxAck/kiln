import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentService } from '../packages/agent/service';
import { Workbench } from '../packages/domain/workbench';
import { codexArguments, type RunInput } from '../packages/agent/codex';
import { claudeArguments } from '../packages/agent/claude';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-project-'));
  const workspace = path.join(root, 'Project with spaces 日本語'); fs.mkdirSync(workspace);
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const item = wb.create({ title: 'Review project', kind: 'prompt', content: 'Review the project entry point.', files: { 'notes.md': Buffer.from('Review notes').toString('base64') } });
  return { root, workspace, wb, item, close: () => { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
async function wait(service: AgentService) {
  for (let i = 0; i < 100 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.running, 0);
}

for (const provider of ['codex', 'claude'] as const) test(`${provider}: project trials use the chosen folder, preserve private evidence, and retry the exact inputs`, async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.workspace, 'entry.ts'), 'export const answer = 42;');
    const inputs: RunInput[] = [];
    const runner = async (input: RunInput) => {
      inputs.push(input);
      assert.equal(fs.readFileSync(path.join(input.workdir!, 'entry.ts'), 'utf8'), 'export const answer = 42;');
      assert.equal(input.writable, undefined);
      assert.equal(fs.readFileSync(path.join(input.folder, 'attachments', 'notes.md'), 'utf8'), 'Review notes');
      assert.match(input.prompt, /Prefer evidence from this project/);
      assert.ok(input.prompt.includes(JSON.stringify(path.join(input.folder, 'attachments.md'))));
      if (inputs.length === 1) throw new Error('Temporary provider failure');
      return { output: 'Found the entry point.', judgement: 'pass', note: 'Inspected the project.' };
    };
    const service = new AgentService(f.wb, () => {}, runner, async () => []);
    const job = service.start({ id: f.item.id, kind: 'trial', provider, workspace: f.workspace, context: 'Review entry.ts only' });
    await wait(service); assert.equal(job.status, 'failed');
    const environment = JSON.parse(fs.readFileSync(path.join(f.wb.local, 'runs', job.trialId!, 'environment.json'), 'utf8'));
    assert.equal(environment.requestedWorkspace, fs.realpathSync(f.workspace));
    assert.ok(!JSON.stringify(f.wb.trials()).includes(f.workspace));
    f.wb.update({ id: f.item.id, expect: f.item.revision, value: { ...f.wb.getRevision(f.item.id), content: 'A newer unrelated draft' } });
    const reloaded = new AgentService(f.wb, () => {}, runner, async () => []);
    const saved = reloaded.list()[0];
    const retry = reloaded.start({ id: saved.itemId, revision: saved.revision, kind: saved.kind, provider: saved.provider, workspace: saved.workspace, context: saved.context });
    await wait(reloaded); assert.equal(retry.status, 'completed', retry.error);
    assert.equal(retry.revision, f.item.revision);
    assert.equal(inputs[1].workdir, inputs[0].workdir);
    assert.match(inputs[1].prompt, /Review entry.ts only/);
    assert.match(inputs[1].prompt, /Review the project entry point/);
    assert.doesNotMatch(inputs[1].prompt, /A newer unrelated draft/);
    assert.notEqual(inputs[1].folder, f.workspace);
    assert.deepEqual(fs.readdirSync(f.workspace), ['entry.ts']);
    const exported = path.join(f.root, 'export.json'); f.wb.exportLibrary(exported);
    assert.ok(!fs.readFileSync(exported, 'utf8').includes('Project with spaces'));
    assert.equal(f.wb.approvals().length, 0);
  } finally { f.close(); }
});

test('invalid folders fail before creating jobs or trials, and an omitted folder preserves isolated runs', async () => {
  const f = fixture();
  try {
    const inputs: RunInput[] = [];
    const service = new AgentService(f.wb, () => {}, async input => { inputs.push(input); return { output: 'Synthetic example', judgement: 'uncertain', note: 'No project selected' }; }, async () => []);
    const file = path.join(f.root, 'file.txt'); fs.writeFileSync(file, 'not a directory');
    for (const workspace of ['relative/path', path.join(f.root, 'missing'), file]) assert.throws(() => service.start({ id: f.item.id, kind: 'trial', workspace }), /absolute path|missing or unreadable/);
    assert.throws(() => service.start({ id: f.item.id, kind: 'derive', workspace: f.workspace }), /only be selected for an experiment/);
    assert.equal(service.list().length, 0); assert.equal(f.wb.trials().length, 0);
    service.start({ id: f.item.id, kind: 'trial' }); await wait(service);
    assert.equal(inputs[0].workdir, undefined); assert.equal(inputs[0].writable, undefined);
  } finally { f.close(); }
});

test('changing the project while an item is running never silently reuses a different run', async () => {
  const f = fixture();
  try {
    let finish!: (value: unknown) => void;
    const service = new AgentService(f.wb, () => {}, () => new Promise(resolve => { finish = resolve; }), async () => []);
    const job = service.start({ id: f.item.id, kind: 'trial', workspace: f.workspace });
    assert.equal(service.start({ id: f.item.id, kind: 'trial', workspace: f.workspace }).id, job.id);
    assert.throws(() => service.start({ id: f.item.id, kind: 'trial' }), /already active/);
    await new Promise(resolve => setTimeout(resolve, 20));
    finish({ output: 'Done', judgement: 'pass', note: 'Done' }); await wait(service);
  } finally { f.close(); }
});

test('a folder removed during model resolution fails the trial without starting a provider', async () => {
  const f = fixture();
  try {
    let launched = false;
    const service = new AgentService(f.wb, () => {}, async () => { launched = true; }, async () => { fs.rmdirSync(f.workspace); return []; });
    const job = service.start({ id: f.item.id, kind: 'trial', provider: 'codex', workspace: f.workspace });
    await wait(service); assert.equal(launched, false); assert.equal(job.status, 'failed');
    assert.match(job.error!, /missing or unreadable/); assert.equal(f.wb.trials()[0].status, 'cancelled');
  } finally { f.close(); }
});

test('project CLI arguments select the working folder and preserve read-only permissions', () => {
  const input: RunInput = { folder: '/private/run', workdir: '/projects/repo', prompt: '', images: [], signal: new AbortController().signal, onEvent: () => {} };
  const codex = codexArguments(input, { schema: '/private/run/schema.json', result: '/private/run/response.json' });
  assert.deepEqual(codex.slice(0, 3), ['exec', '-C', '/projects/repo']);
  assert.ok(codex.includes('sandbox_mode="read-only"'));
  const claude = claudeArguments(input);
  assert.deepEqual(claude.slice(claude.indexOf('--add-dir'), claude.indexOf('--add-dir') + 2), ['--add-dir', '/private/run']);
  assert.ok(claude.includes('Read,Glob,Grep,WebFetch,WebSearch'));
  assert.ok(!claude.some(arg => /Bash|Write|Edit/.test(arg)));
});
