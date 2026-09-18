import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('src/index.html','utf8');
const workflow=fs.readFileSync('.github/workflows/release.yml','utf8');
const tauri=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8'));
const native=fs.readFileSync('src-tauri/src/main.rs','utf8');
const desktop=fs.readFileSync('src/desktop.mjs','utf8');
const backend=fs.readFileSync('src/backend/service.mjs','utf8');

test('sidebar shows the version as the brand subtitle and local storage notice beside conversation heading',()=>{
  assert.doesNotMatch(html,/你的本地 AI 工作伙伴/);
  assert.match(html,/<div class="brand-title">CLI Desk<\/div><small id="version"/);
  const newChat=html.match(/<button id="new-chat"[\s\S]*?<\/button>/)?.[0] || '';
  assert.doesNotMatch(newChat,/记录保存在此电脑/);
  assert.match(html,/<div class="list-heading">[\s\S]*?对话记录[\s\S]*?记录保存在此电脑[\s\S]*?id="count"/);
  assert.doesNotMatch(html,/new-chat-group/);
  assert.doesNotMatch(html,/<div class="sidebar-bottom">[^\n]*记录保存在此电脑/);
});

test('release commands receive an explicit GitHub repository outside a checkout',()=>{
  assert.match(workflow,/GH_TOKEN: \$\{\{ github\.token \}\}\s+GH_REPO: \$\{\{ github\.repository \}\}/);
});

test('only version tags trigger the single release workflow',()=>{
  assert.equal(fs.existsSync('.github/workflows/build-installers.yml'),false);
  assert.match(workflow,/tags:\s+- 'v\*'/);
  assert.match(workflow,/npm run verify:installer/);
});

test('checking for updates does not require signed updater artifacts',()=>{
  assert.equal(tauri.bundle.createUpdaterArtifacts,undefined);
  assert.equal(tauri.plugins?.updater,undefined);
  assert.doesNotMatch(workflow,/TAURI_SIGNING_PRIVATE_KEY|latest-update\.mjs|app\.tar\.gz\.sig/);
});

test('manual update controls stay at the bottom of settings and runtime trace is removed',()=>{
  assert.ok(html.indexOf('class="update-panel"')>html.indexOf('class="data-section"'));
  assert.match(html,/id="check-update"[^>]*>↻ 检测/);
  assert.match(html,/id="download-update"[^>]*>↓ 重新下载/);
  assert.doesNotMatch(html,/terminal-toggle|terminal-panel|运行现场/);
  assert.doesNotMatch(desktop,/['"]trace['"]/);
  assert.doesNotMatch(backend,/traceList/);
});

test('external links use the themed confirmation dialog before native opening',()=>{
  const renderer=fs.readFileSync('src/renderer.mjs','utf8');
  assert.match(renderer,/confirmAction\(\{title:'打开外部链接？'/);
  assert.match(renderer,/api\.link\(\{url:url\.toString\(\),confirmed:true\}\)/);
  assert.match(native,/confirmed_external_url\(&payload\)/);
  assert.doesNotMatch(native,/confirm\(&app, "打开外部链接？"/);
});

test('composer exposes workspace attachments and only Ctrl-based shortcut labels',()=>{
  const renderer=fs.readFileSync('src/renderer.mjs','utf8');
  assert.match(html,/id="attach-files"/);
  assert.match(html,/Enter 发送，Ctrl \+ Enter 换行/);
  assert.match(html,/Enter 换行，Ctrl \+ Enter 发送/);
  assert.match(renderer,/setRangeText\('\\n',start,end,'end'\)/);
  assert.doesNotMatch(html,/Shift \+ Enter/);
});

test('conversation UI groups each turn and collapses execution steps by default',()=>{
  const renderer=fs.readFileSync('src/renderer.mjs','utf8');
  assert.match(renderer,/conversation-turn/);
  assert.match(renderer,/execution-process/);
  assert.match(renderer,/lastTool/);
  assert.match(renderer,/role==='user' \? '◌' : '✳'/);
});

test('message labels and duration sit outside cards and inside composer respectively',()=>{
  const renderer=fs.readFileSync('src/renderer.mjs','utf8');
  assert.match(renderer,/wrapper\.append\(questionLabel,question\)/);
  assert.match(renderer,/wrapper\.append\(answerLabel,answer\)/);
  assert.match(html,/class="composer-meta"[\s\S]*?id="usage"[\s\S]*?class="composer-actions"/);
  assert.doesNotMatch(html,/footer-hint/);
});

test('minimize keeps the native taskbar window visible',()=>{
  assert.doesNotMatch(native,/is_minimized\(\)[\s\S]{0,120}win\.hide\(\)/);
});

test('local answer paths use a scoped reveal action and wide conversations remain fluid',()=>{
  const renderer=fs.readFileSync('src/renderer.mjs','utf8');
  const css=fs.readFileSync('src/style.css','utf8');
  assert.match(renderer,/enhanceLocalPaths\(body\)/);
  assert.match(renderer,/localPathButton\(file\.relativePath\)/);
  assert.match(renderer,/name=localPathButton\(item\.relativePath\)/);
  assert.match(renderer,/api\.reveal\(\{id:current\.id,path:localPath\.dataset\.path\}\)/);
  assert.match(desktop,/'reveal'/);
  assert.match(native,/target\.starts_with\(&root\)/);
  assert.match(css,/#messages\{width:100%;max-width:none/);
});

test('installer requests graceful app exit and removes the tray icon before shutdown',()=>{
  const installer=fs.readFileSync('src-tauri/nsis/installer.nsi','utf8');
  assert.match(installer,/--quit-for-update/);
  assert.match(native,/remove_tray_by_id\(TRAY_ID\)/);
});
