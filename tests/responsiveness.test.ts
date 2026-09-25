import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../packages/domain/workbench';
import { DeploymentService } from '../packages/deployment/service';
test('selected-item installation lookup reads one skill, even with several targets',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kiln-scan-'));const wb=new Workbench(path.join(root,'library'),path.join(root,'private'));
  try {
    const items=Array.from({length:5},(_,i)=>wb.create({title:`Skill ${i}`,kind:'skill',content:`---\nname: skill-${i}\ndescription: Fixture\n---\nDo the task.`,files:{}}));
    const target=path.join(root,'target');fs.mkdirSync(target);wb.enroll({schemaVersion:1,name:'Codex',provider:'codex',scope:'project',profile:'default',root:target,environment:'local'});
    const original=wb.getRevision.bind(wb);let reads=0;wb.getRevision=(...args)=>{reads++;return original(...args);};
    new DeploymentService(wb).installations(items[0].id);assert.equal(reads,1);
  } finally {wb.close();}
});
test('copy observations do not invalidate the content index',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kiln-index-'));const wb=new Workbench(path.join(root,'library'),path.join(root,'private'));
  try {const item=wb.create({title:'Example',kind:'prompt',content:'Text',files:{}});wb.snapshot();let refreshes=0;const original=wb.refresh.bind(wb);wb.refresh=()=>{refreshes++;original();};wb.observe({schemaVersion:1,eventId:'copy-test',itemId:item.id,revision:item.revision,kind:'copied',source:'kiln',confidence:'observed',occurredAt:new Date().toISOString()});wb.snapshot();assert.equal(refreshes,0);}finally{wb.close();}
});
