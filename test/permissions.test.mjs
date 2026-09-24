import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/providers/claude-engine.mjs';
import {createService} from '../src/backend/service.mjs';

function fixture(){const dir=fs.mkdtempSync(path.resolve('test-artifacts/permissions-'));return {dir,store:new Store(dir)};}
test('permission selection validates modes and explicit bypass confirmation; choices are conversation-scoped',async()=>{
  const {dir}=fixture(), service=createService({root:dir,version:'fixture',smoke:true,emit:()=>{}});
  const a=await service.request('create',dir), b=await service.request('create',dir);
  try {
    for(const mode of ['invalid','__proto__',{},null])await assert.rejects(()=>service.request('permission',{id:a.id,mode}),/无效/);
    for(const confirmed of [undefined,false,'true'])await assert.rejects(()=>service.request('permission',{id:a.id,mode:'bypassPermissions',confirmed}),/明确确认/);
    assert.equal(a.permissionMode,undefined);
    await service.request('permission',{id:a.id,mode:'auto'});
    assert.equal(new Store(dir).get(a.id).permissionMode,'auto');assert.equal(b.permissionMode,undefined);
    await service.request('permission',{id:a.id,mode:'bypassPermissions',confirmed:true});
    assert.equal(new Store(dir).get(a.id).permissionMode,'bypassPermissions');
    await service.request('send',{id:a.id,prompt:'[fixture:quiet]'});
    await assert.rejects(()=>service.request('permission',{id:a.id,mode:'default'}),/任务结束/);
  }finally{await service.shutdown();}
});
test('SDK options only enable bypass for the explicitly selected mode and always retain settings and user questions',async()=>{
  const {dir,store}=fixture(), captured=[];
  const query=({options})=>{
    captured.push(options);
    const it=(async function*(){yield {type:'system',subtype:'init',permissionMode:options.permissionMode};
      await options.canUseTool('AskUserQuestion',{questions:[{question:'fixture?'}]},{signal:options.abortController.signal});
      yield {type:'result',subtype:'success',is_error:false};})();it.close=()=>{};return it;
  };
  const engine=new Engine(store,query,()=>{},()=> 'fixture');
  try {
    for(const mode of [undefined,'default','auto','bypassPermissions']) {
      const s=store.create(dir);if(mode)s.permissionMode=mode;
      engine.start(s.id,'fixture mode');const run=engine.runs.get(s.id);
      for(let i=0;i<100&&!engine.pending().length;i++)await new Promise(r=>setTimeout(r,10));
      assert.equal(engine.pending().length,1);assert.equal(s.activePermissionMode,mode || 'default');
      engine.answer(engine.pending()[0].id,true,{'fixture?':'yes'});await run.done;
      const options=captured.at(-1);assert.equal(options.permissionMode,mode || 'default');
      assert.equal(options.allowDangerouslySkipPermissions,mode==='bypassPermissions'?true:undefined);
      assert.deepEqual(options.settingSources,['user','project','local']);
    }
  }finally{await engine.shutdown();}
});
test('CLI mode downgrade is surfaced and invalid stored modes never start a query',async()=>{
  const {dir,store}=fixture(), s=store.create(dir);s.permissionMode='auto';
  const query=()=>{const it=(async function*(){yield {type:'system',subtype:'init',permissionMode:'default'};yield {type:'result',subtype:'success',is_error:false};})();it.close=()=>{};return it;};
  const engine=new Engine(store,query,()=>{},()=> 'fixture');engine.start(s.id,'fixture downgrade');await engine.runs.get(s.id).done;
  assert.equal(s.permissionMode,'auto');assert.equal(s.activePermissionMode,'default');assert.match(s.messages.at(-1).text,/与所选/);
  s.permissionMode='unknown';const before=s.messages.length;assert.throws(()=>engine.start(s.id,'fixture invalid'),/无效/);assert.equal(s.messages.length,before);assert.equal(engine.runs.size,0);
});
