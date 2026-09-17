import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {prepareRuntime} from './prepare-runtime.mjs';
await prepareRuntime();
fs.mkdirSync('dist/ui',{recursive:true});
fs.mkdirSync('dist/backend',{recursive:true});
await build({entryPoints:['src/backend/worker.mjs'],outfile:'dist/backend/worker.mjs',bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"}});
await build({entryPoints:['src/renderer.mjs'],outfile:'dist/ui/renderer.js',bundle:true,minify:true,platform:'browser',format:'iife',target:'chrome100',define:{'import.meta.env.DEV':process.env.CLI_DESK_DEBUG==='1'?'true':'false'}});
for(const name of ['index.html','style.css'])fs.copyFileSync('src/'+name,'dist/ui/'+name);
fs.copyFileSync('build/icon.svg','dist/ui/icon.svg');
const licenses=[];
for(const pkg of ['@anthropic-ai/claude-agent-sdk','@anthropic-ai/sdk','@modelcontextprotocol/sdk','zod','@tauri-apps/api','dompurify','marked']) {
  const root=path.join('node_modules',pkg);
  for(const name of ['LICENSE','LICENSE.md','LICENSE.txt','LICENSE_MIT','COPYING','README.md']) {
    const file=path.join(root,name);
    if(fs.existsSync(file)) {licenses.push('\n\n===== '+pkg+' / '+name+' =====\n'+fs.readFileSync(file,'utf8'));if(name!=='README.md')break;}
  }
}
fs.writeFileSync('dist/backend/THIRD_PARTY_NOTICES.txt',licenses.join(''));
