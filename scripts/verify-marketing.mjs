// Checks the marketing homepage in Chromium: no page errors or failed requests, no horizontal overflow, and the key flows
// driven through their keyboard and tap fallbacks with reduced motion emulated (calm end states), then once more with full
// motion (animated tidy-up, flights and pointer drags). It also checks the support page and the links between the pages. Run it
// against `npm run dev:marketing` or a served build, including one served under a base path such as GitHub Pages' /kiln/:
//   MARKETING_URL=http://127.0.0.1:4174 node scripts/verify-marketing.mjs
//   MARKETING_URL=http://127.0.0.1:4175/kiln/ node scripts/verify-marketing.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base = (process.env.MARKETING_URL ?? 'http://127.0.0.1:5174').replace(/\/?$/, '/');
const supportUrl = new URL('support/', base).href;
const repository = 'https://github.com/waLLxAck/kiln';
const installer = `${repository}/releases/download/v0.18.0/Kiln.Setup.0.18.0.exe`;
const kofi = 'https://ko-fi.com/wallxack';
const widths = [320, 390, 768, 1440, 2048];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });

async function open(width, reducedMotion, url = base) {
  const touch = width < 600;
  const context = await browser.newContext({ viewport: { width, height: touch ? 844 : 1000 }, hasTouch: touch, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', request => errors.push(`request failed: ${request.url()}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const label = `${width}px${reducedMotion === 'reduce' ? ', reduced motion' : ''}`;
  return { page, context, errors, touch, label };
}

/** Press a control the way a visitor without a mouse would: keyboard on desktop, a tap on touch screens. */
async function press(run, locator, key = 'Enter') {
  await locator.scrollIntoViewIfNeeded();
  if (run.touch) await locator.tap();
  else { await locator.focus(); await run.page.keyboard.press(key); }
}

async function assertFits({ page, label }, when) {
  const { scroll, viewport } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.ok(scroll <= viewport, `${label}: horizontal overflow ${when} (${scroll}px > ${viewport}px)`);
}

async function checkStatic({ page, label }) {
  assert.match(await page.title(), /^Kiln — /, `${label}: title`);
  assert.equal(await page.locator('meta[name="robots"]').count(), 0, `${label}: robots meta should be gone`);
  assert.ok((await page.locator('meta[name="description"]').getAttribute('content')).length > 80, `${label}: description`);
  assert.equal(await page.locator('h1').count(), 1, `${label}: one h1`);
  for (const id of ['main', 'folders', 'new-skills', 'download']) assert.equal(await page.locator(`#${id}`).count(), 1, `${label}: #${id}`);
  const hrefs = await page.locator('a.download-button').evaluateAll(links => links.map(link => link.href));
  assert.ok(hrefs.length >= 2, `${label}: download buttons`);
  for (const href of hrefs) {
    assert.equal(href, installer, `${label}: download link`);
  }
  assert.match(await page.locator('#download .fine').innerText(), /unsigned.*SmartScreen/s, `${label}: unsigned-build note`);
  assert.doesNotMatch(await page.locator('body').innerText(), /private GitHub repository|account that has access/, `${label}: no private-repository note`);
  assert.ok(await page.locator(`#download a[href="${repository}/releases"]`).count() >= 1, `${label}: link to all releases`);
  assert.ok(await page.locator(`a[href="${kofi}"]`).count() >= 1, `${label}: Ko-fi link`);
  const supportLinks = await page.locator('a[href$="support/"]').evaluateAll(links => links.map(link => link.href));
  assert.ok(supportLinks.length >= 3, `${label}: support page linked from the header, the download section and the footer`);
  for (const href of supportLinks) assert.equal(href, supportUrl, `${label}: support link resolves under the base path`);
  assert.equal(await page.locator('.site-footer').count(), 1, `${label}: footer`);
}

/** The support page: same header and footer, the Ko-fi button, the other ways to help, and working links back to the homepage. */
async function checkSupport(run) {
  const { page, label } = run;
  assert.match(await page.title(), /^Support Kiln — /, `${label}: support title`);
  assert.equal(await page.locator('h1').count(), 1, `${label}: one h1`);
  assert.match(await page.locator('h1').innerText(), /free/);
  const button = page.locator('a.kofi-button');
  assert.equal(await button.count(), 1, `${label}: one Ko-fi button`);
  assert.equal(await button.getAttribute('href'), kofi);
  assert.match(await button.innerText(), /Support Kiln on Ko-fi/);
  assert.ok(await button.isVisible(), `${label}: Ko-fi button visible`);
  assert.equal(await page.locator('.help-list li').count(), 3, `${label}: three other ways to help`);
  assert.equal(await page.locator(`.help-list a[href="${repository}"]`).count(), 1, `${label}: star the repository`);
  assert.equal(await page.locator(`.help-list a[href="${repository}/issues"]`).count(), 1, `${label}: report issues`);
  assert.equal(await page.locator('.site-header [aria-current="page"]').innerText(), 'Support');
  assert.equal(await page.locator('.site-footer').count(), 1, `${label}: footer`);
  assert.equal(await page.locator('a.brand').first().evaluate(link => link.href), base, `${label}: brand links home`);
  const back = page.locator('.site-header a.header-download');
  assert.equal(await back.evaluate(link => link.href), `${base}#download`);
  await press(run, back);
  await page.waitForURL(`${base}#download`);
  await page.locator('#download').waitFor();
  assert.ok(await page.locator('#download').isVisible(), `${label}: the header's Download leads to the homepage download section`);
}

const tidyState = (page, state) => page.locator(`#folders[data-state="${state}"]`);
const library = page => page.locator('[data-panel="library"]');
const landing = page => page.locator('[data-panel="landing"]');
const libraryStatus = page => library(page).locator('[data-status]');
const switchIn = (panel, row, col) => panel.locator(`tr[data-row="${row}"] td[data-col="${col}"] .switch`);

async function checkTidyUp(run) {
  const { page, label } = run;
  const button = page.locator('[data-tidy]');
  // Reduced motion: the folders are already in the panel when the page opens.
  await tidyState(page, 'tidy').waitFor({ timeout: 3000 });
  assert.equal(await library(page).locator('tbody tr.is-in').count(), 5, `${label}: five rows`);
  assert.match(await page.locator('[data-tidy-status]').innerText(), /11 files, 5 rows/);
  assert.equal(await page.locator('.flight-layer > *').count(), 0, `${label}: no flights with reduced motion`);
  assert.ok(await page.locator('[data-note="n-merge"]').evaluate(note => !note.hidden && note.classList.contains('is-on')), `${label}: red-pen note written`);
  await press(run, button);
  await tidyState(page, 'mess').waitFor({ timeout: 2000 });
  assert.equal(await library(page).locator('tbody tr.is-in').count(), 0, `${label}: panel emptied`);
  assert.match(await button.innerText(), /Pop them into Kiln/);
  await press(run, button);
  await tidyState(page, 'tidy').waitFor({ timeout: 2000 });
  assert.equal(await library(page).locator('tbody tr.is-in').count(), 5, `${label}: rows back`);
  await press(run, library(page).locator('[data-cleanup]'));
  assert.match(await libraryStatus(page).innerText(), /Cleaned up 1 broken link and 1 empty folder/);
}

async function checkSwitchAndDiff(run) {
  const { page, label } = run;
  const plain = switchIn(library(page), 'writing-for-agents', 'shared');
  assert.equal(await plain.getAttribute('aria-checked'), 'false');
  await press(run, plain, 'Space');
  assert.equal(await switchIn(library(page), 'writing-for-agents', 'shared').getAttribute('aria-checked'), 'true', `${label}: switch flipped`);
  assert.match(await libraryStatus(page).innerText(), /Installed rev 1 of writing-for-agents into ~\/\.agents\/skills/);

  const flyout = library(page).locator('[data-flyout]');
  const edited = switchIn(library(page), 'code-review', 'project');
  await press(run, edited, 'Space');
  await flyout.waitFor({ state: 'visible' });
  assert.match(await flyout.locator('h3').innerText(), /changed outside Kiln/);
  assert.match(await flyout.locator('.diff-del').innerText(), /Review standards and the specification separately/);
  assert.match(await flyout.locator('.diff-add').innerText(), /Review the specification only\. FINAL\./);
  if (!run.touch) {
    assert.ok(await flyout.evaluate(el => el.contains(document.activeElement)), `${label}: focus moves into the flyout`);
    await page.keyboard.press('Escape');
    await flyout.waitFor({ state: 'hidden' });
    assert.ok(await edited.evaluate(el => el === document.activeElement), `${label}: Escape returns focus to the switch`);
    await page.keyboard.press('Space');
    await flyout.waitFor({ state: 'visible' });
  }
  await press(run, flyout.locator('[data-act="replace"]'));
  await flyout.waitFor({ state: 'hidden' });
  assert.match(await libraryStatus(page).innerText(), /Moved the changed copy to a private backup and installed rev 3/);
  assert.match(await switchIn(library(page), 'code-review', 'project').getAttribute('class'), /switch-on/);
}

async function checkCaptureTestApprove(run) {
  const { page, label } = run;
  const capture = page.locator('[data-zone="capture"]');
  const test = page.locator('[data-zone="test"]');
  await press(run, page.locator('[data-add="yt"]'));
  const star = capture.locator('[data-star]');
  await star.waitFor({ timeout: 5000 });
  assert.equal(await star.locator('h3').innerText(), 'Try it as a seven-year-old', `${label}: prompt captured`);
  assert.match(await capture.locator('.found-note').innerText(), /links to its minute in the video/);
  assert.match(await star.locator('.timestamp').innerText(), /from 04:12/);
  assert.equal(await capture.locator('.cards li').count(), 3);

  await press(run, star.locator('[data-test-it]'));
  const verdict = test.locator('[data-verdict]');
  await verdict.locator('.verdict-unsure').waitFor({ timeout: 10000 });
  assert.match(await verdict.innerText(), /Uncertain/, `${label}: first run is uncertain`);
  assert.match(await test.locator('[data-meter]').innerText(), /k in .* cached .* out/s);
  assert.match(await test.locator('[data-meter]').innerText(), /sample/);
  assert.match(await test.locator('[data-runmeta]').innerText(), /Nothing in ~\/code\/my-game changed/);
  assert.match(await verdict.locator('.prompt-edit .diff-add').innerText(), /demo profile in README\.md/);

  await press(run, verdict.locator('[data-rerun]'));
  await verdict.locator('.verdict-pass').waitFor({ timeout: 10000 });
  assert.match(await verdict.innerText(), /Pass/, `${label}: rerun passes`);
  assert.equal(await page.locator('[data-rev]').innerText(), 'rev 2');
  assert.match(await star.locator('.star-text mark').innerText(), /demo profile/);
  assert.equal(await test.locator('.run-log-sep').count(), 1);

  assert.ok(await landing(page).evaluate(el => el.closest('[data-landing]').hidden), `${label}: landing panel hidden before approval`);
  await press(run, verdict.locator('[data-approve]'));
  await landing(page).waitFor({ state: 'visible' });
  assert.equal(await verdict.locator('[data-approve]').innerText(), 'Approved as fresh-eyes');
  assert.match(await verdict.locator('[data-yours]').innerText(), /Approved rev 2/);
  const row = landing(page).locator('tr[data-row="fresh-eyes"]');
  await row.waitFor();
  assert.deepEqual(await row.locator('.switch').evaluateAll(switches => switches.map(s => s.getAttribute('aria-checked'))), ['false', 'false', 'false', 'false', 'false'], `${label}: new skill not installed yet`);
  assert.equal(await library(page).locator('tr[data-row="fresh-eyes"].is-fresh').count(), 1, `${label}: new row on the library panel too`);
  await press(run, switchIn(landing(page), 'fresh-eyes', 'claude'), 'Space');
  assert.equal(await switchIn(landing(page), 'fresh-eyes', 'claude').getAttribute('aria-checked'), 'true');
  assert.match(await landing(page).locator('[data-status]').innerText(), /Installed rev 2 of fresh-eyes .* A new Claude Code session picks it up/);
  assert.equal(await switchIn(library(page), 'fresh-eyes', 'claude').getAttribute('aria-checked'), 'true', `${label}: both panels agree`);
}

/** Full motion: the tidy-up animates once the panel is in view, sources fly and can be dragged, the skill name flies into its row. */
async function checkMotion(run) {
  const { page, label } = run;
  assert.equal(await page.locator('#folders').getAttribute('data-state'), 'mess', `${label}: waits for the visitor before tidying`);
  await page.locator('[data-folders-window]').scrollIntoViewIfNeeded();
  await tidyState(page, 'tidying').waitFor({ timeout: 8000 });
  await page.locator('.flight-layer > .flyer').first().waitFor({ state: 'attached', timeout: 2000 }); // files fly into the panel
  await tidyState(page, 'tidy').waitFor({ timeout: 12000 });
  await page.locator('[data-note="n-merge"].is-on').waitFor({ timeout: 8000 });
  assert.equal(await library(page).locator('tbody tr.is-in').count(), 5);

  const capture = page.locator('[data-zone="capture"]');
  const test = page.locator('[data-zone="test"]');
  if (run.touch) {
    await press(run, page.locator('[data-add="yt"]'));
    await page.locator('.drag-ghost').waitFor({ state: 'attached', timeout: 2000 });
  } else await drag(page, page.locator('[data-drag="yt"]'), capture);
  await capture.locator('.analysing').waitFor({ timeout: 3000 });
  const star = capture.locator('[data-star]');
  await star.waitFor({ timeout: 6000 });
  if (run.touch) await press(run, star.locator('[data-test-it]'));
  else await drag(page, star, test);
  await test.locator('.run-state.is-running').waitFor({ timeout: 3000 });
  await test.locator('.verdict-unsure').waitFor({ timeout: 15000 });
  await press(run, test.locator('[data-rerun]'));
  await test.locator('.verdict-pass').waitFor({ timeout: 15000 });
  await press(run, test.locator('[data-approve]'));
  await page.locator('.skill-chip').waitFor({ state: 'attached', timeout: 4000 });
  await page.locator('.skill-chip').waitFor({ state: 'detached', timeout: 6000 });
  await landing(page).locator('tr[data-row="fresh-eyes"]').waitFor();
}

async function drag(page, from, zone) {
  await from.scrollIntoViewIfNeeded();
  const start = await from.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + Math.min(40, start.height / 2));
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 20, start.y + 60, { steps: 4 });
  assert.equal(await page.locator('.drag-ghost').count(), 1, 'dragging lifts a ghost');
  const end = await zone.boundingBox();
  await page.mouse.move(end.x + end.width / 2, end.y + Math.min(end.height / 2, 200), { steps: 12 });
  assert.ok(await zone.evaluate(el => el.classList.contains('is-over')), 'the drop zone lights up');
  await page.mouse.up();
}

try {
  for (const width of widths) {
    const run = await open(width, 'reduce');
    await assertFits(run, 'on load');
    await checkStatic(run);
    await checkTidyUp(run);
    await checkSwitchAndDiff(run);
    await checkCaptureTestApprove(run);
    await assertFits(run, 'after the flows');
    assert.deepEqual(run.errors, [], `${run.label}: page errors`);
    await run.context.close();
    console.log(`ok  ${run.label}`);
  }
  for (const width of [320, 390, 1440]) {
    const run = await open(width, 'reduce', supportUrl);
    await assertFits(run, 'on the support page');
    await checkSupport(run);
    assert.deepEqual(run.errors, [], `${run.label}: support page errors`);
    await run.context.close();
    console.log(`ok  ${run.label}, support page`);
  }
  for (const width of [390, 1440]) {
    const run = await open(width, 'no-preference');
    await checkMotion(run);
    await assertFits(run, 'after the animated flows');
    assert.deepEqual(run.errors, [], `${run.label}: page errors`);
    await run.context.close();
    console.log(`ok  ${run.label}, full motion`);
  }
} finally {
  await browser.close();
}
console.log(`Marketing site verified at ${base}`);
