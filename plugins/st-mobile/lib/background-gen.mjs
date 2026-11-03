import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR, ensureStateDir, stDataRoot } from './config.mjs';

/**
 * 后台代跑（方案 T）的持久化层。
 *
 * 场景：手机点发送 → 生成中 → 手机退出/被杀 → 网关侧不再掐断上游。
 * 上游跑完后，这里把那段回复按酒馆自己的 jsonl 结构写回聊天文件，
 * 手机重开时酒馆从文件读，消息已经完整躺在那里。
 *
 * 铁律：**第 1 行 chat_metadata 一个字节都不能动**。
 * 酒馆的 /api/chats/save 会比对文件里的 chat_metadata.integrity 和前端带上来的值，
 * 改了它，浏览器之后任何一次保存都会被 400 integrity 拒绝。
 */

/** 从 x-stm-chat 头里解出聊天身份（base64url JSON）。 */
export function decodeChatHint(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
    if (!data || typeof data.f !== 'string' || !data.f) return null;
    return {
      file: data.f,
      folder: typeof data.a === 'string' ? data.a.replace(/\.png$/i, '') : '',
      intent: typeof data.i === 'string' && data.i ? data.i : 'normal',
    };
  } catch {
    return null;
  }
}

/** 从 SSE 流或 JSON 响应里抠出完整的助手正文。 */
export function extractGeneratedText(buffer, contentType = '') {
  const text = buffer.toString('utf8');
  if (!text) return '';
  if (/json/i.test(contentType) && !/event-stream/i.test(contentType)) {
    try {
      const data = JSON.parse(text);
      return String(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '');
    } catch {
      return '';
    }
  }
  let out = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let data;
    try { data = JSON.parse(payload); } catch { continue; }
    const choice = data?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || choice.message;
    if (typeof delta?.content === 'string') out += delta.content;
    else if (typeof choice.text === 'string') out += choice.text;
  }
  return out;
}

/** 有界递归兜底：群聊目录、老版本布局都能找到，跳过备份目录。 */
function findChatFileRecursively(root, fileName, depth = 0) {
  if (depth > 4) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'backups' || entry.name === 'node_modules') continue;
    const full = path.join(root, entry.name);
    if (entry.name === fileName) return full;              // 目录名撞上文件名，忽略
    const candidate = path.join(full, fileName);
    if (fs.existsSync(candidate)) return candidate;
    const nested = findChatFileRecursively(full, fileName, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function chatRoots() {
  const root = stDataRoot();
  const found = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const chats = path.join(root, entry.name, 'chats');
      if (fs.existsSync(chats)) found.push(chats);
    }
  } catch { /* data 目录还没建 */ }
  return found;
}

/** 找到 hint 指向的聊天文件：先按「角色头像目录」精确找，再全盘按文件名找。 */
export function locateChatFile(hint) {
  if (!hint?.file) return null;
  const fileName = hint.file.endsWith('.jsonl') ? hint.file : hint.file + '.jsonl';
  for (const chats of chatRoots()) {
    if (hint.folder) {
      const direct = path.join(chats, hint.folder, fileName);
      if (fs.existsSync(direct)) return direct;
    }
    let dirs = [];
    try {
      dirs = fs.readdirSync(chats, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { continue; }
    for (const dir of dirs) {
      const candidate = path.join(chats, dir, fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return findChatFileRecursively(stDataRoot(), fileName);
}

/**
 * 把后台跑完的回复写回聊天文件。
 * intent=swipe/regenerate 时写成最后一条消息的新 swipe，其余情况追加一条新消息。
 */
export function persistRecoveredReply({ hint, text, startedAt, finishedAt }) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, reason: 'empty_text' };
  if (!hint?.file) return { ok: false, reason: 'no_hint' };

  const file = locateChatFile(hint);
  if (!file) return { ok: false, reason: 'chat_not_found', file: hint.file, folder: hint.folder };

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { return { ok: false, reason: 'read_failed', error: error.message }; }

  const lines = raw.split('\n');
  const firstLine = lines.shift() ?? '';
  let meta = null;
  try { meta = JSON.parse(firstLine); } catch { meta = null; }
  if (!meta || !meta.chat_metadata) return { ok: false, reason: 'bad_chat_file' };

  const messages = lines
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);

  const started = new Date(startedAt || Date.now()).toISOString();
  const finished = new Date(finishedAt || Date.now()).toISOString();
  const intent = hint.intent || 'normal';
  let mode = 'append';

  if (intent === 'swipe' || intent === 'regenerate') {
    const last = [...messages].reverse().find((m) => m && !m.is_user && !m.is_system);
    if (last) {
      const swipes = Array.isArray(last.swipes) && last.swipes.length ? last.swipes.slice() : [String(last.mes || '')];
      swipes.push(body);
      last.swipes = swipes;
      last.swipe_id = swipes.length - 1;
      last.mes = body;
      last.gen_started = started;
      last.gen_finished = finished;
      mode = 'swipe';
    }
  }

  if (mode === 'append') {
    const template = [...messages].reverse().find((m) => m && !m.is_user && !m.is_system);
    messages.push({
      name: template?.name || hint.folder || 'Character',
      is_user: false,
      is_system: false,
      send_date: finished,
      mes: body,
      extra: { stmobileRecovered: true },
      gen_started: started,
      gen_finished: finished,
      swipe_id: 0,
      swipe_info: [{}],
      swipes: [body],
    });
  }

  try {
    ensureStateDir();
    const backupDir = path.join(STATE_DIR, 'chat-backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(backupDir, stamp + '-' + path.basename(file)), raw, { mode: 0o600 });

    const output = [firstLine, ...messages.map((m) => JSON.stringify(m))].join('\n');
    const temp = file + '.stmobile.tmp';
    fs.writeFileSync(temp, output);
    fs.renameSync(temp, file);
  } catch (error) {
    return { ok: false, reason: 'write_failed', error: error.message };
  }

  return { ok: true, mode, file, chars: body.length };
}
