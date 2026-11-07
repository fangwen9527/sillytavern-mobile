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
    setStep('advanced', '—', '');
    const box = $('stm-auto-recover');
    if (box) box.disabled = true;
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

/** 404 = 酒馆根本没加载这个服务端插件，不能只说「未安装」。 */
function markPluginDisabled() {
    setBadge('未启用', 'bad');
    setStep('install', '待确认', 'pending');
    setStep('config', '未开启', 'pending');
    setStep('restart', '待重启', 'pending');
    setStep('pair', '—', '');
    setStep('status', '404', 'bad');
    setStep('advanced', '—', '');
    const box = $('stm-auto-recover');
    if (box) box.disabled = true;
    if ($('stm-origin')) $('stm-origin').textContent = '—';
    if ($('stm-path')) $('stm-path').textContent = '—';
    if ($('stm-peers')) $('stm-peers').textContent = '—';
    if ($('stm-devices')) $('stm-devices').textContent = '还没有设备配对。';
    if ($('stm-log')) {
        $('stm-log').textContent = [
            '酒馆返回 404：服务端插件没有被加载。两种可能，按顺序排查：',
            '',
            '① plugins/st-mobile 不存在 —— 先跑第 1 步的安装命令。',
            '② config.yaml 里 enableServerPlugins 不是 true ——',
            '   SillyTavern 1.19 的默认值就是 false，必须手动改成 true，然后重启酒馆。',
            '',
            '改完重启后本面板会自动变成「运行中」。',
        ].join('\n');
    }
}

async function refresh() {
    if (!root) return;
    const result = await apiGet('/status');
    if (result.status === 404) {
        markPluginDisabled();
        return;
    }
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
    applyAdvanced(status);
    lastStatus = status;
    renderLanState(status);
    renderLanDiagnostics(status);
    $('stm-log').textContent = (status.logs || []).slice(-40).join('\n') || '—';
}

let lastStatus = null;

/** 第 4 步：局域网不可用时常驻显示原因，不用等点"生成"。 */
function renderLanState(status) {
    const box = $('stm-lan-error');
    if (!box) return;
    if (status && status.lan) {
        box.style.display = 'none';
        return;
    }
    const reason = (status && status.lanError) || '局域网通道未就绪';
    box.textContent = '局域网二维码不可用：' + reason;
    box.style.display = '';
    setStep('pair', 'iroh 可用', 'pending');
}

/** 页脚版本号从 manifest 读，别再手写死。 */
async function loadVersion() {
    try {
        const res = await fetch('/scripts/extensions/third-party/' + SELF_DIR + '/manifest.json');
        const manifest = await res.json();
        const el = $('stm-version');
        if (el && manifest && manifest.version) el.textContent = '插件 v' + manifest.version;
    } catch { /* 读不到就留着占位符 */ }
}

/**
 * 局域网排障：手机连不上时，先看「最近局域网请求」。
 * 空的 = 请求根本没到电脑（防火墙 / 不同网段 / AP 隔离）；
 * 有记录 = 到了电脑，问题在证书或鉴权。
 */
function renderLanDiagnostics(status) {
    const lan = status && status.lan;
    const lanEl = $('stm-lan');
    if (lanEl) {
        lanEl.textContent = lan
            ? (lan.primary || '—') + ':' + lan.port
            : (status && status.lanError) || '未启用';
    }
    const firewallEl = $('stm-firewall');
    if (firewallEl) {
        firewallEl.textContent = (lan && lan.firewallCommand) || '局域网未启用，暂无命令';
    }
    const lastEl = $('stm-lan-last');
    if (!lastEl) return;
    const last = status && status.lastLanRequest;
    if (last) {
        const time = new Date(last.at).toLocaleTimeString();
        lastEl.textContent = time + ' · ' + last.remote + ' · ' + last.method + ' ' + last.path;
    } else {
        lastEl.textContent = '还没有收到任何局域网请求';
    }
}

/** 第 7 步：实验开关。开关真相在服务端，这里只反映 /status 里的 settings。 */
function applyAdvanced(status) {
    const box = $('stm-auto-recover');
    const hint = $('stm-advanced-hint');
    if (!box) return;
    const settings = (status && status.settings) || {};
    const on = settings.backgroundRecover === true;
    box.checked = on;
    box.disabled = false;
    setStep('advanced', on ? '已开启' : '默认关闭', on ? 'done' : 'off');
    if (hint) {
        hint.textContent = on
            ? '当前：开。手机在生成途中断开，回复会继续跑完并写回聊天记录。'
            : '当前：关（默认）。行为与酒馆原生一致——断开即中止，回复不会保留。';
    }
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

    // 局域网二维码生成不出来时，把原因写清楚（最常见是端口被系统保留 / 证书签不出来）
    const lanError = $('stm-lan-error');
    if (lanError) {
        if (data.lanUrl) {
            lanError.style.display = 'none';
        } else {
            const reason = (lastStatus && lastStatus.lanError) || '局域网通道未就绪';
            lanError.textContent = '局域网二维码不可用：' + reason;
            lanError.style.display = '';
        }
    }

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

// ─────────────────────────────────────────────────────────────
// 后台代跑：给 /api/backends/chat-completions/generate 贴一个聊天身份头。
// 手机在生成途中断开时，网关会继续把上游跑完，然后按这个头找到聊天文件，
// 把完整回复写回去——重开就能看到整条消息，而不是半截或空白。
// ─────────────────────────────────────────────────────────────
let stmPendingIntent = 'normal';

function stmEncodeHint(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function stmChatHint() {
    try {
        const context = ctx();
        const chatId = typeof context.getCurrentChatId === 'function'
            ? context.getCurrentChatId()
            : context.chatId;
        if (!chatId) return null;

        let folder = '';
        if (context.groupId) {
            // 群聊：酒馆按群 id 建目录
            folder = String(context.groupId);
        } else {
            const character = (context.characters || [])[Number(context.characterId)];
            folder = String((character && character.avatar) || '').replace(/\.png$/i, '');
        }
        return stmEncodeHint({ f: String(chatId), a: folder, i: stmPendingIntent });
    } catch {
        return null;
    }
}

function installGenerationWatcher() {
    if (window.__stmGenerationWatcher) return;
    window.__stmGenerationWatcher = true;

    try {
        const context = ctx();
        const started = (context.eventTypes || context.event_types || {}).GENERATION_STARTED;
        if (started && context.eventSource) {
            context.eventSource.on(started, (type) => {
                const value = String(type || 'normal');
                // 重刷/换 swipe 走的是"改最后一条"，和普通发送的落盘方式不同
                stmPendingIntent = (value === 'swipe' || value === 'regenerate') ? 'swipe' : value;
            });
        }
    } catch { /* 事件总线不可用就一律按 normal 处理 */ }

    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            const url = typeof input === 'string' ? input : String((input && input.url) || '');
            const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            if (method === 'POST' && url.indexOf('/api/backends/chat-completions/generate') !== -1) {
                const hint = stmChatHint();
                if (hint) {
                    const headers = new Headers((init && init.headers) || {});
                    headers.set('x-stm-chat', hint);
                    init = Object.assign({}, init, { headers });
                }
            }
        } catch { /* 贴头失败只影响断线补救，不影响正常生成 */ }
        return originalFetch.call(this, input, init);
    };
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

    installGenerationWatcher();
    loadVersion();
    bindStepToggles();
    bindCopyButtons();

    if ($('stm-diagnose')) {
        $('stm-diagnose').addEventListener('click', async () => {
            const button = $('stm-diagnose');
            const box = $('stm-diagnose-result');
            const original = button.textContent;
            button.textContent = '检查中…';
            const response = await apiGet('/diagnose');
            button.textContent = original;
            if (!box) return;
            const body = response.body || {};
            if (!response.ok || !body.ok) {
                box.textContent = '检查失败：' + (body.error || response.status);
                box.style.color = '#f36b6b';
                return;
            }
            const lines = [];
            lines.push('settings.json 体积：' + body.mb + ' MB（阈值 ' + body.thresholdMb + ' MB）');
            if (body.topExtensions && body.topExtensions.length) {
                lines.push('占用最大的扩展设置：' + body.topExtensions.map((row) => row.key + ' ' + row.mb + ' MB').join('、'));
            }
            if (body.topScripts && body.topScripts.length) {
                lines.push('酒馆助手脚本 Top：' + body.topScripts
                    .map((row) => row.name + ' ' + row.mb + ' MB' + (row.enabled ? '' : '（已禁用）'))
                    .join('、'));
            }
            if (body.warning) {
                lines.push('');
                lines.push('⚠ 体积偏大，手机端首屏很可能超时。把上面列出的「已禁用」大脚本删掉通常最有效（删前先备份 settings.json）。');
            }
            box.textContent = lines.join('\n');
            box.style.color = body.warning ? '#f0b849' : '#56d98b';
            box.style.whiteSpace = 'pre-wrap';
        });
    }

    if ($('stm-fw-apply')) {
        $('stm-fw-apply').addEventListener('click', async () => {
            const button = $('stm-fw-apply');
            const result = $('stm-fw-result');
            const original = button.textContent;
            button.textContent = '处理中…';
            if (result) { result.textContent = '正在请求提权，如果弹出 UAC 请点「是」…'; result.style.color = ''; }
            const response = await apiPost('/firewall/apply', {});
            button.textContent = original;
            if (!result) return;
            const body = response.body || {};
            if (response.ok && body.ok) {
                result.textContent = body.message || '规则已添加。';
                result.style.color = '#56d98b';
            } else {
                result.textContent = (body.message || ('添加失败：' + response.status))
                    + '（可直接用下面那条命令，在管理员 PowerShell 里执行）';
                result.style.color = '#f36b6b';
            }
            refresh().catch(() => {});
        });
    }

    if ($('stm-auto-recover')) {
        $('stm-auto-recover').addEventListener('change', async () => {
            const box = $('stm-auto-recover');
            const hint = $('stm-advanced-hint');
            const want = box.checked;
            box.disabled = true;
            if (hint) hint.textContent = '保存中…';
            const result = await apiPost('/settings', { backgroundRecover: want });
            if (!result.ok) {
                box.checked = !want;
                box.disabled = false;
                if (hint) hint.textContent = '保存失败：' + ((result.body && result.body.error) || result.status);
                return;
            }
            applyAdvanced({ settings: result.body });
        });
    }

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
