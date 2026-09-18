// Deterministic integration fixture. Disabled in packaged builds.
import fs from 'node:fs';
import path from 'node:path';

export function fakeQuery({ options }) {
  let stopped = false;
  const delay = () => new Promise(r => setTimeout(r, 100));
  const iterator = (async function* () {
    const session_id = options.resume || 'mock-session-' + Date.now();
    yield { type:'system', subtype:'init', session_id };
    const messageId = 'msg-' + Date.now();
    yield { type:'stream_event', session_id, event:{ type:'message_start', message:{id:messageId} } };
    for (const chunk of ['这是一个','**测试回复**。\n\n','```js\nconsole.log("你好");\n```\n','链接与图片会安全处理。 <img src=x onerror="window.hacked=true">']) {
      await delay(); if (stopped || options.abortController.signal.aborted) throw new Error('aborted');
      yield { type:'stream_event', session_id, event:{ type:'content_block_delta', delta:{type:'text_delta',text:chunk} } };
    }
    const tool={id:'mock-tool-'+Date.now(),type:'tool_use',name:'Write',input:{file_path:'example.txt',content:'经过确认后写入'}};
    yield {type:'stream_event',session_id,event:{type:'content_block_start',content_block:tool}};
    const approved = await options.canUseTool(tool.name,tool.input,{ signal:options.abortController.signal });
    if (stopped || options.abortController.signal.aborted) throw new Error('aborted');
    yield {type:'user',session_id,message:{content:[{type:'tool_result',tool_use_id:tool.id,is_error:approved.behavior!=='allow',content:approved.behavior==='allow'?'已写入':'已拒绝'}]}};
    const generated=path.join(options.cwd,'example.txt');
    if (approved.behavior === 'allow') fs.writeFileSync(generated,'fixture');
    yield { type:'assistant', session_id, message:{id:'final-' + Date.now(),content:[{type:'text',text:approved.behavior === 'allow' ? `已收到允许。文件位于 \`${generated}\`。` : '已拒绝此次操作。'}]} };
    yield { type:'result', subtype:'success', session_id, is_error:false, total_cost_usd:0, duration_ms:500 };
  })();
  iterator.close = () => { stopped = true; }; return iterator;
}
