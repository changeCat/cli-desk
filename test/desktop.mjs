import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import {once} from 'node:events';

export async function launchDesktop({data, packaged = false, fixture = !packaged, executable: customExecutable}) {
  if(process.platform!=='win32') throw new Error('Native WebView UI automation currently requires Windows; macOS needs native manual verification.');
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const executable=customExecutable || path.resolve(`src-tauri/target/${packaged?'release':'debug'}/cli-desk.exe`);
  if(!fs.existsSync(executable))throw new Error('Build the Tauri executable before running UI tests.');
  const child=spawn(executable,['--profile-dir='+data,...(fixture?['--smoke-test']:[])],{
    env:{...process.env,CLI_DESK_CDP_PORT:String(port)},windowsHide:true,stdio:'pipe'
  });
  let output='';child.stderr.on('data',b=>output+=b);child.stdout.on('data',b=>output+=b);
  let browser;
  try {
    const deadline=Date.now()+90_000;
    let cdpReady=false;
    while(Date.now()<deadline) {
      if(child.exitCode!==null)throw new Error('Desktop exited: '+child.exitCode+' '+output);
      try {
        const result=await fetch(`http://127.0.0.1:${port}/json/version`);
        if(result.ok) {cdpReady=true;break;}
      } catch {}
      await new Promise(r=>setTimeout(r,100));
    }
    if(!cdpReady) {
      throw new Error(`WebView2 CDP endpoint did not start within 90 seconds. Verify that the WebView2 Runtime is installed. Desktop output: ${output || '(none)'}`);
    }
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context=browser.contexts()[0];let page=context.pages()[0];
    if(!page)page=await context.waitForEvent('page');
    await page.waitForSelector('#new-chat');
    await page.waitForFunction(()=>document.querySelector('#version').textContent);
    const desktop={
      page,child,
      async action(action,response) {return page.evaluate(({action,response})=>window.__desktopTest(action,response),{action,response});},
      async secondInstance() {
        const second=spawn(executable,['--profile-dir='+data],{windowsHide:true,stdio:'ignore'});
        const [code]=await once(second,'exit');if(code!==0)throw new Error('Second instance did not exit cleanly: '+code);
      },
      async close() {
        if(child.exitCode===null && fixture && !packaged) {
          try {await desktop.action('confirm',true);await desktop.action('quit');}catch{}
        }
        for(let i=0;i<70&&child.exitCode===null;i++)await new Promise(r=>setTimeout(r,100));
        if(child.exitCode===null)child.kill();
        await browser?.close();
      }
    };
    return desktop;
  } catch(error) {child.kill();await browser?.close();throw error;}
}
