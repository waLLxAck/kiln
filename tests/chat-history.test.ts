import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentService, type AgentJob } from '../packages/agent/service';
import { chatSessions, chatTurns, mergeTurns } from '../packages/agent/chat-history';
import { AgentConsent } from '../apps/desktop/agent-consent';
import { Workbench } from '../packages/domain/workbench';

const wait = async (service: AgentService) => { for (let i = 0; i < 300 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(service.running, 0); };
const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-chat-history-')); const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private')); return { root, wb, close: () => { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } }; };
const turn = (fields: Partial<AgentJob>): AgentJob => ({ id: randomUUID(), itemId: randomUUID(), revision: 'a'.repeat(64), kind: 'chat', provider: 'codex', status: 'completed', startedAt: '2026-09-01T10:00:00.000Z', phase: 'Completed', model: '', effort: '', steps: [], ...fields });

test('chatHistory returns every chat turn of an item from disk, including ones agent.jobs no longer lists', () => {
  const { wb, close } = fixture();
  try {
    const item = wb.create({ title: 'Kept', kind: 'prompt', content: 'Hello' }), other = wb.create({ title: 'Busy', kind: 'prompt', content: 'Busy' });
    const folder = path.join(wb.local, 'agent-jobs'); fs.mkdirSync(folder, { recursive: true });
    const old = turn({ itemId: item.id, conversationId: randomUUID(), question: 'First question', startedAt: '2026-01-01T09:00:00.000Z', finishedAt: '2026-01-01T09:01:00.000Z', result: { reply: 'An old reply' } });
    fs.writeFileSync(path.join(folder, `${old.id}.json`), JSON.stringify(old));
    for (let i = 0; i < 105; i++) { const busy = turn({ itemId: other.id, conversationId: randomUUID(), startedAt: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString() }); fs.writeFileSync(path.join(folder, `${busy.id}.json`), JSON.stringify(busy)); }
    const service = new AgentService(wb, () => {}, async () => 'unused', async () => []);
    assert.equal(service.list().some(j => j.id === old.id), false, 'the newest hundred runs leave the old chat out');
    const history = service.chatHistory({ itemId: item.id });
    assert.deepEqual(history.map(j => j.id), [old.id]);
    assert.equal((history[0].result as { reply: string }).reply, 'An old reply');
    assert.equal(service.chatHistory({ itemId: other.id }).length, 105);
    assert.throws(() => service.chatHistory({ itemId: 'not-an-id' }));
  } finally { close(); }
});

test('a Claude chat shows its shell commands as steps', async () => {
  const { wb, close } = fixture();
  try {
    wb.saveSettings({ ...wb.settings(), agentProvider: 'claude' });
    const item = wb.create({ title: 'Commands', kind: 'prompt', content: 'Hello' });
    const service = new AgentService(wb, () => {}, async input => {
      input.onEvent({ type: 'system', subtype: 'init', model: 'fake', session_id: randomUUID() });
      input.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: `kiln items update ${item.id} --file draft.md` } }] } });
      return 'Done';
    }, async () => []);
    const shown = service.chat({ itemId: item.id, message: 'Edit it again', conversationId: randomUUID() }); await wait(service);
    const job = service.list().find(j => j.id === shown.id)!;
    assert.equal(job.steps.find(s => s.id === 'tool-1')!.text, `Bash kiln items update ${item.id} --file draft.md`);
  } finally { close(); }
});

test('conversations group by id, newest first, named by their first message; merged turns keep the fresher copy', () => {
  const itemId = randomUUID(), a = randomUUID(), b = randomUUID();
  const turns = [turn({ itemId, conversationId: a, question: 'Start A', startedAt: '2026-09-01T10:00:00.000Z' }), turn({ itemId, conversationId: b, question: 'Start B', provider: 'claude', startedAt: '2026-09-02T10:00:00.000Z' }), turn({ itemId, conversationId: a, question: 'More A', startedAt: '2026-09-03T10:00:00.000Z' }), turn({ itemId: randomUUID(), conversationId: randomUUID(), startedAt: '2026-09-04T10:00:00.000Z' })];
  const sessions = chatSessions(chatTurns(turns, itemId));
  assert.deepEqual(sessions.map(s => [s.conversationId, s.question, s.turns, s.provider]), [[a, 'Start A', 2, 'codex'], [b, 'Start B', 1, 'claude']]);
  const running = { ...turns[0], status: 'running' as const };
  const merged = mergeTurns([running], turns);
  assert.equal(merged.length, turns.length); assert.equal(merged[0].status, 'running');
  assert.deepEqual(merged.map(t => t.startedAt), [...merged.map(t => t.startedAt)].sort());
});

test('chat consent covers the rest of the app session only for chat messages marked as a chat session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-consent-session-')), file = path.join(root, 'consent.json');
  try {
    const consent = new AgentConsent(file); let prompts = 0;
    const agree = async () => { prompts++; return { response: 1, checkboxChecked: false }; };
    await assert.rejects(consent.require(async () => ({ response: 0 }), { chatSession: true }), /cancelled/);
    await consent.require(agree, { chatSession: true }); assert.equal(prompts, 1);
    await consent.require(agree, { chatSession: true }); await consent.require(agree, { chatSession: true }); assert.equal(prompts, 1, 'later chat messages are covered');
    await consent.require(agree); assert.equal(prompts, 2, 'other runs still ask every time');
    await consent.require(agree); assert.equal(prompts, 3);
    assert.equal(fs.existsSync(file), false, 'session acceptance is never written to disk');
    await new AgentConsent(file).require(agree, { chatSession: true }); assert.equal(prompts, 4, 'a restarted app asks again');
    consent.reset(); await consent.require(agree, { chatSession: true }); assert.equal(prompts, 5, 'restoring the warning in Settings asks again');
    // Accepting another kind of run does not cover chat.
    const fresh = new AgentConsent(file); await fresh.require(agree); await fresh.require(agree, { chatSession: true }); assert.equal(prompts, 7);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
