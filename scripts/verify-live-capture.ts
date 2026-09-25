import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../packages/domain/workbench';
import { AgentService } from '../packages/agent/service';
// A screenshot to capture alongside the link, e.g. KILN_CAPTURE_IMAGE=post.png npx tsx scripts/verify-live-capture.ts
const image=process.env.KILN_CAPTURE_IMAGE; if(!image) throw new Error('Set KILN_CAPTURE_IMAGE to a screenshot to capture.');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kiln-live-capture-'));
const wb=new Workbench(path.join(root,'library'),path.join(root,'private'));
const service=new AgentService(wb,(event,fields)=>console.log(event,JSON.stringify(fields)));
const result=service.capture({ text:'https://x.com/georgepickett/status/2095979879137460640',files:{'source.png':fs.readFileSync(image).toString('base64')} });
while(service.running) await new Promise(resolve=>setTimeout(resolve,1000));
const job=service.list()[0];
fs.mkdirSync('artifacts/agent-capture',{recursive:true});fs.writeFileSync('artifacts/agent-capture/live-result.json',JSON.stringify({root,item:wb.getItem(result.item.id),job},null,2));
console.log(JSON.stringify(job,null,2)); wb.close(); if(job.status!=='completed')process.exitCode=1;
