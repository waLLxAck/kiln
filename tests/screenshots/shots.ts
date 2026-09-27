/** Navigates the seeded app through the real UI and saves one PNG per screenshot. Shared by the Electron spec and the local preview. */
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { Machine, Seeded } from './seed';

export type ShotContext = { page: Page; ids: Seeded; m: Machine; out: string; electron: boolean; chooseDirectory: (folder: string) => void | Promise<void> };
export const captions: Record<string, string> = {};

export async function takeScreenshots({ page, ids, out }: ShotContext) {
  const shot = async (name: string, caption: string) => {
    await page.mouse.move(1439, 899);
    await page.waitForTimeout(400);
    // Chromium occasionally refuses a capture while a modal's backdrop is compositing; a moment later it succeeds.
    for (let attempt = 1; ; attempt++) {
      try { await page.screenshot({ path: path.join(out, `${name}.png`), caret: 'hide' }); break; }
      catch (error) { if (attempt === 3) throw error; await page.waitForTimeout(1000); }
    }
    captions[name] = caption;
  };
  const nav = (name: string) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
  // The item page is one document with a rail: installs are always in the rail, Tests swap in from it, and "Content" goes back.
  const detailTab = async (name: 'installs' | 'overview' | 'trials') => {
    if (name === 'trials') { await page.getByRole('button', { name: 'Open tests', exact: true }).click(); return; }
    const back = page.getByRole('button', { name: 'Content', exact: true });
    if (await back.count()) await back.click();
  };
  const exact = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const row = (title: string) => page.locator('.item-card').filter({ has: page.locator('.item-title', { hasText: exact(title) }) }).first();
  const search = page.getByRole('combobox', { name: 'Search library' });
  await expect(search).toBeVisible({ timeout: 60_000 });
  /** Back from an open item to the list, as Esc does. */
  const back = () => page.getByRole('toolbar', { name: 'Item navigation' }).getByRole('button').first().click();

  // 1. A skill with its install locations.
  await search.fill('kind:skill'); await search.press('Enter'); await search.press('Escape');
  await row('code-review').click();
  await detailTab('installs');
  await expect(page.getByRole('group', { name: 'Installed for' })).toBeVisible();
  await shot('skill-installs', 'A skill with one install switch per location, and each folder it is in, including a copy edited outside Kiln.');

  // 2. A copy that differs from the approved version, compared file by file.
  await back();
  await row('research').click();
  await detailTab('installs');
  await page.getByRole('group', { name: 'Installed for' }).getByRole('button', { name: /^Agents/ }).click();
  await expect(page.getByRole('dialog').locator('.compare-summary')).toBeVisible();
  await shot('drift-compare', 'An older copy found in the shared Agents folder, compared line by line with the approved version.');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();

  // 3. A video distilled into a collection of entries with timestamped links.
  await back();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: /I let a seven-year-old test my app/ }).first().click();
  await row('I let a seven-year-old test my app (with an agent)').click();
  await detailTab('overview');
  await expect(page.locator('.source-takeaway')).toBeVisible();
  await shot('video-distilled', 'A YouTube video distilled into a prompt, techniques, an insight and a tool, each linked to its minute in the video.');

  // 4. The distilled prompt tested on a real project, fixed, and tested again.
  await back();
  await row('Try it as a seven-year-old').click();
  await detailTab('trials');
  await expect(page.locator('.agent-result').first()).toBeVisible();
  await shot('experiment-result', 'The distilled prompt tested read-only on a local project, with the agent’s output and a pass verdict for that exact revision.');

  // 5. The Test dialog with its project selector.
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await page.getByRole('dialog').getByLabel('What should it try? (optional)').fill('Start from the first screen after the parent gate, and try the Shop too.');
  await shot('test-dialog', 'Test runs the exact revision read-only on a project you choose, with Codex or Claude Code.');
  await page.keyboard.press('Escape');

  // 6. Config files.
  await nav('Config files');
  await page.getByLabel('Filter config files').fill('claude');
  await page.locator('.cfg-file').filter({ hasText: /^settings\.json/ }).first().click();
  await expect(page.getByRole('tab', { name: /Permissions/ })).toBeVisible();
  await shot('config-files', 'Agent instructions and settings grouped by agent and project; Claude Code permissions as Allow, Ask and Deny, with syntax checks and private backups.');

  // 7. Asking the agent about a distilled entry, with the video's transcript as context, in the dark theme.
  await page.getByRole('button', { name: /I let a seven-year-old test my app/ }).first().click();
  if (await page.getByRole('toolbar', { name: 'Item navigation' }).count()) await back();
  await row('Try it as a seven-year-old').click();
  await detailTab('overview');
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();
  const chat = page.getByRole('complementary', { name: 'Ask the agent' });
  await chat.getByLabel('Your message').fill('What did they change between the first and the second run?');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.locator('.chat-reply-text')).toBeVisible({ timeout: 120_000 });
  await shot('ask-agent-dark', 'Asking the agent about a distilled prompt: it answers from the video’s transcript and your library. Dark theme.');
}
