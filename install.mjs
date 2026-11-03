#!/usr/bin/env node
/**
 * 酒馆远程 —— 服务端组件安装器（跨平台，Node 版）
 *
 *   node install.mjs                 # 自动定位（从扩展目录上溯）
 *   node install.mjs D:\\SillyTavern   # 指定酒馆根目录
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..', '..');
const source = path.join(here, 'plugins', 'st-mobile');

if (!fs.existsSync(source)) {
  console.error('扩展目录里缺少 plugins/st-mobile，请用完整仓库安装扩展。');
  process.exit(1);
}

const tavern = process.argv[2] ? path.resolve(process.argv[2]) : repoRoot;
if (!fs.existsSync(path.join(tavern, 'server.js'))) {
  console.error('找不到 server.js，酒馆目录不正确：', tavern);
  process.exit(1);
}

const pluginsDir = path.join(tavern, 'plugins');
fs.mkdirSync(pluginsDir, { recursive: true });
const target = path.join(pluginsDir, 'st-mobile');

if (fs.existsSync(target)) {
  // 备份必须放在 plugins/ 之外：酒馆的 loader 会把 plugins/ 下每个目录都当成插件加载
  const backupRoot = path.join(tavern, 'plugin-backups');
  fs.mkdirSync(backupRoot, { recursive: true });
  const backup = path.join(backupRoot, 'st-mobile-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.renameSync(target, backup);
  console.log('已备份旧版本到', backup);
}

function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copy(src, dst);
    else fs.copyFileSync(src, dst);
  }
}
copy(source, target);
console.log('已复制到', target);

execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--no-audit', '--no-fund', '--loglevel=error'],
  { cwd: target, stdio: 'inherit' });

console.log('');
console.log('完成。请重启 SillyTavern。');