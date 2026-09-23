import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(temp, file);
}
export function readJson(file, fallback, warnings = []) {
  for (const p of [file, `${file}.bak`]) {
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (p.endsWith('.bak')) {
        warnings.push(`已从备份恢复：${path.basename(file)}`);
        // Preserve corrupt bytes for manual recovery before replacing them.
        if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
        fs.copyFileSync(p, file);
      }
      return data;
    } catch { warnings.push(`无法读取：${path.basename(p)}`); }
  }
  return fallback;
}
export class Store {
  constructor(root) {
    this.root = root; this.warnings = []; this.sessions = new Map();
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
    this.settings = { cliPath: '', model: '', defaultCwd: '', sendKey: 'enter', ...readJson(path.join(root, 'settings.json'), {}, this.warnings) };
    if (this.settings.sendKey === 'shift-enter') this.settings.sendKey = 'ctrl-enter';
    if (!['enter', 'ctrl-enter'].includes(this.settings.sendKey)) this.settings.sendKey = 'enter';
    for (const name of fs.readdirSync(path.join(root, 'sessions')).filter(n => /^[\w-]+\.json$/.test(n))) {
      const session = readJson(path.join(root, 'sessions', name), null, this.warnings);
      if (!session || !Array.isArray(session.messages) || `${session.id}.json` !== name) continue;
      this.sessions.set(session.id, session);
      if (['running', 'waiting', 'stopping'].includes(session.status)) {
        session.status = 'interrupted';
        session.activity = ''; session.runStartedAt = null; session.lastEventAt = null;
        session.messages.push({ id: randomUUID(), role: 'notice', text: '上次运行意外中断。已保留收到的内容，可以发送新消息继续。', at: Date.now() });
        this.save(session);
      }
    }
  }
  file(id) { if (!/^[\w-]{1,80}$/.test(id)) throw new Error('无效的对话 ID'); return path.join(this.root, 'sessions', `${id}.json`); }
  get(id) { const s = this.sessions.get(id); if (!s) throw new Error('对话不存在'); return s; }
  list() { return [...this.sessions.values()].sort((a,b) => b.updatedAt-a.updatedAt).map(({messages, draft, ...s}) => s); }
  create(cwd, model = '') {
    const s = { id: randomUUID(), title: '新对话', cwd, model, provider:'claude', providerSessionId: null, createdAt: Date.now(), updatedAt: Date.now(), status: 'idle', draft: '', messages: [] };
    this.sessions.set(s.id, s); this.save(s); return s;
  }
  save(s) { atomicJson(this.file(s.id), s); }
  remove(id) {
    const s = this.get(id); if (['running','waiting','stopping'].includes(s.status)) throw new Error('请先停止任务再归档对话');
    const archive = path.join(this.root, 'archive'); fs.mkdirSync(archive, { recursive: true });
    const entry = `${Date.now()}-${randomUUID()}`, destination = path.join(archive, entry);
    fs.mkdirSync(destination);
    for (const suffix of ['', '.bak']) {
      const p = this.file(id) + suffix;
      if (fs.existsSync(p)) fs.renameSync(p, path.join(destination, `session.json${suffix}`));
    }
    this.sessions.delete(id);
    return { key:`archive:${entry}`, title:s.title, archivedAt:Number(entry.split('-')[0]) };
  }
  archiveTarget(key) {
    if (typeof key !== 'string') throw new Error('无效的归档记录');
    const match = /^(archive|trash):([\w.-]{1,200})$/.exec(key);
    if (!match || match[2] === '.' || match[2] === '..') throw new Error('无效的归档记录');
    if (match[1] === 'archive' && !/^[\w-]+$/.test(match[2])) throw new Error('无效的归档记录');
    if (match[1] === 'trash' && !/^[\w-]+\.json$/.test(match[2])) throw new Error('无效的归档记录');
    const root = path.join(this.root, match[1] === 'archive' ? 'archive' : 'trash');
    const container = path.join(root, match[2]);
    return { source:match[1], name:match[2], container, file:match[1] === 'archive' ? path.join(container, 'session.json') : container };
  }
  readArchived(target) {
    for (const file of [target.file, `${target.file}.bak`]) {
      if (!fs.existsSync(file)) continue;
      try {
        const session = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (session && /^[\w-]{1,80}$/.test(session.id) && Array.isArray(session.messages)) {
          if (file.endsWith('.bak')) {
            if (fs.existsSync(target.file)) fs.copyFileSync(target.file, `${target.file}.corrupt-${Date.now()}`);
            fs.copyFileSync(file, target.file);
          }
          return session;
        }
      } catch {}
    }
    return null;
  }
  archives() {
    const entries = [];
    const archive = path.join(this.root, 'archive');
    if (fs.existsSync(archive)) for (const name of fs.readdirSync(archive).filter(name => /^[\w-]+$/.test(name))) {
      const target = this.archiveTarget(`archive:${name}`), session = this.readArchived(target); if (!session) continue;
      const timestamp = Number(name.split('-')[0]);
      entries.push(this.archiveSummary(`archive:${name}`, session, Number.isFinite(timestamp) ? timestamp : session.updatedAt));
    }
    // Previous versions used root/trash/*.json. Keep those records manageable after upgrading.
    const trash = path.join(this.root, 'trash');
    if (fs.existsSync(trash)) for (const name of fs.readdirSync(trash).filter(name => /^[\w-]+-\d+\.json$/.test(name))) {
      const target = this.archiveTarget(`trash:${name}`), session = this.readArchived(target); if (!session) continue;
      const timestamp = Number(name.match(/-(\d+)\.json$/)?.[1]);
      entries.push(this.archiveSummary(`trash:${name}`, session, Number.isFinite(timestamp) ? timestamp : session.updatedAt));
    }
    return entries.sort((a,b) => b.archivedAt-a.archivedAt);
  }
  archiveSummary(key, session, archivedAt) {
    return { key, id:session.id, title:session.title || '未命名对话', cwd:session.cwd || '', archivedAt:archivedAt || session.updatedAt || Date.now(), updatedAt:session.updatedAt || 0, messageCount:session.messages.length, hasDraft:!!session.draft };
  }
  restore(key) {
    const target = this.archiveTarget(key), session = this.readArchived(target);
    if (!session) throw new Error('归档记录损坏或不存在，无法恢复');
    if (this.sessions.has(session.id) || fs.existsSync(this.file(session.id))) throw new Error('同一对话已存在，无法重复恢复');
    fs.renameSync(target.file, this.file(session.id));
    if (fs.existsSync(`${target.file}.bak`)) fs.renameSync(`${target.file}.bak`, `${this.file(session.id)}.bak`);
    if (target.source === 'archive') fs.rmSync(target.container, { recursive:true, force:true });
    this.sessions.set(session.id, session);
    return session;
  }
  purge(key) {
    const target = this.archiveTarget(key);
    if (!fs.existsSync(target.container)) throw new Error('归档记录不存在');
    if (target.source === 'archive') fs.rmSync(target.container, { recursive:true, force:true });
    else {
      fs.rmSync(target.file, { force:true });
      fs.rmSync(`${target.file}.bak`, { force:true });
    }
    return true;
  }
  saveSettings(settings) { this.settings = settings; atomicJson(path.join(this.root, 'settings.json'), settings); }
}
