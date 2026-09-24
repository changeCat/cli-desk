// Permission-routing UI fixtures; not proof of real account/classifier support.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {launchDesktop} from './desktop.mjs';
const data=fs.mkdtempSync(path.resolve('test-artifacts/ui-permissions-')), store=new Store(data);
store.saveSettings({...store.settings,defaultCwd:data});
const a=store.create(data),b=store.create(data);a.title='fixture 权限选择';b.title='fixture 独立对话';store.save(a);store.save(b);
let app;
async function select(page,id){await page.locator(`[data-session-id="${id}"]`).click();await page.waitForFunction(value=>document.querySelector('.session.selected')?.dataset.sessionId===value,id);}
async function mode(page,value){await page.click('#permission-mode');await page.locator(`[data-mode="${value}"]`).click();}
async function send(page,text){const before=await page.locator('.message.user').count();await page.fill('#prompt',text);await page.click('#send');await page.waitForFunction(count=>document.querySelectorAll('.message.user').length>count,before);}
async function done(page){await page.waitForFunction(()=>!document.querySelector('.session.selected').classList.contains('busy'));}
try {
  app=await launchDesktop({data});let page=app.page;const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await select(page,a.id);assert.match(await page.locator('#permission-mode').innerText(),/请求批准/);
  await page.click('#permission-mode');assert.equal(await page.locator('#permission-menu [role=menuitemradio]').count(),3);
  await page.screenshot({path:path.resolve('test-artifacts/11-permission-modes.png')});await page.keyboard.press('Escape');
  await mode(page,'bypassPermissions');await page.waitForSelector('#confirm-dialog[open]');await page.click('#confirm-cancel');
  assert.match(await page.locator('#permission-mode').innerText(),/请求批准/);
  await mode(page,'auto');await page.waitForFunction(()=>document.querySelector('#permission-mode').textContent.includes('帮我批准'));
  await send(page,'fixture auto approval');await done(page);assert.equal(await page.locator('.approval').count(),0);
  await select(page,b.id);assert.match(await page.locator('#permission-mode').innerText(),/请求批准/);
  await app.close();app=await launchDesktop({data});page=app.page;page.on('pageerror',e=>errors.push(e.message));
  await select(page,a.id);assert.match(await page.locator('#permission-mode').innerText(),/帮我批准/);
  await mode(page,'bypassPermissions');await page.waitForSelector('#confirm-dialog[open]');await page.click('#confirm-accept');
  await page.waitForFunction(()=>document.querySelector('#permission-mode').textContent.includes('完全访问权限'));
  await send(page,'fixture bypass approval');await done(page);assert.equal(await page.locator('.approval').count(),0);
  await send(page,'[fixture:question]');await page.waitForSelector('.approval');
  assert.equal(await page.locator('#permission-mode').isDisabled(),true);
  await page.waitForFunction(()=>document.querySelector('#scroll-bottom').hidden || document.querySelector('#scroll-bottom').getBoundingClientRect().bottom<=document.querySelector('#approvals').getBoundingClientRect().top);
  await page.screenshot({path:path.resolve('test-artifacts/12-permission-question.png')});
  await page.locator('.approval input[type=radio]').check();await page.click('.approval .primary');await done(page);
  assert.match(await page.locator('#messages').innerText(),/fixture 已收到回答/);
  await mode(page,'auto');await page.waitForFunction(()=>document.querySelector('#permission-mode').textContent.includes('帮我批准'));
  await send(page,'[fixture:auto-unavailable]');await page.waitForSelector('.approval');
  assert.match(await page.locator('#permission-mode').innerText(),/请求批准/);assert.match(await page.locator('#messages').innerText(),/与所选/);
  await page.locator('.approval-actions button').filter({hasText:'拒绝'}).click();await done(page);
  await mode(page,'default');await page.waitForFunction(()=>document.querySelector('#permission-mode').textContent.includes('请求批准'));
  await send(page,'fixture manual approval');await page.waitForSelector('.approval');await page.click('#send');await done(page);
  assert.deepEqual(errors,[]);
  console.log('UI PERMISSIONS PASS: fixture mode menu, explicit bypass confirmation, session isolation, persistence, questions, fallback visibility and manual approvals.');
}finally{await app?.close();}
