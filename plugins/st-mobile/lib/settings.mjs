import fs from 'node:fs';

import { SETTINGS_FILE, ensureStateDir } from './config.mjs';

/**
 * 插件开关。注意：**真相只在服务端**。
 * 前端面板只负责显示/切换，绝不能把开关状态只记在浏览器里——
 * 那样会出现"面板显示开着、网关实际没开"的假象。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  /** 断线代跑（实验）：手机在生成途中断开时，网关继续把上游跑完并写回聊天。 */
  backgroundRecover: false,
});

function coerce(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return out;
}

export function loadSettings() {
  try {
    return coerce(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(current, patch) {
  const merged = { ...coerce(current) };
  if (patch && typeof patch === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof patch[key] === 'boolean') merged[key] = patch[key];
    }
  }
  try {
    ensureStateDir();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  } catch {
    // 写盘失败就只保留内存态，调用方会拿到合并后的值
  }
  return merged;
}
