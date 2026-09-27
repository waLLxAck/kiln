/**
 * Local preview of the screenshot run for machines without a display: the built renderer in headless Chromium, talking to
 * Kiln's real backend (Router and AgentService) in this process instead of Electron's main process. Paths are Linux paths,
 * so the published images still come from the Windows workflow; this is for checking data and navigation quickly.
 *
 *   npm run build && npx tsx tests/screenshots/preview.ts [output folder]
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDemoApp } from './harness';
import { takeScreenshots } from './shots';

const out = path.resolve(process.argv[2] ?? 'test-results/screenshots-preview');
const app = await openDemoApp();
fs.mkdirSync(out, { recursive: true });
try { await takeScreenshots({ page: app.page, ids: app.ids, m: app.m, out, chooseDirectory: folder => app.chooseDirectory(folder), electron: false }); } catch (error) { await app.page.screenshot({ path: path.join(out, 'failure.png') }); console.error(error instanceof Error ? error.message.split('\n')[0] : error); }
await app.close();
console.log(`Screenshots in ${out}; demo machine in ${app.scratch}`);
process.exit(0);
