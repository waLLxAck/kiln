import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopEnv } from './fixture';

/**
 * A stand-in `claude` on PATH: answers --version and every experiment with a failing assessment, so no real agent is contacted.
 * A run whose context says SLOW-RUN holds its slot for a while, so the next run has to queue.
 */
function fakeClaude(root: string) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const file = path.join(bin, 'claude');
  fs.writeFileSync(file, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('9.9.9 (fake Claude Code)'); process.exit(0); }
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: '00000000-0000-4000-8000-000000000001' });
  const structured = process.argv.includes('--json-schema') ? { output: 'FAKE OUTPUT: the summary skipped the error handling.', judgement: 'fail', note: 'It ignored the failure path.' } : undefined;
  setTimeout(() => emit({ type: 'result', is_error: false, result: structured ? '' : 'Done.', structured_output: structured, usage: { input_tokens: 10, output_tokens: 5 } }), input.includes('SLOW-RUN') ? 60_000 : 0);
});
`, { mode: 0o755 });
  return bin;
}
const api = (page: Page, method: string, args?: unknown) => page.evaluate(([m, a]) => (window as any).kiln.call(m, a), [method, args] as const);
const short = (hash: string) => hash.slice(0, 8);

test('trial loop: re-test, improve with agent, your verdict beside the agent’s, approve, the Experiments page and a queued run', async () => {
  test.skip(process.platform === 'win32', 'The fake Claude Code CLI is a POSIX script');
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-trial-loop-ui-'));
  const env = { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'desktop'), PATH: `${fakeClaude(root)}${path.delimiter}${process.env.PATH}` };
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox; });
    const item = await api(page, 'items.create', { title: 'Loop fixture', kind: 'prompt', content: 'Summarise the change.' }) as { id: string; revision: string };
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await page.getByText('Loop fixture', { exact: true }).first().click();

    // Open tests (in the rail's Tests section: a prompt's primary action is Copy) opens the grid; its full run dialog picks the revision, the current one by default.
    await page.getByRole('region', { name: 'Tests', exact: true }).getByRole('button', { name: 'Open tests', exact: true }).click();
    const grid = page.getByRole('region', { name: 'Experiments', exact: true });
    await grid.getByRole('button', { name: 'Run options…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Run an experiment' });
    await dialog.getByLabel('Run with', { exact: true }).selectOption('claude');
    await expect(dialog.getByLabel('Revision', { exact: true })).toHaveValue(item.revision);
    await dialog.getByRole('button', { name: 'Run experiment', exact: true }).click();

    const panel = page.getByRole('complementary', { name: 'Experiment result' });
    await expect(grid.getByRole('button', { name: `${short(item.revision)} on Isolated example: Fail` })).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByText('Agent’s assessment')).toBeVisible();
    await expect(panel.getByRole('group', { name: 'Your verdict' })).toContainText('Not given yet');
    await expect(panel.getByRole('button', { name: 'Run again' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Re-test current revision' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Approve this revision' })).toHaveCount(0);

    // Improve with agent: the docked chat opens about this item with the result typed in, not sent.
    await panel.getByRole('button', { name: 'Improve with agent' }).click();
    const chat = page.getByRole('complementary', { name: 'Ask the agent' });
    await expect(chat).toBeVisible();
    const composer = chat.getByLabel('Your message');
    await expect(composer).toHaveValue(/Verdict: fail \(agent assessment\)/);
    await expect(composer).toHaveValue(/It ignored the failure path\./);
    await expect(composer).toHaveValue(/FAKE OUTPUT/);
    expect((await api(page, 'agent.jobs') as { kind: string }[]).filter(j => j.kind === 'chat')).toHaveLength(0);
    await chat.getByRole('button', { name: 'Close chat' }).click();

    // After an edit the experiment belongs to an earlier revision: it can't be judged any more, and re-testing runs the new one with the same agent.
    await api(page, 'items.update', { id: item.id, expect: item.revision, summary: 'Mention error handling', value: { ...(await api(page, 'items.read', { id: item.id }) as { revision: object }).revision, content: 'Summarise the change, including its error handling.' } });
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    const updated = (await api(page, 'items.read', { id: item.id }) as { item: { revision: string } }).item.revision;
    await grid.getByRole('button', { name: `${short(item.revision)} on Isolated example: Fail` }).click();
    await expect(panel.getByRole('button', { name: 'Mark as passed' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Re-test current revision' }).click();
    const fresh = grid.getByRole('button', { name: `${short(updated)} on Isolated example: Fail` });
    await expect(fresh).toBeVisible({ timeout: 60_000 });
    const trials = (await api(page, 'snapshot') as { trials: { revision: string; provider: string }[] }).trials;
    expect(trials.map(t => t.revision).sort()).toEqual([item.revision, updated].sort());
    expect(trials.every(t => t.provider === 'claude')).toBe(true);

    // Your verdict sits beside the agent's, which stays Fail; a pass from you offers approval of this revision.
    await fresh.click();
    await panel.getByRole('button', { name: 'Mark as passed' }).click();
    await expect(panel.getByRole('group', { name: 'Your verdict' })).toContainText('Passed');
    await expect(panel.getByRole('button', { name: 'Mark as passed' })).toHaveAttribute('aria-pressed', 'true');
    await expect(grid.getByRole('button', { name: `${short(updated)} on Isolated example: Fail, your verdict passed` })).toBeVisible();
    await expect(grid.getByRole('img', { name: 'Your verdict: passed' })).toBeVisible();
    await expect(grid.getByText('This is the agent’s view')).toHaveCount(0);
    // Verdicts are not runs: the grid still counts two.
    await expect(grid).toContainText('2 runs');
    await panel.getByRole('button', { name: 'Approve this revision' }).click();
    await expect.poll(async () => (await api(page, 'items.read', { id: item.id }) as { item: { status: string } }).item.status).toBe('approved');
    await expect(panel.getByRole('button', { name: 'Approve this revision' })).toHaveCount(0);
    await page.screenshot({ path: 'artifacts/trial-loop-grid.png', animations: 'disabled' });

    // Experiments page: grouped by item and revision, filtered by verdict (your pass counts over the agent's fail).
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Experiments', exact: true }).click();
    const all = page.getByRole('region', { name: 'All experiments' });
    const filter = all.getByRole('group', { name: 'Filter experiments by verdict' });
    await expect(all.getByRole('group', { name: `Revision ${short(updated)}` })).toContainText('Current');
    await expect(all.getByRole('group', { name: `Revision ${short(item.revision)}` })).toContainText('Earlier revision');
    await filter.getByRole('button', { name: /^Pass/ }).click();
    await expect(all.locator('.exps-row')).toHaveCount(1);
    await filter.getByRole('button', { name: /^Fail/ }).click();
    await expect(all.locator('.exps-row')).toHaveCount(1);
    await filter.getByRole('button', { name: /^Uncertain/ }).click();
    await expect(all).toContainText('No experiments with this verdict.');
    await filter.getByRole('button', { name: /^All/ }).click();
    await expect(all.locator('.exps-row')).toHaveCount(2);
    await page.screenshot({ path: 'artifacts/trial-loop-experiments.png', animations: 'disabled' });
    // The item's name opens its grid.
    await all.getByRole('button', { name: 'Loop fixture' }).click();
    await expect(grid).toBeVisible();

    // With both run slots busy, Run again waits as Queued in its cell and can be cancelled before it starts.
    const others = await Promise.all(['Slow one', 'Slow two'].map(title => api(page, 'items.create', { title, kind: 'prompt', content: 'Wait.' }) as Promise<{ id: string }>));
    for (const other of others) await api(page, 'agent.start', { id: other.id, kind: 'trial', provider: 'claude', context: 'SLOW-RUN' });
    await fresh.click();
    await panel.getByRole('button', { name: 'Run again' }).click();
    const waiting = grid.getByRole('button', { name: `${short(updated)} on Isolated example: queued` });
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText('Queued');
    await expect(panel).toContainText('Queued for Claude Code');
    await panel.getByRole('button', { name: 'Cancel run' }).click();
    await expect(grid.getByRole('button', { name: `${short(updated)} on Isolated example: cancelled` })).toBeVisible();
    for (const job of (await api(page, 'agent.jobs') as { id: string; status: string }[]).filter(j => j.status === 'running')) await api(page, 'agent.cancel', { id: job.id });
  } finally { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});
