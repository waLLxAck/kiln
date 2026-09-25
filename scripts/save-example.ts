import fs from 'node:fs';import path from 'node:path';
import { Workbench } from '../packages/domain/workbench';import { AgentService } from '../packages/agent/service';import { defaultLibrary,privateRoot } from '../packages/storage/config';
// A screenshot to capture alongside the link, e.g. KILN_CAPTURE_IMAGE=post.png npx tsx scripts/save-example.ts
const image=process.env.KILN_CAPTURE_IMAGE; if(!image) throw new Error('Set KILN_CAPTURE_IMAGE to a screenshot to capture.');
const wb=new Workbench(defaultLibrary(),privateRoot());const url='https://x.com/georgepickett/status/2095979879137460640';
const existing=wb.listItems().find(item=>item.source===url);
if(existing){console.log(JSON.stringify({existing:true,id:existing.id,title:existing.title}));wb.close();}else{
 const service=new AgentService(wb,(event,fields)=>{if(event!=='agent.progress')console.log(event,JSON.stringify(fields));});
 const saved=service.capture({text:url,files:{'source.png':fs.readFileSync(image).toString('base64')}});
 while(service.running)await new Promise(resolve=>setTimeout(resolve,1000));
 const item=wb.getItem(saved.item.id),job=service.list().find(j=>j.itemId===item.id);fs.writeFileSync('artifacts/agent-capture/saved-example.json',JSON.stringify({item,job},null,2));console.log(JSON.stringify({id:item.id,title:item.title,collection:item.collection,status:job?.status}));wb.close();if(job?.status!=='completed')process.exitCode=1;
}
