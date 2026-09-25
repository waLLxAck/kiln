import { defineConfig } from '@playwright/test';
// Screenshots for the README and website, run by .github/workflows/screenshots.yml. Kept apart from `npm run test:desktop`.
export default defineConfig({ testDir: '.', testMatch: 'app.spec.ts', timeout: 15 * 60_000, expect: { timeout: 20_000 }, workers: 1, reporter: 'list', outputDir: '../../test-results/screenshots-run', use: { trace: 'retain-on-failure' } });
