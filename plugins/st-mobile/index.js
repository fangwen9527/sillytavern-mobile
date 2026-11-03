import QRCode from 'qrcode';

import { Bridge } from './lib/bridge.mjs';
import { renderPanel } from './lib/panel.mjs';
import { IROH_LOCAL_PORT } from './lib/config.mjs';

export const info = {
    id: 'st-mobile',
    name: '酒馆远程访问',
    description: 'iroh 加密直连 + 扫码配对，把酒馆安全地送到手机，无需域名或公网 IP。',
};

const MAX_LOG_LINES = 200;
const logLines = [];

/** @type {Bridge | null} */
let bridge = null;

function log(...parts) {
    const line = new Date().toISOString().slice(11, 19) + ' ' + parts.join(' ');
    logLines.push(line);
    if (logLines.length > MAX_LOG_LINES) logLines.shift();
    console.log('[st-mobile]', ...parts);
}

function json(res, status, body) {
    res.status(status).json(body);
}

export async function init(router) {
    bridge = new Bridge({ log });

    // 不阻塞酒馆启动：sidecar 首次下载/握手可能需要几秒到几十秒。
    bridge.start().catch((error) => log('启动异常: ' + error.message));

    router.get('/panel', (req, res) => {
        res.type('html').send(renderPanel());
    });

    router.get('/status', (req, res) => {
        const status = bridge.status();
        json(res, 200, { ...status, logs: logLines.slice(-60) });
    });

    router.post('/pairing/new', async (req, res) => {
        try {
            const { text, descriptor, lanUrl, expiresAt } = await bridge.newPairing();
            const dataUrl = await QRCode.toDataURL(text, { width: 640, margin: 1, errorCorrectionLevel: 'M' });
            const lanDataUrl = lanUrl
                ? await QRCode.toDataURL(lanUrl, { width: 640, margin: 1, errorCorrectionLevel: 'M' })
                : null;
            json(res, 200, { descriptor, text, dataUrl, lanUrl, lanDataUrl, expiresAt });
        } catch (error) {
            json(res, 409, { error: error.message });
        }
    });

    router.post('/devices/revoke', (req, res) => {
        const deviceId = String(req.body?.deviceId || '');
        const removed = bridge.revokeDevice(deviceId);
        json(res, removed ? 200 : 404, { removed });
    });

    router.post('/restart', async (req, res) => {
        await bridge.stop();
        const status = await bridge.start();
        json(res, 200, status);
    });

    router.get('/settings', (req, res) => {
        json(res, 200, { ...bridge.settings });
    });

    router.post('/settings', (req, res) => {
        const patch = req.body && typeof req.body === 'object' ? req.body : {};
        json(res, 200, bridge.updateSettings({ backgroundRecover: patch.backgroundRecover }));
    });

    router.get('/logs', (req, res) => {
        res.type('text/plain').send(logLines.join('\n'));
    });

    log(`插件已加载，本地端口 ${IROH_LOCAL_PORT}，面板 /api/plugins/st-mobile/panel`);
}

export async function exit() {
    if (bridge) {
        log('酒馆退出，正在关闭远程访问…');
        await bridge.stop().catch(() => {});
        bridge = null;
    }
}