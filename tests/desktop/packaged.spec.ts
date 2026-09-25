import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('packaged Windows app opens the selected migrated library', async () => {
  test.skip(!process.env.KILN_PACKAGED_EXE, 'Explicit packaged executable required.');
  test.setTimeout(120_000);
  const evidence = path.resolve('artifacts/skills-migration');
  const app = await electron.launch({ executablePath: process.env.KILN_PACKAGED_EXE!, env: { ...process.env, KILN_DESKTOP_DATA: path.join(evidence, 'packaged-profile') } });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.getByRole('tab', { name: /^Skills/ }).click();
    await expect(page.locator('.item-card')).toHaveCount(217);
    await page.getByRole('button', { name: /build-knowledge-system/ }).first().click();
    await expect(page.getByRole('heading', { name: 'build-knowledge-system', exact: true })).toBeVisible();
    const state = await page.evaluate(async () => await (window as any).kiln.call('snapshot', {}));
    if (process.env.KILN_PACKAGED_LIBRARY) expect(state.root.replaceAll('\\', '/')).toBe(process.env.KILN_PACKAGED_LIBRARY.replaceAll('\\', '/'));
    expect(state.targets.map((t: any) => t.provider).sort()).toEqual(['claude', 'codex']);
    expect(errors).toEqual([]);
    await page.screenshot({ path: path.join(evidence, 'packaged-library.png') });
    fs.writeFileSync(path.join(evidence, 'packaged-result.json'), JSON.stringify({ executable: process.env.KILN_PACKAGED_EXE, root: state.root, activeSkills: 217, enrolledAgents: ['codex', 'claude'], rendererErrors: errors, verifiedAt: new Date().toISOString() }, null, 2));
  } finally { await app.close(); }
});
