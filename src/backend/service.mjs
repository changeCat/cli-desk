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
export function createService({root, version, smoke = false, emit}) {
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
    send: ({id, prompt}) => engine.start(text(id, 80), text(prompt)),
    stop: id => engine.stop(text(id, 80)),
    answer: ({id, allow, answers}) => { if (typeof allow !== 'boolean') throw new Error('无效的授权选项'); return engine.answer(text(id, 80), allow, answers); },
    settings: value => {
      const sendKey = value.sendKey ?? store.settings.sendKey;
      if (!['enter', 'shift-enter'].includes(sendKey)) throw new Error('无效的发送按键');
      const settings = {cliPath:text(value.cliPath,32768).trim(), model:text(value.model,150).trim(), defaultCwd:text(value.defaultCwd,32768).trim(), sendKey};
      if (settings.defaultCwd) directory(settings.defaultCwd);
      store.saveSettings(settings); return settings;
    },
    check: configured => smoke ? {path:'test-fixture', version:'测试模式 · 不连接模型'} : provider.check(text(configured,32768)),
    export: id => {
      const s = store.get(text(id, 80));
      const body = `# ${s.title}\n\n工作文件夹：${s.cwd}\n\n` + s.messages.map(m => `## ${{user:'我', assistant:'Claude', notice:'提示', tool:m.name}[m.role]}\n\n${m.role === 'tool' ? '```json\n' + JSON.stringify(m.input,null,2) + '\n```\n\n' : ''}${m.text}\n`).join('\n');
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
