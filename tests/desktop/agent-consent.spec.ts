import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('native agent warning cancels before dispatch, repeats, remembers acceptance and resets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-consent-ui-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Capture Ctrl N', exact: true })).toBeVisible();
    await app.evaluate(({ dialog }) => {
      const state = globalThis as any; state.consentCalls = []; state.consentAnswer = { response: 0, checkboxChecked: false };
      dialog.showMessageBox = (async (...args: any[]) => { state.consentCalls.push(args.at(-1)); return state.consentAnswer; }) as any;
    });
    const request = () => page.evaluate(async () => {
      try { await window.kiln.call('agent.chat', { itemId: 'invalid-id', message: 'Do not run an agent in this test' }); return ''; }
      catch (error) { return String(error); }
    });
    expect(await request()).toContain('cancelled'); expect(await request()).toContain('cancelled');
    const prompts = await app.evaluate(() => (globalThis as any).consentCalls);
    expect(prompts).toHaveLength(2); expect(prompts[0].detail).toContain('read/write');
    expect(prompts[0].detail).toContain('not confined'); expect(prompts[0].checkboxLabel).toBe('Don’t show again');
    await app.evaluate(() => { (globalThis as any).consentAnswer = { response: 1, checkboxChecked: true }; });
    expect(await request()).not.toContain('cancelled'); // Invalid ID fails in the worker; no provider is invoked.
    await request(); expect(await app.evaluate(() => (globalThis as any).consentCalls.length)).toBe(3);
    await page.evaluate(() => window.kiln.call('desktop.resetAgentConsent'));
    await request(); expect(await app.evaluate(() => (globalThis as any).consentCalls.length)).toBe(4);
    expect(await page.evaluate(() => window.kiln.call('agent.jobs'))).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('new session and item switches clear the previous chat composer without invoking a provider', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-chat-controls-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      for (const title of ['Chat entry A', 'Chat entry B']) await window.kiln.call('items.create', { title, kind: 'prompt', content: title });
    });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await page.getByRole('button', { name: /Chat entry A/ }).click();
    await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
    const message = page.getByRole('textbox', { name: 'Your message' });
    await message.fill('Unsent first session');
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(message).toHaveValue('');
    await message.fill('Unsent item A');
    await page.getByRole('button', { name: /Chat entry B/ }).click();
    await expect(message).toHaveValue('');
    await expect(page.locator('.chat-context')).toContainText('Chat entry B');
    await page.getByRole('button', { name: /Chat entry A/ }).click();
    await expect(message).toHaveValue('');
    await expect(page.locator('.chat-context')).toContainText('Chat entry A');
    expect(await page.evaluate(() => window.kiln.call('agent.jobs'))).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});


test('programmatic save and multi-location install do not ask for agent consent or compose with a model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-programmatic-ui-'));
  const env = desktopEnv(root); delete (env as Record<string, string | undefined>).KILN_PLAIN_COMMITS;
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Capture Ctrl N', exact: true })).toBeVisible();
    await app.evaluate(({ dialog }) => {
      (globalThis as any).consentCalls = 0;
      dialog.showMessageBox = (async () => { (globalThis as any).consentCalls++; return { response: 0, checkboxChecked: false }; }) as any;
    });
    for (const name of ['codex', 'claude']) fs.mkdirSync(path.join(root, name));
    await page.evaluate(async root => {
      const item = await window.kiln.call<any>('items.create', { kind: 'skill', title: 'Consent test', content: '---\nname: consent-test\ndescription: Test installation\n---\nRead carefully.' });
      const detail = await window.kiln.call<any>('items.read', { id: item.id });
      await window.kiln.call('items.update', { id: item.id, expect: item.revision, summary: '', value: { ...detail.revision, content: detail.revision.content + '\nCheck results.' } });
      for (const provider of ['codex', 'claude']) {
        const target = await window.kiln.call<any>('targets.enroll', { name: provider, provider, scope: 'personal', root: root + '/' + provider });
        await window.kiln.call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
      }
    }, root);
    await expect.poll(async () => page.evaluate(async () => {
      const jobs = await window.kiln.call<any[]>('publish.jobs');
      return jobs.length > 0 && jobs.every(j => j.status === 'done' && j.composer === 'fallback');
    })).toBe(true);
    expect(await app.evaluate(() => (globalThis as any).consentCalls)).toBe(0);
    expect(fs.existsSync(path.join(root, 'codex/.agents/skills/consent-test/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'claude/.claude/skills/consent-test/SKILL.md'))).toBe(true);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
