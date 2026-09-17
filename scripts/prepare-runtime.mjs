import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const nodeVersion = '24.14.1';

const targets = {
  'win32-x64': {
    archive: `node-v${nodeVersion}-win-x64.zip`,
    sha256: '6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70',
    binary: 'node.exe'
  },
  'darwin-arm64': {
    archive: `node-v${nodeVersion}-darwin-arm64.tar.gz`,
    sha256: '25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe',
    binary: 'bin/node'
  }
};

function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`下载 Node.js 运行环境失败：HTTP ${response.status}`);
  const temp = file + '.tmp';
  const output = fs.createWriteStream(temp);
  try {
    for await (const chunk of response.body) {
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
    fs.renameSync(temp, file);
  } catch (error) {
    output.destroy();
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export async function prepareRuntime() {
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`不支持的桌面构建平台：${process.platform}-${process.arch}`);
  const cache = path.resolve('.cache/node-runtime');
  const archive = path.join(cache, target.archive);
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(archive) || hash(archive) !== target.sha256) {
    fs.rmSync(archive, { force: true });
    console.log(`Downloading private Node.js ${nodeVersion} runtime...`);
    await download(`https://nodejs.org/dist/v${nodeVersion}/${target.archive}`, archive);
  }
  if (hash(archive) !== target.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error('Node.js 运行环境校验失败，已删除损坏的下载文件');
  }
  const extracted = path.join(cache, target.archive.replace(/\.(zip|tar\.gz)$/, ''));
  const root = path.join(extracted, `node-v${nodeVersion}-${process.platform === 'win32' ? 'win-x64' : 'darwin-arm64'}`);
  const source = path.join(root, target.binary);
  if (!fs.existsSync(source) || !fs.existsSync(path.join(root, 'LICENSE'))) {
    fs.rmSync(extracted, { recursive: true, force: true });
    fs.mkdirSync(extracted, { recursive: true });
    const result = spawnSync('tar', ['-xf', archive, '-C', extracted], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('无法解压 Node.js 运行环境');
  }
  const destination = path.resolve('dist/runtime');
  fs.mkdirSync(destination, { recursive: true });
  const binary = path.join(destination, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(source, binary);
  if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(destination, 'NODE-LICENSE.txt'));
  fs.writeFileSync(path.join(destination, 'runtime.json'), JSON.stringify({ name: 'Node.js', version: nodeVersion, sha256: target.sha256 }) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/prepare-runtime.mjs')) {
  await prepareRuntime();
}
