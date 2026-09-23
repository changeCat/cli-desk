// Isolated fixtures: no real account, conversations or model requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {launchDesktop} from './desktop.mjs';

const data=fs.mkdtempSync(path.resolve('test-artifacts/ui-resilience-'));
const store=new Store(data);store.saveSettings({...store.settings,defaultCwd:data,sendKey:'ctrl-enter'});
const history=store.create(data);history.title='fixture 历史对话';
for(let i=0;i<40;i++)history.messages.push({id:`fixture-user-${i}`,role:'user',text:`问题 ${i}`,at:Date.now()},{id:`fixture-answer-${i}`,role:'assistant',text:`回答 ${i}\n\n`+'这是用于检查历史节点是否保留的模拟内容。'.repeat(30),at:Date.now()});
store.save(history);
const draft=store.create(data);draft.title='fixture 附件草稿';draft.draft='保留附件的草稿';
fs.writeFileSync(path.join(data,'fixture.txt'),'fixture');
draft.draftAttachments=[{name:'fixture.txt',relativePath:'fixture.txt',size:7,copied:false}];store.save(draft);
const request=(page,method,payload)=>page.evaluate(({method,payload})=>window.__TAURI_INTERNALS__.invoke('desk_request',{method,payload}),{method,payload});
async function selectSession(page,id) {
  await page.locator(`[data-session-id="${id}"]`).click();
  await page.waitForFunction(value=>document.querySelector('.session.selected')?.dataset.sessionId===value,id);
}
let app;
try {
  app=await launchDesktop({data});let page=app.page;const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await selectSession(page,draft.id);
  assert.equal(await page.locator('.pending-chip').count(),1);
  await page.fill('#prompt','修改文字，仍然保留附件');await page.waitForTimeout(500);
  assert.equal((await request(page,'get',draft.id)).draftAttachments.length,1);
  await app.close();app=await launchDesktop({data});page=app.page;page.on('pageerror',e=>errors.push(e.message));
  await selectSession(page,draft.id);
  assert.equal(await page.inputValue('#prompt'),'修改文字，仍然保留附件');
  assert.equal(await page.locator('.pending-chip').count(),1);
  await page.getByRole('button',{name:'移除 fixture.txt',exact:true}).click();await page.waitForTimeout(500);
  assert.deepEqual((await request(page,'get',draft.id)).draftAttachments,[]);

  await selectSession(page,history.id);
  await page.evaluate(()=>{window.fixtureHistoryNode=document.querySelector('.conversation-turn');});
  await page.fill('#prompt','[fixture:quiet]');
  assert.equal(await page.evaluate(()=>window.fixtureHistoryNode===document.querySelector('.conversation-turn')),true);
  // Debug-only gate holds the acknowledgement after the real backend accepts the send.
  await app.action('hold-send',true);
  await page.click('#send');await page.waitForSelector('#run-activity');
  await page.fill('#prompt','发送期间新写的下一条消息');
  await app.action('hold-send',false);
  await page.waitForFunction(()=>!document.querySelector('#attach-files').disabled);
  assert.equal(await page.inputValue('#prompt'),'发送期间新写的下一条消息');
  assert.equal((await request(page,'get',history.id)).draft,'发送期间新写的下一条消息');
  assert.equal(await page.evaluate(()=>window.fixtureHistoryNode===document.querySelector('.conversation-turn')),true);
  await page.click('#send');await page.waitForSelector('#run-activity',{state:'detached'});

  await selectSession(page,draft.id);
  await request(page,'send',{id:history.id,prompt:'fixture background approval'});
  await page.waitForFunction(()=>document.querySelector('#task-notice').textContent.includes('需要确认'));
  assert.equal(await page.locator(`[data-session-id="${history.id}"] .session-attention`).innerText(),'需要确认');
  const state=await request(page,'state');
  await request(page,'answer',{id:state.approvals[0].id,allow:false,answers:{}});
  await page.waitForFunction(()=>document.querySelector('#task-notice').textContent.includes('已完成'));
  await page.screenshot({path:path.resolve('test-artifacts/09-background-reminder.png')});
  await page.click('#task-notice button');
  await page.waitForFunction(id=>document.querySelector('.session.selected')?.dataset.sessionId===id,history.id);
  assert.equal(await page.locator('#task-notice').isHidden(),true);
  await page.fill('#prompt','[fixture:error]');await page.click('#send');
  await page.waitForFunction(()=>document.querySelector('.session.selected small')?.textContent.includes('请求失败'));
  assert.equal(await page.locator('#run-activity').count(),0);

  await page.fill('#prompt','[fixture:quiet]');await page.click('#send');await page.waitForSelector('#run-activity');
  await page.fill('#prompt','断开后保留在窗口的草稿');
  await app.action('disconnect-backend');
  await page.waitForFunction(()=>document.querySelector('#banner').textContent.includes('后台连接已中断'));
  assert.equal(await page.locator('#run-activity').count(),0);assert.equal(await page.locator('#send').isDisabled(),true);
  assert.equal(await page.inputValue('#prompt'),'断开后保留在窗口的草稿');
  assert.match(await page.locator('.session.selected small').innerText(),/连接中断/);
  await page.waitForTimeout(5500);assert.equal(await page.locator('#banner').isVisible(),true);
  await page.screenshot({path:path.resolve('test-artifacts/10-backend-disconnected.png')});
  assert.deepEqual(errors,[]);
  console.log('UI RESILIENCE PASS: fixture attachment draft restart, delayed send acknowledgement, historical DOM retention, background alerts, error status and real backend disconnect.');
} finally {await app?.close();}
