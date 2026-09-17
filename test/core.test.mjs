import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Engine } from '../src/providers/claude-engine.mjs';
import { fakeQuery } from '../src/mock.mjs';
import { resolveCli } from '../src/platform/cli-runtime.mjs';
const root = path.resolve('test-artifacts'); fs.mkdirSync(root,{recursive:true});
function fixture() { const dir = fs.mkdtempSync(path.join(root,'core-')); return {dir,store:new Store(dir)}; }
async function until(fn) { for(let i=0;i<200;i++) { if(fn()) return; await new Promise(r=>setTimeout(r,10)); } throw new Error('等待超时'); }
test('persist Unicode, sessions, drafts and recover an interrupted run', () => {
  const {dir,store} = fixture(); const s=store.create(dir); s.title='你好 世界'; s.draft='草稿'; s.providerSessionId='real-id'; s.status='running'; store.save(s);
  const fresh=new Store(dir); const restored=fresh.get(s.id); assert.equal(restored.title,'你好 世界'); assert.equal(restored.draft,'草稿'); assert.equal(restored.providerSessionId,'real-id'); assert.equal(restored.status,'interrupted');
});
test('recover damaged JSON from backup without discarding evidence', () => {
  const {dir,store}=fixture(); const s=store.create(dir); s.title='saved'; store.save(s); s.title='last'; store.save(s); fs.writeFileSync(store.file(s.id),'{broken');
  const fresh=new Store(dir); assert.equal(fresh.get(s.id).title,'saved'); assert.ok(fresh.warnings.length); assert.ok(fs.readdirSync(path.join(dir,'sessions')).some(n=>n.includes('.corrupt-')));
});
test('local archives can be listed, restored and permanently deleted', () => {
  const {dir,store}=fixture(); assert.throws(()=>store.file('../../escape')); const s=store.create(dir); s.title='可恢复对话'; s.draft='保留草稿'; s.messages.push({id:'m1',role:'user',text:'内容',at:Date.now()}); store.save(s);
  s.status='running'; assert.throws(()=>store.remove(s.id),/停止任务/); s.status='idle'; store.save(s);
  store.remove(s.id); assert.equal(store.list().length,0);
  const archived=store.archives(); assert.equal(archived.length,1); assert.equal(archived[0].title,'可恢复对话'); assert.equal(archived[0].messageCount,1); assert.equal(archived[0].hasDraft,true);
  const restored=store.restore(archived[0].key); assert.equal(restored.draft,'保留草稿'); assert.equal(store.list().length,1); assert.equal(store.archives().length,0);
  store.remove(restored.id); const key=store.archives()[0].key; assert.equal(store.purge(key),true); assert.equal(store.archives().length,0); assert.throws(()=>store.restore('../../escape'),/无效/);
});
test('legacy trash records remain visible and restorable', () => {
  const {dir,store}=fixture(), s=store.create(dir); s.title='旧版记录'; store.save(s);
  const trash=path.join(dir,'trash'); fs.mkdirSync(trash); const name=`${s.id}-1700000000000.json`; fs.renameSync(store.file(s.id),path.join(trash,name)); store.sessions.delete(s.id);
  const archived=store.archives(); assert.equal(archived.length,1); assert.equal(archived[0].key,`trash:${name}`); assert.equal(store.restore(archived[0].key).title,'旧版记录'); assert.equal(store.archives().length,0);
});
test('tool denial, session resume and streamed text persistence', async () => {
  const {dir,store}=fixture(); const s=store.create(dir,'sonnet'); const options=[];
  const engine=new Engine(store, p=>{options.push(p.options);return fakeQuery(p)},()=>{},()=> 'fixture');
  engine.start(s.id,'你好'); assert.throws(()=>engine.start(s.id,'重复'));
  await until(()=>engine.pending().length); assert.equal(s.status,'waiting'); engine.answer(engine.pending()[0].id,false); await until(()=>!engine.runs.size);
  assert.equal(s.status,'idle'); assert.ok(s.messages.some(m=>m.text.includes('已拒绝'))); assert.ok(s.providerSessionId);
  assert.equal(options[0].model, 'sonnet'); store.saveSettings({...store.settings, model:'opus'});
  engine.start(s.id,'继续'); await until(()=>engine.pending().length); engine.answer(engine.pending()[0].id,true); await until(()=>!engine.runs.size);
  assert.equal(options[1].resume,s.providerSessionId); assert.equal(options[1].permissionMode,'default'); assert.deepEqual(options[1].settingSources,['user','project','local']);
  assert.equal(options[1].model, 'sonnet'); assert.equal(options[0].model, 'sonnet');
  const restored=new Store(dir); assert.equal(restored.get(s.id).messages.filter(m=>m.role==='user').length,2);
});

test('global model and send shortcut persist across restart', () => {
  const {dir,store} = fixture(); assert.equal(store.settings.sendKey, 'enter');
  store.saveSettings({...store.settings, model:'sonnet', sendKey:'shift-enter'});
  const fresh = new Store(dir);
  assert.equal(fresh.settings.sendKey, 'shift-enter'); assert.equal(fresh.settings.model, 'sonnet');
  assert.equal(fresh.create(dir, 'claude-model-id').model, 'claude-model-id');
});

test('per-conversation model is fixed; blank uses Claude default and legacy sessions use the configured default', async () => {
  const {dir,store} = fixture(), fixed = store.create(dir,'conversation-model'), blank = store.create(dir), legacy = store.create(dir), options = [];
  delete legacy.model;
  store.saveSettings({...store.settings, model:'global-model'});
  const engine = new Engine(store, p => { options.push(p.options); return fakeQuery(p); }, () => {}, () => 'fixture');
  try {
    engine.start(fixed.id, '固定模型');
    await until(() => engine.pending().length);
    engine.answer(engine.pending()[0].id, false); await until(() => !engine.runs.size);
    engine.start(blank.id, '默认模型'); await until(() => engine.pending().length);
    engine.answer(engine.pending()[0].id, false); await until(() => !engine.runs.size);
    engine.start(legacy.id, '旧对话'); await until(() => engine.pending().length);
    engine.answer(engine.pending()[0].id, false); await until(() => !engine.runs.size);
    assert.equal(options[0].model, 'conversation-model'); assert.ok(!('model' in options[1])); assert.equal(options[2].model, 'global-model');
  } finally { await engine.shutdown(); }
});
test('stop while waiting resolves approval and allows next turn',async()=>{
  const {dir,store}=fixture(); const s=store.create(dir); const engine=new Engine(store,fakeQuery,()=>{},()=> 'fixture'); engine.start(s.id,'开始');
  await until(()=>engine.pending().length); engine.stop(s.id); await until(()=>!engine.runs.size); assert.equal(engine.pending().length,0); assert.equal(s.status,'interrupted');
  engine.start(s.id,'继续'); await until(()=>engine.pending().length); engine.answer(engine.pending()[0].id,false); await until(()=>!engine.runs.size); assert.equal(s.status,'idle');
});
test('stream and final assistant events do not duplicate the reply',async()=>{
  const {dir,store}=fixture(); const s=store.create(dir);
  function query(){const iterator=(async function*(){yield {type:'stream_event',event:{type:'message_start',message:{id:'m1'}}}; yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'你好'}}}; yield {type:'assistant',message:{id:'m1',content:[{type:'text',text:'你好'}]}}; yield {type:'result',subtype:'success',is_error:false};})();iterator.close=()=>{};return iterator;}
  const engine=new Engine(store,query,()=>{},()=> 'fixture'); engine.start(s.id,'test'); await until(()=>!engine.runs.size); assert.equal(s.messages.filter(m=>m.role==='assistant').length,1); assert.equal(s.messages.find(m=>m.role==='assistant').text,'你好');
});
test('invalid CLI fails before consuming the user draft',()=>{
  const {dir,store}=fixture(); const s=store.create(dir);s.draft='保留草稿';const engine=new Engine(store,fakeQuery,()=>{},()=>{throw new Error('not found')});assert.throws(()=>engine.start(s.id,'hello'));assert.equal(s.draft,'保留草稿');assert.equal(s.messages.length,0);
});
test('standard npm shim resolves without invoking a shell',()=>{
  const {dir}=fixture();const shim=path.join(dir,'claude.cmd'), js=path.join(dir,'node_modules','@anthropic-ai','claude-code','cli.js');fs.mkdirSync(path.dirname(js),{recursive:true});fs.writeFileSync(shim,'');fs.writeFileSync(js,'');assert.equal(resolveCli(shim),js);assert.throws(()=>resolveCli(path.join(dir,'missing.exe')));
});
test('failed process becomes actionable error; secrets in environment are masked',async()=>{
  const {dir,store}=fixture();const s=store.create(dir);process.env.DESK_TEST_API_KEY='private-value-123';
  const query=()=>{const it=(async function*(){throw new Error('failure private-value-123 sk-secret-abc')})();it.close=()=>{};return it;};
  const engine=new Engine(store,query,()=>{},()=> 'fixture');engine.start(s.id,'go');await until(()=>!engine.runs.size);assert.equal(s.status,'error');const text=s.messages.at(-1).text;assert.ok(!text.includes('private-value-123'));assert.ok(!text.includes('sk-secret'));delete process.env.DESK_TEST_API_KEY;
  assert.match(engine.explainError('UNKNOWN_CERTIFICATE_VERIFICATION_ERROR'),/HTTPS 证书校验/);assert.match(engine.explainError('429 Service Unavailable'),/稍后重试/);
});
test('AskUserQuestion validates every answer and forwards answers to SDK',async()=>{
  const {dir,store}=fixture();const s=store.create(dir);let response;
  const query=({options})=>{const it=(async function*(){response=await options.canUseTool('AskUserQuestion',{questions:[{question:'选择语言？'},{question:'项目名称？'}]},{signal:options.abortController.signal});yield {type:'result',subtype:'success',is_error:false}})();it.close=()=>{};return it;};
  const engine=new Engine(store,query,()=>{},()=> 'fixture');engine.start(s.id,'问我问题');await until(()=>engine.pending().length);
  const id=engine.pending()[0].id;assert.throws(()=>engine.answer(id,true,{'选择语言？':'中文'}));assert.equal(engine.pending().length,1);
  engine.answer(id,true,{'选择语言？':'中文','项目名称？':'示例'});await until(()=>!engine.runs.size);assert.deepEqual(response.updatedInput.answers,{'选择语言？':'中文','项目名称？':'示例'});assert.equal(s.status,'idle');
});
test('concurrent conversations keep approvals isolated and enforce the run limit',async()=>{
  const {dir,store}=fixture();const sessions=Array.from({length:4},()=>store.create(dir));const engine=new Engine(store,fakeQuery,()=>{},()=> 'fixture');
  for(const s of sessions.slice(0,3))engine.start(s.id,'测试并行');assert.throws(()=>engine.start(sessions[3].id,'第四个'));
  await until(()=>engine.pending().length===3);engine.stop(sessions[0].id);await until(()=>!engine.runs.has(sessions[0].id));assert.equal(engine.pending().length,2);
  for(const request of engine.pending())engine.answer(request.id,true);await until(()=>!engine.runs.size);assert.equal(sessions[1].status,'idle');assert.equal(sessions[2].status,'idle');
});
