import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 插件配置目录：
 * - 状态/身份/设备放 ~/.st-mobile（sidecar 要求"仅当前用户可写"的私有目录，
 *   酒馆的 data 目录在多数 Windows 安装里不满足这个 ACL 条件）。
 * - 只有面板与日志面板相关的轻量状态放酒馆 data 目录。
 */
export const HOME = os.homedir();
export const STATE_DIR = path.join(HOME, '.st-mobile');
export const SIDECAR_DIR = path.join(STATE_DIR, 'sidecar');
export const DEVICES_FILE = path.join(STATE_DIR, 'devices.json');

/** 酒馆自己的数据目录（由 server-main.js 注入 globalThis.DATA_ROOT）。 */
export function stDataRoot() {
  return globalThis.DATA_ROOT || path.join(process.cwd(), 'data');
}

/** 上游酒馆端口：优先命令行参数，其次 config。 */
export function upstreamTarget() {
  const port = Number(process.env.ST_MOBILE_UPSTREAM_PORT || globalThis.COMMAND_LINE_ARGS?.port || 8000);
  return { host: '127.0.0.1', port };
}

/** 从酒馆 config.yaml 读 basicAuth，用于给网关注入 Authorization。 */
export function readBasicAuth() {
  const here = path.dirname(fileURLToPath(import.meta.url));   // <repo>/plugins/st-mobile/lib
  const candidates = [
    path.join(process.cwd(), 'config.yaml'),
    path.resolve(here, '../../..', 'config.yaml'),             // <repo>/config.yaml
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (!/^basicAuthMode:\s*true/m.test(text)) continue;
      const user = text.match(/^\s*username:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
      const pass = text.match(/^\s*password:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
      if (user && pass) return { user, pass };
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

/** App 侧写死的本地端口，不能改（IrohHttpsTransport.kt:34）。 */
export const IROH_LOCAL_PORT = 25443;

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SIDECAR_DIR, { recursive: true, mode: 0o700 });
}