import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../../packages/domain/workbench';
import { transcriptMarkdown } from '../../packages/agent/youtube';
import { desktopEnv, readyLibrary, showKind } from './fixture';

test('a source has its own tab and page: no copy or test, its analysis, what was made from it with keep and archive, and links both ways', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-sources-'));
  const library = readyLibrary(root);
  const wb = new Workbench(library, path.join(root, 'private'));
  try {
    const source = wb.create({ title: 'Design chat', kind: 'source', content: 'We compared three homepage designs.', description: 'A chat comparing homepage designs.', collection: 'Design' });
    const technique = wb.createFrom({ id: source.id, revision: source.revision, author: 'Codex', item: { title: 'Compare designs side by side', kind: 'technique', content: '1. Compare.', collection: 'Design' } });
    wb.createFrom({ id: source.id, revision: source.revision, author: 'Codex', item: { title: 'Ground the copy', kind: 'prompt', content: 'Ground every claim in this repository.', collection: 'Writing' } });
    wb.create({ title: 'Unrelated prompt', kind: 'prompt', content: 'Other', collection: 'Writing' });
    wb.recordAnalysis({ schemaVersion: 1, id: randomUUID(), itemId: source.id, revision: source.revision, provider: 'codex', model: 'gpt-test', effort: 'medium', usage: { input: 42000, cached: 0, output: 1704, reasoning: 0 }, startedAt: '2026-09-24T10:35:00.000Z', finishedAt: '2026-09-24T10:36:05.000Z', summary: 'This exchange explores homepage designs.', takeaway: 'Ground claims in the code.', skipped: 'Live designs were not inspected.', counts: { prompt: 1, technique: 1 }, created: [technique.id], collection: 'Design' });
  } finally { wb.close(); }
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.locator('.item-card', { hasText: 'Design chat' })).toBeVisible({ timeout: 15_000 });
    await showKind(page, 'source');
    const row = page.locator('.item-card', { hasText: 'Design chat' });
    await expect(page.locator('.item-card')).toHaveCount(1);
    await expect(row.locator('.lib-made')).toHaveText('2 made');

    // The source page: summary, one-line analysis, what was made from it and the material; no copy, test or approval.
    await row.click();
    const detail = page.getByRole('article', { name: 'Selected item' });
    const sourcePage = detail.getByRole('region', { name: 'Source' });
    await expect(sourcePage.getByRole('heading', { name: 'Design chat' })).toBeVisible();
    await expect(sourcePage).toContainText('Source · text');
    await expect(sourcePage.locator('.source-callout')).toContainText('This exchange explores homepage designs.');
    await expect(sourcePage.locator('.source-callout')).toContainText('Ground claims in the code.');
    await expect(sourcePage.getByRole('button', { name: 'Analyze again' })).toBeVisible();
    await expect(sourcePage.getByRole('button', { name: 'Ask about this source' })).toBeVisible();
    // Only videos get a timeline and a transcript.
    await expect(sourcePage.getByRole('region', { name: 'Timeline' })).toHaveCount(0);
    await expect(sourcePage.getByRole('button', { name: 'Show transcript' })).toHaveCount(0);
    for (const name of ['Copy', 'Test']) await expect(detail.getByRole('button', { name, exact: true })).toHaveCount(0);
    const line = sourcePage.locator('.source-analysis');
    await expect(line).toContainText('Codex · gpt-test · medium effort · 42k in · 1,704 out · 1m 5s');
    await line.getByRole('button', { name: 'Analysis details' }).click();
    const record = sourcePage.getByRole('region', { name: 'Recorded analysis' });
    await expect(record).toContainText('This exchange explores homepage designs.');
    await expect(record).toContainText('42k in · 1,704 out');
    await expect(sourcePage.getByRole('heading', { name: 'Original material' })).toBeVisible();
    await expect(sourcePage.locator('.content-preview')).toContainText('We compared three homepage designs.');
    await page.screenshot({ path: 'test-results/source-overview.png' });

    // What was made from it, grouped by kind, wherever it is filed.
    const made = sourcePage.getByRole('region', { name: 'Made from this source' });
    await expect(made.locator('.source-group-title')).toHaveText(['Prompts1', 'Techniques1']);
    const ground = made.locator('.source-entry', { hasText: 'Ground the copy' });
    await expect(ground).toContainText('Writing');
    // Keep stars an entry; Archive moves it to Archive with an undo, and Restore brings it back.
    await ground.getByRole('button', { name: 'Keep' }).click();
    await expect(ground.getByRole('button', { name: 'Kept' })).toHaveAttribute('aria-pressed', 'true');
    await made.locator('.source-entry', { hasText: 'Compare designs side by side' }).getByRole('button', { name: 'Archive' }).click();
    await expect(page.locator('.undo-toast')).toContainText('Compare designs side by side');
    await page.locator('.undo-toast').getByRole('button', { name: 'Undo' }).click();
    await expect(made.locator('.source-entry')).toHaveCount(2);
    await made.locator('.source-entry', { hasText: 'Compare designs side by side' }).getByRole('button', { name: 'Archive' }).click();
    await made.getByRole('button', { name: 'Archived (1)' }).click();
    await made.locator('.source-entry.archived', { hasText: 'Compare designs side by side' }).getByRole('button', { name: 'Restore' }).click();
    await expect(made.getByRole('button', { name: /^Archived/ })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/source-made.png' });

    // No copy on its menu either. Esc goes back to the list.
    await page.keyboard.press('Escape');
    await row.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /^Copy/ })).toHaveCount(0);
    await menu.getByRole('menuitem', { name: /^Show what was made from it/ }).click();

    // The library, filtered to the source across collections.
    await expect(page.getByRole('button', { name: 'Remove from: Design chat' })).toBeVisible();
    await expect(page.locator('.item-card')).toHaveCount(2);
    await expect(page.locator('.item-card', { hasText: 'Unrelated prompt' })).toHaveCount(0);

    // An entry links back to its source.
    await page.locator('.item-card', { hasText: 'Ground the copy' }).click();
    await detail.getByRole('button', { name: 'From “Design chat”' }).click();
    await expect(sourcePage.getByRole('heading', { name: 'Design chat' })).toBeVisible();

    await page.keyboard.press('Escape');
    // The sort pill names the order. Across the library the source mixes in; inside its collection it leads, whatever the order.
    const sortPill = page.getByRole('button', { name: /^Sort: / }), titles = page.locator('.item-card .item-title');
    await expect(sortPill).toHaveText(/Recently added/);
    await sortPill.click();
    await page.getByRole('menuitem', { name: /^Title A–Z/ }).click();
    await expect(sortPill).toHaveText(/Title A–Z/);
    await expect(titles).toHaveText(['Compare designs side by side', 'Design chat', 'Ground the copy', 'Unrelated prompt']);
    await page.locator('.sidebar .nav-item', { hasText: /^Design/ }).click();
    await expect(sortPill).toHaveText(/Recently added/);
    await expect(titles).toHaveText(['Design chat', 'Compare designs side by side']);
    // Custom order brings the move arrows; an entry cannot be moved above the pinned source.
    await expect(page.getByRole('button', { name: 'Move selected item up' })).toHaveCount(0);
    await sortPill.click();
    await page.getByRole('menuitem', { name: /^Custom order/ }).click();
    await page.locator('.item-card', { hasText: 'Compare designs side by side' }).click({ modifiers: ['Control'] });
    await expect(page.getByRole('button', { name: 'Move selected item up' })).toBeDisabled();
    await expect(titles).toHaveText(['Design chat', 'Compare designs side by side']);
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a video source is a timeline: entries at their minutes, skipped parts shaded, and a transcript that links to each minute', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-video-source-'));
  const library = readyLibrary(root);
  const wb = new Workbench(library, path.join(root, 'private'));
  const url = 'https://www.youtube.com/watch?v=kilnDemo001';
  try {
    const transcript = transcriptMarkdown({ id: 'kilnDemo001', url, title: 'Test like a kid', channel: 'Pixel & Pine', durationSeconds: 1104, uploadDate: '20260612', description: '', chapters: [{ title: 'Why test like a kid', start: 0 }, { title: 'The prompt', start: 252 }], transcript: '[0:00]\nSo this week I tried something.\n[2:05]\nQuick thanks to the sponsor.\n[4:00]\nHere is the prompt, word for word.', language: 'en' });
    const source = wb.create({ title: 'Test like a kid', kind: 'source', content: `${url}\n\nTest like a kid — Pixel & Pine · 18:24`, files: { 'transcript.md': Buffer.from(transcript).toString('base64') }, source: url, tags: ['video', 'youtube'], collection: 'Test like a kid' });
    const entry = (title: string, kind: 'prompt' | 'insight', seconds: number) => wb.createFrom({ id: source.id, revision: source.revision, author: 'Claude Code', item: { title, kind, description: `${title}, explained.`, content: title, source: `${url}&t=${seconds}s`, collection: 'Test like a kid' } });
    entry('Try it as a seven-year-old', 'prompt', 252);
    entry('You stop seeing your own app', 'insight', 665);
    wb.recordAnalysis({ schemaVersion: 1, id: randomUUID(), itemId: source.id, revision: source.revision, provider: 'claude', model: 'claude-test', effort: '', startedAt: '2026-09-24T10:35:00.000Z', finishedAt: '2026-09-24T10:35:40.000Z', summary: 'A developer hands an app to an agent.', takeaway: 'Fix the first obstacle, then run it again.', skipped: 'Sponsor segment (2:05 to 3:10) and the sign-off.', counts: { prompt: 1, insight: 1 }, created: [], collection: 'Test like a kid' });
  } finally { wb.close(); }
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.getByRole('tab', { name: /^Sources/ }).click({ timeout: 15_000 });
    await page.locator('.item-card', { hasText: 'Test like a kid' }).click();
    const sourcePage = page.getByRole('region', { name: 'Source' });
    await expect(sourcePage).toContainText('Source · YouTube');
    await expect(sourcePage.locator('.source-byline')).toHaveText(/^Pixel & Pine\s*·\s*18:24\s*·\s*Published 2026-06-12\s*·\s*Captured /);
    await expect(page.getByRole('button', { name: 'Open original', exact: true })).toBeVisible();
    await expect(sourcePage.getByRole('button', { name: 'Ask about this video' })).toBeVisible();

    const timeline = sourcePage.getByRole('region', { name: 'Timeline' });
    await expect(timeline.locator('.source-marker')).toHaveCount(2);
    await expect(timeline.getByRole('button', { name: '4:12 · Try it as a seven-year-old' })).toBeVisible();
    await expect(timeline.locator('.source-skip')).toHaveAttribute('title', /Sponsor segment · 2:05–3:10/);
    // Entries line up by minute, under the chapter they fall in.
    const made = sourcePage.getByRole('region', { name: 'Made from this source' });
    await expect(made.locator('.source-time')).toHaveText(['4:12', '11:05']);
    await expect(made.locator('.source-group-title').first()).toHaveText('The prompt');
    // Hovering a marker highlights its entry; clicking scrolls to it.
    await timeline.getByRole('button', { name: '11:05 · You stop seeing your own app' }).hover();
    await expect(made.locator('.source-entry.hot')).toContainText('You stop seeing your own app');
    await timeline.getByRole('button', { name: '11:05 · You stop seeing your own app' }).click();
    await expect(made.locator('.source-entry', { hasText: 'You stop seeing your own app' })).toBeInViewport();

    await sourcePage.getByRole('button', { name: 'Show transcript' }).click();
    const transcript = sourcePage.getByRole('complementary', { name: 'Transcript' });
    await expect(transcript.locator('.source-ts')).toHaveText(['0:00', '2:05', '4:00']);
    await expect(transcript.locator('.source-line.skipped')).toContainText('Quick thanks to the sponsor.');
    await expect(transcript.getByRole('button', { name: 'Show Try it as a seven-year-old' })).toBeVisible();
    await page.screenshot({ path: 'test-results/source-video.png' });
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
