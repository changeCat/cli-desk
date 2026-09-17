import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8'));
const template=fs.readFileSync('src-tauri/nsis/installer.nsi','utf8');

test('NSIS reinstalls and upgrades in place; desktop shortcut is opt-in',()=>{
  assert.equal(config.identifier,'app.clidesk.desktop');
  assert.equal(config.bundle.windows.nsis.installMode,'currentUser');
  assert.equal(config.bundle.windows.nsis.template,'nsis/installer.nsi');
  assert.match(template,/Reinstalling the same version[\s\S]*?StrCpy \$ReinstallPageCheck 2\s+Abort/);
  assert.match(template,/Reinstalling the same version[\s\S]*?StrCpy \$ReinstallPageCheck 2\s+Abort/);
  assert.match(template,/Upgrading[\s\S]*?StrCpy \$ReinstallPageCheck 2\s+Abort/);
  assert.match(template,/!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED/);
});
