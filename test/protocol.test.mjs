import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Store } from '../src/core/store.mjs';
import { Engine } from '../src/providers/claude-engine.mjs';
test('real official SDK launches JS CLI, exchanges approval, streams and persists session', {timeout:20000},async()=>{
  fs.mkdirSync('test-artifacts',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-artifacts/protocol-'));
  const store=new Store(root), session=store.create(root);
  const engine=new Engine(store,query,()=>{},()=>path.resolve('test/fixture-cli.mjs'));
  try {
    engine.start(session.id,'Hello');
    for(let i=0;i<600 && !engine.pending().length && engine.runs.size;i++) await new Promise(r=>setTimeout(r,20));
    assert.equal(engine.pending().length,1,JSON.stringify(session.messages));
    engine.answer(engine.pending()[0].id,true);
    for(let i=0;i<200 && engine.runs.size;i++) await new Promise(r=>setTimeout(r,20));
    assert.equal(session.status,'idle',JSON.stringify(session.messages));
    assert.equal(session.providerSessionId,'11111111-1111-4111-8111-111111111111');
    assert.equal(session.messages.filter(m=>m.role==='assistant').length,1);
    assert.equal(session.messages.find(m=>m.role==='assistant').text,'真实 SDK 协议测试');
  } finally { await engine.shutdown(); }
});
