/**
 * Local preview of the screenshot run for machines without a display: the built renderer in headless Chromium, talking to
 * Kiln's real backend (Router and AgentService) in this process instead of Electron's main process. Paths are Linux paths,
 * so the published images still come from the Windows workflow; this is for checking data and navigation quickly.
 *
 *   npm run build && npx tsx tests/screenshots/preview.ts [output folder]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { environment, machine, prepareMachine, seed } from './seed';
import { takeScreenshots } from './shots';

const out = path.resolve(process.argv[2] ?? 'test-results/screenshots-preview');
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--disable-gpu'] });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-preview-'));
const m = machine(path.join(scratch, 'Users', 'dev'), scratch);
prepareMachine(m);
Object.assign(process.env, environment(m), { KILN_STUB_PACE_MS: process.env.KILN_STUB_PACE_MS ?? '300' });
const { Workbench } = await import('../../packages/domain/workbench');
const { Router } = await import('../../packages/domain/router');
const { AgentService } = await import('../../packages/agent/service');
const wb = new Workbench(m.library, m.local);
const router = new Router(wb, { composer: null });
const agent = new AgentService(wb, () => {}, undefined, undefined, undefined, { node: process.execPath, script: path.resolve('dist', 'cli', 'workbench.cjs') });
let chosenDirectory: string | null = null;
/** The desktop main process's own methods, reduced to what the screenshots need. */
async function backend(method: string, args: any = {}): Promise<unknown> {
  switch (method) {
    case 'desktop.settings': return wb.saveSettings({ ...wb.settings(), ...args });
    case 'desktop.theme': return wb.saveSettings({ ...wb.settings(), ...args });
    case 'desktop.updateCheck': return { current: '0.18.0', source: '', sourceKind: 'none', packaged: true, available: null, stage: { state: 'idle' }, commit: '' };
    case 'desktop.chooseDirectory': return chosenDirectory;
    case 'desktop.trialOutput': { const folder = path.join(wb.local, 'runs', args.id); const read = (name: string) => fs.existsSync(path.join(folder, name)) ? fs.readFileSync(path.join(folder, name), 'utf8') : ''; return { output: read('output.md'), reference: read('output-reference.json'), prompt: read('prompt.md') }; }
    case 'agent.capture': return agent.capture(args);
    case 'agent.start': return agent.start(args);
    case 'agent.chat': return agent.chat(args);
    case 'agent.jobs': return agent.list();
    case 'agent.models': return [];
    case 'agent.cancel': return agent.cancel(args.id);
    case 'trials.delete': return agent.deleteTrial(args);
  }
  if (method.startsWith('desktop.')) return true;
  return router.call(method, args);
}
const call = async <T,>(method: string, args?: unknown) => JSON.parse(JSON.stringify(await backend(method, args) ?? null)) as T;
const ids = await seed(call, m);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', error => console.error('pageerror', error.message));
await page.exposeFunction('__kilnCall', async (method: string, args: unknown) => {
  try { return { ok: true, data: await call(method, args) }; }
  catch (error) { return { ok: false, error: { code: (error as { code?: string }).code ?? 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) } }; }
});
// A string, not a function: tsx would wrap a function in helpers that do not exist in the page.
await page.addInitScript('window.kiln = { call: async (method, args) => { const result = await window.__kilnCall(method, args); if (!result.ok) throw new Error(result.error.code + ": " + result.error.message); return result.data; } };');
const renderer = path.resolve('dist', 'renderer');
await page.route('https://kiln.local/**', route => { const file = path.join(renderer, new URL(route.request().url()).pathname); const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : undefined; return fs.existsSync(file) && fs.statSync(file).isFile() ? route.fulfill({ path: file, contentType: type }) : route.fulfill({ status: 404 }); });
await page.goto('https://kiln.local/index.html');
fs.mkdirSync(out, { recursive: true });
try { await takeScreenshots({ page, ids, m, out, chooseDirectory: folder => { chosenDirectory = folder; }, electron: false }); } catch (error) { await page.screenshot({ path: path.join(out, 'failure.png') }); console.error(error instanceof Error ? error.message.split('\n')[0] : error); }
await browser.close(); wb.close();
console.log(`Screenshots in ${out}; demo machine in ${scratch}`);
process.exit(0);
