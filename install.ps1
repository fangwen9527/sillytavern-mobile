# 酒馆远程 —— 服务端组件安装脚本（Windows PowerShell）
# 用法：在酒馆根目录执行
#   powershell -ExecutionPolicy Bypass -File ".\public\scripts\extensions\third-party\sillytavern-mobile\install.ps1"

$ErrorActionPreference = 'Stop'

$extDir = $PSScriptRoot
$root = $extDir
for ($i = 0; $i -lt 5; $i++) { $root = Split-Path -Parent $root }
Write-Host "[1/4] 酒馆目录: $root"

if (-not (Test-Path (Join-Path $root 'server.js'))) {
    throw "这个目录里没有 server.js，请确认上面打印的是 SillyTavern 根目录"
}

$src = Join-Path $extDir 'plugins\st-mobile'
if (-not (Test-Path $src)) {
    throw "扩展目录里缺少 plugins\st-mobile。请用完整仓库安装扩展：git clone <仓库地址> public/scripts/extensions/third-party/sillytavern-mobile"
}

$pluginsDir = Join-Path $root 'plugins'
if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir | Out-Null }

$dst = Join-Path $pluginsDir 'st-mobile'
if (Test-Path $dst) {
    # 备份必须放在 plugins/ 之外：酒馆的 loader 会把 plugins/ 下每个目录都当成插件加载
    $backupRoot = Join-Path $root 'plugin-backups'
    if (-not (Test-Path $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot | Out-Null }
    $backup = Join-Path $backupRoot ('st-mobile-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Write-Host "[2/4] 备份旧版本到 $backup"
    Move-Item -Path $dst -Destination $backup
} else {
    Write-Host "[2/4] 没有旧版本，直接安装"
}

Write-Host "[3/4] 复制服务端组件"
Copy-Item -Path $src -Destination $dst -Recurse

Write-Host "[4/4] 安装依赖（可能需要几十秒）"
Push-Location $dst
try {
    & npm.cmd install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败，退出码 $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "完成。请重启 SillyTavern，然后回到「酒馆远程」面板。"
Write-Host "面板地址: http://127.0.0.1:<你的端口>/api/plugins/st-mobile/panel"