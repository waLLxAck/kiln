// Checks the marketing homepage in Chromium: no page errors or failed requests, no horizontal overflow, and the key flows
// driven through their keyboard and tap fallbacks with reduced motion emulated (calm end states), then once more with full
// motion (animated tidy-up, flights and pointer drags). It also checks the support page, the links between the pages, and that the
// download button offers the right file for spoofed Windows, macOS, Linux and phone user agents. Run it
// against `npm run dev:marketing` or a served build, including one served under a base path such as GitHub Pages' /kiln/:
//   MARKETING_URL=http://127.0.0.1:4174 node scripts/verify-marketing.mjs
//   MARKETING_URL=http://127.0.0.1:4175/kiln/ node scripts/verify-marketing.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base = (process.env.MARKETING_URL ?? 'http://127.0.0.1:5174').replace(/\/?$/, '/');
const supportUrl = new URL('support/', base).href;
const repository = 'https://github.com/waLLxAck/kiln';
const version = '0.18.2';
const assets = `${repository}/releases/download/v${version}`;
/** Every file the site offers, by the key the page uses in data-download. */
const files = {
  windows: `${assets}/Kiln.Setup.${version}.exe`,
  'mac-arm64': `${assets}/Kiln-${version}-arm64.dmg`,
  'mac-x64': `${assets}/Kiln-${version}-x64.dmg`,
  appimage: `${assets}/Kiln-${version}-x86_64.AppImage`,
  deb: `${assets}/kiln_${version}_amd64.deb`,
};
const agents = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  phone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
};
/** The file the page should offer for a user agent, mirroring detectOs in apps/marketing/src/content.ts. */
const expectedFor = userAgent => /iPhone|iPad|iPod|Android/i.test(userAgent) ? 'windows' : /Windows/i.test(userAgent) ? 'windows' : /Macintosh|Mac OS X/i.test(userAgent) ? 'mac-arm64' : /Linux|X11|CrOS/i.test(userAgent) ? 'appimage' : 'windows';
const osOf = key => key === 'windows' ? 'windows' : key.startsWith('mac') ? 'mac' : 'linux';
const kofi = 'https://ko-fi.com/wallxack';
const widths = [320, 390, 768, 1440, 2048];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });

async function open(width, reducedMotion, url = base, { userAgent, userAgentData } = {}) {
  const touch = width < 600;
  const context = await browser.newContext({ viewport: { width, height: touch ? 844 : 1000 }, hasTouch: touch, reducedMotion, ...(userAgent ? { userAgent } : {}) });
  // Stand in for the browser's userAgentData: `null` removes it (Safari, Firefox); an object reports that platform and chip.
  if (userAgentData !== undefined) await context.addInitScript(data => Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => data && { platform: data.platform, getHighEntropyValues: async () => ({ architecture: data.architecture }) } }), userAgentData);
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

async function checkStatic(run) {
  const { page, label } = run;
  assert.match(await page.title(), /^Kiln — /, `${label}: title`);
  assert.equal(await page.locator('meta[name="robots"]').count(), 0, `${label}: robots meta should be gone`);
  assert.ok((await page.locator('meta[name="description"]').getAttribute('content')).length > 80, `${label}: description`);
  assert.equal(await page.locator('h1').count(), 1, `${label}: one h1`);
  for (const id of ['main', 'folders', 'new-skills', 'download']) assert.equal(await page.locator(`#${id}`).count(), 1, `${label}: #${id}`);
  await checkDownload(run, expectedFor(await page.evaluate(() => navigator.userAgent)));
  const body = await page.locator('body').innerText();
  assert.match(body, /desktop app for Windows, macOS and Linux/, `${label}: names all three platforms`);
  assert.doesNotMatch(body, /a Windows app/, `${label}: no longer called a Windows app`);
  // Every platform's file is offered in the download section, once, as the button or one of the other links.
  const offered = await page.locator('#download a[data-download], #download a[data-download-other]').evaluateAll(links => links.map(link => link.href));
  assert.deepEqual([...offered].sort(), Object.values(files).sort(), `${label}: one link per platform file`);
  const note = os => page.locator(`#download [data-install-note="${os}"]`).innerText();
  assert.match(await note('windows'), /unsigned.*SmartScreen.*More info.*Run anyway/s, `${label}: Windows SmartScreen note`);
  assert.match(await note('mac'), /not notarized|isn’t notarized/, `${label}: macOS notarization note`);
  assert.match(await note('mac'), /right-click.*Open/s, `${label}: macOS right-click Open`);
  assert.match(await note('mac'), /xattr -dr com\.apple\.quarantine \/Applications\/Kiln\.app/, `${label}: macOS quarantine command`);
  assert.match(await note('linux'), new RegExp(`chmod \\+x Kiln-${version}-x86_64\\.AppImage`), `${label}: AppImage chmod`);
  assert.match(await note('linux'), new RegExp(`sudo apt install \\./kiln_${version}_amd64\\.deb`), `${label}: deb install`);
  assert.match(await note('linux'), /--no-sandbox/, `${label}: Linux sandbox note`);
  for (const os of ['mac', 'linux']) assert.match(await note(os), /untested/, `${label}: ${os} build marked untested`);
  assert.doesNotMatch(await page.locator('body').innerText(), /private GitHub repository|account that has access/, `${label}: no private-repository note`);
  assert.ok(await page.locator(`#download a[href="${repository}/releases"]`).count() >= 1, `${label}: link to all releases`);
  assert.ok(await page.locator(`a[href="${kofi}"]`).count() >= 1, `${label}: Ko-fi link`);
  const supportLinks = await page.locator('a[href$="support/"]').evaluateAll(links => links.map(link => link.href));
  assert.ok(supportLinks.length >= 2, `${label}: support page linked from the download section and the footer`);
  assert.equal(await page.locator('.site-header a.header-sponsor').getAttribute('href'), kofi, `${label}: header sponsor button`);
  assert.equal(await page.locator('.hero-sponsor a').getAttribute('href'), kofi, `${label}: hero sponsor link`);
  for (const href of supportLinks) assert.equal(href, supportUrl, `${label}: support link resolves under the base path`);
  assert.equal(await page.locator('.site-footer').count(), 1, `${label}: footer`);
}

/** The hero and closing buttons and the footer link offer `key`; the other files are listed beside it and this platform's notes come first. */
async function checkDownload({ page, label }, key) {
  const buttons = await page.locator('a.download-button').evaluateAll(links => links.map(link => ({ href: link.href, key: link.dataset.download, text: link.innerText })));
  assert.equal(buttons.length, 2, `${label}: hero and closing download buttons`);
  const name = { windows: 'Windows', mac: 'macOS', linux: 'Linux' }[osOf(key)];
  for (const button of buttons) {
    assert.equal(button.href, files[key], `${label}: download button offers ${key}`);
    assert.equal(button.key, key, `${label}: download button key`);
    assert.match(button.text, new RegExp(`for ${name}$`), `${label}: download button names ${name}`);
  }
  assert.match(await page.locator('#download [data-download-file]').innerText(), new RegExp(files[key].split('/').pop().replaceAll('.', '\\.')), `${label}: file name under the button`);
  const others = await page.locator('#download a[data-download-other]').evaluateAll(links => links.map(link => link.href));
  assert.deepEqual([...others].sort(), Object.entries(files).filter(([k]) => k !== key).map(([, url]) => url).sort(), `${label}: other platforms beside the button`);
  assert.equal(await page.locator('#download [data-install-note]').first().getAttribute('data-install-note'), osOf(key), `${label}: ${name} notes first`);
  assert.equal(await page.locator('.site-footer a[data-download]').getAttribute('href'), files[key], `${label}: footer download link`);
}

/** The download button follows the visitor's platform: spoofed user agents, with and without the browser saying which Mac chip it has. */
async function checkPlatforms() {
  const cases = [
    ['Windows', { userAgent: agents.windows }, 'windows'],
    ['macOS, chip unknown', { userAgent: agents.mac, userAgentData: null }, 'mac-arm64'],
    ['macOS, Apple silicon', { userAgent: agents.mac, userAgentData: { platform: 'macOS', architecture: 'arm' } }, 'mac-arm64'],
    ['macOS, Intel', { userAgent: agents.mac, userAgentData: { platform: 'macOS', architecture: 'x86' } }, 'mac-x64'],
    ['Linux', { userAgent: agents.linux, userAgentData: null }, 'appimage'],
    ['phone', { userAgent: agents.phone, userAgentData: null }, 'windows'],
  ];
  for (const [name, spoof, key] of cases) {
    const run = await open(1440, 'reduce', base, spoof);
    run.label = `${name} user agent`;
    // The Intel switch happens once the browser answers; wait for it rather than racing it.
    if (key === 'mac-x64') await run.page.locator('a.download-button[data-download="mac-x64"]').first().waitFor({ state: 'attached', timeout: 3000 });
    await checkDownload(run, key);
    assert.deepEqual(run.errors, [], `${run.label}: page errors`);
    await run.context.close();
    const support = await open(390, 'reduce', supportUrl, spoof);
    if (key === 'mac-x64') await support.page.locator('.site-footer a[data-download="mac-x64"]').waitFor({ state: 'attached', timeout: 3000 });
    assert.equal(await support.page.locator('.site-footer a[data-download]').getAttribute('href'), files[key], `${name} user agent: support page footer download`);
    await support.context.close();
    console.log(`ok  ${name} user agent offers ${files[key].split('/').pop()}`);
  }
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
  assert.equal(await page.locator('.site-header a.header-sponsor').getAttribute('href'), kofi, `${label}: header sponsor button`);
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
  await checkPlatforms();
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
