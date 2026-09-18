import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('src/index.html','utf8');
const workflow=fs.readFileSync('.github/workflows/release.yml','utf8');

test('sidebar shows the version as the brand subtitle and local storage notice by new chat',()=>{
  assert.doesNotMatch(html,/你的本地 AI 工作伙伴/);
  assert.match(html,/<div class="brand-title">CLI Desk<\/div><small id="version"/);
  assert.match(html,/<div class="new-chat-group"><button id="new-chat"[\s\S]*?记录保存在此电脑<\/div><\/div>/);
  assert.doesNotMatch(html,/<div class="sidebar-bottom">[^\n]*记录保存在此电脑/);
});

test('release commands receive an explicit GitHub repository outside a checkout',()=>{
  assert.match(workflow,/GH_TOKEN: \$\{\{ github\.token \}\}\s+GH_REPO: \$\{\{ github\.repository \}\}/);
});
