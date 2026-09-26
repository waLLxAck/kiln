import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentService, SESSION_FILE, type ChatResult } from '../packages/agent/service';
import { codexArguments, type RunInput } from '../packages/agent/codex';
import { claudeArguments } from '../packages/agent/claude';
import { claudeProjectFolder, findSession, restoreSession, sessionMeta } from '../packages/agent/session';
import type { VideoTranscript } from '../packages/agent/youtube';
import { Workbench } from '../packages/domain/workbench';

const wait = async (service: AgentService) => { for (let i = 0; i < 300 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(service.running, 0); };
const video: VideoTranscript = { id: 'Q7n0PGbMW_U', url: 'https://www.youtube.com/watch?v=Q7n0PGbMW_U', title: 'Anthropic Is "Increasing" Your Limits', channel: 'Theo', durationSeconds: 920, uploadDate: '20260831', description: 'Limits went up 25%.', chapters: [], transcript: '[0:00]\nStarting September 14th, we are raising limits.\n[4:05]\nHere is the maths.', language: 'en-orig' };
const distilled = { collection: 'Claude Code limits', summary: 'Theo explains the new limits.', takeaway: 'Measure first.', skipped: '', entries: [
  { type: 'technique', title: 'Compact before context hits 60%', description: 'Keeps sessions cheap.', content: '1. Watch the meter.\n2. Run /compact.', url: '', timestamp: '4:05', tags: ['workflow'] },
  { type: 'prompt', title: 'Estimate my weekly budget', description: 'Usage estimate.', content: 'Given {{logs}}, estimate my weekly token spend.', url: '', timestamp: '', tags: ['usage'] },
] };
const thread = '01a07777-0000-7000-8000-000000000001';
const codexRollout = (id: string, extra = '') => `${JSON.stringify({ timestamp: '2026-09-06T10:00:00.000Z', type: 'session_meta', payload: { id, timestamp: '2026-09-06T10:00:00.000Z', cwd: 'C:\\jobs\\x', cli_version: '0.153.4' } })}\n${JSON.stringify({ timestamp: '2026-09-06T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user' } })}\n${extra}`;
/** A library plus an isolated CODEX_HOME, so the fake runner can leave rollout files exactly where the real CLI would. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-chat-test-'));
  const codexHome = path.join(root, 'codex-home'); fs.mkdirSync(codexHome);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = codexHome;
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const rollout = path.join(codexHome, 'sessions', '2026', '09', '06', `rollout-2026-09-06T10-00-00-${thread}.jsonl`);
  return { wb, rollout, close: () => { wb.close(); if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; } };
}

test('distillation keeps the raw session private and exports it only through the explicit session operation', async () => {
  const { wb, rollout, close } = fixture();
  try {
    const service = new AgentService(wb, () => {}, async input => {
      input.onEvent({ type: 'thread.started', thread_id: thread });
      fs.mkdirSync(path.dirname(rollout), { recursive: true }); fs.writeFileSync(rollout, codexRollout(thread, 'PRIVATE-SESSION-SENTINEL'));
      return distilled;
    }, async () => [], async () => video);
    const { item } = service.capture({ text: video.url, files: {} }); await wait(service);
    const job = service.list()[0]; assert.equal(job.status, 'completed', job.error);
    assert.ok(fs.existsSync(path.join(wb.local, 'agent-jobs', job.id, SESSION_FILE)));
    assert.equal(wb.getRevision(item.id).files[SESSION_FILE], undefined);
    assert.ok(wb.getRevision(item.id).files['transcript.md']);
    const file = path.join(wb.local, 'export.json'); wb.exportLibrary(file);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE-SESSION-SENTINEL|session\.jsonl/);
    assert.match(service.exportSession(job.id), /PRIVATE-SESSION-SENTINEL/);
  } finally { close(); }
});

test('private chat sessions resume, restore locally, reset explicitly and never resume an imported transcript', async () => {
  const { wb, rollout, close } = fixture();
  try {
    const calls: RunInput[] = [];
    const service = new AgentService(wb, () => {}, async input => {
      calls.push(input); input.onEvent({ type: 'thread.started', thread_id: thread });
      if (input.resume) assert.ok(findSession('codex', thread, input.workdir!));
      fs.mkdirSync(path.dirname(rollout), { recursive: true }); fs.writeFileSync(rollout, codexRollout(thread)); return 'Reply';
    }, async () => []);
    const item = wb.create({ title: 'Chat', kind: 'prompt', content: 'Hello' });
    const first = service.chat({ itemId: item.id, message: 'Hi' }); await wait(service);
    fs.rmSync(rollout);
    const next = service.chat({ itemId: item.id, message: 'Again' }); await wait(service);
    assert.equal(next.conversationId, first.conversationId); assert.equal(calls[1].resume, thread);
    service.chat({ itemId: item.id, message: 'Fresh', newSession: true }); await wait(service);
    assert.equal(calls[2].resume, undefined); assert.notEqual(calls[2].workdir, calls[1].workdir);
    const imported = wb.create({ title: 'Imported', kind: 'prompt', content: 'Imported content', files: { [SESSION_FILE]: Buffer.from(codexRollout(thread)).toString('base64') } });
    service.chat({ itemId: imported.id, message: 'Hi' }); await wait(service);
    assert.equal(calls[3].resume, undefined);
    service.chat({ itemId: item.id, message: 'Back to first item' }); await wait(service);
    assert.equal(calls[4].resume, undefined); assert.notEqual(calls[4].workdir, calls[2].workdir);
  } finally { close(); }
});

test('CLI arguments: a kept session drops --ephemeral, a resumed turn continues the thread from its folder with write access, and Claude gets Bash only when it may write', () => {
  const base = { folder: 'C:\\jobs\\run', prompt: '', images: [], signal: new AbortController().signal, onEvent: () => {} };
  const files = { schema: 'C:\\jobs\\run\\schema.json', result: 'C:\\jobs\\run\\response.json' };
  const fresh = codexArguments({ ...base, schema: {}, model: 'gpt-x', effort: 'high' }, files);
  assert.deepEqual(fresh.slice(0, 5), ['exec', '-C', 'C:\\jobs\\run', '--color', 'never']);
  assert.ok(fresh.includes('--ephemeral')); assert.ok(fresh.includes('sandbox_mode="read-only"')); assert.ok(fresh.includes('--output-schema')); assert.equal(fresh.at(-1), '-');
  const kept = codexArguments({ ...base, schema: {}, persist: true }, files);
  assert.ok(!kept.includes('--ephemeral'));
  const resumed = codexArguments({ ...base, folder: 'C:\\jobs\\turn', workdir: 'C:\\jobs\\run', persist: true, resume: thread, writable: ['C:\\library', 'C:\\jobs\\run'] }, files);
  assert.deepEqual(resumed.slice(0, 4), ['exec', 'resume', thread, '--all']);
  assert.ok(!resumed.includes('-C') && !resumed.includes('--color') && !resumed.includes('--ephemeral') && !resumed.includes('--output-schema'));
  assert.ok(resumed.includes(process.platform === 'win32' ? 'sandbox_mode="danger-full-access"' : 'sandbox_mode="workspace-write"'));
  assert.ok(resumed.includes('sandbox_workspace_write.writable_roots=["C:/library","C:/jobs/run"]'), 'TOML gets forward slashes');
  const readOnly = claudeArguments({ ...base, schema: {} });
  assert.ok(readOnly.includes('Read,Glob,Grep,WebFetch,WebSearch') && !readOnly.includes('--resume') && readOnly.includes('--json-schema'));
  const claudeTurn = claudeArguments({ ...base, resume: 'sess-1', writable: ['C:\\library'] });
  assert.ok(claudeTurn.includes('--resume') && claudeTurn.includes('sess-1') && claudeTurn.includes('Read,Glob,Grep,Bash,Write,Edit') && !claudeTurn.includes('--json-schema'));
  assert.deepEqual(claudeTurn.slice(claudeTurn.indexOf('--add-dir'), claudeTurn.indexOf('--add-dir') + 2), ['--add-dir', 'C:\\library']);
});

test('session files: metadata is read from either CLI format and restored where that CLI looks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-session-test-'));
  const previous = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = path.join(root, 'codex'); process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  try {
    assert.deepEqual(sessionMeta(Buffer.from(codexRollout(thread))), { provider: 'codex', id: thread, startedAt: '2026-09-06T10:00:00.000Z' });
    const claudeLines = `${JSON.stringify({ type: 'user', sessionId: 'a1b2c3d4-0000-4000-8000-000000000000', timestamp: '2026-09-06T10:00:00.000Z', cwd: 'C:\\jobs\\run' })}\n`;
    assert.deepEqual(sessionMeta(Buffer.from(claudeLines)), { provider: 'claude', id: 'a1b2c3d4-0000-4000-8000-000000000000', startedAt: '2026-09-06T10:00:00.000Z' });
    assert.deepEqual(sessionMeta(Buffer.from('not json\n{"type":"other"}\n')), { provider: null, id: '', startedAt: '' });
    assert.equal(findSession('codex', thread, 'C:\\jobs\\run'), null);
    assert.equal(findSession('codex', '../../etc', 'C:\\jobs\\run'), null, 'ids that are not session ids are never searched for');
    const restored = restoreSession('codex', thread, 'C:\\jobs\\run', Buffer.from(codexRollout(thread)));
    assert.match(restored.replaceAll('\\', '/'), new RegExp(`/codex/sessions/2026/09/06/rollout-2026-09-06T\\d\\d-00-00-${thread}\\.jsonl$`));
    assert.equal(findSession('codex', thread, 'C:\\jobs\\run'), restored);
    assert.equal(claudeProjectFolder('C:\\Users\\me\\.kiln\\abc\\agent-jobs\\run'), 'C--Users-me--kiln-abc-agent-jobs-run');
    const claude = restoreSession('claude', 'a1b2c3d4-0000-4000-8000-000000000000', 'C:\\jobs\\run', Buffer.from(claudeLines));
    assert.equal(claude, path.join(root, 'claude', 'projects', 'C--jobs-run', 'a1b2c3d4-0000-4000-8000-000000000000.jsonl'));
    assert.equal(findSession('claude', 'a1b2c3d4-0000-4000-8000-000000000000', 'C:\\jobs\\run'), claude);
    assert.equal(findSession('claude', 'a1b2c3d4-0000-4000-8000-000000000000', 'D:\\elsewhere'), claude, 'a session filed under another folder is still found by id');
    assert.throws(() => restoreSession('codex', 'bad id!', 'C:\\jobs\\run', Buffer.alloc(0)), /Invalid session id/);
  } finally {
    if (previous.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.claude;
  }
});

test('the item chat starts fresh on a plain item, writes context.md with the item, and continues the same thread; an entry distilled from a video brings the transcript in a new independent session', async () => {
  const { wb, rollout, close } = fixture();
  try {
    const calls: RunInput[] = [];
    const freshThread = '01a07777-0000-7000-8000-000000000002';
    const service = new AgentService(wb, () => {}, async input => {
      calls.push(input);
      if (input.schema) { input.onEvent({ type: 'thread.started', thread_id: thread }); fs.mkdirSync(path.dirname(rollout), { recursive: true }); fs.writeFileSync(rollout, codexRollout(thread)); return distilled; }
      const id = input.resume ?? freshThread; input.onEvent({ type: 'thread.started', thread_id: id });
      const file = id === thread ? rollout : path.join(path.dirname(rollout), `rollout-2026-09-06T11-00-00-${freshThread}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, (fs.existsSync(file) ? '' : codexRollout(id)) + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', text: 'ok' } }) + '\n');
      return `Reply to: ${input.prompt.split('<user_message>')[1]?.trim().split('\n')[0]}`;
    }, async () => [], async () => video, { node: 'C:\Kiln\Kiln.exe', script: 'C:\Kiln\resources\app.asar.unpacked\dist\cli\workbench.cjs' });
    const plain = wb.create({ title: 'Plain prompt', kind: 'prompt', content: 'Summarise {{text}} in three bullets.', collection: 'Personal' });
    assert.throws(() => service.chat({ message: '  ', itemId: plain.id }), /Type a question/);
    const first = service.chat({ message: 'Make it stricter.', itemId: plain.id });
    assert.equal(first.itemId, plain.id); assert.equal(first.threadId, undefined, 'nothing to resume yet');
    await wait(service);
    assert.equal(service.list().find(j => j.id === first.id)?.status, 'completed');
    const workdir = path.join(wb.local, 'agent-jobs', `session-${first.conversationId}`);
    assert.equal(calls[0].workdir, workdir); assert.equal(calls[0].persist, true); assert.equal(calls[0].resume, undefined);
    const context = fs.readFileSync(path.join(workdir, 'context.md'), 'utf8');
    assert.match(context, /## Open item: Plain prompt/); assert.match(context, /Summarise \{\{text\}\} in three bullets\./); assert.doesNotMatch(context, /## Video/);
    assert.match(calls[0].prompt, /Kiln CLI, the only way to change the library/); assert.match(calls[0].prompt, /reserve placeholders for what only the user can supply or decide/); assert.doesNotMatch(calls[0].prompt, /transcript\.md/);
    assert.deepEqual((service.list().find(j => j.id === first.id)!.result as ChatResult), { reply: 'Reply to: Make it stricter.' });
    const second = service.chat({ message: 'Shorter.', itemId: plain.id }); await wait(service);
    assert.equal(second.threadId, freshThread, 'the second turn continues the first'); assert.equal(second.parentJobId, undefined); assert.equal(calls[1].resume, freshThread);

    // An entry distilled from a video: the chat continues the distillation session and attaches the transcript.
    const { item: videoItem } = service.capture({ text: 'https://youtu.be/Q7n0PGbMW_U', files: {} }); await wait(service);
    const entry = wb.listItems().find(i => i.origin?.itemId === videoItem.id && i.kind === 'technique')!;
    assert.ok(entry, 'the technique entry was filed under its own kind');
    const turn = service.chat({ message: 'Add the exact command.', itemId: entry.id }); await wait(service);
    const distill = service.list().find(j => j.kind === 'distill')!;
    assert.equal(turn.threadId, freshThread, 'starts an independent session'); assert.equal(turn.parentJobId, undefined);
    const call = calls.at(-1)!;
    assert.notEqual(call.workdir, path.join(wb.local, 'agent-jobs', distill.id)); assert.equal(call.resume, undefined);
    assert.ok(fs.existsSync(path.join(call.workdir!, 'attachments', 'transcript.md')), 'the transcript travels with the entry');
    const entryContext = fs.readFileSync(path.join(call.workdir!, 'context.md'), 'utf8');
    assert.match(entryContext, /## Open item: Compact before context hits 60%/); assert.match(entryContext, /## Video: Anthropic Is/); assert.match(entryContext, new RegExp(`\| ${entry.id} \| technique \|`));
    assert.match(call.prompt, /attachments\/transcript\.md/); assert.match(call.prompt, new RegExp(`the video item is ${videoItem.id}`));
  } finally { close(); }
});

test('simultaneous chats on two entries from one video have isolated folders and context', async () => {
  const { wb, close } = fixture();
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  try {
    const videoItem = wb.create({ title: 'Video', kind: 'link', content: video.url, files: { 'transcript.md': Buffer.from('Video words').toString('base64') } });
    const entry = (title: string) => wb.createFrom({ id: videoItem.id, revision: videoItem.revision, author: 'fixture', item: { title, kind: 'prompt', content: title } });
    const a = entry('First entry'), b = entry('Second entry'), calls: RunInput[] = [];
    const service = new AgentService(wb, () => {}, async input => { calls.push(input); await gate; return 'done'; }, async () => []);
    service.chat({ itemId: a.id, message: 'Edit first' }); service.chat({ itemId: b.id, message: 'Edit second' });
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(calls.length, 2); assert.notEqual(calls[0].workdir, calls[1].workdir);
    assert.match(fs.readFileSync(path.join(calls[0].workdir!, 'context.md'), 'utf8'), /## Open item: First entry/);
    assert.match(fs.readFileSync(path.join(calls[1].workdir!, 'context.md'), 'utf8'), /## Open item: Second entry/);
    release(); await wait(service);
  } finally { release(); close(); }
});

test('an entry made from a pasted source brings the source material and its siblings into the chat', async () => {
  const { wb, close } = fixture();
  try {
    const source = wb.create({ title: 'Design chat', kind: 'source', content: 'We compared three homepage designs and kept the grounded copy.' });
    const entry = (title: string) => wb.createFrom({ id: source.id, revision: source.revision, author: 'fixture', item: { title, kind: 'technique', content: title } });
    const a = entry('Compare designs side by side'); entry('Ground copy in the code');
    const calls: RunInput[] = [];
    const service = new AgentService(wb, () => {}, async input => { calls.push(input); return 'done'; }, async () => []);
    service.chat({ itemId: a.id, message: 'Expand this' }); await wait(service);
    const workdir = calls[0].workdir!, context = fs.readFileSync(path.join(workdir, 'context.md'), 'utf8');
    assert.match(context, /## Source: Design chat/); assert.match(context, /source material: attachments\/source\.md/); assert.doesNotMatch(context, /## Video/);
    assert.match(context, /Ground copy in the code/, 'siblings made from the same source are listed');
    assert.equal(fs.readFileSync(path.join(workdir, 'attachments', 'source.md'), 'utf8'), 'We compared three homepage designs and kept the grounded copy.');
    assert.match(calls[0].prompt, new RegExp(`--from ${source.id}`)); assert.doesNotMatch(calls[0].prompt, /the video item is/);
  } finally { close(); }
});
