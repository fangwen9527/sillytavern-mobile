import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const RULE_NAME = 'SillyTavern Remote';

/** 面板上展示/复制的命令（按程序放行，端口变化不受影响）。 */
export function buildFirewallCommand(nodePath) {
  const program = String(nodePath || 'node.exe').replace(/"/g, '');
  return 'netsh advfirewall firewall add rule name="' + RULE_NAME + '" dir=in action=allow '
    + 'program="' + program + '" profile=private enable=yes';
}

function netshArgs(nodePath) {
  return [
    'advfirewall', 'firewall', 'add', 'rule',
    'name=' + RULE_NAME,
    'dir=in',
    'action=allow',
    'program=' + String(nodePath || ''),
    'profile=private',
    'enable=yes',
  ];
}

export async function ruleExists() {
  if (process.platform !== 'win32') return false;
  try {
    await execFileAsync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + RULE_NAME], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const ELEVATION = /需要提升|requires elevation|管理员|Access is denied|拒绝访问/i;

/**
 * 一键添加防火墙规则。
 *
 * 两条路：
 *  1. 酒馆本身以管理员运行时，直接 netsh 就能成功；
 *  2. 否则用 PowerShell `Start-Process -Verb RunAs` 拉起一次 UAC 提权
 *     （用户桌面上会弹一次「是否允许」），不需要重开酒馆。
 */
export async function applyFirewallRule(nodePath) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'unsupported', message: '只有 Windows 需要这一步。' };
  }
  const command = buildFirewallCommand(nodePath);
  if (!nodePath) {
    return { ok: false, reason: 'no_node_path', message: '拿不到 node.exe 路径。', command };
  }

  if (await ruleExists()) {
    return { ok: true, existed: true, command, message: '规则已经存在，无需重复添加。' };
  }

  let directError = null;
  try {
    await execFileAsync('netsh', netshArgs(nodePath), { timeout: 20_000 });
    if (await ruleExists()) {
      return { ok: true, elevated: true, command, message: '规则已添加（酒馆以管理员身份运行，直接生效）。' };
    }
  } catch (error) {
    directError = String(error?.stderr || error?.message || error);
  }

  // 没有权限就不要假装成功，改走 UAC：弹一次系统提权框
  const uacScript = 'Start-Process -FilePath netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('
    + netshArgs(nodePath).map((arg) => "'" + String(arg).replace(/'/g, "''") + "'").join(',')
    + ')';
  try {
    await execFileAsync('powershell', ['-NoProfile', '-Command', uacScript], { timeout: 120_000 });
  } catch (error) {
    const raw = String(error?.stderr || error?.message || error);
    return {
      ok: false,
      reason: 'uac_failed',
      command,
      message: ELEVATION.test(raw) || /canceled|取消/i.test(raw)
        ? '提权被取消或失败。可以手动用「管理员 PowerShell」跑面板里给出的命令。'
        : '提权失败：' + raw.slice(0, 200),
    };
  }

  if (await ruleExists()) {
    return { ok: true, usedUac: true, command, message: '规则已添加（通过 UAC 提权完成）。' };
  }
  return {
    ok: false,
    reason: 'not_applied',
    command,
    directError,
    message: '提权流程走完了，但规则仍未生效。请用「管理员 PowerShell」手动执行面板里的命令。',
  };
}
