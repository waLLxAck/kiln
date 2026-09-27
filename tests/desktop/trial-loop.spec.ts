import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopEnv } from './fixture';

/** A stand-in `claude` on PATH: answers --version and every experiment with a failing assessment, so no real agent is contacted. */
function fakeClaude(root: string) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const file = path.join(bin, 'claude');
  fs.writeFileSync(file, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('9.9.9 (fake Claude Code)'); process.exit(0); }
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: '00000000-0000-4000-8000-000000000001' });
  const structured = process.argv.includes('--json-schema') ? { output: 'FAKE OUTPUT: the summary skipped the error handling.', judgement: 'fail', note: 'It ignored the failure path.' } : undefined;
  emit({ type: 'result', is_error: false, result: structured ? '' : 'Done.', structured_output: structured, usage: { input_tokens: 10, output_tokens: 5 } });
});
`, { mode: 0o755 });
  return bin;
}
const api = (page: Page, method: string, args?: unknown) => page.evaluate(([m, a]) => (window as any).kiln.call(m, a), [method, args] as const);
const trialsTab = (page: Page) => page.locator('.detail-tabs button', { hasText: 'trials' });

test('trialLoop: grouped trials, re-test the current revision, improve with agent, and approve from a human verdict', async () => {
  test.skip(process.platform === 'win32', 'The fake Claude Code CLI is a POSIX script');
  test.setTimeout(150_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-trial-loop-ui-'));
  const env = { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'desktop'), KILN_EXPERIMENTS: 'trialLoop', PATH: `${fakeClaude(root)}${path.delimiter}${process.env.PATH}` };
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox; });
    const item = await api(page, 'items.create', { title: 'Loop fixture', kind: 'prompt', content: 'Summarise the change.' }) as { id: string; revision: string };
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await page.getByText('Loop fixture', { exact: true }).first().click();

    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await page.getByLabel('Run with', { exact: true }).selectOption('claude');
    await expect(page.getByLabel('Revision', { exact: true })).toHaveValue(item.revision);
    await page.getByRole('button', { name: 'Run experiment', exact: true }).click();

    const current = page.locator('.trial-group').first();
    await expect(current).toContainText('Current draft', { timeout: 60_000 });
    await expect(current).toContainText('1 failed');
    await expect(current.locator('.trial-loop-card')).toHaveCount(1);
    await expect(current).toContainText('Claude Code · Typical case');
    await expect(trialsTab(page).locator('span')).toHaveText('1');
    await expect(current.getByRole('button', { name: 'Run again' })).toBeVisible();
    await expect(current.getByRole('button', { name: 'Approve this revision' })).toHaveCount(0);

    // Improve with agent: the chat opens about this item with the result typed in, not sent.
    await current.getByRole('button', { name: 'Improve with agent' }).click();
    const chat = page.getByRole('dialog', { name: 'Ask the agent' });
    await expect(chat).toBeVisible();
    const composer = chat.getByLabel('Your message');
    await expect(composer).toHaveValue(/Verdict: fail \(agent assessment\)/);
    await expect(composer).toHaveValue(/It ignored the failure path\./);
    await expect(composer).toHaveValue(/FAKE OUTPUT/);
    expect((await api(page, 'agent.jobs') as { kind: string }[]).filter(j => j.kind === 'chat')).toHaveLength(0);
    await chat.getByRole('button', { name: 'Close chat' }).click();

    // After an edit the experiment belongs to an earlier revision; re-testing runs the new one with the same agent.
    await api(page, 'items.update', { id: item.id, expect: item.revision, summary: 'Mention error handling', value: { ...(await api(page, 'items.read', { id: item.id }) as { revision: object }).revision, content: 'Summarise the change, including its error handling.' } });
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    const earlier = page.locator('.trial-group', { hasText: 'Earlier revision' });
    await expect(earlier).toContainText(item.revision.slice(0, 8));
    await expect(trialsTab(page).locator('span')).toHaveText('0');
    await expect(earlier.getByRole('button', { name: 'Mark as passed' })).toHaveCount(0);
    await earlier.getByRole('button', { name: 'Re-test current revision' }).click();
    const draft = page.locator('.trial-group', { hasText: 'Current draft' });
    await expect(draft.locator('.trial-loop-card')).toHaveCount(1, { timeout: 60_000 });
    const updated = await api(page, 'items.read', { id: item.id }) as { item: { revision: string } };
    const trials = (await api(page, 'snapshot') as { trials: { revision: string; provider: string }[] }).trials;
    expect(trials.map(t => t.revision).sort()).toEqual([item.revision, updated.item.revision].sort());
    expect(trials.every(t => t.provider === 'claude')).toBe(true);

    // A human verdict sits beside the agent's, and a pass offers approval of this revision.
    await draft.getByRole('button', { name: 'Mark as passed' }).click();
    await expect(draft).toContainText('you: pass');
    await expect(draft).toContainText('Claude Code · Typical case');
    await draft.getByRole('button', { name: 'Approve this revision' }).click();
    await expect.poll(async () => (await api(page, 'items.read', { id: item.id }) as { item: { status: string } }).item.status).toBe('approved');
    const approvedGroup = page.locator('.trial-group', { hasText: 'Current revision · approved' });
    await expect(approvedGroup).toBeVisible();
    await expect(approvedGroup.getByRole('button', { name: 'Approve this revision' })).toHaveCount(0);
    await page.screenshot({ path: 'artifacts/trial-loop-trials.png', animations: 'disabled' });

    // Experiments section: grouped by item, filtered by verdict (the human pass counts over the agent's fail).
    await page.getByRole('button', { name: 'Experiments', exact: true }).click();
    const filter = page.getByRole('group', { name: 'Filter experiments by verdict' });
    await filter.getByRole('button', { name: /^Pass/ }).click();
    await expect(page.locator('.experiments-grouped .table-row')).toHaveCount(1);
    await filter.getByRole('button', { name: /^Fail/ }).click();
    await expect(page.locator('.experiments-grouped .table-row')).toHaveCount(1);
    await expect(page.locator('.experiments-grouped')).toContainText('Loop fixture');
    await page.screenshot({ path: 'artifacts/trial-loop-experiments.png', animations: 'disabled' });

    // Flag off: the Trials tab, Test dialog and Experiments table are as before.
    await api(page, 'desktop.experiment', { id: 'trialLoop', enabled: false });
    await app.close();
    const plain = await electron.launch({ args: ['.'], env: { ...env, KILN_EXPERIMENTS: '' } });
    try {
      const again = await plain.firstWindow();
      await again.getByRole('button', { name: 'Library', exact: true }).click();
      await expect(again.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
      await again.getByText('Loop fixture', { exact: true }).first().click();
      await trialsTab(again).click();
      await expect(again.getByText('Agent assessment', { exact: false }).first()).toBeVisible();
      await expect(again.getByRole('button', { name: 'Re-test current revision' })).toHaveCount(0);
      await expect(again.getByRole('button', { name: 'Improve with agent' })).toHaveCount(0);
      await expect(again.getByRole('button', { name: 'Mark as passed' })).toHaveCount(0);
      await expect(again.locator('.trial-group')).toHaveCount(0);
      await expect(trialsTab(again).locator('span')).toHaveText('3');
      await again.getByRole('button', { name: 'Test', exact: true }).click();
      await expect(again.getByLabel('Revision', { exact: true })).toHaveCount(0);
      await again.getByRole('button', { name: 'Close dialog' }).click();
      await again.getByRole('button', { name: 'Experiments', exact: true }).click();
      await expect(again.getByRole('group', { name: 'Filter experiments by verdict' })).toHaveCount(0);
      await expect(again.locator('.experiments-table .table-row')).toHaveCount(3);
    } finally { await plain.close(); }
  } finally { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});
