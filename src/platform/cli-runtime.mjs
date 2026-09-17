import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function executable(file, platform) {
  if (!isFile(file)) return false;
  if (/\.[cm]?js$/i.test(file)) return true;
  if (platform === 'win32') return /\.exe$/i.test(file);
  try { fs.accessSync(file,fs.constants.X_OK); return true; } catch { return false; }
}
function npmCli(shim, platform) {
  const root=path.join(path.dirname(shim),'node_modules','@anthropic-ai','claude-code');
  const candidates=[];
  try {
    const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.claude;
    if(pkg.name==='@anthropic-ai/claude-code'&&typeof bin==='string'){
      const target=path.resolve(root,bin),relative=path.relative(root,target);
      if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))candidates.push(target);
    }
  }catch{}
  candidates.push(path.join(root,'bin',platform==='win32'?'claude.exe':'claude'),path.join(root,'cli.js'));
  return candidates.find(file=>executable(file,platform));
}
export function resolveCli(configured='',env=process.env,{platform=process.platform,home=os.homedir()}={}) {
  const input=configured.trim().replace(/^"|"$/g,'');
  const discover=!input||/^(claude|claude\.cmd|claude\.exe)$/i.test(input);
  const candidates=[];
  if(!discover)candidates.push(input);
  else {
    const pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path');
    const names=platform==='win32'?['claude.exe','claude.cmd','claude']:['claude'];
    for(const folder of (env[pathKey]||'').split(platform==='win32'?';':':').filter(Boolean))
      for(const name of names)candidates.push(path.join(folder.replace(/^"|"$/g,''),name));
    candidates.push(path.join(home,'.local','bin',names[0]));
    if(platform==='win32') {
      if(env.APPDATA)candidates.push(path.join(env.APPDATA,'npm','claude.cmd'));
    }else{
      candidates.push('/opt/homebrew/bin/claude','/usr/local/bin/claude',path.join(home,'.npm-global','bin','claude'));
      const versions=path.join(home,'.nvm','versions','node');
      try {for(const version of fs.readdirSync(versions).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})))candidates.push(path.join(versions,version,'bin','claude'));}catch{}
    }
  }
  for(let file of candidates){
    if(!file||!isFile(file))continue;
    file=path.resolve(file);
    if(/\.(cmd|bat|ps1)$/i.test(file)||(platform==='win32'&&path.basename(file).toLowerCase()==='claude')){
      const target=npmCli(file,platform);if(target)return target;
      if(!discover)throw new Error('未找到此启动脚本对应的 Claude 程序。请检查 npm Claude 安装是否完整，或直接选择真实的 Claude 程序。');
      continue;
    }
    if(platform!=='win32')file=fs.realpathSync(file);
    if(executable(file,platform))return file;
  }
  const hint=platform==='win32'?'where.exe claude':'which claude';
  throw new Error(`未找到可用的 Claude 程序。请在原命令行运行 ${hint}，然后在设置中选择程序路径；也可留空自动查找。`);
}
export function environment() {
  const env={...process.env};delete env.CLAUDECODE;delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  if(process.platform==='darwin')env.PATH=[env.PATH,'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].filter(Boolean).join(':');
  return env;
}
export function spawnCli(file,args,{cwd,env=environment(),stdio=['ignore','pipe','pipe']}={}) {
  const js=/\.[cm]?js$/i.test(file);
  const child=spawn(js?process.execPath:file,js?[file,...args]:args,{
    cwd,env,windowsHide:true,
    detached:process.platform!=='win32',stdio
  });
  child.cliDeskProcessGroup=process.platform!=='win32';return child;
}
export function verifyCli(file) {
  return new Promise((resolve,reject)=>{
    const child=spawnCli(file,['--version']);let output='';
    const timer=setTimeout(()=>{killTree(child);reject(new Error('Claude 检测超时（15 秒），请检查路径。'));},15000);
    const collect=data=>{output=(output+data.toString()).slice(-4000);};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(output.trim()):reject(new Error(`Claude 启动失败：${output||code}`));});
  });
}
export function killTree(child) {
  if(!child?.pid)return;
  if(process.platform==='win32'){
    if(child.exitCode!==null)return;
    const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.on('error',()=>child.kill());
  }else if(child.cliDeskProcessGroup){
    try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')child.kill('SIGKILL');}
  }else if(child.exitCode===null)child.kill('SIGTERM');
}
