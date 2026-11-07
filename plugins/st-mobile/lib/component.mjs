import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { once } from 'node:events';

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

/** 多久没收到数据就判定卡死（不是总时长——50 KB/s 下 15 MB 要 5 分钟，那是正常速度）。 */
const IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_ATTEMPTS = 4;

/**
 * 单次下载，支持断点续传。
 * 老实现是裸 fetch + pipeline：没有超时、没有续传，一旦卡住就是永久「启动中」。
 */
async function downloadOnce(url, destination, log) {
  const temporary = destination + '.part';
  let start = 0;
  try { start = fs.statSync(temporary).size; } catch { start = 0; }

  const controller = new AbortController();
  let idle = null;
  const arm = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      try { controller.abort(new Error('idle timeout')); } catch { /* ignore */ }
    }, IDLE_TIMEOUT_MS);
  };
  arm();

  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: start > 0 ? { Range: `bytes=${start}-` } : undefined,
    });
  } catch (error) {
    clearTimeout(idle);
    throw error;
  }

  if (response.status === 416 && start > 0) {
    // 续传起点已经等于文件尾：说明上次其实下完了
    clearTimeout(idle);
    return temporary;
  }
  if (!response.ok) {
    clearTimeout(idle);
    throw new Error(`下载失败 ${response.status}: ${url}`);
  }

  const resumed = start > 0 && response.status === 206;
  if (!resumed) start = 0;
  if (resumed && log) log('检测到未完成的下载，从 ' + Math.round(start / 1024) + ' KB 处续传');

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const out = fs.createWriteStream(temporary, { mode: 0o700, flags: resumed ? 'a' : 'w' });
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      arm();
      if (!out.write(chunk)) await once(out, 'drain');
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    throw error;
  } finally {
    clearTimeout(idle);
  }
  return temporary;
}

export async function download(url, destination, log = () => {}) {
  const temporary = destination + '.part';
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      await downloadOnce(url, destination, log);
      fs.renameSync(temporary, destination);
      return destination;
    } catch (error) {
      lastError = error;
      let partial = 0;
      try { partial = fs.statSync(temporary).size; } catch { partial = 0; }
      const reason = error?.name === 'AbortError' || /idle timeout/.test(error?.message || '')
        ? '超过 ' + IDLE_TIMEOUT_MS / 1000 + ' 秒没有收到数据'
        : (error?.message || '未知错误');
      if (attempt < DOWNLOAD_ATTEMPTS) {
        log('下载中断（第 ' + attempt + '/' + DOWNLOAD_ATTEMPTS + ' 次）：' + reason
          + (partial > 0 ? '，已缓存 ' + Math.round(partial / 1024) + ' KB，稍后续传' : ''));
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      } else {
        log('下载失败：' + reason);
      }
    }
  }
  throw new Error('组件下载失败（已重试 ' + DOWNLOAD_ATTEMPTS + ' 次）：'
    + (lastError?.message || '未知错误')
    + '。可手动下载放到 ' + destination + '，或用 ST_MOBILE_IROH_HOST 指向已有的 sidecar。来源: ' + url);
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
  let response;
  try {
    response = await fetch(`${CDN}/native/manifest.json`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(IDLE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error('无法获取 iroh 组件清单（网络或超时）：' + (error?.message || 'unknown')
      + '。可设置 ST_MOBILE_IROH_HOST 指向已有的 sidecar 跳过下载。');
  }
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
  await download(`${CDN}/native/${fileName}`, target.path, log);
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