import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {once} from 'node:events';
import {createService} from '../src/backend/service.mjs';
const root=path.resolve('test-artifacts');fs.mkdirSync(root,{recursive:true});
test('backend allowlist, settings validation and isolation',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'backend-'));
  const service=createService({root:dir,version:'fixture',smoke:true,emit:()=>{}});
  const s=await service.request('create',{cwd:dir,model:'claude-test-model'});assert.equal(s.model,'claude-test-model');
  const changed=await service.request('model',{id:s.id,model:'claude-updated-model'});assert.equal(changed.model,'claude-updated-model');
  assert.equal((await service.request('get',s.id)).model,'claude-updated-model');
  await assert.rejects(()=>service.request('__proto__'),/不支持/);
  await assert.rejects(()=>service.request('settings',{cliPath:'',model:'',defaultCwd:'',sendKey:'invalid'}),/发送按键/);
  await service.request('settings',{cliPath:'',model:'',defaultCwd:dir,sendKey:'enter'});
  await service.request('draft',{id:s.id,draft:'草稿'});
  assert.equal((await service.request('get',s.id)).draft,'草稿');
  const exported=await service.request('export',s.id);assert.ok(exported.body.includes(dir));
  await service.request('delete',s.id);assert.equal((await service.request('state')).sessions.length,0);
  const archived=await service.request('archives');assert.equal(archived.length,1);assert.equal(archived[0].hasDraft,true);
  await service.request('restore',archived[0].key);assert.equal((await service.request('state')).sessions.length,1);
  await service.request('delete',s.id);const key=(await service.request('archives'))[0].key;await service.request('purge',key);assert.equal((await service.request('archives')).length,0);
  await service.shutdown();
});
test('private stdio carries requests/events and closes active work on parent EOF', {timeout:15000},async()=>{
  const dir=fs.mkdtempSync(path.join(root,'stdio-'));
  const child=spawn(process.execPath,['src/backend/worker.mjs',dir,'fixture','--fixture'],{stdio:['pipe','pipe','pipe']});
  const pending=new Map(),events=[];let next=1;
  readline.createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.event)events.push(m.event);else{const p=pending.get(m.id);if(p){pending.delete(m.id);m.ok?p.resolve(m.data):p.reject(new Error(m.error));}}});
  const request=(method,payload)=>new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,payload})+'\n');});
  try {
    const s=await request('create',dir);await request('send',{id:s.id,prompt:'stdio fixture'});
    for(let i=0;i<150&&!events.some(e=>e.type==='approvals'&&e.data.length);i++)await new Promise(r=>setTimeout(r,20));
    assert.ok(events.some(e=>e.type==='approvals'&&e.data.length));
    const exit=once(child,'exit');child.stdin.end();await exit;
    const stored=JSON.parse(fs.readFileSync(path.join(dir,'sessions',s.id+'.json')));
    assert.equal(stored.status,'interrupted');assert.ok(stored.messages.some(m=>m.role==='assistant'));
  }finally{child.kill();}
});
