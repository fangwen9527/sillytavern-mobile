// 酒馆远程 —— 前端面板（步骤向导）+ 服务端组件安装引导
// 真正的网关与 iroh 隧道在 server plugin（plugins/st-mobile）里，这里只负责 UI。

const API = '/api/plugins/st-mobile';
const TEMPLATE = 'settings.html';

const SELF_DIR = (() => {
    try {
        const parts = new URL('.', import.meta.url).pathname.split('/').filter(Boolean);
        return parts[parts.length - 1];
    } catch {
        return 'sillytavern-mobile';
    }
})();

let root = null;
let pollTimer = null;

function ctx() {
    return SillyTavern.getContext();
}

function headers(extra) {
    try {
        return Object.assign({}, ctx().getRequestHeaders(), extra || {});
    } catch {
        return Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    }
}

async function apiGet(path) {
    const res = await fetch(API + path, { headers: headers() });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
}

async function apiPost(path, payload) {
    const res = await fetch(API + path, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload || {}),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
}

function $(id) {
    return root ? root.querySelector('#' + id) : document.getElementById(id);
}

function setBadge(text, kind) {
    const el = $('stm-state');
    if (!el) return;
    el.textContent = text;
    el.className = 'stm-badge ' + (kind || 'warn');
}

function setStep(name, text, kind) {
    const el = root ? root.querySelector('[data-state="' + name + '"]') : null;
    if (!el) return;
    el.textContent = text;
    el.className = 'stm-step-state ' + (kind || '');
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } finally { area.remove(); }
    return Promise.resolve();
}

function renderDevices(devices) {
    const box = $('stm-devices');
    if (!box) return;
    const list = devices || [];
    if (list.length === 0) {
        box.innerHTML = '还没有设备配对。';
        return;
    }
    box.innerHTML = list.map((device) => {
        const seen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '—';
        return '<div class="stm-dev"><div><div>' + escapeHtml(device.label || 'device') + '</div>' +
            '<div class="stm-hint">最后在线：' + escapeHtml(seen) + '</div></div>' +
            '<div class="menu_button stm-btn" data-stm-revoke="' + escapeHtml(device.deviceId) + '">撤销</div></div>';
    }).join('');
    box.querySelectorAll('[data-stm-revoke]').forEach((button) => {
        button.addEventListener('click', async () => {
            button.textContent = '…';
            await apiPost('/devices/revoke', { deviceId: button.getAttribute('data-stm-revoke') });
            refresh();
        });
    });
}

function markNotInstalled() {
    setBadge('未安装', 'bad');
    setStep('install', '待处理', 'pending');
    setStep('config', '待确认', '');
    setStep('restart', '待重启', '');
    setStep('pair', '—', '');
    setStep('status', '未运行', '');
}

function markRunning(status) {
    const labels = {
        running: ['运行中', 'ok'],
        starting: ['启动中', 'warn'],
        stopped: ['已停止', 'warn'],
        failed: ['启动失败', 'bad'],
    };
    const entry = labels[status.state] || [status.state || '未知', 'warn'];
    setBadge(entry[0], entry[1]);

    setStep('install', '已完成', 'done');
    setStep('config', '已开启', 'done');
    setStep('restart', status.state === 'running' ? '已完成' : '进行中', status.state === 'running' ? 'done' : 'pending');

    const devices = (status.devices || []).length;
    setStep('pair', status.state === 'running'
        ? (devices > 0 ? devices + ' 台设备' : '待配对')
        : '等待启动', status.state === 'running' && devices > 0 ? 'done' : 'pending');

    setStep('status', entry[0], entry[1] === 'ok' ? 'done' : 'pending');
}

async function refresh() {
    if (!root) return;
    const result = await apiGet('/status');
    if (!result.ok || !result.body || result.body.raw) {
        markNotInstalled();
        $('stm-origin').textContent = '—';
        $('stm-path').textContent = '—';
        $('stm-peers').textContent = '—';
        $('stm-log').textContent = '服务端组件尚未安装。展开第 1 步查看安装命令。';
        return;
    }

    const status = result.body;
    markRunning(status);

    $('stm-origin').textContent = status.origin || '—';
    $('stm-path').textContent = status.peerPath || '—';
    $('stm-peers').textContent = String(status.connectedPeers || 0) + ' / ' + String((status.devices || []).length);
    if (status.error) {
        $('stm-err-row').style.display = '';
        $('stm-err').textContent = status.error;
    } else {
        $('stm-err-row').style.display = 'none';
    }
    renderDevices(status.devices);
    $('stm-log').textContent = (status.logs || []).slice(-40).join('\n') || '—';
}

function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        refresh().catch(() => {});
    }, 5000);
}

async function generatePairing() {
    const button = $('stm-pair');
    if (button) button.textContent = '生成中…';
    const result = await apiPost('/pairing/new', {});
    if (button) button.textContent = '生成配对二维码';
    if (!result.ok) {
        $('stm-pair-hint').textContent = '生成失败：' + ((result.body && result.body.error) || result.status);
        return;
    }
    const data = result.body || {};
    if (data.dataUrl) {
        $('stm-qr-iroh').src = data.dataUrl;
        $('stm-qr-iroh').style.display = '';
    }
    if (data.lanDataUrl) {
        $('stm-qr-lan').src = data.lanDataUrl;
        $('stm-qr-lan').style.display = '';
    } else {
        $('stm-qr-lan').style.display = 'none';
    }
    const minutes = data.expiresAt ? Math.max(0, Math.round((data.expiresAt - Date.now()) / 60000)) : 10;
    $('stm-pair-hint').textContent = '扫任意一个，约 ' + minutes + ' 分钟内有效（先扫的生效，另一个立即失效）。扫不了码的话，用下面的配对链接。';

    // 配对链接：iroh 那段就是二维码里的原文（App 的 iroh 输入框直接吃），局域网那条是短链接
    const linkWrap = $('stm-link-wrap');
    const linkIroh = $('stm-link-iroh');
    const linkLan = $('stm-link-lan');
    const linkLanRow = $('stm-link-lan-row');
    if (linkIroh) linkIroh.textContent = data.text || '';
    if (linkLan) linkLan.textContent = data.lanUrl || '';
    if (linkLanRow) linkLanRow.style.display = data.lanUrl ? '' : 'none';
    if (linkWrap) linkWrap.style.display = data.text ? '' : 'none';

    // 生成成功后自动展开第 4 步并滚到能看见二维码的位置
    const pairStep = root && root.querySelector('[data-step="pair"]');
    if (pairStep) {
        pairStep.classList.add('open');
        const body = pairStep.querySelector('.stm-step-body');
        if (body && body.scrollIntoView) body.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    refresh().catch(() => {});
}

function bindStepToggles() {
    root.querySelectorAll('.stm-step-head').forEach((head) => {
        head.addEventListener('click', () => {
            head.parentElement.classList.toggle('open');
        });
    });
}

function bindCopyButtons() {
    root.querySelectorAll('.stm-copy').forEach((button) => {
        button.addEventListener('click', async () => {
            const key = button.getAttribute('data-copy');
            const source = root.querySelector('pre[data-cmd="' + key + '"]');
            if (!source) return;
            const original = button.textContent;
            try {
                await copyText(source.textContent);
                button.textContent = '已复制';
                button.classList.add('stm-copy-ok');
            } catch {
                button.textContent = '复制失败，请手动选中';
            }
            setTimeout(() => { button.textContent = original; button.classList.remove('stm-copy-ok'); }, 1600);
        });
    });
}

async function boot() {
    const container = document.getElementById('extensions_settings');
    if (!container) {
        setTimeout(boot, 400);
        return;
    }
    if (document.getElementById('stm-panel')) return;

    let html = '';
    try {
        const res = await fetch('/scripts/extensions/third-party/' + SELF_DIR + '/' + TEMPLATE);
        html = await res.text();
    } catch {
        html = '<div class="stm-hint">面板模板加载失败，请重新安装扩展。</div>';
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'inline-drawer';
    wrapper.innerHTML =
        '<div class="inline-drawer-toggle inline-drawer-header">' +
        '<b>酒馆远程</b>' +
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>' +
        '</div>' +
        '<div class="inline-drawer-content">' + html + '</div>';
    container.appendChild(wrapper);
    root = wrapper;

    bindStepToggles();
    bindCopyButtons();

    if ($('stm-pair')) $('stm-pair').addEventListener('click', generatePairing);
    if ($('stm-pair-quick')) $('stm-pair-quick').addEventListener('click', generatePairing);

    if ($('stm-restart')) {
        $('stm-restart').addEventListener('click', async () => {
            const button = $('stm-restart');
            button.textContent = '重启中…';
            await apiPost('/restart', {});
            button.textContent = '重启隧道';
            setTimeout(() => { refresh().catch(() => {}); }, 1500);
        });
    }

    refresh().catch(() => {});
    startPolling();
}

jQuery(async () => {
    await boot();
});
