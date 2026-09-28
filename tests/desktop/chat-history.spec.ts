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
const exact = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
/** Opens an item from the library list, going back to the list first when an item is open. */
async function open(page: Page, title: string) {
  const bar = page.getByRole('toolbar', { name: 'Item navigation' });
  if (await bar.count()) await bar.getByRole('button').first().click();
  await page.getByRole('button', { name: 'Refresh library', exact: true }).first().click();
  await page.locator('.item-card').filter({ has: page.locator('.item-title', { hasText: exact(title) }) }).first().click();
  await expect(page.locator('.detail-pane h1')).toContainText(title);
}

test('docked chat keeps each item’s conversation, lists sessions, resizes, renders Markdown, shows agent changes with View changes and Undo, asks consent once per start', async () => {
  test.skip(process.platform === 'win32', 'The fake Claude Code CLI is a POSIX script');
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-chat-history-ui-'));
  const env = { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'desktop'), PATH: `${fakeClaude(root)}${path.delimiter}${process.env.PATH}` };
  let app = await electron.launch({ args: ['.'], env });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true }).first()).toBeVisible();
    await consent(app); useClaude(root);
    const main = await api<{ id: string; revision: string }>(page, 'items.create', { title: 'Chat fixture', kind: 'prompt', content: 'Summarise the change.' });
    const second = await api<{ id: string }>(page, 'items.create', { title: 'Second fixture', kind: 'prompt', content: 'Another prompt.' });
    const side = await api<{ id: string }>(page, 'items.create', { title: 'Side item', kind: 'prompt', content: 'Side content.' });
    await open(page, 'Chat fixture');

    // Docked beside the item page, pushing it aside rather than covering it; the edge drags to resize and the width is kept.
    await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
    let dock = page.getByRole('complementary', { name: 'Ask the agent' });
    await expect(dock).toBeVisible();
    const [paneBox, dockBox] = [await page.locator('.detail-pane').boundingBox(), await dock.boundingBox()];
    expect(paneBox!.width).toBeGreaterThan(300);
    expect(dockBox!.x).toBeGreaterThanOrEqual(paneBox!.x + paneBox!.width - 1);
    await expect(dock.getByRole('button', { name: 'Sessions' })).toBeDisabled();
    const edge = page.getByRole('separator', { name: 'Resize chat' });
    const grip = (await edge.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 200); await page.mouse.down();
    await page.mouse.move(grip.x - 100, grip.y + 200, { steps: 4 }); await page.mouse.up();
    const widened = (await dock.boundingBox())!.width;
    expect(widened).toBeGreaterThan(dockBox!.width + 80);

    // A reply renders as Markdown.
    await dock.getByLabel('Your message').fill('Give me a list');
    await dock.getByRole('button', { name: 'Send' }).click();
    await expect(dock.locator('.chat-reply-text li')).toHaveCount(2, { timeout: 60_000 });
    await expect(dock.locator('.chat-reply-text li').first()).toHaveText('first point');
    expect(await consentCalls(app)).toBe(1);

    // Closing and reopening, Esc from inside, and switching items all bring the same conversation back.
    await dock.getByRole('button', { name: 'Close chat' }).click();
    await expect(dock).toHaveCount(0);
    await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
    await expect(dock.locator('.chat-you')).toContainText('Give me a list');
    await dock.getByLabel('Your message').focus(); await page.keyboard.press('Escape');
    await expect(dock).toHaveCount(0);
    await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
    await open(page, 'Second fixture');
    await expect(dock.locator('.chat-context')).toContainText('Second fixture');
    await expect(dock.locator('.chat-turns')).toHaveCount(0);
    await open(page, 'Chat fixture');
    await expect(dock.locator('.chat-context')).toContainText('Chat fixture');
    await expect(dock.locator('.chat-reply-text li')).toHaveCount(2);

    // The agent edits this item and another through the CLI: one card per item, with the revision note, View changes and Undo.
    await dock.getByLabel('Your message').fill(`EDIT this prompt, ALSO ${side.id}`);
    await dock.getByRole('button', { name: 'Send' }).click();
    const card = dock.getByRole('region', { name: 'Changed by the agent: Chat fixture' });
    await expect(card).toContainText('Agent made it clearer', { timeout: 60_000 });
    await expect(dock.getByRole('region', { name: 'Changed by the agent: Side item' })).toContainText('Agent tidied the side item');
    await expect(dock.locator('.chat-reply-text strong')).toHaveText('changed');
    expect(await consentCalls(app)).toBe(1);
    await card.getByRole('button', { name: 'View changes' }).click();
    const diff = page.getByRole('dialog', { name: 'Changes to Chat fixture' });
    await expect(diff.locator('.diff')).toContainText('Summarise the change in three bullets.');
    await expect(diff.locator('.diff')).toContainText('Summarise the change.');
    await diff.getByRole('button', { name: 'Close dialog' }).click();
    await expect(dock).toBeVisible();
    await card.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await api<{ revision: { content: string } }>(page, 'items.read', { id: main.id })).revision.content).toBe('Summarise the change.');
    await expect(dock.locator('.chat-change-done', { hasText: 'Chat fixture' })).toContainText('Undone');
    expect((await api<{ revision: { content: string } }>(page, 'items.read', { id: side.id })).revision.content).toBe('Side content, rewritten.');
    await dock.getByRole('region', { name: 'Changed by the agent: Side item' }).getByRole('button', { name: 'Keep' }).click();
    await expect(dock.locator('.chat-change-done', { hasText: 'Side item' })).toContainText('Kept');
    await page.screenshot({ path: 'artifacts/chat-history-dock.png', animations: 'disabled' });

    // New session starts empty; Sessions lists the earlier one by its first message, date and agent, and reopens it.
    await dock.getByRole('button', { name: 'New session' }).click();
    await expect(dock.locator('.chat-turns')).toHaveCount(0);
    await dock.getByRole('button', { name: /^Sessions/ }).click();
    const earlier = page.getByRole('menuitemradio', { name: /Give me a list/ });
    await expect(earlier).toBeVisible();
    await expect(earlier).toContainText('Claude Code');
    await earlier.click();
    await expect(dock.locator('.chat-turns > li')).toHaveCount(2);

    // kiln:ask-agent (Improve with agent) opens the chat about an item with the message typed in, unsent.
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent('kiln:ask-agent', { detail })), { itemId: second.id, message: 'Improve this, please' });
    await expect(dock.locator('.chat-context')).toContainText('Second fixture');
    await expect(dock.getByLabel('Your message')).toHaveValue('Improve this, please');

    // After a restart the conversation, the decisions on its cards and the panel width are still there; consent is asked again, once.
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow(); dock = page.getByRole('complementary', { name: 'Ask the agent' });
    await expect(page.getByRole('button', { name: 'Ask the agent', exact: true })).toBeVisible();
    await consent(app);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Library', exact: true }).click();
    await open(page, 'Chat fixture');
    await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
    await expect(dock.locator('.chat-reply-text li')).toHaveCount(2);
    await expect(dock.locator('.chat-change-done', { hasText: 'Chat fixture' })).toContainText('Undone');
    expect(Math.round((await dock.boundingBox())!.width)).toBe(Math.round(widened));
    await dock.getByLabel('Your message').fill('One more');
    await dock.getByRole('button', { name: 'Send' }).click();
    await expect(dock.locator('.chat-turns > li')).toHaveCount(3, { timeout: 60_000 });
    await expect(dock.locator('.chat-turns > li').last().locator('.chat-reply-text li')).toHaveCount(2, { timeout: 60_000 });
    expect(await consentCalls(app)).toBe(1);
  } finally { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});
