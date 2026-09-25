import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentConsent, usesAgent } from '../apps/desktop/agent-consent';

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
