import { execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { STATE_DIR } from './config.mjs';

const LAN_DIR = path.join(STATE_DIR, 'lan');
const OPENSSL = process.platform === 'win32' ? 'openssl' : 'openssl';

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

function run(args, options = {}) {
  return execFileSync(OPENSSL, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function sanMatches(certPem, addresses) {
  for (const { address } of addresses) {
    if (certPem.includes('IP Address:' + address) || certPem.includes('IP:' + address)) return true;
    // OpenSSL 输出的 SAN 是二进制扩展，用 -text 检查太慢；改用命令行读取
  }
  try {
    const text = run(['x509', '-in', path.join(LAN_DIR, 'cert.pem'), '-noout', '-text']).toString();
    return addresses.every(({ address }) => text.includes('IP Address:' + address));
  } catch {
    return false;
  }
}

/**
 * 用 iroh 那套 CA 给局域网 IP 签一张叶子证书。
 * 复用同一 CA 的好处：手机只要 pin 一次，局域网和 iroh 两条通道都认。
 */
export function ensureLanCertificate({ caCertPem, caKeyPem, addresses }) {
  fs.mkdirSync(LAN_DIR, { recursive: true, mode: 0o700 });
  const certFile = path.join(LAN_DIR, 'cert.pem');
  const keyFile = path.join(LAN_DIR, 'key.pem');

  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    try {
      const text = run(['x509', '-in', certFile, '-noout', '-text']).toString();
      const covers = addresses.every(({ address }) => text.includes('IP Address:' + address));
      const expiry = run(['x509', '-in', certFile, '-noout', '-enddate']).toString();
      const end = Date.parse(expiry.replace('notAfter=', '').trim());
      if (covers && end - Date.now() > 7 * 86400_000) {
        return { certFile, keyFile, regenerated: false };
      }
    } catch { /* 重新签 */ }
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

  run(['ecparam', '-genkey', '-name', 'prime256v1', '-out', keyFile]);
  run(['req', '-new', '-key', keyFile, '-subj', '/CN=st-mobile-lan', '-out', csrFile]);
  run(['x509', '-req', '-in', csrFile, '-CA', caCertFile, '-CAkey', caKeyFile,
    '-set_serial', String(Date.now()), '-days', '90', '-extfile', extFile, '-out', certFile]);

  for (const file of [csrFile, extFile, caKeyFile]) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  return { certFile, keyFile, regenerated: true };
}