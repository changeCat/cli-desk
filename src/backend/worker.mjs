import readline from 'node:readline';
import path from 'node:path';
import { createService } from './service.mjs';

// Only the Rust parent owns this private stdio transport. No listening socket.
const root = process.argv[2], version = process.argv[3];
if (!root || !path.isAbsolute(root)) throw new Error('缺少绝对数据目录');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const service = createService({root, version, smoke:process.argv[4] === '--fixture', emit:(type,data) => emit({event:{type,data}})});
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 6000);
  try { await service.shutdown(); } finally { clearTimeout(deadline); process.exit(0); }
}
const input = readline.createInterface({input:process.stdin, crlfDelay:Infinity});
input.on('line', async line => {
  let request;
  try {
    if (line.length > 1200000) throw new Error('请求过大');
    request = JSON.parse(line);
    if (!Number.isSafeInteger(request.id) || typeof request.method !== 'string') throw new Error('无效的请求');
    if (closing) throw new Error('正在退出');
    const data = await service.request(request.method, request.payload);
    emit({id:request.id, ok:true, data});
    if (request.method === 'shutdown') await shutdown();
  } catch (error) { emit({id:request?.id, ok:false, error:error.message}); }
});
input.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
