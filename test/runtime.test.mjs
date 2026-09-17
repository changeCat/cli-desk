import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCli } from '../src/platform/cli-runtime.mjs';
const resolveWindows = file => resolveCli(file,process.env,{platform:'win32'});
const root = path.resolve('test-artifacts');
fs.mkdirSync(root,{recursive:true});
function install(bin, files) {
  const dir = fs.mkdtempSync(path.join(root,'runtime-'));
  const pkg = path.join(dir,'node_modules','@anthropic-ai','claude-code');
  fs.mkdirSync(pkg,{recursive:true});
  fs.writeFileSync(path.join(dir,'claude.cmd'),'@echo THIS SHIM MUST NOT BE EXECUTED\r\nexit /b 99');
  fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@anthropic-ai/claude-code',bin}));
  for (const file of files) { const target=path.join(pkg,file); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,'fixture'); }
  return {dir,pkg,shim:path.join(dir,'claude.cmd')};
}
test('npm native Windows shim resolves bin/claude.exe without executing the shim',()=>{
  const {pkg,shim}=install({claude:'bin/claude.exe'},['bin/claude.exe','cli.js']);
  assert.equal(resolveWindows(shim),path.join(pkg,'bin','claude.exe'));
  assert.equal(resolveWindows('"'+shim+'"'),path.join(pkg,'bin','claude.exe'));
});
test('legacy npm JS entry remains supported, including string bin metadata',()=>{
  const {pkg,shim}=install('cli.js',['cli.js']);
  assert.equal(resolveWindows(shim),path.join(pkg,'cli.js'));
});
test('extensionless npm launcher and native fallback work without package metadata',()=>{
  const {dir,pkg}=install({claude:'bin/claude.exe'},['bin/claude.exe']);
  fs.writeFileSync(path.join(dir,'claude'),'shell fixture');
  fs.unlinkSync(path.join(pkg,'package.json'));
  assert.equal(resolveWindows(path.join(dir,'claude')),path.join(pkg,'bin','claude.exe'));
});
test('invalid npm entry cannot escape its package and directories are not executables',()=>{
  const {pkg,shim}=install({claude:'../../../outside.exe'},[]);
  fs.writeFileSync(path.resolve(pkg,'../../../outside.exe'),'fixture');
  assert.throws(()=>resolveWindows(shim),/未找到此启动脚本/);
  fs.mkdirSync(path.join(pkg,'bin','claude.exe'),{recursive:true});
  assert.throws(()=>resolveWindows(shim),/未找到此启动脚本/);
});
test('bare claude discovers the npm native entry using PATH on Windows', {skip:process.platform!=='win32'},()=>{
  const {dir,pkg}=install({claude:'bin/claude.exe'},['bin/claude.exe']);
  const env={...process.env};
  for(const key of Object.keys(env)) if(key.toLowerCase()==='path') delete env[key];
  env.PATH=dir; env.PATHEXT='.CMD;.EXE';
  assert.equal(resolveCli('claude',env),path.join(pkg,'bin','claude.exe'));
});

test('macOS GUI discovery finds native CLI in the user local bin directory',()=>{
  const home=fs.mkdtempSync(path.join(root,'mac-home-'));
  const native=path.join(home,'.local','bin','claude');fs.mkdirSync(path.dirname(native),{recursive:true});
  fs.writeFileSync(native,'#!/bin/sh\nexit 0\n');fs.chmodSync(native,0o755);
  assert.equal(resolveCli('',{PATH:''},{platform:'darwin',home}),fs.realpathSync(native));
  assert.equal(resolveCli(native,{},{platform:'darwin',home}),fs.realpathSync(native));
});
test('macOS npm symlink resolves to its JS entry', {skip:process.platform==='win32'},()=>{
  const home=fs.mkdtempSync(path.join(root,'mac-npm-'));
  const entry=path.join(home,'npm','cli.js'),link=path.join(home,'.local','bin','claude');
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.mkdirSync(path.dirname(link),{recursive:true});
  fs.writeFileSync(entry,'// npm fixture');fs.symlinkSync(entry,link);
  assert.equal(resolveCli('claude',{PATH:''},{platform:'darwin',home}),entry);
});
