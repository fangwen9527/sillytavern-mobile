import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/** 找 sidecar 可执行文件：优先项目自带，其次复用 dsh-mobile 已下载的组件。 */
export function locateSidecar() {
  const candidates = [
    process.env.ST_MOBILE_IROH_HOST,
    path.join(process.cwd(), 'bin', 'dsh-mobile-iroh-host-win32-x64.exe'),
    path.join(process.env.USERPROFILE || '', '.dsh/mobile-access/components/iroh/0.1.0-alpha.1/dsh-mobile-iroh-host-win32-x64.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

function runOnce(exe, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '',
      err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('sidecar one-shot timeout')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('sidecar exit ' + code + ': ' + err.trim()));
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try { resolve(JSON.parse(line)); } catch (e) { reject(new Error('bad sidecar output: ' + line)); }
    });
  });
}

export async function prepareTls(exe, dataDir, { renew = false } = {}) {
  const sub = renew ? 'tls-renew' : 'tls-prepare';
  return runOnce(exe, [sub, '--data-dir', dataDir, '--lang', 'zh']);
}

export async function readTlsStatus(exe, dataDir) {
  return runOnce(exe, ['tls-status', '--data-dir', dataDir]);
}

/**
 * 常驻 host 进程。事件通过 emitter 抛：ready / pairing / pairing-done / peer-connected /
 * peer-path / peer-disconnected / proxy-opened / devices / error / stopped。
 */
export class IrohHost extends EventEmitter {
  constructor({ exe, dataDir, proxyTarget, localOnly = false, lang = 'zh' }) {
    super();
    this.exe = exe;
    this.dataDir = dataDir;
    this.proxyTarget = proxyTarget;
    this.localOnly = localOnly;
    this.lang = lang;
    this.child = null;
    this.buffer = '';
    this.state = { endpointId: null, addresses: [], code: null, codeExpiresAt: 0, ready: false };
  }

  start() {
    const args = ['host', '--data-dir', this.dataDir, '--proxy-target', this.proxyTarget, '--lang', this.lang];
    if (this.localOnly) args.push('--local-only');
    const child = spawn(this.exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.onLine(line);
      }
    });
    // 关键：sidecar 每次拒绝连接都会写 stderr；不消费会写满管道把它卡死。
    child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString().trim()));
    child.on('close', (code) => { this.state.ready = false; this.emit('stopped', code); });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('iroh host ready timeout')), 45_000);
      this.once('ready', (info) => { clearTimeout(timer); resolve(info); });
      this.once('stopped', () => { clearTimeout(timer); reject(new Error('iroh host exited before ready')); });
    });
  }

  onLine(line) {
    let event;
    try { event = JSON.parse(line); } catch { this.emit('stderr', line); return; }
    if (event.type === 'ready') {
      this.state.endpointId = event.endpoint_id;
      this.state.addresses = event.direct_addresses || [];
      this.state.ready = true;
      this.emit('ready', event);
    } else if (event.type === 'pairing') {
      this.state.code = event.code;
      this.state.codeExpiresAt = Date.now() + (event.expires_in_sec || 600) * 1000;
      this.emit('pairing', event);
    } else {
      this.emit(event.type, event);
    }
  }

  command(payload) {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(JSON.stringify({ version: 1, ...payload }) + '\n');
  }

  beginPairing() { this.command({ type: 'pairing-begin' }); }
  listDevices() { this.command({ type: 'device-list' }); }
  forgetDevice(id) { this.command({ type: 'device-forget', id }); }

  async stop() {
    if (!this.child) return;
    try { this.command({ type: 'shutdown' }); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { this.child.kill(); } catch {} resolve(); }, 3000);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
      this.child.once('stopped', () => { clearTimeout(timer); resolve(); });
      try { this.child.kill(); } catch {}
    });
  }
}
