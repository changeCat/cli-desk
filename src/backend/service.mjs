import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../core/store.mjs';
import { createClaudeProvider } from '../providers/claude.mjs';

export function text(value, max = 100000) {
  if (typeof value !== 'string' || value.length > max) throw new Error('无效的输入');
  return value;
}
function directory(value) {
  const cwd = path.resolve(text(value, 32768));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('工作文件夹必须是已经存在的项目目录');
  return cwd;
}
const attachmentLimits = { count:10, each:25*1024*1024, total:50*1024*1024 };
function inside(root, target) {
  const relative = path.relative(root,target);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
function attachmentName(value) { return path.basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,180) || '附件'; }
function validateAttachments(session, value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > attachmentLimits.count) throw new Error(`每次最多添加 ${attachmentLimits.count} 个文件`);
  let total = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('无效的附件');
    const relativePath = text(item.relativePath,32768).replace(/\\/g,'/'), target = path.resolve(session.cwd,relativePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile() || !inside(fs.realpathSync(session.cwd),fs.realpathSync(target))) throw new Error('附件必须位于当前工作文件夹中');
    const size = fs.statSync(target).size; total += size;
    if (size > attachmentLimits.each || total > attachmentLimits.total) throw new Error('附件大小超出限制（单个 25 MB，总计 50 MB）');
    return {name:attachmentName(item.name || target),relativePath,size,copied:!!item.copied};
  });
}
function stageAttachments(store, id, values) {
  const session=store.get(text(id,80));
  if (!Array.isArray(values) || !values.length || values.length > attachmentLimits.count) throw new Error(`请选择 1-${attachmentLimits.count} 个文件`);
  const cwd=fs.realpathSync(session.cwd), staged=[]; let total=0;
  for (const value of values) {
    const source=fs.realpathSync(path.resolve(text(value,32768))), info=fs.statSync(source);
    if (!info.isFile()) throw new Error('只支持添加文件，不支持文件夹');
    total += info.size;
    if (info.size > attachmentLimits.each || total > attachmentLimits.total) throw new Error('附件大小超出限制（单个 25 MB，总计 50 MB）');
    const inWorkspace=inside(cwd,source); let target=source, copied=false;
    if (!inWorkspace) {
      const folder=path.join(session.cwd,'.cli-desk','attachments',session.id); fs.mkdirSync(folder,{recursive:true});
      const parsed=path.parse(attachmentName(source)); target=path.join(folder,parsed.base); let index=2;
      while (fs.existsSync(target)) target=path.join(folder,`${parsed.name}-${index++}${parsed.ext}`);
      const temporary=`${target}.tmp`; fs.copyFileSync(source,temporary); fs.renameSync(temporary,target); copied=true;
    }
    staged.push({name:path.basename(target),relativePath:path.relative(session.cwd,target).replace(/\\/g,'/'),size:info.size,copied});
  }
  return staged;
}
function versionParts(value) {
  const match=String(value).match(/^v?(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
  return match ? match.slice(1).map(Number) : null;
}
function isNewerVersion(remote,current) {
  const next=versionParts(remote), installed=versionParts(current);
  if(!next||!installed)return false;
  for(let index=0;index<3;index++)if(next[index]!==installed[index])return next[index]>installed[index];
  return false;
}
async function checkRelease(current,fetcher) {
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetcher('https://api.github.com/repos/changeCat/cli-desk/releases/latest',{headers:{Accept:'application/vnd.github+json','User-Agent':'CLI-Desk'},signal:controller.signal});
    if(!response.ok)throw new Error(`GitHub 返回 ${response.status}`);
    const release=await response.json(), tag=String(release.tag_name||''), url=String(release.html_url||'');
    if(!versionParts(tag)||!url.startsWith('https://github.com/changeCat/cli-desk/releases/'))throw new Error('GitHub Release 信息无效');
    return {available:isNewerVersion(tag,current),current,version:tag.replace(/^v/,''),url};
  } catch(error) {
    if(error.name==='AbortError')throw new Error('检查更新超时，请确认网络能够访问 GitHub。');
    throw new Error(`检查更新失败：${error.message}`);
  } finally { clearTimeout(timer); }
}
export function createService({root, version, smoke = false, emit, fetcher = globalThis.fetch}) {
  const store = new Store(root), provider = createClaudeProvider({smoke});
  const engine = provider.createEngine(store, (type, data) => {
    emit(type, data); if (type === 'session') emit('list', store.list());
  });
  const methods = {
    state: () => ({sessions:store.list(), settings:store.settings, approvals:engine.pending(), warnings:store.warnings, dataPath:root, version, smoke}),
    get: id => store.get(text(id, 80)),
    create: value => {
      const input = typeof value === 'string' ? {cwd:value,model:''} : value;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的新建对话参数');
      const s = store.create(directory(input.cwd), text(input.model ?? '', 150).trim()); emit('list', store.list()); return s;
    },
    rename: ({id, title}) => { const s = store.get(text(id, 80)); s.title = text(title, 100).trim() || '新对话'; store.save(s); emit('list', store.list()); return s; },
    model: ({id, model}) => {
      const s = store.get(text(id, 80));
      if (['running','waiting','stopping'].includes(s.status)) throw new Error('请等待当前任务结束后再修改模型');
      s.model = text(model, 150).trim(); store.save(s); emit('list', store.list()); return s;
    },
    delete: id => { store.remove(text(id, 80)); emit('list', store.list()); return true; },
    archives: () => store.archives(),
    restore: key => { const s = store.restore(text(key, 240)); emit('list', store.list()); return s; },
    purge: key => store.purge(text(key, 240)),
    draft: ({id, draft}) => { const s = store.get(text(id, 80)); s.draft = text(draft); store.save(s); },
    attach: ({id, paths}) => stageAttachments(store,id,paths),
    send: ({id, prompt, attachments}) => {
      const session=store.get(text(id,80));
      return engine.start(session.id,text(prompt),validateAttachments(session,attachments));
    },
    stop: id => engine.stop(text(id, 80)),
    answer: ({id, allow, answers}) => { if (typeof allow !== 'boolean') throw new Error('无效的授权选项'); return engine.answer(text(id, 80), allow, answers); },
    settings: value => {
      const sendKey = value.sendKey ?? store.settings.sendKey;
      if (!['enter', 'ctrl-enter'].includes(sendKey)) throw new Error('无效的发送按键');
      const settings = {cliPath:text(value.cliPath,32768).trim(), model:text(value.model,150).trim(), defaultCwd:text(value.defaultCwd,32768).trim(), sendKey};
      if (settings.defaultCwd) directory(settings.defaultCwd);
      store.saveSettings(settings); return settings;
    },
    check: configured => smoke ? {path:'test-fixture', version:'测试模式 · 不连接模型'} : provider.check(text(configured,32768)),
    updateCheck: () => smoke ? {available:false,current:version,version,url:'https://github.com/changeCat/cli-desk/releases/latest'} : checkRelease(version,fetcher),
    export: id => {
      const s = store.get(text(id, 80));
      const body = `# ${s.title}\n\n工作文件夹：${s.cwd}\n\n` + s.messages.map(m => `## ${{user:'我', assistant:'Claude', notice:'提示', tool:m.name}[m.role]}\n\n${m.role === 'tool' ? '```json\n' + JSON.stringify(m.input,null,2) + '\n```\n\n' : ''}${m.text}${m.attachments?.length ? '\n\n附件：\n' + m.attachments.map(item => `- ${item.name}（${item.relativePath}）`).join('\n') : ''}\n`).join('\n');
      return {name:s.title.replace(/[<>:"/\\|?*]/g,'_') + '.md', body};
    },
    active: () => engine.runs.size,
    shutdown: () => engine.shutdown()
  };
  return {
    async request(method, payload) {
      if (!Object.hasOwn(methods, method)) throw new Error('不支持的操作');
      return (await methods[method](payload)) ?? null;
    },
    shutdown: () => engine.shutdown()
  };
}
