import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
export function buildEnvironment() {
  const env = {...process.env};
  const localCargo = path.resolve('.cache/cargo');
  if (fs.existsSync(path.join(localCargo,'bin',process.platform==='win32'?'cargo.exe':'cargo'))) {
    env.CARGO_HOME = localCargo; env.RUSTUP_HOME = path.resolve('.cache/rustup');
    const key = Object.keys(env).find(k=>k.toLowerCase()==='path') || 'PATH';
    env[key] = path.join(localCargo,'bin') + path.delimiter + (env[key] || '');
  }
  return env;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/tauri.mjs')) {
  const args = process.argv.slice(2), env = buildEnvironment();
  env.CLI_DESK_DEBUG = args.includes('--debug') || args[0] === 'dev' ? '1' : '0';
  const result = args[0] === 'test'
    ? spawnSync('cargo',['test','--manifest-path','src-tauri/Cargo.toml','--locked'],{stdio:'inherit',env})
    : spawnSync(process.execPath,[require.resolve('@tauri-apps/cli/tauri.js'),...args],{stdio:'inherit',env});
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
