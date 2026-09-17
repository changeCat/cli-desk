import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { desk as api } from './desktop.mjs';

const $ = selector => document.querySelector(selector);
let state = { sessions:[], settings:{}, approvals:[] }, current = null, approvalsSignature = '', sending = false, composing = false;
const drafts = new Map(); let draftTimer, toastTimer;
let menuSessionId = null, editingSessionId = null, selectionRequest = 0;
let confirmResolver = null, archiveReturnToSettings = false;
const statusNames = { idle:'就绪', running:'正在处理', waiting:'等待确认', stopping:'正在停止', error:'请求失败', interrupted:'已停止' };
const busy = s => s && ['running','waiting','stopping'].includes(s.status);
function el(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true,5000); }
function confirmAction({title,message,detail,accept='确认',danger=false,icon='▱'}) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title; $('#confirm-message').textContent = message; $('#confirm-detail').textContent = detail || ''; $('#confirm-detail').hidden = !detail; $('#confirm-icon').textContent = icon;
  const button = $('#confirm-accept'); button.textContent = accept; button.className = danger ? 'danger-solid' : 'primary';
  dialog.showModal();
  return new Promise(resolve => confirmResolver = resolve);
}
function finishConfirm(value) { if (!confirmResolver) return; const resolve = confirmResolver; confirmResolver = null; $('#confirm-dialog').close(); resolve(value); }
async function attempt(fn) { try { return await fn(); } catch (e) { toast(e.message); } }
function date(time) {
  const value = new Date(time), pad = number => String(number).padStart(2,'0');
  if (Number.isNaN(value.getTime())) return '';
  return `${value.getFullYear()}-${pad(value.getMonth()+1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
function list() {
  const fragment = document.createDocumentFragment();
  const term = $('#search').value.trim().toLowerCase();
  for (const s of state.sessions.filter(s => s.title.toLowerCase().includes(term))) {
    const button = el('button', `session ${s.id === current?.id ? 'selected' : ''} ${busy(s) ? 'busy' : ''}`);
    button.dataset.sessionId = s.id; button.title = s.title; button.setAttribute('aria-current',s.id === current?.id ? 'true' : 'false');
    button.append(el('span','session-symbol',s.status === 'waiting' ? '◉' : '◌'));
    const visibleStatus = ['running','waiting','stopping','interrupted'].includes(s.status) ? statusNames[s.status] : '';
    const label = el('div'); label.append(el('span','session-name',s.title),el('small','', date(s.updatedAt) + (visibleStatus ? ` · ${visibleStatus}` : ''))); button.append(label);
    button.onclick = () => attempt(() => select(s.id));
    button.oncontextmenu = event => { event.preventDefault(); openSessionMenu(s.id, event.clientX, event.clientY); };
    button.onkeydown = event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); const rect = button.getBoundingClientRect(); openSessionMenu(s.id, rect.left + 20, rect.bottom);
      }
    };
    fragment.append(button);
  }
  if (!fragment.childNodes.length) fragment.append(el('p','local-label',term ? '没有匹配的对话' : '你的对话会显示在这里'));
  $('#sessions').replaceChildren(fragment); $('#count').textContent = state.sessions.length;
  if (menuSessionId) {
    const target = state.sessions.find(s => s.id === menuSessionId);
    if (!target) closeSessionMenu(); else { $('#context-model').disabled = busy(target); $('#context-delete').disabled = busy(target); }
  }
}
function closeSessionMenu(restoreFocus = false) {
  const id = menuSessionId; menuSessionId = null; $('#session-menu').hidden = true;
  if (restoreFocus) [...$('#sessions').children].find(n => n.dataset.sessionId === id)?.focus();
}
function openSessionMenu(id, x, y) {
  const target = state.sessions.find(s => s.id === id); if (!target) return;
  menuSessionId = id;
  const menu = $('#session-menu'), archiveButton = $('#context-delete'), modelButton = $('#context-model');
  archiveButton.disabled = busy(target); archiveButton.title = busy(target) ? '请先停止任务再归档对话' : '';
  modelButton.disabled = busy(target); modelButton.title = busy(target) ? '请等待当前任务结束后再修改模型' : '';
  menu.hidden = false;
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4)) + 'px';
  menu.querySelector('button:not(:disabled)')?.focus();
}
async function deleteSession(id) {
  if (!id) return;
  const target = state.sessions.find(s => s.id === id); if (!target) return;
  if (!(await confirmAction({title:'归档这个对话？',message:`“${target.title}”将从左侧列表移到本地归档。`,detail:'对话内容、草稿和续聊信息都会保留，可随时在设置中恢复。项目文件和 Claude 原始会话不会删除。',accept:'归档对话'}))) return;
  if (current?.id === id) await flushDraft();
  if (!(await api.delete(id))) return;
  toast('已归档到本地，可在设置中恢复');
  drafts.delete(id);
  state.sessions = state.sessions.filter(s => s.id !== id);
  if (current?.id === id) {
    clearTimeout(draftTimer); current = null; $('#prompt').value = ''; $('#messages').replaceChildren(); approvalsSignature = '';
    if (state.sessions.length) await select(state.sessions[0].id); else render();
  }
  list();
}
async function flushDraft() {
  clearTimeout(draftTimer);
  if (!current || !drafts.has(current.id)) return;
  const id = current.id, draft = drafts.get(id); await api.draft({ id,draft });
}
async function select(id) {
  const request = ++selectionRequest;
  closeSessionMenu();
  await flushDraft();
  const selected = await api.get(id);
  if (request !== selectionRequest) return;
  current = selected;
  $('#prompt').value = drafts.has(id) ? drafts.get(id) : selected.draft || '';
  $('#messages').replaceChildren(); approvalsSignature = ''; render(); list(); $('#feed').scrollTop = $('#feed').scrollHeight; $('#prompt').focus();
}
function markdown(value) {
  return DOMPurify.sanitize(marked.parse(value || '', { breaks:true, gfm:true }), { FORBID_TAGS:['img','svg','math','style','input','form','iframe','video','audio'], FORBID_ATTR:['style','id','name'], ALLOW_DATA_ATTR:false });
}
function renderMessages() {
  const container = $('#messages'), feed = $('#feed');
  const atEnd = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
  const nodes = new Map([...container.children].map(n => [n.dataset.messageId,n]));
  for (const m of current?.messages || []) {
    let node = nodes.get(m.id);
    const signature = JSON.stringify(m); if (node?.dataset.signature === signature) continue;
    if (!node) { node = el('article',`message ${m.role}`); node.dataset.messageId = m.id; container.append(node); }
    node.dataset.signature = signature;
    const wasOpen = node.querySelector('details')?.open;
    node.replaceChildren();
    if (m.role === 'notice') { node.textContent = m.text; continue; }
    if (m.role === 'tool') {
      const details = el('details','tool'); details.open = !!wasOpen;
      const summary = el('summary','',`◇ ${m.name}`); summary.append(el('span','tool-state', {running:'运行中',done:'已完成',error:'失败',interrupted:'已停止',unknown:'已结束'}[m.status] || ''));
      details.append(summary,el('pre','',JSON.stringify(m.input,null,2) + (m.text ? '\n\n' + m.text : ''))); node.append(details); continue;
    }
    const label = el('div','message-label'); label.append(el('span','avatar', m.role === 'user' ? '◌' : '✳'),el('span','',m.role === 'user' ? '你' : 'Claude'),el('time','',new Date(m.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})));
    const copy = el('button','copy','复制'); copy.onclick = () => attempt(async () => { await api.copy(m.text); toast('已复制'); }); label.append(copy);
    const body = el('div','body'); if (m.role === 'assistant') body.innerHTML = markdown(m.text); else body.textContent = m.text;
    for (const pre of body.querySelectorAll('pre')) {
      const button = el('button','copy','复制代码'); const code = pre.textContent;
      button.onclick = () => attempt(async () => { await api.copy(code); toast('代码已复制'); }); pre.prepend(button);
    }
    node.append(label,body);
  }
  if (atEnd) feed.scrollTop = feed.scrollHeight;
  $('#scroll-bottom').hidden = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
}
function approvals() {
  const requests = state.approvals.filter(r => r.sessionId === current?.id);
  const sig = JSON.stringify(requests); if (sig === approvalsSignature) return; approvalsSignature = sig;
  $('#approvals').replaceChildren();
  for (const request of requests) {
    const card = el('div','approval'); card.dataset.requestId = request.id;
    card.append(el('h3','',request.name === 'AskUserQuestion' ? 'Claude 需要你的回答' : `需要确认 · ${request.name}`));
    if (request.reason) card.append(el('p','',request.reason));
    const questions = [];
    if (request.name === 'AskUserQuestion' && Array.isArray(request.input.questions)) {
      request.input.questions.forEach((q,index) => {
        const section = el('div','question'); section.append(el('strong','',q.question));
        const fields = [];
        for (const option of q.options || []) {
          const label = el('label'), field = el('input'); field.type = q.multiSelect ? 'checkbox' : 'radio'; field.name = `q-${request.id}-${index}`; field.value = option.label;
          const desc = el('span','',option.label); if (option.description) desc.append(el('small','', ' — ' + option.description)); label.append(field,desc); fields.push(field); section.append(label);
        }
        const other = el('input'); other.placeholder = '或输入你的回答'; other.setAttribute('aria-label', q.question); section.append(other);
        questions.push({ q, fields, other }); card.append(section);
      });
    } else { const details = el('details'); details.open = true; details.append(el('summary','','操作详情'),el('pre','',JSON.stringify(request.input,null,2))); card.append(details); }
    const actions = el('div','approval-actions'), deny = el('button','','拒绝'), allow = el('button','primary',request.name === 'AskUserQuestion' ? '提交回答' : '仅允许此次');
    const submit = value => attempt(async () => {
      const answers = {}; for (const { q,fields,other } of questions) answers[q.question] = other.value.trim() || fields.filter(f => f.checked).map(f => f.value).join(', ');
      allow.disabled = deny.disabled = true;
      try { await api.answer({id:request.id,allow:value,answers}); } finally { allow.disabled = deny.disabled = false; }
    });
    deny.onclick = () => submit(false); allow.onclick = () => submit(true); actions.append(deny,allow); card.append(actions); $('#approvals').append(card);
  }
}
function render() {
  const active = busy(current);
  $('#title').textContent = current?.title || '开始一段新对话';
  $('#workspace').textContent = current?.cwd || '选择文件夹，让 Claude 了解你的项目'; $('#workspace').title = current?.cwd || '';
  $('#welcome').hidden = !!current?.messages.length;
  $('#welcome-new').textContent = current ? '开始输入你的需求 ↓' : '新建我的第一个对话 ↗';
  $('#prompt').disabled = !current;
  const running = active || sending;
  $('#send').disabled = !current || running || !$('#prompt').value.trim();
  $('#send').textContent = running ? '运行中…' : '发送 ↑'; $('#send').classList.toggle('running',running);
  $('#stop').hidden = !active; $('#stop').disabled = current?.status === 'stopping';
  $('#composer-hint').textContent = current?.activity || (active ? current.status === 'waiting' ? '等待你的确认后继续' : 'Claude 正在处理，你可以先编辑下一条消息' : current ? '在当前工作文件夹中继续对话' : '先新建一个对话');
  $('#usage').textContent = current?.usage?.duration ? `本次 ${(current.usage.duration/1000).toFixed(1)} 秒` : '';
  $('#send-key-hint').textContent = state.settings.sendKey === 'shift-enter' ? 'Shift + Enter 发送 · Enter 换行' : 'Enter 发送 · Shift + Enter 换行';
  renderMessages(); approvals();
}
function newDialog() { $('#new-cwd').value = state.settings.defaultCwd || current?.cwd || ''; $('#new-model').value = state.settings.model || ''; $('#new-error').textContent = ''; $('#new-dialog').showModal(); }
async function renameDialog(id) {
  const session = id === current?.id ? current : await api.get(id); editingSessionId = id;
  $('#rename-input').value = session.title; $('#rename-dialog').showModal(); $('#rename-input').select();
}
async function modelDialog(id) {
  const session = id === current?.id ? current : await api.get(id); editingSessionId = id;
  $('#model-dialog-title').textContent = `“${session.title}”将在下一次发送时使用此模型。`;
  $('#session-model').value = session.model || ''; $('#model-dialog').showModal(); $('#session-model').select();
}
async function settingsDialog() {
  $('#cli-path').value = state.settings.cliPath || ''; $('#default-cwd').value = state.settings.defaultCwd || ''; $('#model').value = state.settings.model || ''; $('#send-key').value = state.settings.sendKey || 'enter'; $('#settings-error').textContent = '';
  $('#archive-count').textContent = '读取中…'; $('#settings-dialog').showModal();
  try { const items = await api.archives(); $('#archive-count').textContent = items.length ? `${items.length} 个已归档对话` : '暂无归档'; }
  catch (error) { $('#archive-count').textContent = error.message; }
}
function archiveTime(value) { return new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
async function refreshArchives() {
  const listNode = $('#archive-list'); listNode.replaceChildren(el('p','archive-empty','正在读取…'));
  const items = await api.archives(); listNode.replaceChildren(); $('#archive-total').textContent = `${items.length} 个归档`;
  if (!items.length) { listNode.append(el('p','archive-empty','暂无归档对话')); return; }
  for (const item of items) {
    const card = el('article','archive-item');
    const symbol = el('div','archive-item-icon','◷');
    const details = el('div','archive-details'); details.append(el('strong','',item.title));
    const meta = el('div','archive-meta'); meta.append(el('span','',archiveTime(item.archivedAt)),el('span','',`${item.messageCount} 条记录`)); if (item.hasDraft) meta.append(el('span','archive-draft','有草稿')); details.append(meta);
    if (item.cwd) details.append(el('span','archive-path',item.cwd));
    const actions = el('div','archive-actions'), restore = el('button','archive-restore','恢复'), purge = el('button','danger archive-purge','永久删除');
    restore.onclick = () => attempt(async () => {
      restore.disabled = purge.disabled = true;
      try {
        const restored = await api.restore(item.key), {messages,draft,...summary} = restored;
        state.sessions = [summary,...state.sessions.filter(s => s.id !== summary.id)];
        archiveReturnToSettings = false; $('#archive-dialog').close(); await select(restored.id); toast('对话已恢复');
      } finally { restore.disabled = purge.disabled = false; }
    });
    purge.onclick = () => attempt(async () => {
      if (!(await confirmAction({title:'永久删除归档？',message:`“${item.title}”的本地归档将被彻底删除。`,detail:'此操作无法撤销。项目文件、Claude 原始会话、账号和设置不会受到影响。',accept:'永久删除',danger:true,icon:'!'}))) return;
      restore.disabled = purge.disabled = true;
      try { if (await api.purge(item.key)) { toast('归档已永久删除'); await refreshArchives(); } }
      finally { if (document.body.contains(restore)) restore.disabled = purge.disabled = false; }
    });
    actions.append(restore,purge); card.append(symbol,details,actions); listNode.append(card);
  }
}
async function archiveDialog() { archiveReturnToSettings = $('#settings-dialog').open; $('#settings-dialog').close(); $('#archive-dialog').showModal(); await refreshArchives(); }
function banner(value) { $('#banner').replaceChildren(); $('#banner').hidden = !value; if (!value) return; $('#banner').append(document.createTextNode(value)); const button = el('button','','打开设置'); button.onclick = settingsDialog; $('#banner').append(button); }
async function check(path) {
  $('#check-cli').disabled = true; $('#check-result').textContent = '正在检测…';
  try { const info = await api.check(path); $('#check-result').textContent = info.version + ' · ' + info.path; $('#connection-dot').classList.add('connected'); banner(state.smoke ? '当前为自动化测试模式，不会调用真实 Claude。' : ''); return true; }
  catch (e) { $('#check-result').textContent = e.message; $('#connection-dot').classList.remove('connected'); banner(e.message); return false; }
  finally { $('#check-cli').disabled = false; }
}
async function sendMessage() {
  if (!current || busy(current) || sending) return;
  const prompt = $('#prompt').value; if (!prompt.trim()) return;
  sending = true; clearTimeout(draftTimer); render();
  const id = current.id;
  try {
    const result = await api.send({id,prompt}); drafts.delete(id);
    if (current?.id === id) { current = result; $('#prompt').value = ''; }
  } catch (e) { toast(e.message); }
  finally { sending = false; render(); $('#prompt').focus(); }
}
$('#new-chat').onclick = () => attempt(newDialog);
$('#welcome-new').onclick = () => current ? $('#prompt').focus() : attempt(newDialog);
$('#search').oninput = list;
$('#settings-button').onclick = settingsDialog;
$('#manage-archive').onclick = () => attempt(archiveDialog);
for (const button of document.querySelectorAll('.close-dialog')) button.onclick = () => {
  const dialog = button.closest('dialog'); dialog.close();
  if (dialog.id === 'archive-dialog' && archiveReturnToSettings) { archiveReturnToSettings = false; $('#settings-dialog').showModal(); }
};
$('#pick-new').onclick = () => attempt(async () => { const p = await api.folder(); if (p) $('#new-cwd').value = p; });
$('#pick-default').onclick = () => attempt(async () => { const p = await api.folder(); if (p) $('#default-cwd').value = p; });
$('#pick-cli').onclick = () => attempt(async () => { const p = await api.cli(); if (p) $('#cli-path').value = p; });
$('#new-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; try { const s = await api.create({cwd:$('#new-cwd').value,model:$('#new-model').value}); $('#new-dialog').close(); await select(s.id); } catch (e) { $('#new-error').textContent = e.message; } finally { button.disabled = false; } };
$('#settings-form').onsubmit = async event => { event.preventDefault(); try { state.settings = await api.settings({cliPath:$('#cli-path').value,defaultCwd:$('#default-cwd').value,model:$('#model').value,sendKey:$('#send-key').value}); $('#settings-dialog').close(); render(); await check(state.settings.cliPath); toast('设置已保存'); } catch(e) { $('#settings-error').textContent = e.message; } };
$('#check-cli').onclick = () => check($('#cli-path').value);
$('#open-data').onclick = () => attempt(() => api.data());
$('#rename-form').onsubmit = event => { event.preventDefault(); attempt(async () => { const result = await api.rename({id:editingSessionId,title:$('#rename-input').value}); if (current?.id === result.id) current = result; $('#rename-dialog').close(); render(); }); };
$('#model-form').onsubmit = event => { event.preventDefault(); attempt(async () => { const result = await api.model({id:editingSessionId,model:$('#session-model').value}); if (current?.id === result.id) current = result; $('#model-dialog').close(); render(); toast(result.model ? `模型已改为 ${result.model}` : '已改用 Claude Code 默认模型'); }); };
$('#context-rename').onclick = () => { const id = menuSessionId; closeSessionMenu(); attempt(() => renameDialog(id)); };
$('#context-model').onclick = () => { const id = menuSessionId; closeSessionMenu(); attempt(() => modelDialog(id)); };
$('#context-open-cwd').onclick = () => { const id = menuSessionId; closeSessionMenu(); attempt(async () => { await api.openCwd(id); toast('已打开当前目录'); }); };
$('#context-export').onclick = () => { const id = menuSessionId; closeSessionMenu(); attempt(async () => { if (await api.export(id)) toast('对话已导出'); }); };
$('#context-delete').onclick = () => { const id = menuSessionId; closeSessionMenu(); attempt(() => deleteSession(id)); };
$('#confirm-cancel').onclick = () => finishConfirm(false);
$('#confirm-accept').onclick = () => finishConfirm(true);
$('#confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); finishConfirm(false); });
$('#archive-dialog').addEventListener('cancel', event => { event.preventDefault(); $('#archive-dialog').close(); if (archiveReturnToSettings) { archiveReturnToSettings = false; $('#settings-dialog').showModal(); } });
document.addEventListener('pointerdown', event => { if (!event.target.closest('#session-menu')) closeSessionMenu(); });
document.addEventListener('keydown', event => {
  if (!menuSessionId) return;
  if (event.key === 'Escape' || event.key === 'Tab') { closeSessionMenu(true); if (event.key === 'Escape') event.preventDefault(); return; }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); const buttons = [...$('#session-menu').querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement), step = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  }
});
$('#sessions').addEventListener('scroll', () => closeSessionMenu());
window.addEventListener('resize', () => closeSessionMenu());
$('#send').onclick = sendMessage;
$('#stop').onclick = () => attempt(() => api.stop(current.id));
$('#prompt').addEventListener('compositionstart', () => composing = true);
$('#prompt').addEventListener('compositionend', () => { setTimeout(() => composing = false,0); });
$('#prompt').addEventListener('keydown', event => {
  const sendWithShift = state.settings.sendKey === 'shift-enter';
  if (event.key === 'Enter' && event.shiftKey === sendWithShift && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && !composing && event.keyCode !== 229) {
    event.preventDefault(); sendMessage();
  }
});
$('#prompt').oninput = () => {
  if (!current) return; drafts.set(current.id,$('#prompt').value); clearTimeout(draftTimer); draftTimer = setTimeout(() => attempt(flushDraft),350); render();
};
$('#feed').onscroll = () => $('#scroll-bottom').hidden = $('#feed').scrollHeight - $('#feed').scrollTop - $('#feed').clientHeight < 120;
$('#scroll-bottom').onclick = () => { $('#feed').scrollTop = $('#feed').scrollHeight; };
document.addEventListener('click', event => { const anchor = event.target.closest('a'); if (anchor) { event.preventDefault(); attempt(() => api.link(anchor.href)); } });
document.addEventListener('keydown', event => { if (event.ctrlKey && event.key.toLowerCase() === 'n' && !document.querySelector('dialog[open]')) { event.preventDefault(); attempt(newDialog); } });
window.addEventListener('blur', () => attempt(flushDraft));
api.onEvent(({type,data}) => {
  if (type === 'list') { state.sessions = data; list(); }
  if (type === 'session' && data.id === current?.id) { current = data; render(); }
  if (type === 'approvals') { state.approvals = data; approvals(); }
  if (type === 'error') toast(data);
});
async function initialize() {
  try {
    state = await api.state(); $('#version').textContent = 'v' + state.version;
    $('#node-info').textContent = `${state.runtime.bundled ? '应用内置' : '开发环境'} Node ${state.runtime.version}`;
    if (state.sessions.length) await select(state.sessions[0].id); else { list(); render(); }
    if (state.warnings.length) toast(state.warnings.join('\n'));
    await check(state.settings.cliPath || '');
  } catch (error) {
    toast(error.message);
  }
}
initialize();
