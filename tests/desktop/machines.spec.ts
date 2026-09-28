import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { desktopEnv, readyLibrary } from './fixture';

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

test('Machines manages this machine, says adding a machine is coming soon, and publishes no machine report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-machines-'));
  const library = readyLibrary(root), home = path.join(root, 'home'); fs.mkdirSync(home);
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
  try {
    const page = await app.firstWindow();
    const content = '---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\nRead the diff.';
    await page.evaluate(async ({ content, home }) => {
      const item = await window.kiln.call<{ id: string; revision: string }>('items.create', { kind: 'skill', title: 'Careful review', content, collection: 'Personal' });
      await window.kiln.call('approvals.approve', { id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', evidence: [], waivedChecks: 'Fixture' });
      await window.kiln.call('targets.enroll', { name: 'Claude skills', root: home, provider: 'claude', scope: 'personal', profile: 'Personal' });
    }, { content, home });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    // Shown in every build, public releases included, with no "Soon" badge.
    await expect(nav(page).getByRole('button', { name: 'Machines' })).toHaveText('Machines');
    await nav(page).getByRole('button', { name: 'Machines' }).click();
    await expect(page.getByText(/^This machine · .+ · (Linux|Windows|macOS)$/)).toBeVisible();
    const soon = page.getByRole('note', { name: 'Add a machine: coming soon' });
    await expect(soon).toContainText('Coming soon');
    await expect(soon).toContainText('Soon: see and install to your other computers from here.');
    // Nothing multi-machine: no other machines, no overview, no sharing.
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByText('All machines')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Report now' })).toHaveCount(0);
    // Everything for this machine is here.
    await expect(page.getByRole('button', { name: 'Add project…' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check drift' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recover interrupted installs' })).toBeVisible();
    await page.getByRole('button', { name: 'Careful review in Claude: Not installed' }).click();
    await page.getByRole('button', { name: 'Install…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Careful review in Claude: Installed' })).toBeVisible();
    await page.screenshot({ path: 'test-results/machines-this-machine.png' });

    // The item page doesn't lead to other machines either.
    await nav(page).getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('.item-card', { hasText: 'Careful review' }).click();
    await expect(page.getByRole('region', { name: 'Installs' }).getByRole('button', { name: 'Install into project…' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Other machines…' })).toHaveCount(0);
    // The install goes to GitHub in installs.json after a moment; no machine report is ever committed.
    await page.waitForTimeout(3000);
    expect(execFileSync('git', ['-C', library, 'log', '--oneline', '--all', '--', 'workbench/machines'], { encoding: 'utf8' }).trim()).toBe('');
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the state chips filter the matrix, combine with the name and column filters, clear in one click and persist', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-machines-filter-'));
  const library = readyLibrary(root), home = path.join(root, 'home'), project = path.join(root, 'my-app'); fs.mkdirSync(home); fs.mkdirSync(project);
  const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: A skill for testing the Machines filters.\n---\n${body}\n`;
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
  try {
    const page = await app.firstWindow();
    // Careful review: installed in Agents, then edited by hand in Claude. Plan first: approved, with a different copy Kiln
    // didn't put in Agents. Rough idea: a draft, so it can't be installed anywhere. my-app: a project column with nothing in it.
    await page.evaluate(async ({ home, project, review, plan, rough }) => {
      const call = window.kiln.call;
      const agents = await call<{ id: string }>('targets.enroll', { name: 'codex', root: home, provider: 'codex', scope: 'personal' });
      const claude = await call<{ id: string }>('targets.enroll', { name: 'claude', root: home, provider: 'claude', scope: 'personal' });
      await call('targets.enroll', { name: 'my-app', root: project, provider: 'codex', scope: 'project' });
      for (const [title, content] of [['Careful review', review], ['Plan first', plan]]) {
        const item = await call<{ id: string; revision: string }>('items.create', { kind: 'skill', title, content, collection: 'Personal' });
        await call('approvals.approve', { id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', evidence: [], waivedChecks: 'Fixture' });
        if (title === 'Careful review') for (const target of [agents, claude]) await call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
      }
      await call('items.create', { kind: 'skill', title: 'Rough idea', content: rough, collection: 'Personal' });
    }, { home, project, review: skill('careful-review', 'Read the diff.'), plan: skill('plan-first', 'Plan, then act.'), rough: skill('rough-idea', 'Not ready.') });
    fs.appendFileSync(path.join(home, '.claude', 'skills', 'careful-review', 'SKILL.md'), 'Edited by hand.\n');
    fs.mkdirSync(path.join(home, '.agents', 'skills', 'plan-first'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'skills', 'plan-first', 'SKILL.md'), skill('plan-first', 'An older plan copied by hand.'));
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await nav(page).getByRole('button', { name: 'Machines' }).click();

    const matrix = page.getByRole('table', { name: 'Installs on this machine' });
    const rows = matrix.getByRole('rowheader');
    const show = page.getByRole('group', { name: 'Show' }), states = page.getByRole('group', { name: 'Filter by state' });
    const chip = (name: string) => states.getByRole('button', { name: new RegExp(`^${name} \\d+$`) });
    const byName = page.getByRole('textbox', { name: 'Filter by name' });
    await expect(rows).toHaveText([/^Careful review/, /^Plan first/, /^Rough idea/]);
    await expect(show.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
    // The chips are the legend, each with its count; a state nothing is in can't be chosen, and marks only show when there are some.
    await expect(chip('Installed')).toHaveText(/1$/);
    await expect(chip('Changed outside Kiln')).toHaveText(/1$/);
    await expect(chip('Not managed')).toHaveText(/1$/);
    await expect(chip('Outdated')).toBeDisabled();
    await expect(chip('Marked')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);

    // Installed keeps the rows with an installed copy; the row's other cells stay, faded.
    await chip('Installed').click();
    await expect(chip('Installed')).toHaveAttribute('aria-pressed', 'true');
    await expect(show.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'false');
    await expect(rows).toHaveText([/^Careful review/]);
    await expect(page.getByRole('status').filter({ hasText: 'shown' })).toHaveText(/1 of 3 shown/);
    await expect(page.getByRole('cell').filter({ has: page.getByRole('button', { name: 'Careful review in Claude: Changed outside Kiln' }) })).toHaveClass(/fleet-faded/);
    await expect(page.getByRole('cell').filter({ has: page.getByRole('button', { name: 'Careful review in Agents: Installed' }) })).not.toHaveClass(/fleet-faded/);
    // Chips add up: installed or not managed.
    await chip('Not managed').click();
    await expect(rows).toHaveText([/^Careful review/, /^Plan first/]);
    await page.screenshot({ path: 'test-results/machines-filter.png' });
    // Needs attention is changed, outdated or not managed.
    await show.getByRole('button', { name: /^Needs attention/ }).click();
    await expect(chip('Installed')).toHaveAttribute('aria-pressed', 'false');
    for (const name of ['Changed outside Kiln', 'Outdated', 'Not managed']) await expect(chip(name)).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveText([/^Careful review/, /^Plan first/]);
    // The name and column filters narrow further.
    await byName.fill('plan');
    await expect(rows).toHaveText([/^Plan first/]);
    await expect(page.getByRole('columnheader', { name: /my-app/ })).toBeVisible();
    await page.getByRole('group', { name: 'Columns' }).getByRole('button', { name: 'Personal' }).click();
    await expect(page.getByRole('columnheader', { name: /my-app/ })).toHaveCount(0);

    // Kept for the session: a reload shows the same filtered view.
    await page.reload();
    await nav(page).getByRole('button', { name: 'Machines' }).click();
    await expect(rows).toHaveText([/^Plan first/]);
    await expect(show.getByRole('button', { name: /^Needs attention/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(byName).toHaveValue('plan');
    await expect(page.getByRole('columnheader', { name: /my-app/ })).toHaveCount(0);

    // One click clears everything.
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(rows).toHaveText([/^Careful review/, /^Plan first/, /^Rough idea/]);
    await expect(show.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(byName).toHaveValue('');
    await expect(page.getByRole('columnheader', { name: /my-app/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
    await expect(page.locator('td.fleet-faded')).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// Multi-machine is off for now (multiMachine in apps/desktop/src/features.ts): Machines manages this machine only and shares no
// report. The fleet backend is still covered by tests/fleet.test.ts; turn this spec back on together with the switch.
test.skip('the matrix shows this machine live and another machine from its report, and marks travel through GitHub', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-machines-fleet-'));
  const library = readyLibrary(root), origin = path.join(root, 'origin.git'), home = path.join(root, 'home'); fs.mkdirSync(home);
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
  /** Runs a step on the other machine (tests/desktop/second-machine.ts) and returns its JSON output. */
  const studio = (step: 'setup' | 'sync') => JSON.parse(execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('tests/desktop/second-machine.ts'), clone, path.join(root, 'studio', 'private'), studioHome, step], { encoding: 'utf8' }).trim().split('\n').at(-1)!);
  const clone = path.join(root, 'studio', 'library'), studioHome = path.join(root, 'studio', 'home');
  try {
    const page = await app.firstWindow();
    const content = '---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\nRead the diff.';
    const itemId = await page.evaluate(async ({ content, home }) => {
      const item = await window.kiln.call<{ id: string; revision: string }>('items.create', { kind: 'skill', title: 'Careful review', content, collection: 'Personal' });
      await window.kiln.call('approvals.approve', { id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', evidence: [], waivedChecks: 'Fixture' });
      await window.kiln.call('targets.enroll', { name: 'Claude skills', root: home, provider: 'claude', scope: 'personal', profile: 'Personal' });
      return item.id;
    }, { content, home });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await nav(page).getByRole('button', { name: 'Machines' }).click();
    const cell = page.getByRole('button', { name: 'Careful review in Claude: Not installed' });
    await cell.click();
    await expect(page.getByRole('dialog', { name: 'Careful review in Claude' })).toContainText('Not installed here');
    await page.getByRole('button', { name: 'Install…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Careful review in Claude: Installed' })).toBeVisible();
    await expect(page.getByText(/Shared (just now|\d+ min ago)/)).toBeVisible({ timeout: 20_000 });

    // Another machine: a clone of the same "GitHub" with its own private data, reporting an Agents folder.
    execFileSync('git', ['clone', '-q', origin, clone]); fs.mkdirSync(studioHome, { recursive: true });
    const studioId = (studio('setup') as { id: string }).id;

    // Reopening Machines fetches (at most once a minute), so reopen after a fresh start of the view.
    await app.close();
    const again = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
    try {
      const view = await again.firstWindow();
      await nav(view).getByRole('button', { name: 'Machines' }).click();
      await view.getByRole('tab', { name: /studio-pc/ }).click();
      await view.getByRole('button', { name: 'Careful review in Agents: Not installed' }).click();
      await view.getByRole('button', { name: 'Mark for studio-pc' }).click();
      await expect(view.getByRole('button', { name: 'Careful review in Agents: Marked, not installed yet' })).toBeVisible();
      await expect.poll(() => { try { return JSON.parse(execFileSync('git', ['-C', origin, 'show', `main:workbench/machines/${studioId}.json`], { encoding: 'utf8' })).wanted[itemId]; } catch { return null; } }, { timeout: 20_000 }).toEqual(['agents']);
      await view.getByRole('tab', { name: /All machines/ }).click();
      await expect(view.getByRole('button', { name: 'Careful review on studio-pc: marked' })).toBeVisible();
      await view.screenshot({ path: 'test-results/machines-fleet.png' });
    } finally { await again.close(); }

    // On the other machine, syncing installs what was marked there, without creating an approval.
    const synced = studio('sync') as { location?: string; result: string }[];
    expect(synced.find(r => r.location === 'agents')?.result).toBe('installed approved revision');
    expect(fs.existsSync(path.join(studioHome, '.agents', 'skills', 'careful-review', 'SKILL.md'))).toBe(true);
  } finally { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});
