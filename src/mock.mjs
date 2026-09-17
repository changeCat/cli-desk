// Deterministic integration fixture. Disabled in packaged builds.
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
    const approved = await options.canUseTool('Write', { file_path:'example.txt', content:'经过确认后写入' }, { signal:options.abortController.signal });
    if (stopped || options.abortController.signal.aborted) throw new Error('aborted');
    yield { type:'assistant', session_id, message:{id:'final-' + Date.now(),content:[{type:'text',text:approved.behavior === 'allow' ? '已收到允许。' : '已拒绝此次操作。'}]} };
    yield { type:'result', subtype:'success', session_id, is_error:false, total_cost_usd:0, duration_ms:500 };
  })();
  iterator.close = () => { stopped = true; }; return iterator;
}
