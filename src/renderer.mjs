import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { desk as api } from './desktop.mjs';

const $ = selector => document.querySelector(selector);
let state = { sessions:[], settings:{}, approvals:[] }, current = null, approvalsSignature = '', sending = false, composing = false;
const drafts = new Map(), pendingAttachments = new Map(); let draftTimer, toastTimer;
const openProcessTurns = new Set(), openTools = new Set();
let menuSessionId = null, editingSessionId = null, selectionRequest = 0;
let confirmResolver = null, archiveReturnToSettings = false, sendAfterCreate = false;
let updateAvailable = null, updating = false;
let activityTimer;
const latestReleaseUrl = 'https://github.com/changeCat/cli-desk/releases/latest';
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
async function openExternalLink(value) {
  let url;
  try { url=new URL(value); if (!['http:','https:'].includes(url.protocol)) throw new Error(); }
  catch { throw new Error('只允许打开 HTTP 或 HTTPS 链接'); }
  const accepted=await confirmAction({title:'打开外部链接？',message:'即将在默认浏览器中打开以下地址',detail:url.toString(),accept:'在浏览器打开',icon:'↗'});
  if (accepted) await api.link({url:url.toString(),confirmed:true});
}
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
  const wasCurrent = current?.id === id;
  if (wasCurrent) await flushDraft();
  if (!(await api.delete(id))) return;
  toast('已归档到本地，可在设置中恢复');
  drafts.delete(id);
  state.sessions = state.sessions.filter(s => s.id !== id);
  if (wasCurrent) {
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
function localPathButton(value) {
  const button=el('button','local-path'); button.type='button'; button.dataset.path=value; button.title='在文件管理器中显示';
  button.append(el('span','local-path-value',value),el('span','local-path-icon','↗')); return button;
}
function enhanceLocalPaths(root) {
  const exact=/^(?:[A-Za-z]:\\[^<>:"|?*\r\n]+|\\\\[^\\/:*?"<>|\r\n]+\\[^<>:"|?*\r\n]+|\/(?:Users|Volumes|private|tmp)\/[^\r\n]+)$/;
  for (const code of [...root.querySelectorAll('code:not(pre code)')]) {
    const value=code.textContent.trim();
    const relative=!/(^|[\\/])\.\.([\\/]|$)/.test(value) && (/^[.\w\-一-鿿 ()]+[\\/][^<>:"|?*\r\n]+$/.test(value) || /^[^\\/:*?"<>|\r\n]+\.(?:json|md|txt|csv|ya?ml|toml|js|mjs|cjs|ts|tsx|jsx|html?|css|scss|less|py|rs|go|java|kt|swift|c|h|cpp|hpp|cs|sh|ps1|bat|cmd|sql|xml|svg|png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|zip)$/i.test(value));
    if (exact.test(value) || relative) code.replaceWith(localPathButton(value));
  }
  const pattern=/(?:[A-Za-z]:\\|\\\\)[^\s<>"'`|?*]+/g, nodes=[];
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:node=>node.parentElement.closest('pre,a,button,code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text=node.textContent; pattern.lastIndex=0; let match,last=0; const fragment=document.createDocumentFragment();
    while ((match=pattern.exec(text))) {
      let value=match[0].replace(/[),.;!?]+$/,''); if (!value) continue;
      fragment.append(document.createTextNode(text.slice(last,match.index)),localPathButton(value)); last=match.index+value.length;
    }
    if (last) { fragment.append(document.createTextNode(text.slice(last))); node.replaceWith(fragment); }
  }
}
function markdownBody(value, className = 'body') {
  const body=el('div',className); body.innerHTML=markdown(value);
  enhanceLocalPaths(body);
  for (const pre of body.querySelectorAll('pre')) {
    const button=el('button','copy','复制代码'), code=pre.textContent;
    button.onclick=()=>attempt(async()=>{await api.copy(code);toast('代码已复制');}); pre.prepend(button);
  }
  return body;
}
function updateScrollButton() {
  const feed=$('#feed'), distance=Math.max(0,feed.scrollHeight-feed.scrollTop-feed.clientHeight);
  $('#scroll-bottom').hidden=distance<120;
}
function toolDetails(message) {
  const details=el('details','tool'); details.open=openTools.has(message.id);
  const summary=el('summary','',`◇ ${message.name}`); summary.append(el('span','tool-state',{running:'运行中',done:'已完成',error:'失败',interrupted:'已停止',unknown:'已结束'}[message.status]||''));
  details.append(summary,el('pre','',JSON.stringify(message.input,null,2)+(message.text ? '\n\n'+message.text : '')));
  details.ontoggle=()=>{details.open ? openTools.add(message.id) : openTools.delete(message.id);requestAnimationFrame(updateScrollButton);};
  return details;
}
function messageLabel(role, at, copyText) {
  const label=el('div','message-label');
  label.append(el('span','avatar',role==='user' ? '◌' : '✳'),el('span','',role==='user' ? '你' : 'Claude'),el('time','',new Date(at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})));
  const copy=el('button','copy','复制'); copy.onclick=()=>attempt(async()=>{await api.copy(copyText);toast('已复制');}); label.append(copy); return label;
}
function elapsedTime(milliseconds) {
  const seconds=Math.max(0,Math.floor(milliseconds/1000));
  return seconds<60 ? `${seconds} 秒` : `${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
}
function updateActivity() {
  const card=$('#run-activity'); if (!card || !busy(current)) return;
  const now=Date.now(), lastUser=current.messages.findLast(message=>message.role==='user');
  const started=current.runStartedAt || lastUser?.at || now;
  const label=current.status==='waiting' ? '等待你的确认或回答' : current.status==='stopping' ? '正在停止，保留已收到的内容…' : current.activity || '等待 Claude 回复…';
  card.dataset.state=current.status;
  const title=card.querySelector('.activity-title'); if (title.textContent!==label) title.textContent=label;
  card.querySelector('.activity-time').textContent=`已用 ${elapsedTime(now-started)}`;
  const quiet=now-(current.lastEventAt || started), note=card.querySelector('.activity-note');
  note.hidden=current.status!=='running' || quiet<30000;
  if (!note.hidden) note.textContent=`已 ${elapsedTime(quiet)} 未收到新反馈，仍在等待 Claude。可点击右下角运行按钮停止。`;
}
function activityCard() {
  const card=el('div','run-activity'); card.id='run-activity';
  const row=el('div','activity-row'), spinner=el('span','activity-spinner'); spinner.setAttribute('aria-hidden','true');
  const title=el('span','activity-title'); title.setAttribute('role','status');
  const time=el('span','activity-time'); time.setAttribute('aria-live','off');
  row.append(spinner,title,time); const note=el('p','activity-note'); note.hidden=true; card.append(row,note); return card;
}
function renderMessages() {
  const container = $('#messages'), feed = $('#feed');
  const atEnd = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
  const turns=[]; let turn=null;
  for (const message of current?.messages || []) {
    if (message.role==='user') { turn={id:message.id,user:message,items:[]}; turns.push(turn); }
    else if (turn) turn.items.push(message);
    else turns.push({id:message.id,user:null,items:[message]});
  }
  container.replaceChildren();
  for (const item of turns) {
    const wrapper=el('section','conversation-turn'); wrapper.dataset.turnId=item.id;
    if (item.user) {
      const question=el('article','message user turn-question'); question.dataset.messageId=item.user.id;
      const questionLabel=messageLabel('user',item.user.at,item.user.text); questionLabel.classList.add('turn-label','user-label');
      question.append(el('div','body',item.user.text));
      if (item.user.attachments?.length) {
        const files=el('div','message-attachments');
        for (const file of item.user.attachments) {
          const chip=localPathButton(file.relativePath); chip.classList.add('attachment-chip'); chip.querySelector('.local-path-value').textContent=`▱ ${file.name} · ${file.relativePath}`; files.append(chip);
        }
        question.append(files);
      }
      wrapper.append(questionLabel,question);
    }
    const activeTurn=busy(current) && item===turns.at(-1);
    if (item.items.length || activeTurn) {
      const assistantText=item.items.filter(message=>message.role==='assistant').map(message=>message.text).join('\n\n');
      const answer=el('article','message assistant turn-answer'); answer.dataset.messageId=item.items[0]?.id || `pending-${item.id}`;
      const answerLabel=messageLabel('assistant',item.items[0]?.at || item.user.at,assistantText || item.items.map(message=>message.text||message.name||'').join('\n')); answerLabel.classList.add('turn-label','answer-label');
      if (!item.items.length) answerLabel.querySelector('.copy').remove();
      const lastTool=item.items.reduce((last,message,index)=>message.role==='tool' ? index : last,-1);
      if (lastTool>=0) {
        const process=el('details','execution-process'); process.open=openProcessTurns.has(item.id);
        const toolCount=item.items.slice(0,lastTool+1).filter(message=>message.role==='tool').length;
        const summary=el('summary','',`执行过程 · ${toolCount} 个步骤`), processState=el('span','process-state',process.open ? '点击收起' : '点击展开'); summary.append(processState);
        const processBody=el('div','execution-body');
        for (const message of item.items.slice(0,lastTool+1)) {
          if (message.role==='assistant' && message.text) processBody.append(markdownBody(message.text,'process-text'));
          else if (message.role==='tool') processBody.append(toolDetails(message));
          else if (message.role==='notice') processBody.append(el('div','process-notice',message.text));
        }
        process.append(summary,processBody); process.ontoggle=()=>{processState.textContent=process.open ? '点击收起' : '点击展开';process.open ? openProcessTurns.add(item.id) : openProcessTurns.delete(item.id);requestAnimationFrame(updateScrollButton);}; answer.append(process);
      }
      const finalItems=lastTool>=0 ? item.items.slice(lastTool+1) : item.items;
      const final=el('div','answer-content');
      for (const message of finalItems) {
        if (message.role==='assistant' && message.text) final.append(markdownBody(message.text,'body'));
        else if (message.role==='notice') final.append(el('div','answer-notice',message.text));
        else if (message.role==='tool') final.append(toolDetails(message));
      }
      if (final.childNodes.length) answer.append(final);
      if (activeTurn) answer.append(activityCard());
      wrapper.append(answerLabel,answer);
    }
    container.append(wrapper);
  }
  clearInterval(activityTimer); activityTimer=null;
  updateActivity();
  if (busy(current)) activityTimer=setInterval(updateActivity,1000);
  if (atEnd) feed.scrollTop = feed.scrollHeight;
  updateScrollButton();
}
function addPending(items, sessionId = current?.id) {
  if (!sessionId || !items?.length) return;
  const existing=pendingAttachments.get(sessionId) || [], merged=[...existing];
  for (const item of items) if (!merged.some(value => value.relativePath === item.relativePath)) merged.push(item);
  pendingAttachments.set(sessionId,merged); render();
  const copied=items.filter(item => item.copied).length;
  toast(copied ? `${items.length} 个文件已添加；其中 ${copied} 个已复制到当前工作目录` : `${items.length} 个工作目录文件已添加`);
}
function renderPending() {
  const container=$('#pending-attachments'), items=current ? pendingAttachments.get(current.id) || [] : [];
  container.replaceChildren(); container.hidden=!items.length;
  for (const item of items) {
    const chip=el('div','pending-chip'), name=localPathButton(item.relativePath), remove=el('button','','×');
    name.classList.add('pending-path'); name.querySelector('.local-path-value').textContent=`▱ ${item.name}`; remove.type='button'; remove.setAttribute('aria-label',`移除 ${item.name}`);
    remove.onclick=()=>{const next=(pendingAttachments.get(current.id)||[]).filter(value=>value.relativePath!==item.relativePath);if(next.length)pendingAttachments.set(current.id,next);else pendingAttachments.delete(current.id);render();};
    chip.append(name,remove); container.append(chip);
  }
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
  $('#welcome-new').textContent = current ? '开始输入你的需求 ↓' : '设置工作文件夹与模型 ↗';
  $('#prompt').disabled = false;
  const running = active || sending;
  const hasAttachments = !!current && !!pendingAttachments.get(current.id)?.length;
  $('#send').disabled = active ? current.status === 'stopping' : sending || (!$('#prompt').value.trim() && !hasAttachments);
  $('#send').textContent = active ? current.status === 'stopping' ? '正在停止…' : '■ 运行中…' : sending ? '正在发送…' : '发送 ↑';
  $('#send').classList.toggle('running',running);
  $('#send').title = active && current.status !== 'stopping' ? '点击停止当前回答' : '';
  $('#send').setAttribute('aria-label',active && current.status !== 'stopping' ? '停止当前回答' : '发送消息');
  $('#composer-hint').textContent = active ? current.status === 'waiting' ? '等待你的确认后继续' : current.status === 'stopping' ? '正在停止…' : current.activity || 'Claude 正在处理，你可以先编辑下一条消息' : current ? '在当前工作文件夹中继续对话' : state.settings.defaultCwd ? '发送后将按默认设置创建对话' : '输入需求，发送时选择工作文件夹';
  $('#usage').textContent = current?.usage?.duration ? `本次 ${(current.usage.duration/1000).toFixed(1)} 秒` : '';
  $('#send-key-hint').textContent = state.settings.sendKey === 'ctrl-enter' ? 'Enter 换行 · Ctrl + Enter 发送' : 'Enter 发送 · Ctrl + Enter 换行';
  $('#attach-files').disabled = !current || sending;
  renderMessages(); renderPending(); approvals();
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
  $('#update-current').textContent = state.version;
  $('#update-latest').textContent = updateAvailable?.version || '—';
  $('#update-badge').hidden = !updateAvailable?.available;
  $('#update-status').textContent = updateAvailable ? (updateAvailable.available ? `发现新版本 v${updateAvailable.version}` : '当前已是最新版') : '检测后显示 GitHub 最新版本';
  $('#check-update').textContent = updating ? '检测中…' : '↻ 检测'; $('#check-update').disabled = updating;
  $('#download-update').textContent = updateAvailable?.available ? '↓ 下载新版' : '↓ 重新下载';
  $('#archive-count').textContent = '读取中…'; $('#settings-dialog').showModal();
  try { const items = await api.archives(); $('#archive-count').textContent = items.length ? `${items.length} 个已归档对话` : '暂无归档'; }
  catch (error) { $('#archive-count').textContent = error.message; }
}
async function updateAction() {
  const button = $('#check-update'), status = $('#update-status');
  button.disabled = true; updating = true;
  try {
    button.textContent = '检测中…'; status.textContent = '正在连接 GitHub…';
    const result = await api.updateCheck();
    updateAvailable = result; $('#update-latest').textContent = result.version || state.version; $('#update-badge').hidden = !result.available;
    $('#download-update').textContent = result.available ? '↓ 下载新版' : '↓ 重新下载';
    status.textContent = result.available ? `发现新版本 v${result.version}` : '当前已是最新版';
  } catch (error) { status.textContent = error.message; }
  finally { updating = false; button.disabled = false; button.textContent = '↻ 检测'; }
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
  if (busy(current) || sending) return;
  const prompt = $('#prompt').value, attachments=current ? pendingAttachments.get(current.id) || [] : [];
  if (!prompt.trim() && !attachments.length) return;
  sending = true; clearTimeout(draftTimer); render();
  try {
    if (!current) {
      if (!state.settings.defaultCwd) {
        sendAfterCreate = true;
        newDialog();
        $('#new-error').textContent = '请选择工作文件夹；当前输入内容会保留。';
        return;
      }
      const created = await api.create({cwd:state.settings.defaultCwd,model:state.settings.model || ''}), {messages,draft,...summary} = created;
      state.sessions = [summary,...state.sessions.filter(s => s.id !== summary.id)];
      current = created; $('#messages').replaceChildren(); approvalsSignature = ''; list();
    }
    const id = current.id;
    const result = await api.send({id,prompt,attachments}); drafts.delete(id); pendingAttachments.delete(id);
    if (current?.id === id) { current = result; $('#prompt').value = ''; }
  } catch (e) { toast(e.message); }
  finally { sending = false; render(); $('#prompt').focus(); }
}
$('#new-chat').onclick = () => attempt(newDialog);
$('#welcome-new').onclick = () => current ? $('#prompt').focus() : attempt(newDialog);
$('#search').oninput = list;
$('#settings-button').onclick = settingsDialog;
$('#attach-files').onclick = () => attempt(async () => { if (!current) return toast('请先新建对话并选择工作文件夹'); const id=current.id; addPending(await api.files(id),id); });
$('#manage-archive').onclick = () => attempt(archiveDialog);
$('#check-update').onclick = () => attempt(updateAction);
$('#download-update').onclick = () => attempt(() => openExternalLink(updateAvailable?.url || latestReleaseUrl));
for (const button of document.querySelectorAll('.close-dialog')) button.onclick = () => {
  const dialog = button.closest('dialog'); dialog.close();
  if (dialog.id === 'archive-dialog' && archiveReturnToSettings) { archiveReturnToSettings = false; $('#settings-dialog').showModal(); }
};
$('#pick-new').onclick = () => attempt(async () => { const p = await api.folder(); if (p) $('#new-cwd').value = p; });
$('#pick-default').onclick = () => attempt(async () => { const p = await api.folder(); if (p) $('#default-cwd').value = p; });
$('#pick-cli').onclick = () => attempt(async () => { const p = await api.cli(); if (p) $('#cli-path').value = p; });
$('#new-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter, shouldSend = sendAfterCreate, pending = current ? '' : $('#prompt').value; button.disabled = true; try { const s = await api.create({cwd:$('#new-cwd').value,model:$('#new-model').value}); sendAfterCreate = false; $('#new-dialog').close(); await select(s.id); if (pending) { $('#prompt').value = pending; drafts.set(s.id,pending); render(); } if (shouldSend) await sendMessage(); } catch (e) { $('#new-error').textContent = e.message; } finally { button.disabled = false; } };
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
$('#send').onclick = () => busy(current) ? attempt(() => api.stop(current.id)) : sendMessage();
$('#prompt').addEventListener('compositionstart', () => composing = true);
$('#prompt').addEventListener('compositionend', () => { setTimeout(() => composing = false,0); });
$('#prompt').addEventListener('keydown', event => {
  const sendWithCtrl = state.settings.sendKey === 'ctrl-enter';
  const validEnter = event.key === 'Enter' && !event.metaKey && !event.altKey && !event.isComposing && !composing && event.keyCode !== 229;
  if (validEnter && !sendWithCtrl && event.ctrlKey && !event.shiftKey) {
    event.preventDefault();
    const input=$('#prompt'), start=input.selectionStart, end=input.selectionEnd;
    input.setRangeText('\n',start,end,'end'); input.dispatchEvent(new Event('input',{bubbles:true})); return;
  }
  const shortcutMatches = sendWithCtrl ? event.ctrlKey && !event.shiftKey : !event.ctrlKey && !event.shiftKey;
  if (validEnter && shortcutMatches) {
    event.preventDefault(); sendMessage();
  }
});
$('#prompt').oninput = () => {
  if (current) { drafts.set(current.id,$('#prompt').value); clearTimeout(draftTimer); draftTimer = setTimeout(() => attempt(flushDraft),350); }
  render();
};
$('#new-dialog').addEventListener('close', () => sendAfterCreate = false);
$('#feed').onscroll = updateScrollButton;
$('#scroll-bottom').onclick = () => { $('#feed').scrollTop = $('#feed').scrollHeight; updateScrollButton(); };
if ('ResizeObserver' in window) new ResizeObserver(() => requestAnimationFrame(updateScrollButton)).observe($('#messages'));
document.addEventListener('click', event => {
  const localPath=event.target.closest('.local-path');
  if (localPath) { event.preventDefault(); if (current) attempt(async()=>{await api.reveal({id:current.id,path:localPath.dataset.path});toast('已在文件管理器中定位');}); return; }
  const anchor=event.target.closest('a'); if (anchor) { event.preventDefault(); attempt(() => openExternalLink(anchor.href)); }
});
document.addEventListener('keydown', event => { if (event.ctrlKey && event.key.toLowerCase() === 'n' && !document.querySelector('dialog[open]')) { event.preventDefault(); attempt(newDialog); } });
window.addEventListener('blur', () => attempt(flushDraft));
api.onEvent(({type,data}) => {
  if (type === 'list') {
    state.sessions = data;
    if (current && !state.sessions.some(session => session.id === current.id)) {
      clearTimeout(draftTimer); current = null; $('#prompt').value = ''; $('#messages').replaceChildren(); approvalsSignature = '';
    }
    list(); render();
  }
  if (type === 'session' && data.id === current?.id) { current = data; render(); }
  if (type === 'fileDrag') {
    $('.composer').classList.toggle('file-dragging',data.type === 'enter' || data.type === 'over');
    if (data.type === 'drop') attempt(async () => {
      if (!current) return toast('请先新建对话并选择工作文件夹');
      const id=current.id; addPending(await api.attach({id,paths:data.paths}),id);
    });
  }
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
