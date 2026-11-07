import fs from 'node:fs';
import path from 'node:path';

import { stDataRoot } from './config.mjs';

/** 超过这个体积就认为会拖慢手机端首屏（局域网预算是 30 秒）。 */
const WARN_BYTES = 8 * 1024 * 1024;

function byteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return 0; }
}

function rowsOf(collection, limit) {
  const rows = [];
  if (Array.isArray(collection)) {
    collection.forEach((value, index) => {
      rows.push({ key: String((value && value.name) || ('#' + (index + 1))), bytes: byteLength(value), enabled: value ? value.enabled : undefined });
    });
  } else if (collection && typeof collection === 'object') {
    for (const [key, value] of Object.entries(collection)) {
      rows.push({ key, bytes: byteLength(value), enabled: value ? value.enabled : undefined });
    }
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return rows.slice(0, limit);
}

/**
 * 酒馆设置体积诊断。
 * 手机上「卡在初始化 → 连接超时」的常见根因：/api/settings/get 返回几十 MB，
 * 服务端序列化 + 传输就吃掉十几秒，直接撞上 App 的连接预算。
 */
export function settingsReport() {
  const root = stDataRoot();
  let best = null;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'settings.json');
      try {
        const stat = fs.statSync(file);
        if (!best || stat.size > best.size) best = { file, size: stat.size, user: entry.name };
      } catch { /* 这个用户没有 settings.json */ }
    }
  } catch {
    return { ok: false, reason: 'no_data_dir' };
  }
  if (!best) return { ok: false, reason: 'no_settings' };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(best.file, 'utf8'));
  } catch {
    return { ok: true, file: best.file, bytes: best.size, mb: +(best.size / 1048576).toFixed(1), warning: true, reason: 'unreadable' };
  }

  const extensionSettings = parsed.extension_settings || {};
  const helperScripts = (((extensionSettings.tavern_helper || {}).script) || {}).scripts;

  return {
    ok: true,
    file: best.file.replace(/\\/g, '/'),
    bytes: best.size,
    mb: +(best.size / 1048576).toFixed(1),
    warning: best.size >= WARN_BYTES,
    thresholdMb: Math.round(WARN_BYTES / 1048576),
    topExtensions: rowsOf(extensionSettings, 5).map((row) => ({ key: row.key, mb: +(row.bytes / 1048576).toFixed(2) })),
    topScripts: helperScripts ? rowsOf(helperScripts, 5).map((row) => ({
      name: String(row.key).slice(0, 60),
      mb: +(row.bytes / 1048576).toFixed(2),
      enabled: row.enabled,
    })) : [],
  };
}
