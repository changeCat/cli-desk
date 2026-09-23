import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { resolveCli, environment, killTree, spawnCli } from '../platform/cli-runtime.mjs';

export class Engine {
  constructor(store, query, emit, resolver = resolveCli) {
    this.store = store; this.query = query; this.emit = emit; this.resolver = resolver;
    this.runs = new Map(); this.approvals = new Map();
  }
  publish(s, persist = true) { if (persist) this.store.save(s); this.emit('session', s); }
  publishCleanup(s) {
    try { this.publish(s); }
    catch { this.publish(s, false); this.emit('error', '保存对话失败，请检查磁盘空间或目录权限。当前内容仍保留在窗口中，可复制或导出。'); }
  }
  start(id, text, attachments = []) {
    const s = this.store.get(id);
    if (this.runs.has(id)) throw new Error('此对话正在运行，请等待完成或停止任务。');
    if (this.runs.size >= 3) throw new Error('最多同时运行 3 个对话，请先等待其他任务完成。');
    if (typeof text !== 'string' || (!text.trim() && !attachments.length) || text.length > 100000) throw new Error('请输入消息或添加附件（消息最多 100,000 字符）。');
    if (!fs.existsSync(s.cwd) || !fs.statSync(s.cwd).isDirectory()) throw new Error('工作文件夹不存在，请重新选择或新建对话。');
    const cli = this.resolver(this.store.settings.cliPath);
    const previous = {...s,messages:[...s.messages]};
    const run = { controller: new AbortController(), child: null, stopped: false, query: null, dirty: false, streamId: null, tools: new Map(), textIds: new Map(), finished: false };
    this.runs.set(id, run);
    s.status = 'running'; s.updatedAt = Date.now(); s.draft = ''; s.draftAttachments = [];
    s.runStartedAt = s.updatedAt; s.lastEventAt = null; s.activity = '正在启动 Claude…'; s.usage = null;
    const userText = text.trim() || '请查看并处理附件。';
    if (!s.messages.some(m => m.role === 'user')) s.title = userText.slice(0, 30);
    s.messages.push({ id: randomUUID(), role: 'user', text: userText, attachments, at: Date.now() });
    try { this.publish(s); } catch (error) {
      this.runs.delete(id);
      for (const key of Object.keys(s)) if (!Object.hasOwn(previous,key)) delete s[key];
      Object.assign(s,previous); throw error;
    }
    const attachmentPrompt = attachments.length ? `\n\n附件已放在当前工作目录中。请按要求读取或修改；修改会直接保存到这些路径：\n${attachments.map(item => `- ${item.relativePath}`).join('\n')}` : '';
    run.done = this.execute(s, userText + attachmentPrompt, cli, run);
    return s;
  }
  notice(s, text) { s.messages.push({ id: randomUUID(), role: 'notice', text, at: Date.now() }); }
  textMessage(s, run, key) {
    let msg = run.textIds.get(key);
    if (!msg) { msg = { id: randomUUID(), role: 'assistant', text: '', at: Date.now() }; s.messages.push(msg); run.textIds.set(key, msg); }
    return msg;
  }
  tool(s, run, block) {
    let msg = run.tools.get(block.id);
    if (!msg) { msg = { id: block.id || randomUUID(), role: 'tool', name: block.name || '工具', input: block.input || {}, text: '', status: 'running', at: Date.now() }; run.tools.set(msg.id, msg); s.messages.push(msg); }
    else if (block.input && Object.keys(block.input).length) msg.input = block.input;
    s.activity = `正在执行工具 · ${msg.name}`;
    return msg;
  }
  async permission(s, run, name, input, options = {}) {
    if (run.stopped || options.signal?.aborted) return { behavior: 'deny', message: '用户已停止任务', interrupt: true };
    const request = { id: randomUUID(), sessionId: s.id, name, input, reason: options.decisionReason || options.title || '', at: Date.now() };
    s.status = 'waiting'; this.publish(s);
    return new Promise(resolve => {
      const finish = response => {
        if (!this.approvals.has(request.id)) return;
        this.approvals.delete(request.id); options.signal?.removeEventListener('abort', abort);
        s.status = run.stopped ? 'stopping' : (this.pending(s.id).length ? 'waiting' : 'running');
        this.emit('approvals', this.pending());
        try { this.publishCleanup(s); } finally { resolve(response); }
      };
      const abort = () => finish({ behavior: 'deny', message: '操作已取消', interrupt: true });
      this.approvals.set(request.id, { request, finish });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      else this.emit('approvals', this.pending());
    });
  }
  pending(id) { return [...this.approvals.values()].map(v => v.request).filter(r => !id || r.sessionId === id); }
  answer(id, allow, answers) {
    const p = this.approvals.get(id); if (!p) throw new Error('此授权请求已失效。');
    const input = { ...p.request.input };
    if (allow && p.request.name === 'AskUserQuestion') {
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('请回答问题。');
      for (const question of input.questions || []) {
        if (typeof answers[question.question] !== 'string' || !answers[question.question].trim()) throw new Error('请回答所有问题。');
      }
      input.answers = answers;
    }
    p.finish(allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '用户拒绝了此次操作。' });
  }
  async execute(s, prompt, cli, run) {
    let stderr = ''; let sawResult = false;
    const startupTimer = setTimeout(() => {
      if (run.finished || run.stopped) return;
      run.startupError = 'Claude 在 60 秒内没有返回启动信息。请检查 CLI 路径、登录状态、代理以及项目中的 MCP 配置。';
      this.stop(s.id);
    }, 60000);
    const timer = setInterval(() => {
      if (!run.dirty) return; run.dirty = false;
      try { this.publish(s); } catch { this.stop(s.id); }
    }, 500);
    try {
      const selectedModel = Object.hasOwn(s, 'model') ? s.model : this.store.settings.model;
      const options = {
        cwd: s.cwd, pathToClaudeCodeExecutable: cli, env: environment(),
        settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code' },
        permissionMode: 'default', includePartialMessages: true, abortController: run.controller,
        ...(s.providerSessionId ? { resume: s.providerSessionId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        canUseTool: (name, input, opts) => this.permission(s, run, name, input, opts),
        stderr: data => { stderr = (stderr + data).slice(-6000); },
        spawnClaudeCodeProcess: opts => {
          const js = /\.[cm]?js$/i.test(cli);
          const child = spawnCli(cli, js ? opts.args.slice(1) : opts.args, {cwd:opts.cwd,env:opts.env,stdio:['pipe','pipe','pipe']});
          // Own the whole process tree so tools do not linger after cancellation.
          const terminate = () => killTree(child);
          opts.signal.addEventListener('abort', terminate, { once: true });
          child.once('exit', () => opts.signal.removeEventListener('abort', terminate));
          child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-6000); });
          run.child = child; if (run.stopped) terminate(); return child;
        }
      };
      // Streaming input keeps stdin open for permission responses during the turn.
      async function* input() { yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: s.providerSessionId || '' }; }
      run.query = this.query({ prompt: input(), options });
      for await (const event of run.query) {
        clearTimeout(startupTimer);
        if (run.stopped) break;
        if (event.session_id && !s.providerSessionId) { s.providerSessionId = event.session_id; this.store.save(s); }
        s.lastEventAt = Date.now();
        run.dirty = true;
        if (event.type === 'tool_progress') s.activity = `正在执行工具 · ${event.tool_name}`;
        if (event.parent_tool_use_id) continue;
        if (event.type === 'stream_event') {
          const e = event.event;
          if (e.type === 'message_start') { run.streamId = e.message.id; s.activity = 'Claude 正在处理…'; }
          if ((e.type === 'content_block_start' && e.content_block.type === 'thinking') || (e.type === 'content_block_delta' && e.delta.type === 'thinking_delta')) s.activity = 'Claude 正在思考…';
          if (e.type === 'content_block_start' && e.content_block.type === 'tool_use') this.tool(s, run, e.content_block);
          if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') { this.textMessage(s, run, run.streamId || 'stream').text += e.delta.text; s.activity = '正在生成回复…'; }
        } else if (event.type === 'assistant') {
          const key = event.message.id || run.streamId || event.uuid;
          const text = event.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          if (text) {
            s.activity = '正在处理后续步骤…';
            const msg = this.textMessage(s, run, key);
            if (!msg.text || text.startsWith(msg.text)) msg.text = text;
            else if (!msg.text.includes(text)) msg.text += '\n' + text;
          }
          for (const block of event.message.content) if (block.type === 'tool_use') this.tool(s, run, block);
          if (!text && event.message.content.some(b => b.type === 'thinking')) s.activity = 'Claude 正在思考…';
        } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) if (block.type === 'tool_result') {
            const msg = run.tools.get(block.tool_use_id);
            if (msg) { msg.status = block.is_error ? 'error' : 'done'; msg.text = (typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')).slice(0, 20000); }
          }
          const activeTool = [...run.tools.values()].find(tool => tool.status === 'running');
          s.activity = activeTool ? `正在执行工具 · ${activeTool.name}` : '等待 Claude 继续回复…';
        } else if (event.type === 'system' && event.subtype === 'init') {
          s.activity = '已连接 Claude，等待回复…';
        } else if (event.type === 'system' && event.subtype === 'status') {
          s.activity = event.status === 'compacting' ? '正在整理对话上下文…' : '等待 Claude 继续回复…';
        } else if (event.type === 'system' && event.subtype === 'api_retry') {
          s.activity = `连接重试 ${event.attempt}/${event.max_retries}，请稍候…`;
        } else if (event.type === 'result') {
          sawResult = true; s.usage = { cost: event.total_cost_usd, duration: event.duration_ms }; s.activity = '';
          if (event.is_error || event.subtype !== 'success') { s.status = 'error'; this.notice(s, this.explainError((event.errors || [event.result || 'Claude 未能完成本次请求。']).join('\n'))); }
          else { s.status = 'idle'; if (!run.textIds.size && event.result) this.textMessage(s, run, 'result').text = event.result; }
          if (event.permission_denials?.length) this.notice(s, '有部分工具被现有权限规则拒绝。可查看 Claude 的配置后重试。');
          break;
        }
      }
      if (run.stopped) { s.status = run.startupError ? 'error' : 'interrupted'; this.notice(s, run.startupError || '已停止生成。收到的消息已保存；已执行的文件修改不会自动撤销。'); }
      else if (!sawResult) { s.status = 'error'; this.notice(s, 'Claude 提前结束，未返回完成状态。可以发送消息继续；若持续出现，请检查登录和 CLI 版本。'); }
    } catch (error) {
      s.status = run.stopped && !run.startupError ? 'interrupted' : 'error';
      this.notice(s, run.startupError || (run.stopped ? '已停止生成，已保留收到的内容。' : this.explainError(this.cleanError(error.message + (stderr ? '\n' + stderr : '')))));
    } finally {
      clearInterval(timer); clearTimeout(run.stopTimer); clearTimeout(startupTimer);
      const finalStatus = s.status;
      for (const item of [...this.approvals.values()]) if (item.request.sessionId === s.id) item.finish({ behavior: 'deny', message: '本次任务已结束', interrupt: true });
      s.status = finalStatus;
      try { run.query?.close(); } catch {}
      // SDK handles graceful close; enforce bounded cleanup as a fallback.
      const child = run.child; if (child && child.exitCode === null) setTimeout(() => killTree(child), 3000).unref();
      for (const tool of run.tools.values()) if (tool.status === 'running') tool.status = run.stopped ? 'interrupted' : 'unknown';
      s.activity = ''; s.runStartedAt = null; s.lastEventAt = null; s.updatedAt = Date.now(); run.finished = true; this.runs.delete(s.id);
      this.publishCleanup(s);
    }
  }
  cleanError(text) {
    let safe = text.replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏凭据]').replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]');
    for (const [key, value] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value?.length > 5) safe = safe.split(value).join('[已隐藏凭据]');
    return safe.slice(-6000);
  }
  explainError(text) {
    if (/UNKNOWN_CERTIFICATE_VERIFICATION_ERROR|certificate verification/i.test(text)) return `${text}\n\n处理建议：这是 HTTPS 证书校验问题。请检查代理、企业证书或安全软件的 HTTPS 检查；若代理环境变量只在终端中设置，请从同一终端启动 CLI Desk。`;
    if (/\b429\b|Service Unavailable/i.test(text)) return `${text}\n\n处理建议：服务暂时不可用或请求受到限制。请稍后重试，并检查账号额度、代理和服务状态。`;
    if (/Unable to connect|ECONN(?:REFUSED|RESET)|ENETUNREACH|ETIMEDOUT/i.test(text)) return `${text}\n\n处理建议：请检查网络、代理以及 Claude Code 的连接设置，然后重新发送。`;
    return text;
  }
  stop(id) {
    const run = this.runs.get(id); if (!run || run.stopped) return;
    run.stopped = true; const s = this.store.get(id); s.status = 'stopping';
    run.controller.abort();
    run.stopTimer = setTimeout(() => { killTree(run.child); try { run.query?.close(); } catch {} }, 2500);
    for (const p of [...this.approvals.values()]) if (p.request.sessionId === id) p.finish({ behavior: 'deny', message: '用户停止任务', interrupt: true });
    this.publishCleanup(s);
  }
  async shutdown() {
    const runs = [...this.runs.entries()]; for (const [id] of runs) this.stop(id);
    await Promise.race([Promise.allSettled(runs.map(([,r]) => r.done)), new Promise(resolve => setTimeout(resolve, 4000))]);
    for (const [,r] of runs) killTree(r.child);
  }
}
