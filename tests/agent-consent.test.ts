import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentConsent, agentConsentDetail, usesAgent } from '../apps/desktop/agent-consent';
import { codexArguments } from '../packages/agent/codex';

test('agent consent cancels, repeats by default, persists only accepted opt-out and can be reset', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-consent-')), file = path.join(root, 'consent.json');
  const consent = new AgentConsent(file); let prompts = 0;
  try {
    await assert.rejects(consent.require(async () => ({ response: 0, checkboxChecked: true })), /cancelled/);
    assert.equal(fs.existsSync(file), false);
    const agree = async () => { prompts++; return { response: 1, checkboxChecked: false }; };
    await consent.require(agree); await consent.require(agree); assert.equal(prompts, 2);
    await consent.require(async () => ({ response: 1, checkboxChecked: true }));
    await new AgentConsent(file).require(agree); assert.equal(prompts, 2);
    consent.reset(); await consent.require(agree); assert.equal(prompts, 3);
    assert.equal(usesAgent('agent.capture', { analyze: false }), false);
    for (const method of ['agent.chat', 'agent.start', 'agent.capture']) assert.equal(usesAgent(method, {}), true);
    assert.equal(usesAgent('items.update', { summary: 'My own note' }), false);
    for (const method of ['items.update', 'skills.install', 'approvals.approve', 'approvals.unapprove', 'publish.retry', 'agent.jobs', 'agent.cancel']) assert.equal(usesAgent(method, {}), false, method);
    assert.equal(usesAgent('skills.sync', {}), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the consent text describes the Codex sandbox of the platform it runs on', () => {
  const windows = agentConsentDetail('win32');
  assert.match(windows, /On Windows, Codex chat runs without a sandbox/);
  for (const platform of ['darwin', 'linux'] as const) {
    const text = agentConsentDetail(platform);
    assert.doesNotMatch(text, /Windows|without a sandbox/, platform);
    assert.match(text, /Codex chat runs in Codex’s workspace-write sandbox/, platform);
    assert.match(text, /Claude chat can use Bash, Write and Edit, and its access is not confined/, platform);
  }
  for (const text of [windows, agentConsentDetail('linux')]) assert.match(text, /Capture, distillation and tests request read-only access/);
  // The wording follows what codexArguments asks Codex for on this platform.
  const args = codexArguments({ folder: '/tmp/job', workdir: '/tmp/session', prompt: '', images: [], writable: ['/library', '/tmp/session'], signal: new AbortController().signal, onEvent: () => {} } as Parameters<typeof codexArguments>[0], { schema: 's', result: 'r' }).join(' ');
  if (process.platform === 'win32') assert.match(args, /danger-full-access/); else assert.match(args, /workspace-write/);
});
