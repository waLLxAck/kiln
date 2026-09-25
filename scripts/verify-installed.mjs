import {_electron as electron} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const app=await electron.launch({executablePath:path.join(process.env.LOCALAPPDATA,'Programs/Kiln/Kiln.exe')});
try {
  const page=await app.firstWindow();
  await page.getByRole('button',{name:'Toggle theme'}).waitFor();
  const version=await app.evaluate(({app})=>app.getVersion());
  assert.equal(version,'0.5.0');
  const snapshot=await page.evaluate(()=>window.kiln.call('snapshot'));
  const item=snapshot.items.find(i=>i.source==='https://x.com/georgepickett/status/2095979879137460640');
  assert.ok(item); assert.equal(item.collection,'To test');
  await page.getByRole('button',{name:/^To test/}).click();
  await page.evaluate(id => { localStorage.setItem('kiln-selected', id); localStorage.setItem('kiln-section', 'library'); }, item.id);
  await page.reload();
  await page.getByText('Next test:',{exact:true}).waitFor();
  const start=Date.now();
  const plan=await page.evaluate(()=>window.kiln.call('repository.migrationPlan'));
  const previewMs=Date.now()-start;
  assert.equal(plan.count,217); assert.equal(plan.unchanged,217); assert.equal(plan.pending,0);
  await page.screenshot({path:'artifacts/installed-0.5.0-example.png',animations:'disabled'});
  const result={version,sourceSkills:plan.count,alreadyImported:plan.unchanged,pending:plan.pending,previewMs,savedExample:{id:item.id,title:item.title,collection:item.collection}};
  fs.writeFileSync('artifacts/installed-0.5.0-check.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally { await app.close(); }
