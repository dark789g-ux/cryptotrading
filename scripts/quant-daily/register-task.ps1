# =====================================================================
# quant-daily / register-task.ps1
#
# 用途：把 daily-sync-quality-infer.ps1 注册为 Windows 任务计划程序条目，
#       每日 22:00 在当前 Windows 用户上下文运行（不需要管理员权限 / 不需要
#       「最高权限运行」）。
#
# 设计依据：
#   - m4-monitoring-frontend-v2.md §附录：22:00 触发时刻
#   - CLAUDE.md / Shell 规范：禁用 `&&`，schtasks 用裸命令调用
#
# 使用方法（PowerShell 用户态，无需 sudo / 管理员）：
#   pwsh -File scripts\quant-daily\register-task.ps1
#   pwsh -File scripts\quant-daily\register-task.ps1 -Time 22:30 -TaskName CryptoQuantDaily
#
# 注销：
#   schtasks /Delete /TN CryptoQuantDaily /F
#
# 验证：
#   schtasks /Query /TN CryptoQuantDaily /V /FO LIST
#   schtasks /Run   /TN CryptoQuantDaily        # 手动触发一次
# =====================================================================

[CmdletBinding()]
param(
    [string]$TaskName = 'CryptoQuantDaily',
    # HH:mm（24h 制本机 TZ）；默认 22:00（见附录论证）
    [string]$Time = '22:00',
    # 任务计划下显示的可读描述
    [string]$Description = 'cryptotrading 量化每日链：22:00 sync raw → quality check → infer'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Time -notmatch '^([01]\d|2[0-3]):[0-5]\d$') {
    throw "Time 必须为 HH:mm（24h 制），实际=$Time"
}

# 定位待注册的目标脚本绝对路径
$scriptPath = Join-Path $PSScriptRoot 'daily-sync-quality-infer.ps1'
if (-not (Test-Path $scriptPath)) {
    throw "未找到 daily-sync-quality-infer.ps1：$scriptPath"
}

# 选优先级最高的可用 powershell 解释器：
#   - 7+ 的 pwsh（Windows PowerShell 5.1 之外的现代版）
#   - 5.1 的 powershell.exe（Windows 11 自带）
$pwshCmd = (Get-Command pwsh -ErrorAction SilentlyContinue)
if ($pwshCmd) {
    $exe = $pwshCmd.Source
} else {
    $exe = (Get-Command powershell.exe).Source
}

# 任务计划要求 schtasks 的 /TR 参数整体被 ""，且内含 ' 包裹的子参数；
# 这里用一段 ExecutionPolicy=Bypass 的内联命令保证脚本可执行（不影响系统策略）
$tr = "`"$exe`" -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

Write-Host "[register-task] TN=$TaskName ST=$Time"
Write-Host "[register-task] TR=$tr"

# /RU "$env:USERNAME" + 无 /RL HIGHEST → 用户级触发器；避免要求管理员
# /F 覆盖已存在的同名任务（idempotent）
& schtasks /Create `
    /SC DAILY `
    /TN $TaskName `
    /TR $tr `
    /ST $Time `
    /RU $env:USERNAME `
    /F

if ($LASTEXITCODE -ne 0) {
    throw "schtasks /Create 失败 exit_code=$LASTEXITCODE"
}

Write-Host "[register-task] 注册成功，下面是任务详情："
& schtasks /Query /TN $TaskName /V /FO LIST
