import {_electron as electron} from 'playwright';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kiln-release-check-'));
const executable=path.resolve('release/0.5.0/win-unpacked/Kiln.exe');
const app=await electron.launch({executablePath:executable,env:{...process.env,KILN_LIBRARY:path.join(root,'library'),KILN_LOCAL:path.join(root,'private')}});
try{
 const page=await app.firstWindow();await page.getByRole('button',{name:'Toggle theme'}).waitFor();const start=Date.now();await page.getByRole('button',{name:'Toggle theme'}).click();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');const themeMs=Date.now()-start;
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.nav-item.active')).backgroundColor==='rgba(143, 174, 255, 0.12)',null,{timeout:5000});
 const colors=await page.evaluate(()=>({nav:getComputedStyle(document.querySelector('.nav-item.active')).backgroundColor,logo:getComputedStyle(document.querySelector('.brand-symbol')).backgroundColor}));assert.equal(colors.nav,'rgba(143, 174, 255, 0.12)');assert.equal(colors.logo,'rgb(23, 23, 29)');
 const providers=await page.evaluate(()=>(window).kiln.call('providers.detect'));assert.equal(providers.find(p=>p.id==='codex').available,true);
 const version=await app.evaluate(({app})=>app.getVersion());assert.equal(version,'0.5.0');await page.screenshot({path:'artifacts/release-0.5.0.png',animations:'disabled'});fs.writeFileSync('artifacts/release-0.5.0-check.json',JSON.stringify({version,themeMs,colors,codexDetected:true},null,2));console.log(JSON.stringify({version,themeMs,colors,codexDetected:true}));
}finally{await app.close();}
