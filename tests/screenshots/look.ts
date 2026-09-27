/**
 * Opens the seeded demo app in headless Chromium and saves one screenshot, for a quick look at the UI without a display.
 *
 *   npm run build && npx tsx tests/screenshots/look.ts [out.png]
 */
import { openDemoApp } from './harness';
const app = await openDemoApp();
await app.page.getByRole('main').waitFor({ timeout: 60_000 });
await app.page.waitForTimeout(1500);
await app.page.screenshot({ path: process.argv[2] ?? 'test-results/look.png' });
await app.close();
process.exit(0);
