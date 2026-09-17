import {launchDesktop} from './desktop.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=fs.mkdtempSync(path.resolve('test-artifacts/packaged-'));
// Exercise the installed resource layout in a path with spaces and Chinese text.
const install=path.join(root,'安装目录 CLI Desk');
fs.mkdirSync(install);
fs.copyFileSync('src-tauri/target/release/cli-desk.exe',path.join(install,'cli-desk.exe'));
for (const directory of ['backend','runtime']) {
  fs.mkdirSync(path.join(install,directory));
  for (const name of fs.readdirSync(path.join('src-tauri/target/release',directory))) {
    fs.copyFileSync(path.join('src-tauri/target/release',directory,name),path.join(install,directory,name));
  }
}
// A stale system-runtime preference must not affect the standard self-contained build.
fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({nodePath:'Z:\\missing-node.exe'}));
fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({cliPath:path.resolve('test/fixture-cli.mjs'),defaultCwd:root,model:''}));
let app;
try {
  app=await launchDesktop({data:root,packaged:true,executable:path.join(install,'cli-desk.exe')});
  const page=app.page;
  assert.equal(await page.evaluate(()=>typeof window.__desktopTest),'undefined');
  await page.click('#settings-button');
  assert.match(await page.locator('#node-info').innerText(),/^应用内置 Node v24\.14\.1$/);
  await page.click('#settings-dialog .close-dialog');
  await page.click('#new-chat');await page.click('#new-form button[type=submit]');await page.waitForSelector('#new-dialog',{state:'hidden'});await page.waitForSelector('.session.selected');
  await page.fill('#prompt','测试安装版调用本地 CLI');await page.click('#send');await page.waitForSelector('.approval',{timeout:20000});await page.click('.approval .primary');
  await page.waitForFunction(()=>!document.querySelector('.session.selected')?.classList.contains('busy'));
  assert.ok((await page.locator('#messages').innerText()).includes('真实 SDK 协议测试'));
  const files=fs.readdirSync(path.join(root,'sessions')).filter(f=>f.endsWith('.json'));const record=JSON.parse(fs.readFileSync(path.join(root,'sessions',files[0])));
  assert.equal(record.providerSessionId,'11111111-1111-4111-8111-111111111111');
  await page.screenshot({path:path.resolve('test-artifacts/05-packaged.png')});
  console.log('PACKAGED PASS: Tauri release -> private Node runtime -> bundled official SDK -> external fixture CLI -> streaming approval response.');
}finally{await app?.close()}
