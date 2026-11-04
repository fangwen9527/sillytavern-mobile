import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { STATE_DIR } from './config.mjs';

const LAN_DIR = path.join(STATE_DIR, 'lan');
/** 证书有效期下限：少于 7 天就重签。 */
const MIN_REMAINING_MS = 7 * 86400_000;

/** 用一次不会真正发包的 UDP connect 找出默认路由的出口 IP。 */
export function defaultRouteAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (value) => { try { socket.close(); } catch { /* ignore */ } resolve(value); };
    try {
      socket.connect(53, '8.8.8.8', () => {
        try { done(socket.address().address); } catch { done(null); }
      });
      socket.on('error', () => done(null));
    } catch { done(null); }
    setTimeout(() => done(null), 800);
  });
}

/** 选出用于局域网的 IPv4 地址：默认路由 IP 排第一，其余作为附加 SAN。 */
export async function lanAddresses() {
  const primary = await defaultRouteAddress();
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    if (/loopback|virtual|vmware|vbox|hyper-v|vethernet|docker|wsl|baby.?link/i.test(name)) continue;
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      result.push({ name, address: entry.address });
    }
  }
  result.sort((a, b) => {
    const score = (item) => (item.address === primary ? -100 : 0)
      + (/^192\.168\./.test(item.address) ? -10 : 0)
      + (/^10\./.test(item.address) ? -5 : 0);
    return score(a) - score(b);
  });
  if (primary && !result.some((item) => item.address === primary)) {
    result.unshift({ name: 'default', address: primary });
  }
  return result;
}

// ── openssl 查找 ──────────────────────────────────────────────
// 酒馆可能由计划任务/开机自启拉起，PATH 里未必有 Git 自带的 openssl，
// 所以不能只靠 PATH，必须给一批绝对路径兜底。
let resolvedOpenssl;
let lookedUp = false;

function opensslCandidates() {
  const exe = process.platform === 'win32' ? 'openssl.exe' : 'openssl';
  const list = [];
  if (process.env.ST_MOBILE_OPENSSL) list.push(process.env.ST_MOBILE_OPENSSL);
  list.push('openssl');

  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    list.push(path.join(dir, exe));
    // PATH 里只有 git.exe 时，顺着找它旁边的 mingw64/usr
    try {
      if (fs.existsSync(path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git'))) {
        list.push(path.join(dir, '..', 'mingw64', 'bin', exe));
        list.push(path.join(dir, '..', 'usr', 'bin', exe));
        list.push(path.join(dir, '..', '..', 'mingw64', 'bin', exe));
        list.push(path.join(dir, '..', '..', 'usr', 'bin', exe));
      }
    } catch { /* ignore */ }
  }

  const roots = ['C:', 'D:', 'E:'];
  for (const drive of roots) {
    for (const base of ['Program Files\\Git', 'Program Files (x86)\\Git', 'Git']) {
      const prefix = path.join(drive + path.sep, base);
      list.push(path.join(prefix, 'usr', 'bin', exe));
      list.push(path.join(prefix, 'mingw64', 'bin', exe));
    }
    list.push(path.join(drive + path.sep, 'Program Files', 'OpenSSL-Win64', 'bin', exe));
    list.push(path.join(drive + path.sep, 'Program Files', 'OpenSSL', 'bin', exe));
  }
  list.push('/usr/bin/openssl', '/usr/local/bin/openssl', '/opt/homebrew/bin/openssl');
  return [...new Set(list)];
}

/** 找到可用的 openssl；找不到返回 null（由调用方给出可读错误）。 */
export function resolveOpenssl() {
  if (lookedUp) return resolvedOpenssl;
  lookedUp = true;
  for (const candidate of opensslCandidates()) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore', timeout: 5000 });
      resolvedOpenssl = candidate;
      return candidate;
    } catch { /* 试下一个 */ }
  }
  resolvedOpenssl = null;
  return null;
}

function run(args, options = {}) {
  const bin = resolveOpenssl();
  if (!bin) throw new Error('找不到 openssl');
  return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

// ── 证书校验（纯 node，不再依赖 openssl）──────────────────────
/**
 * 用 node:crypto 直接解析现有证书。
 * 旧实现靠 `openssl x509 -text` 校验，一旦 PATH 里没有 openssl 就连"证书还有效"
 * 这种纯读取操作都会失败，进而逼着重签、然后重签又失败 → 局域网整体挂掉。
 */
export function inspectLanCert(certFile, addresses) {
  let cert;
  try {
    cert = new crypto.X509Certificate(fs.readFileSync(certFile));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const san = String(cert.subjectAltName || '');
  const missing = addresses
    .map((entry) => entry.address)
    .filter((address) => !san.includes('IP Address:' + address));
  if (missing.length) return { ok: false, reason: 'san_missing', missing };
  const end = Date.parse(cert.validTo);
  if (!Number.isFinite(end)) return { ok: false, reason: 'bad_expiry' };
  if (end - Date.now() < MIN_REMAINING_MS) return { ok: false, reason: 'expiring', validTo: cert.validTo };
  return { ok: true, validTo: cert.validTo };
}

/**
 * 用 iroh 那套 CA 给局域网 IP 签一张叶子证书。
 * 复用同一 CA 的好处：手机只要 pin 一次，局域网和 iroh 两条通道都认。
 */
export function ensureLanCertificate({ caCertPem, caKeyPem, addresses }) {
  fs.mkdirSync(LAN_DIR, { recursive: true, mode: 0o700 });
  const certFile = path.join(LAN_DIR, 'cert.pem');
  const keyFile = path.join(LAN_DIR, 'key.pem');

  let stale = { ok: false, reason: 'missing' };
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    stale = inspectLanCert(certFile, addresses);
    if (stale.ok) return { certFile, keyFile, regenerated: false, validTo: stale.validTo };
  }

  if (!resolveOpenssl()) {
    const detail = stale.reason === 'san_missing'
      ? '网卡地址变了（证书缺少 ' + (stale.missing || []).join(', ') + '）'
      : stale.reason === 'expiring' ? '证书即将过期' : '证书缺失或无法解析';
    throw new Error('局域网证书需要重新签发（' + detail + '），但系统里找不到 openssl。'
      + '装 Git for Windows 即可，或用 ST_MOBILE_OPENSSL 指定 openssl 路径。');
  }

  const caCertFile = path.join(LAN_DIR, 'ca.pem');
  const caKeyFile = path.join(LAN_DIR, 'ca-key.pem');
  fs.writeFileSync(caCertFile, caCertPem, { mode: 0o600 });
  fs.writeFileSync(caKeyFile, caKeyPem, { mode: 0o600 });

  const csrFile = path.join(LAN_DIR, 'server.csr');
  const extFile = path.join(LAN_DIR, 'ext.cnf');
  const san = addresses.map(({ address }) => 'IP:' + address).join(',');
  fs.writeFileSync(extFile, [
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=' + san,
    '',
  ].join('\n'), { mode: 0o600 });

  try {
    run(['ecparam', '-genkey', '-name', 'prime256v1', '-out', keyFile]);
    run(['req', '-new', '-key', keyFile, '-subj', '/CN=st-mobile-lan', '-out', csrFile]);
    run(['x509', '-req', '-in', csrFile, '-CA', caCertFile, '-CAkey', caKeyFile,
      '-set_serial', String(Date.now()), '-days', '90', '-extfile', extFile, '-out', certFile]);
  } finally {
    for (const file of [csrFile, extFile, caKeyFile, caCertFile]) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }

  const after = inspectLanCert(certFile, addresses);
  if (!after.ok) throw new Error('局域网证书签发后校验失败：' + after.reason);
  return { certFile, keyFile, regenerated: true, validTo: after.validTo };
}
