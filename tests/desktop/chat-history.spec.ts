import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopEnv } from './fixture';

/**
 * A stand-in `claude` on PATH. It answers with a Markdown list; a message containing EDIT makes it change the open item through Kiln's
 * CLI (through the `kiln` shell wrapper the chat writes), and `ALSO <id>` changes that item too, as a real agent would.
 */
function fakeClaude(root: string) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const file = path.join(bin, 'claude');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'), { execFileSync } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('9.9.9 (fake Claude Code)'); process.exit(0); }
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: require('node:crypto').randomUUID() });
  const message = (input.match(/<user_message>\\n([\\s\\S]*?)\\n<\\/user_message>/) || [])[1] || '';
  let reply = 'Here you go:\\n\\n- first point\\n- second point';
  if (message.includes('EDIT')) {
    // Runs the wrapper the chat writes, as a real agent's shell would.
    const kiln = args => JSON.parse(execFileSync('./kiln', args, { encoding: 'utf8' })).data;
    const edit = (id, content, summary) => {
      const revision = kiln(['items', 'read', id]).revision;
      fs.writeFileSync('draft.md', content);
      const args = ['items', 'update', id, '--file', 'draft.md', '--expect', revision, '--summary', summary];
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-' + id, name: 'Bash', input: { command: 'kiln ' + args.join(' ') } }] } });
      kiln(args);
    };
    const context = fs.readFileSync('context.md', 'utf8'), open = context.match(/^id: (\\S+)/m)[1];
    edit(open, 'Summarise the change in three bullets.', 'Agent made it clearer');
    const also = message.match(/ALSO (\\S+)/); if (also) edit(also[1], 'Side content, rewritten.', 'Agent tidied the side item');
    reply = 'I **changed** the prompt.';
  }
  emit({ type: 'result', is_error: false, result: reply, usage: { input_tokens: 10, output_tokens: 5 } });
});
`, { mode: 0o755 });
  return bin;
}
const api = <T = unknown>(page: Page, method: string, args?: unknown) => page.evaluate(([m, a]) => (window as any).kiln.call(m, a), [method, args] as const) as Promise<T>;
/** Answers the agent warning with "Agree", without ticking Don't show again, and counts how often it was shown. */
const consent = (app: ElectronApplication) => app.evaluate(({ dialog }) => { const state = globalThis as any; state.consentCalls = 0; dialog.showMessageBox = (async () => { state.consentCalls++; return { response: 1, checkboxChecked: false }; }) as any; });
const consentCalls = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).consentCalls as number);
/** The chat reads the provider from the machine-private settings on every message, so switching to the fake Claude needs no restart. */
function useClaude(root: string) {
  const local = fs.readdirSync(path.join(root, 'private')).map(name => path.join(root, 'private', name)).find(dir => fs.existsSync(path.join(dir, 'agent-jobs')))!;
  const file = path.join(local, 'settings.json'), previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...previous, agentProvider: 'claude' }));
}
const open = async (page: Page, title: string) => { await page.getByRole('button', { name: 'Refresh library', exact: true }).click(); await page.getByText(title, { exact: true }).first().click(); await expect(page.locator('.detail-pane h1')).toContainText(title); };

test('chatHistory: docked chat keeps conversations per item, renders Markdown, shows and undoes agent changes, asks consent once', async () => {
  test.skip(process.platform === 'win32', 'The fake Claude Code CLI is a POSIX script');
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-chat-history-ui-'));
  const env = { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'desktop'), KILN_EXPERIMENTS: 'chatHistory,trialLoop', PATH: `${fakeClaude(root)}${path.delimiter}${process.env.PATH}` };
  let app = await electron.launch({ args: ['.'], env });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
    await consent(app); useClaude(root);
    const main = await api<{ id: string; revision: string }>(page, 'items.create', { title: 'Chat fixture', kind: 'prompt', content: 'Summarise the change.' });
    const second = await api<{ id: string }>(page, 'items.create', { title: 'Second fixture', kind: 'prompt', content: 'Another prompt.' });
    const side = await api<{ id: string }>(page, 'items.create', { title: 'Side item', kind: 'prompt', content: 'Side content.' });
    await open(page, 'Chat fixture');

    // Docked beside the detail pane, not over it.
    await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
    let dock = page.locator('aside.chat-dock');
    await expect(dock).toBeVisible();
    await expect(page.locator('.chat-popover')).toHaveCount(0);
    const detail = page.locator('.detail-pane');
    await expect(detail).toBeVisible();
    const [paneBox, dockBox] = [await detail.boundingBox(), await dock.boundingBox()];
    expect(paneBox!.width).toBeGreaterThan(300);
    expect(dockBox!.x).toBeGreaterThanOrEqual(paneBox!.x + paneBox!.width - 1);
    await expect(page.locator('.library-list')).toBeVisible();

    // A reply renders as Markdown.
    await dock.getByLabel('Your message').fill('Give me a list');
    await dock.getByRole('button', { name: 'Send' }).click();
    await expect(dock.locator('.chat-markdown li')).toHaveCount(2, { timeout: 60_000 });
    await expect(dock.locator('.chat-markdown li').first()).toHaveText('first point');
    await expect(dock.locator('pre.chat-text')).toHaveCount(0);
    expect(await consentCalls(app)).toBe(1);

    // Closing and reopening, Esc from inside, and switching items all bring the same conversation back.
    await dock.getByRole('button', { name: 'Close chat' }).click();
    await expect(dock).toHaveCount(0);
    await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
    await expect(dock.locator('.chat-question')).toContainText('Give me a list');
    await dock.getByLabel('Your message').focus(); await page.keyboard.press('Escape');
    await expect(dock).toHaveCount(0);
    await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
    await page.getByText('Second fixture', { exact: true }).first().click();
    await expect(dock.locator('.chat-context')).toContainText('Second fixture');
    await expect(dock.locator('.chat-turns')).toHaveCount(0);
    await page.getByText('Chat fixture', { exact: true }).first().click();
    await expect(dock.locator('.chat-context')).toContainText('Chat fixture');
    await expect(dock.locator('.chat-markdown li')).toHaveCount(2);

    // The agent edits this item and another through the CLI: a card names both, shows the diff and undoes the change.
    await dock.getByLabel('Your message').fill(`EDIT this prompt, ALSO ${side.id}`);
    await dock.getByRole('button', { name: 'Send' }).click();
    const changes = dock.getByRole('group', { name: 'Changes the agent made' });
    await expect(changes).toContainText('Changed Chat fixture: Agent made it clearer', { timeout: 60_000 });
    await expect(changes).toContainText('Changed Side item: Agent tidied the side item');
    await expect(dock.locator('.chat-markdown strong')).toHaveText('changed');
    expect(await consentCalls(app)).toBe(1);
    const card = changes.locator('.chat-change', { hasText: 'Chat fixture' });
    await card.getByRole('button', { name: 'View changes' }).click();
    const diff = page.getByRole('dialog', { name: 'Changes to Chat fixture' });
    await expect(diff.locator('.diff')).toContainText('Summarise the change in three bullets.');
    await expect(diff.locator('.diff')).toContainText('Summarise the change.');
    await diff.getByRole('button', { name: 'Close dialog' }).click();
    await card.getByRole('button', { name: 'Undo change' }).click();
    const confirm = page.getByRole('dialog', { name: 'Undo this change?' });
    await confirm.getByRole('button', { name: 'Undo change' }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(async () => (await api<{ revision: { content: string }; item: { revision: string } }>(page, 'items.read', { id: main.id })).item.revision).toBe(main.revision);
    await expect(card).toContainText('Undone');
    await expect(card.getByRole('button', { name: 'Undo change' })).toHaveCount(0);
    expect((await api<{ revision: { content: string } }>(page, 'items.read', { id: side.id })).revision.content).toBe('Side content, rewritten.');
    await page.screenshot({ path: 'artifacts/chat-history-dock.png', animations: 'disabled' });

    // New session starts empty; Sessions lists the earlier one and reopens it.
    await dock.getByRole('button', { name: 'New session' }).click();
    await expect(dock.locator('.chat-turns')).toHaveCount(0);
    await dock.getByRole('button', { name: /^Sessions/ }).click();
    const earlier = page.getByRole('menuitem', { name: /Give me a list/ });
    await expect(earlier).toBeVisible();
    await expect(earlier).toContainText('Claude Code');
    await earlier.click();
    await expect(dock.locator('.chat-turns > li')).toHaveCount(2);

    // trialLoop's kiln:ask-agent still opens the chat about an item with the message typed in, unsent.
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent('kiln:ask-agent', { detail })), { itemId: second.id, message: 'Improve this, please' });
    await expect(dock.locator('.chat-context')).toContainText('Second fixture');
    await expect(dock.getByLabel('Your message')).toHaveValue('Improve this, please');

    // After a restart the conversation is still there (and consent is asked again, once).
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow(); dock = page.locator('aside.chat-dock');
    await consent(app);
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await open(page, 'Chat fixture');
    await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
    await expect(dock.locator('.chat-markdown li')).toHaveCount(2);
    await expect(dock.getByRole('group', { name: 'Changes the agent made' })).toContainText('Undone');
    await dock.getByLabel('Your message').fill('One more');
    await dock.getByRole('button', { name: 'Send' }).click();
    await expect(dock.locator('.chat-turns > li')).toHaveCount(3, { timeout: 60_000 });
    await expect(dock.locator('.chat-turns > li').last().locator('.chat-markdown li')).toHaveCount(2, { timeout: 60_000 });
    expect(await consentCalls(app)).toBe(1);

    // Flag off: the popover overlay, plain-text replies and a warning before every message, as before.
    await app.close();
    app = await electron.launch({ args: ['.'], env: { ...env, KILN_EXPERIMENTS: '' } });
    page = await app.firstWindow();
    await consent(app);
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await open(page, 'Chat fixture');
    await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
    const popover = page.locator('aside.chat-popover');
    await expect(popover).toBeVisible();
    await expect(page.locator('.chat-dock')).toHaveCount(0);
    await expect(popover.locator('.chat-turns')).toHaveCount(0);
    await expect(popover.getByRole('button', { name: /^Sessions/ })).toHaveCount(0);
    for (const n of [1, 2]) {
      await popover.getByLabel('Your message').fill(`Plain ${n}`);
      await popover.getByRole('button', { name: 'Send' }).click();
      await expect(popover.locator('pre.chat-text')).toHaveCount(n, { timeout: 60_000 });
    }
    await expect(popover.locator('pre.chat-text').first()).toContainText('- first point');
    await expect(popover.locator('.chat-markdown, .chat-changes')).toHaveCount(0);
    expect(await consentCalls(app)).toBe(2);
    expect(await page.evaluate(() => window.kiln.call('agent.chatHistory', { itemId: '00000000-0000-4000-8000-000000000000' }).then(() => 'listed', e => String(e)))).toContain('Experimental features');
  } finally { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});
