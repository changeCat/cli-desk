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
  const outside=fs.mkdtempSync(path.join(root,'outside-')), source=path.join(outside,'参考图.png');fs.writeFileSync(source,'fixture');
  const [attachment]=await service.request('attach',{id:s.id,paths:[source]});assert.equal(attachment.copied,true);assert.equal(attachment.name,'参考图.png');assert.ok(fs.existsSync(path.join(dir,attachment.relativePath)));
  const changed=await service.request('model',{id:s.id,model:'claude-updated-model'});assert.equal(changed.model,'claude-updated-model');
  assert.equal((await service.request('get',s.id)).model,'claude-updated-model');
  await assert.rejects(()=>service.request('__proto__'),/不支持/);
  await assert.rejects(()=>service.request('settings',{cliPath:'',model:'',defaultCwd:'',sendKey:'invalid'}),/发送按键/);
  assert.equal((await service.request('settings',{cliPath:'',model:'',defaultCwd:dir,sendKey:'ctrl-enter'})).sendKey,'ctrl-enter');
  await service.request('draft',{id:s.id,draft:'草稿'});
  assert.equal((await service.request('get',s.id)).draft,'草稿');
  const exported=await service.request('export',s.id);assert.ok(exported.body.includes(dir));
  await service.request('delete',s.id);assert.equal((await service.request('state')).sessions.length,0);
  const archived=await service.request('archives');assert.equal(archived.length,1);assert.equal(archived[0].hasDraft,true);
  await service.request('restore',archived[0].key);assert.equal((await service.request('state')).sessions.length,1);
  await service.request('delete',s.id);const key=(await service.request('archives'))[0].key;await service.request('purge',key);assert.equal((await service.request('archives')).length,0);
  await service.shutdown();
});
test('update check compares the latest GitHub release and returns its download page',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'updates-'));
  const fetcher=async()=>({ok:true,json:async()=>({tag_name:'v1.2.0',html_url:'https://github.com/changeCat/cli-desk/releases/tag/v1.2.0'})});
  const service=createService({root:dir,version:'1.0.2',emit:()=>{},fetcher});
  const result=await service.request('updateCheck');assert.equal(result.available,true);assert.equal(result.version,'1.2.0');assert.match(result.url,/releases\/tag\/v1\.2\.0$/);
  await service.shutdown();
});

test('attachment drafts survive restart and missing files do not prevent saving text',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'draft-files-'));
  const service=createService({root:dir,version:'fixture',smoke:true,emit:()=>{}});
  const s=await service.request('create',dir), file=path.join(dir,'fixture.txt');fs.writeFileSync(file,'fixture');
  const attachments=await service.request('attach',{id:s.id,paths:[file]});
  await service.request('draft',{id:s.id,draft:'附件草稿',attachments});await service.shutdown();
  const reopened=createService({root:dir,version:'fixture',smoke:true,emit:()=>{}});
  assert.deepEqual((await reopened.request('get',s.id)).draftAttachments,attachments);
  assert.equal('draftAttachments' in (await reopened.request('state')).sessions[0],false);
  fs.unlinkSync(file);
  await reopened.request('draft',{id:s.id,draft:'仍能保存的文字',attachments});
  await assert.rejects(()=>reopened.request('send',{id:s.id,prompt:'send',attachments}),/附件不存在/);
  await assert.rejects(()=>reopened.request('draft',{id:s.id,draft:'invalid',attachments:[{name:'fixture',relativePath:'../outside.txt',size:1}]}),/附件必须/);
  assert.equal((await reopened.request('get',s.id)).draft,'仍能保存的文字');
  await reopened.request('draft',{id:s.id,draft:'文字',attachments:[]});
  assert.deepEqual((await reopened.request('get',s.id)).draftAttachments,[]);await reopened.shutdown();
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
