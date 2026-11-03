import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';

import { PAIR_PAGE } from './pair-page.mjs';
import { decodeChatHint, extractGeneratedText } from './background-gen.mjs';

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const MAX_CONTROL_BODY = 16 * 1024;

/** 生成请求：这条链上是"手机 → 网关 → 酒馆 → LLM"，网关是唯一能决定"断线后还跑不跑"的位置。 */
const GENERATE_PATH = '/api/backends/chat-completions/generate';
const MAX_RECOVER_BYTES = 8 * 1024 * 1024;

/**
 * 与 dsh-mobile Android 客户端（0.7.x）协商的元数据常量。
 * - PLUGIN_PROTOCOL_VERSION 必须 >= 0.2.2，否则 App 弹「需要更新插件」（VersionCompatibility.kt:23）
 * - version / discoveryProtocol 必须精确等于 1
 */
const METADATA_VERSION = 1;
const DISCOVERY_PROTOCOL = 1;
const PLUGIN_PROTOCOL_VERSION = '0.8.1';
// 改装版 App 用的是自己的编号体系（0.1.x），所以最低版本按我们的号走；
// 上游官方包 0.7.x/0.8.x 的版本号更大，同样能通过这条比较。
const MINIMUM_APP_VERSION = '0.1.0';

function sendJson(res, status, body, extra = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': payload.length, ...extra });
  res.end(payload);
}

function readBody(req, limit = MAX_CONTROL_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class Gateway {
  constructor(options) {
    this.cert = options.cert;
    this.key = options.key;
    this.caDer = options.caDer;
    this.instanceId = crypto.createHash('sha256').update(options.caDer).digest('hex');
    this.upstream = options.upstream;
    this.basicAuth = options.basicAuth || null;
    this.devices = options.devices || new Map();
    this.pairingWindow = null;
    this.server = null;
    this.lanServer = null;
    this.port = 0;
    this.lanPort = 0;
    this.lanAddresses = [];
    this.deviceCookie = 'st_mobile_device';
    /**
     * App 用原生 HttpsURLConnection 配对，服务端 Set-Cookie 不会进 WebView 的 CookieManager。
     * App 只会把 sessionToken 自己写进 CookieManager（NativeSessionCookies.kt:12-20），
     * 所以网关必须同时认 dsh_ma_session。
     */
    this.sessionCookieNames = ['dsh_ma_session', '__Host-dsh_ma_session'];
    this.sessions = new Map();
    this.onDevicesChanged = options.onDevicesChanged || (() => {});
    this.log = options.log || (() => {});
    /** 手机在生成途中断开时，上游仍会跑完，这里把成品交出去落盘。 */
    this.onGenerationOrphaned = options.onGenerationOrphaned || (() => {});
    /** 断线代跑开关（实验功能，默认关闭）。每次请求现读，切了立刻生效。 */
    this.autoRecoverEnabled = options.autoRecoverEnabled || (() => false);
  }

  openPairing(ttlMs = 600_000) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.pairingWindow = {
      digest: crypto.createHash('sha256').update(token).digest('hex'),
      expiresAt: Date.now() + ttlMs,
    };
    return { token, expiresAt: this.pairingWindow.expiresAt };
  }

  consumePairing(token) {
    const window = this.pairingWindow;
    if (!window) return { ok: false, error: 'no_pairing_window' };
    if (window.expiresAt <= Date.now()) { this.pairingWindow = null; return { ok: false, error: 'pairing_expired' }; }
    const digest = crypto.createHash('sha256').update(String(token || '')).digest('hex');
    const a = Buffer.from(digest, 'hex');
    const b = Buffer.from(window.digest, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'invalid_token' };
    this.pairingWindow = null;
    const deviceToken = crypto.randomBytes(32).toString('base64url');
    const deviceId = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const record = {
      deviceId, deviceToken, label: 'device',
      createdAt: now, deviceExpiresAt: now + 180 * 86400_000, lastSeenAt: now,
    };
    this.devices.set(deviceToken, record);
    this.onDevicesChanged(this.devices);
    return { ok: true, record };
  }

  sessionFor(record) {
    const now = Date.now();
    const session = {
      sessionToken: crypto.randomBytes(32).toString('base64url'),
      csrfToken: crypto.randomBytes(32).toString('base64url'),
      sessionExpiresAt: now + 12 * 3600_000,
    };
    if (record) {
      this.sessions.set(session.sessionToken, { deviceId: record.deviceId, expiresAt: session.sessionExpiresAt });
    }
    return session;
  }

  parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return out;
  }

  recordFromCookies(req) {
    const cookies = this.parseCookies(req);
    const deviceToken = cookies[this.deviceCookie];
    if (deviceToken) {
      const record = this.devices.get(deviceToken);
      if (record && record.deviceExpiresAt > Date.now()) return record;
    }
    for (const name of this.sessionCookieNames) {
      const sessionToken = cookies[name];
      if (!sessionToken) continue;
      const session = this.sessions.get(sessionToken);
      if (!session || session.expiresAt <= Date.now()) continue;
      for (const record of this.devices.values()) {
        if (record.deviceId === session.deviceId && record.deviceExpiresAt > Date.now()) return record;
      }
    }
    return null;
  }

  authorize(req) {
    const record = this.recordFromCookies(req);
    if (!record) return null;
    record.lastSeenAt = Date.now();
    return record;
  }

  handleControl(res, pathname) {
    if (pathname === '/mobile-access/metadata') {
      return sendJson(res, 200, {
        version: METADATA_VERSION,
        pluginVersion: PLUGIN_PROTOCOL_VERSION,
        minimumAndroidAppVersion: MINIMUM_APP_VERSION,
        discoveryProtocol: DISCOVERY_PROTOCOL,
      });
    }
    if (pathname === '/mobile-access/ca.cer') {
      res.writeHead(200, { 'content-type': 'application/pkix-cert', 'content-length': this.caDer.length });
      return res.end(this.caDer);
    }
    if (pathname === '/mobile-access/pair') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAIR_PAGE);
    }
    return null;
  }

  async handleAuth(req, res, pathname) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return sendJson(res, 400, { error: 'bad_request' }); }

    if (pathname === '/mobile-access/auth/native-pair') {
      const result = this.consumePairing(body.token);
      if (!result.ok) return sendJson(res, 401, { error: result.error });
      const record = result.record;
      record.label = typeof body.label === 'string' ? body.label.slice(0, 64) : 'device';
      const session = this.sessionFor(record);
      return sendJson(res, 201, {
        instanceId: this.instanceId,
        deviceId: record.deviceId,
        deviceToken: record.deviceToken,
        deviceExpiresAt: record.deviceExpiresAt,
        sessionToken: session.sessionToken,
        csrfToken: session.csrfToken,
        sessionExpiresAt: session.sessionExpiresAt,
      }, {
        'set-cookie': this.deviceCookie + '=' + encodeURIComponent(record.deviceToken) + '; Path=/; HttpOnly; SameSite=Lax',
      });
    }

    if (pathname === '/mobile-access/auth/native-renew') {
      const record = this.devices.get(String(body.deviceToken || ''));
      if (!record || record.deviceExpiresAt <= Date.now()) return sendJson(res, 401, { error: 'authentication_failed' });
      const session = this.sessionFor(record);
      return sendJson(res, 200, {
        instanceId: this.instanceId,
        deviceId: record.deviceId,
        sessionToken: session.sessionToken,
        csrfToken: session.csrfToken,
        sessionExpiresAt: session.sessionExpiresAt,
      });
    }

    if (pathname === '/mobile-access/auth/native-probe') {
      const record = this.devices.get(String(body.deviceToken || ''));
      if (!record) return sendJson(res, 401, { error: 'authentication_failed' });
      return sendJson(res, 200, {
        instanceId: this.instanceId,
        deviceId: record.deviceId,
        deviceExpiresAt: record.deviceExpiresAt,
      });
    }

    return sendJson(res, 404, { error: 'not_found' });
  }

  proxy(req, res) {
    const headers = { ...req.headers };
    headers.host = this.upstream.host + ':' + this.upstream.port;
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-for'] = req.socket.remoteAddress || '';
    headers['x-real-ip'] = req.socket.remoteAddress || '';
    if (this.basicAuth && !headers.authorization) {
      headers.authorization = 'Basic ' + Buffer.from(this.basicAuth.user + ':' + this.basicAuth.pass).toString('base64');
    }

    const pathname = String(req.url || '').split('?')[0];
    // 开关关掉时完全走原生逻辑：不建看护对象，手机一断就跟酒馆一起断。
    let autoRecover = false;
    try { autoRecover = Boolean(this.autoRecoverEnabled()); } catch { autoRecover = false; }
    const isGenerate = req.method === 'POST' && pathname === GENERATE_PATH && autoRecover;
    // 生成请求从一开始就看护：手机可能在响应回来之前就断了。
    const watch = isGenerate
      ? {
        hint: decodeChatHint(req.headers['x-stm-chat']),
        chunks: [],
        bytes: 0,
        contentType: '',
        status: 0,
        startedAt: Date.now(),
        orphaned: false,
      }
      : null;
    let upstreamRes = null;

    const upstream = http.request({
      host: this.upstream.host,
      port: this.upstream.port,
      method: req.method,
      path: req.url,
      headers,
    }, (incoming) => {
      upstreamRes = incoming;
      if (watch) {
        watch.status = incoming.statusCode || 0;
        watch.contentType = String(incoming.headers['content-type'] || '');
        incoming.on('data', (chunk) => {
          if (watch.bytes > MAX_RECOVER_BYTES) return;
          watch.chunks.push(chunk);
          watch.bytes += chunk.length;
        });
        incoming.on('end', () => {
          if (!watch.orphaned) return;
          watch.finishedAt = Date.now();
          let text = '';
          try { text = extractGeneratedText(Buffer.concat(watch.chunks), watch.contentType); } catch { text = ''; }
          try {
            this.onGenerationOrphaned({
              hint: watch.hint,
              text,
              status: watch.status,
              contentType: watch.contentType,
              startedAt: watch.startedAt,
              finishedAt: watch.finishedAt,
            });
          } catch (error) {
            this.log('后台代跑落盘回调失败: ' + error.message);
          }
        });
      }

      // 手机已经走了：别往死掉的 res 上写，安静把上游读完
      if (watch && watch.orphaned) {
        incoming.resume();
        return;
      }

      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(res);
    });
    upstream.on('error', (error) => {
      if (!res.headersSent && !(watch && watch.orphaned)) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Gateway: ' + error.message);
      }
    });
    req.pipe(upstream);
    res.on('close', () => {
      // 关键分支：生成请求 + 响应还没写完 = 手机断了。
      // 这里**不能** upstream.destroy()。酒馆把上游 LLM 的 abort 挂在入站 socket 的 close 上
      // （src/endpoints/backends/chat-completions.js:2630），一关就等于当场掐死生成。
      if (watch && !res.writableFinished) {
        watch.orphaned = true;
        try { req.unpipe(upstream); } catch { /* 请求体多半已经发完 */ }
        try {
          upstreamRes?.unpipe(res);
          // unpipe 会把源流切换回 paused，不 resume 就永远等不到 end（数据也就不再被读走）
          upstreamRes?.resume();
        } catch { /* 已经自动解绑 */ }
        return;
      }
      upstream.destroy();
    });
  }

  async handler(req, res) {
    const pathname = new URL(req.url, 'https://gateway.invalid').pathname;

    if (pathname.startsWith('/mobile-access/')) {
      const control = this.handleControl(res, pathname);
      if (control !== null) return control;
      if (pathname.startsWith('/mobile-access/auth/')) return this.handleAuth(req, res, pathname);
      return sendJson(res, 404, { error: 'not_found' });
    }

    if (!this.authorize(req)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>需要配对</title>' +
        '<body style="font-family:system-ui;padding:2rem;background:#14161a;color:#e6e8eb">' +
        '<h1>这台设备还没有配对</h1>' +
        '<p>请在电脑端打开 <code>/api/plugins/st-mobile/panel</code> 生成配对二维码，用手机 App 扫码。</p></body>');
    }

    return this.proxy(req, res);
  }

  createServer(cert, key) {
    return https.createServer({ cert, key, ALPNProtocols: ['http/1.1'] }, (req, res) => {
      this.handler(req, res).catch((error) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error: ' + error.message);
      });
    });
  }

  async start() {
    this.server = this.createServer(this.cert, this.key);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this.port;
  }

  async startLan({ cert, key, port = 8443, addresses = [] }) {
    this.lanServer = this.createServer(cert, key);
    await new Promise((resolve, reject) => {
      this.lanServer.once('error', reject);
      this.lanServer.listen(port, '0.0.0.0', () => {
        this.lanPort = this.lanServer.address().port;
        this.lanAddresses = addresses;
        resolve();
      });
    });
    return this.lanPort;
  }

  async stop() {
    if (this.server) { await new Promise((resolve) => this.server.close(resolve)); this.server = null; }
    if (this.lanServer) { await new Promise((resolve) => this.lanServer.close(resolve)); this.lanServer = null; }
  }
}
