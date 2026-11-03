import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { STATE_DIR } from './config.mjs';

/** 与 dsh-mobile 保持一致的组件坐标：iroh 主机端预编译产物。 */
const PACKAGE = 'dsh-mobile-iroh';
const VERSION = '0.1.0-alpha.1';
const CDN = `https://unpkg.com/${PACKAGE}@${VERSION}`;
const COMPONENT_DIR = path.join(STATE_DIR, 'components', `${PACKAGE}@${VERSION}`);

function platformKey() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  return null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + '.part';
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { mode: 0o700 }));
  fs.renameSync(temporary, destination);
  return destination;
}

/** 本地已存在且校验通过的副本。 */
function existingInstalled() {
  const platform = platformKey();
  if (!platform) return null;
  return { path: path.join(COMPONENT_DIR, `dsh-mobile-iroh-host-${platform}${platform === 'win32-x64' ? '.exe' : ''}`), platform };
}

/** 复用 dsh-mobile 插件已经下载好的副本（同一台机器上很常见）。 */
function dshMobileCopy(platform) {
  const base = path.join(os.homedir(), '.dsh', 'mobile-access', 'components', 'iroh', VERSION);
  const file = path.join(base, `dsh-mobile-iroh-host-${platform}${platform === 'win32-x64' ? '.exe' : ''}`);
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

async function readManifest() {
  const response = await fetch(`${CDN}/native/manifest.json`, { redirect: 'follow' });
  if (!response.ok) throw new Error('无法获取 iroh 组件清单: ' + response.status);
  return response.json();
}

/**
 * 确保 iroh sidecar 可用。顺序：环境变量 → 本地缓存 → dsh-mobile 副本 → 下载。
 * 所有本地副本都会做 SHA-256 校验，不匹配就重新下载。
 */
export async function ensureSidecar({ log = () => {}, forceDownload = false } = {}) {
  const explicit = process.env.ST_MOBILE_IROH_HOST;
  if (explicit && fs.existsSync(explicit)) {
    log('sidecar 来自 ST_MOBILE_IROH_HOST: ' + explicit);
    return explicit;
  }

  const platform = platformKey();
  if (!platform) throw new Error('当前平台没有 iroh sidecar 发行版（只提供 win32-x64 / linux-x64）');

  const target = existingInstalled();
  const manifest = await readManifest();
  const entry = manifest?.targets?.[platform] ?? manifest?.[platform];
  const expectedSha = entry?.sha256 ?? entry?.sha256sum ?? null;
  const expectedBytes = entry?.bytes ?? entry?.size ?? null;

  if (!forceDownload && fs.existsSync(target.path)) {
    const actual = await sha256File(target.path);
    if (!expectedSha || actual === expectedSha) {
      log('sidecar 命中本地缓存');
      return target.path;
    }
    log('本地 sidecar 校验失败，准备重新下载');
  }

  if (!forceDownload) {
    const shared = dshMobileCopy(platform);
    if (shared) {
      const actual = await sha256File(shared);
      if (!expectedSha || actual === expectedSha) {
        fs.mkdirSync(path.dirname(target.path), { recursive: true, mode: 0o700 });
        fs.copyFileSync(shared, target.path);
        fs.chmodSync(target.path, 0o700);
        log('复用 dsh-mobile 已下载的 sidecar 副本');
        return target.path;
      }
    }
  }

  log('正在下载 iroh sidecar（约 15 MB）…');
  const fileName = path.basename(target.path);
  await download(`${CDN}/native/${fileName}`, target.path);
  fs.chmodSync(target.path, 0o700);

  const actual = await sha256File(target.path);
  if (expectedSha && actual !== expectedSha) {
    try { fs.unlinkSync(target.path); } catch { /* ignore */ }
    throw new Error('sidecar 校验失败：下载内容与清单不符');
  }
  const size = fs.statSync(target.path).size;
  if (expectedBytes && size !== expectedBytes) throw new Error('sidecar 大小不符: ' + size);
  log('sidecar 就绪: ' + target.path);
  return target.path;
}

export const SIDECAR_INFO = { PACKAGE, VERSION, CDN };