import fs from 'node:fs';
import path from 'node:path';

import { DEVICES_FILE, IROH_LOCAL_PORT, SIDECAR_DIR, ensureStateDir, readBasicAuth, upstreamTarget } from './config.mjs';
import { ensureSidecar } from './component.mjs';
import { IrohHost, prepareTls, readTlsStatus } from './sidecar.mjs';
import { Gateway } from './gateway.mjs';
import { buildDescriptor, caFingerprint, irohHostname } from './pairing.mjs';
import { ensureLanCertificate, lanAddresses } from './lan.mjs';
import { persistRecoveredReply } from './background-gen.mjs';
import { loadSettings, saveSettings } from './settings.mjs';

const LAN_PORT = Number(process.env.ST_MOBILE_LAN_PORT || 8443);
/**
 * 局域网端口候选表。
 * Windows 会把一些区间整段保留给 Hyper-V/WSL（`netsh interface ipv4 show excludedportrange`），
 * 一旦 8443 落进保留段就会 EACCES，所以必须能自动换端口。
 */
const LAN_PORT_CANDIDATES = [LAN_PORT, 18443, 28443, 38443, 15443, 24443];

function loadDevices() {
  const devices = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    for (const record of data.devices || []) devices.set(record.deviceToken, record);
  } catch { /* 首次运行 */ }
  return devices;
}

function saveDevices(devices) {
  fs.writeFileSync(DEVICES_FILE, JSON.stringify({ version: 1, devices: [...devices.values()] }, null, 2), { mode: 0o600 });
}

function pemToDer(pem) {
  const match = String(pem).match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!match) throw new Error('无法解析 CA 证书');
  return Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
}

/** 编排 sidecar、网关、局域网与配对状态。 */
export class Bridge {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.state = 'stopped';
    this.error = null;
    this.host = null;
    this.gateway = null;
    this.devices = loadDevices();
    this.descriptor = null;
    this.lanUrl = null;
    this.endpointId = null;
    this.hostname = null;
    this.origin = null;
    this.peerPath = null;
    this.connectedPeers = 0;
    this.startedAt = 0;
    this.sidecarPath = null;
    this.localOnly = false;
    this.lanInfo = null;
    /** 局域网通道失败原因（找不到 openssl、端口占用、证书签不出来……）。 */
    this.lanError = null;
    /** 最近的后台代跑记录（面板/状态里看得见，便于排查）。 */
    this.recovered = [];
    this.settings = loadSettings();
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      endpointId: this.endpointId,
      hostname: this.hostname,
      origin: this.origin,
      localPort: IROH_LOCAL_PORT,
      upstream: upstreamTarget(),
      devices: [...this.devices.values()].map(({ deviceToken, ...rest }) => rest),
      descriptor: this.descriptor,
      lanUrl: this.lanUrl,
      lan: this.lanInfo,
      lanError: this.lanError,
      lanRequests: this.gateway?.lanRequests ?? 0,
      lastLanRequest: this.gateway?.lastLanRequest ?? null,
      recovered: this.recovered.slice(-10),
      settings: { ...this.settings },
      peerPath: this.peerPath,
      connectedPeers: this.connectedPeers,
      startedAt: this.startedAt,
      sidecar: this.sidecarPath,
      localOnly: this.localOnly,
    };
  }

  async start({ localOnly = false, withLan = true } = {}) {
    if (this.state === 'starting' || this.state === 'running') return this.status();
    this.state = 'starting';
    this.error = null;
    this.localOnly = localOnly;

    try {
      ensureStateDir();
      const exe = await ensureSidecar({ log: this.log });
      this.sidecarPath = exe;

      let tls;
      try {
        tls = await readTlsStatus(exe, SIDECAR_DIR);
      } catch {
        this.log('首次运行：生成 iroh 身份与证书…');
        tls = await prepareTls(exe, SIDECAR_DIR);
      }

      this.endpointId = tls.endpointId;
      this.hostname = irohHostname(tls.endpointId);

      const caPem = fs.readFileSync(tls.tls.caFile, 'utf8');
      const caDer = pemToDer(caPem);
      const cert = fs.readFileSync(tls.tls.certFile);
      const key = fs.readFileSync(tls.tls.keyFile);
      const basicAuth = readBasicAuth();

      this.gateway = new Gateway({
        cert, key, caDer,
        upstream: upstreamTarget(),
        basicAuth,
        devices: this.devices,
        onDevicesChanged: (map) => saveDevices(map),
        log: this.log,
        onGenerationOrphaned: (job) => this.recoverOrphaned(job),
        autoRecoverEnabled: () => this.settings.backgroundRecover,
      });
      const port = await this.gateway.start();
      this.log('iroh 网关监听 127.0.0.1:' + port);

      if (withLan) {
        try {
          const addresses = await lanAddresses();
          const stateFile = path.join(SIDECAR_DIR, 'tls-state.json');
          const tlsState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          const lanCert = ensureLanCertificate({
            caCertPem: tlsState.ca_certificate,
            caKeyPem: tlsState.ca_private_key,
            addresses,
          });
          const lanCertPem = fs.readFileSync(lanCert.certFile);
          const lanKeyPem = fs.readFileSync(lanCert.keyFile);
          let lanPort = null;
          let portError = null;
          for (const candidate of [...new Set(LAN_PORT_CANDIDATES)]) {
            try {
              lanPort = await this.gateway.startLan({
                cert: lanCertPem,
                key: lanKeyPem,
                port: candidate,
                addresses: addresses.map((entry) => entry.address),
              });
              break;
            } catch (error) {
              portError = error;
              if (!['EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL'].includes(error.code)) throw error;
              this.log('局域网端口 ' + candidate + ' 不可用（' + error.code + '），换下一个');
            }
          }
          if (lanPort === null) {
            throw new Error('没有可用的局域网端口：' + (portError ? portError.code + ' ' + portError.message : '全部候选失败'));
          }
          this.lanInfo = {
            port: lanPort,
            addresses: addresses.map((entry) => entry.address),
            primary: addresses[0]?.address || null,
            regenerated: lanCert.regenerated,
          };
          this.lanError = null;
          this.log('局域网网关监听 0.0.0.0:' + lanPort + '（' + addresses.map((a) => a.address).join(', ') + '）'
            + (lanCert.regenerated ? '，证书已重签' : '，证书沿用缓存'));
        } catch (lanError) {
          this.log('局域网通道启动失败（iroh 不受影响）: ' + lanError.message);
          this.lanInfo = null;
          this.lanError = lanError.message;
        }
      }

      this.host = new IrohHost({ exe, dataDir: SIDECAR_DIR, proxyTarget: '127.0.0.1:' + port, localOnly });
      this.host.on('stderr', (line) => this.log('sidecar: ' + line));
      this.host.on('pairing-done', (event) => this.log('配对成功: ' + event.name));
      this.host.on('peer-connected', () => { this.connectedPeers += 1; });
      this.host.on('peer-disconnected', () => { this.connectedPeers = Math.max(0, this.connectedPeers - 1); });
      this.host.on('peer-path', (event) => { this.peerPath = event.kind; });
      this.host.on('stopped', (code) => {
        this.state = 'stopped';
        this.log('sidecar 退出: ' + code);
      });

      const ready = await this.host.start();
      this.origin = 'https://' + this.hostname + ':' + IROH_LOCAL_PORT;
      this.startedAt = Date.now();
      this.state = 'running';
      this.log('iroh 端点就绪: ' + this.endpointId);
      if (localOnly) this.log('local-only 直连地址: ' + (ready.direct_addresses || []).join(', '));
      return this.status();
    } catch (error) {
      this.state = 'failed';
      this.error = error.message;
      this.log('启动失败: ' + error.message);
      await this.stop().catch(() => {});
      this.state = 'failed';
      return this.status();
    }
  }

  /**
   * 生成一次配对。iroh 需要 sidecar 的 6 位码，局域网只需要 URL fragment。
   * 两者共用同一个一次性 token —— 先扫哪个，另一个立即失效。
   */
  async newPairing(ttlMs = 600_000) {
    if (this.state !== 'running') throw new Error('服务还没就绪（当前状态: ' + this.state + '）');
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 sidecar 配对码超时')), 20_000);
      this.host.once('pairing', (event) => { clearTimeout(timer); resolve(event.code); });
      this.host.beginPairing();
    });
    const open = this.gateway.openPairing(ttlMs);
    const expiresAt = Math.min(open.expiresAt, Date.now() + 600_000);

    const { text, descriptor } = buildDescriptor({
      endpointId: this.endpointId,
      localPort: IROH_LOCAL_PORT,
      irohCode: code,
      gatewayToken: open.token,
      caDer: this.gateway.caDer,
      expiresAt,
    });
    this.descriptor = descriptor;

    let lanUrl = null;
    if (this.lanInfo?.primary) {
      const fingerprint = caFingerprint(this.gateway.caDer);
      lanUrl = 'https://' + this.lanInfo.primary + ':' + this.lanInfo.port +
        '/mobile-access/pair#key=dsh2.' + fingerprint + '.' + open.token;
      this.lanUrl = lanUrl;
    }

    return { text, descriptor, lanUrl, expiresAt };
  }

  /** 改开关：即时生效，网关每次请求现读，不用重启酒馆。 */
  updateSettings(patch) {
    this.settings = saveSettings(this.settings, patch);
    if (this.gateway) this.gateway.autoRecoverEnabled = () => this.settings.backgroundRecover;
    this.log('设置已更新：断线代跑 = ' + (this.settings.backgroundRecover ? '开' : '关'));
    return { ...this.settings };
  }

  /**
   * 手机在生成途中断开，上游仍跑完后的落盘处理。
   * 只有拿到 2xx 和正文才写；聊天身份缺失时只记一条日志，不猜。
   */
  recoverOrphaned({ hint, text, status, startedAt, finishedAt }) {
    const chars = String(text || '').trim().length;
    if (status < 200 || status >= 300) {
      this.log('后台代跑：上游返回 ' + status + '，不落盘');
      return;
    }
    if (!chars) {
      this.log('后台代跑：回复为空，不落盘');
      return;
    }
    if (!hint) {
      this.log('后台代跑：缺少聊天身份（前端没带 x-stm-chat），已丢弃 ' + chars + ' 字');
      return;
    }
    let result;
    try {
      result = persistRecoveredReply({ hint, text, startedAt, finishedAt });
    } catch (error) {
      result = { ok: false, reason: 'exception', error: error.message };
    }
    this.recovered.push({
      at: Date.now(),
      ok: Boolean(result.ok),
      mode: result.mode || null,
      chars,
      file: result.file || hint.file,
      folder: hint.folder || '',
      intent: hint.intent,
      reason: result.reason || null,
      error: result.error || null,
    });
    if (this.recovered.length > 50) this.recovered.shift();
    if (result.ok) {
      this.log('后台代跑：手机中途断开，已把 ' + chars + ' 字回复写回聊天（' + result.mode + '）');
    } else {
      this.log('后台代跑：写回失败（' + (result.reason || 'unknown') + '），正文 ' + chars + ' 字已丢弃');
    }
  }

  revokeDevice(deviceId) {
    for (const [token, record] of this.devices) {
      if (record.deviceId === deviceId) {
        this.devices.delete(token);
        saveDevices(this.devices);
        return true;
      }
    }
    return false;
  }

  async stop() {
    try { if (this.host) await this.host.stop(); } catch { /* ignore */ }
    try { if (this.gateway) await this.gateway.stop(); } catch { /* ignore */ }
    this.host = null;
    this.gateway = null;
    if (this.state !== 'failed') this.state = 'stopped';
  }
}