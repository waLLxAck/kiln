import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';
test('collection totals match active rows and quick capture starts with one field', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kiln-counts-'));
  const app=await electron.launch({args:['.'],env:desktopEnv(root)});
  try {
    const page=await app.firstWindow();await expect(page.getByRole('button',{name:'Capture Ctrl N',exact:true})).toBeVisible();
    await page.evaluate(async()=>{const api=(window as any).kiln.call;const item=await api('items.create',{title:'Archived fixture',kind:'prompt',content:'Example',collection:'Installation tests'});await api('items.meta',{id:item.id,expect:item.revision,status:'archived'});});
    await page.getByRole('button',{name:'Refresh library',exact:true}).click();
    const collection=page.getByRole('button',{name:/Installation tests/});await expect(collection.locator('small')).toHaveText('0');await collection.click();await expect(page.locator('.item-card')).toHaveCount(0);
    await page.getByRole('button',{name:'Capture Ctrl N',exact:true}).click();await expect(page.getByRole('dialog').locator('textarea')).toHaveCount(1);await expect(page.getByRole('button',{name:'Analyze and add'})).toBeDisabled();
    await page.getByLabel('Idea',{exact:true}).fill('A short prompt');await expect(page.getByRole('button',{name:'Analyze and add'})).toBeEnabled();
    await page.screenshot({path:'artifacts/quick-capture.png',animations:'disabled'});
  } finally {await app.close();}
});
test('live signed-in Codex: screenshot capture and automatic experiment result', async()=>{
  test.skip(process.env.KILN_AGENT_LIVE!=='1'||!process.env.KILN_CAPTURE_IMAGE,'Explicit live subscription test with KILN_CAPTURE_IMAGE set to a screenshot');test.setTimeout(240000);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kiln-agent-ui-'));
  const app=await electron.launch({...(process.env.KILN_PERFORMANCE_EXE?{executablePath:process.env.KILN_PERFORMANCE_EXE}:{args:['.']}),env:{...process.env,KILN_LIBRARY:path.join(root,'library'),KILN_LOCAL:path.join(root,'private')}});
  try {
    const page=await app.firstWindow();await page.getByRole('button',{name:'Capture Ctrl N',exact:true}).click();
    await page.getByLabel('Idea',{exact:true}).fill('https://x.com/georgepickett/status/2095979879137460640');
    await page.getByLabel('Select files',{exact:true}).setInputFiles(process.env.KILN_CAPTURE_IMAGE!);
    await page.getByRole('button',{name:'Analyze and add'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Takeaway:',{exact:true})).toBeVisible({timeout:180000});
    await page.getByRole('button',{name:'Test',exact:true}).click();await page.getByLabel('Test context').fill('Review only this synthetic example: function sum(xs) { return xs.reduce((a,b) => a+b, 0); }. Explain whether there is anything to delete, or whether it is already simple. Do not inspect or modify any files.');
    await page.getByRole('button',{name:'Run experiment'}).click();
    await expect(page.getByText(/Agent assessment/)).toBeVisible({timeout:180000});
    const data=await page.evaluate(async()=>({snapshot:await (window as any).kiln.call('snapshot'),jobs:await (window as any).kiln.call('agent.jobs')}));
    expect(data.snapshot.trials[0].mode).toBe('codex');expect(data.snapshot.trials[0].status).toBe('completed');expect(data.snapshot.items[0].status).not.toBe('approved');
    fs.writeFileSync('artifacts/agent-capture/live-ui-result.json',JSON.stringify(data,null,2));await page.screenshot({path:'artifacts/agent-capture/live-ui.png',animations:'disabled'});
  }finally{await app.close();}
});

