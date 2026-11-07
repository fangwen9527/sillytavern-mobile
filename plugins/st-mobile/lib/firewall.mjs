import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const RULE_NAME = 'SillyTavern Remote';

/** 面板上展示/复制的命令（按程序放行，端口变化不受影响）。 */
export function buildFirewallCommand(nodePath) {
  return buildFirewallCommandFor(RULE_NAME, nodePath || 'node.exe');
}

/**
 * 一个规则对象 = 一条入站放行。
 * 除了 node.exe（承载局域网网关），还要放行 iroh 的 sidecar 进程——
 * 用户实测过：那个 exe 的绿则只建在「公用网络」下，Wi-Fi 是「专用网络」时直连一律被拦，
 * 只能被迫走海外中继。
 */
export function firewallTargets(nodePath, sidecarPath) {
  const targets = [];
  if (nodePath) targets.push({ name: RULE_NAME, program: nodePath });
  if (sidecarPath) targets.push({ name: RULE_NAME + ' (iroh)', program: sidecarPath });
  return targets;
}

function netshArgs(name, program) {
  return [
    'advfirewall', 'firewall', 'add', 'rule',
    'name=' + name,
    'dir=in',
    'action=allow',
    'program=' + String(program || ''),
    'profile=private,domain',
    'enable=yes',
  ];
}

export async function ruleExists(name = RULE_NAME) {
  if (process.platform !== 'win32') return false;
  try {
    await execFileAsync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + name], { timeout: 15_000 });
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
async function addRule(target) {
  try {
    await execFileAsync('netsh', netshArgs(target.name, target.program), { timeout: 20_000 });
    return await ruleExists(target.name);
  } catch (error) {
    return { failed: String(error?.stderr || error?.message || error) };
  }
}

async function addRuleWithUac(target) {
  const uacScript = 'Start-Process -FilePath netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('
    + netshArgs(target.name, target.program).map((arg) => "'" + String(arg).replace(/'/g, "''") + "'").join(',')
    + ')';
  try {
    await execFileAsync('powershell', ['-NoProfile', '-Command', uacScript], { timeout: 120_000 });
  } catch (error) {
    return { failed: String(error?.stderr || error?.message || error) };
  }
  return await ruleExists(target.name);
}

/**
 * 一键放行：node.exe（局域网网关）+ iroh sidecar（直连通道）。
 * 每条规则都回读校验，绝不把没生效的命令报成成功。
 */
export async function applyFirewallRule(nodePath, sidecarPath) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'unsupported', message: '只有 Windows 需要这一步。' };
  }
  const targets = firewallTargets(nodePath, sidecarPath);
  if (!targets.length) {
    return { ok: false, reason: 'no_target', message: '拿不到 node.exe / sidecar 的路径。' };
  }

  const results = [];
  for (const target of targets) {
    if (await ruleExists(target.name)) {
      results.push({ name: target.name, ok: true, existed: true });
      continue;
    }
    let outcome = await addRule(target);
    if (outcome === true) {
      results.push({ name: target.name, ok: true, elevated: true });
      continue;
    }
    // 没有权限就不要假装成功，改走 UAC：弹一次系统提权框
    outcome = await addRuleWithUac(target);
    if (outcome === true) {
      results.push({ name: target.name, ok: true, usedUac: true });
      continue;
    }
    const raw = typeof outcome === 'object' && outcome ? outcome.failed : '';
    results.push({
      name: target.name,
      ok: false,
      reason: ELEVATION.test(String(raw)) || /canceled|取消/i.test(String(raw)) ? 'uac_failed' : 'not_applied',
      detail: String(raw).slice(0, 200),
    });
  }

  const failed = results.filter((row) => !row.ok);
  const message = failed.length
    ? '部分规则未生效：' + failed.map((row) => row.name).join('、') + '。可用「管理员 PowerShell」手动执行面板里的命令。'
    : '规则已就绪：' + results.map((row) => row.name + (row.existed ? '（已存在）' : '')).join('、');
  return {
    ok: failed.length === 0,
    results,
    commands: targets.map((target) => buildFirewallCommandFor(target.name, target.program)),
    message,
  };
}

export function buildFirewallCommandFor(name, program) {
  return 'netsh advfirewall firewall add rule name="' + name + '" dir=in action=allow '
    + 'program="' + String(program || '').replace(/"/g, '') + '" profile=private,domain enable=yes';
}
