# =====================================================================
# scripts/register_task.ps1
#
# 注册 Windows 任务计划项 "QuantDailyPipeline"：每日 22:00 触发
# scripts/daily_pipeline.ps1（M4 Part L 交付物 #5）。
#
# 重新执行此脚本会先 schtasks /Delete 旧任务再创建，等价"幂等更新"。
#
# 用法：
#   .\scripts\register_task.ps1                       # 默认 22:00
#   .\scripts\register_task.ps1 -RunTime "22:30"      # 自定义时刻
#
# 卸载：scripts/unregister_task.ps1
# =====================================================================

[CmdletBinding()]
param(
    [string]$TaskName = "QuantDailyPipeline",
    [string]$RunTime = "22:00",
    [string]$ApiBaseUrl = "http://localhost:3000",
    [string]$ModelVersion = "",
    [string]$MailTo = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$ScriptPath = Join-Path $RepoRoot "scripts\daily_pipeline.ps1"
if (-not (Test-Path $ScriptPath)) {
    Write-Error "daily_pipeline.ps1 不存在：$ScriptPath"
    exit 1
}

# 构造 powershell.exe 参数（注意单引号 + 转义；CLAUDE.md PowerShell 规范禁用 &&）
$pwshArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -ApiBaseUrl `"$ApiBaseUrl`""
if ($ModelVersion) { $pwshArgs += " -ModelVersion `"$ModelVersion`"" }
if ($MailTo)       { $pwshArgs += " -MailTo `"$MailTo`"" }

# 先尝试删除旧任务（不存在时忽略错误）
$null = & schtasks.exe /Delete /TN $TaskName /F 2>&1
Write-Host "尝试删除旧任务 $TaskName（若不存在则忽略）"

# 创建任务
$createCmd = @(
    "/Create",
    "/TN", $TaskName,
    "/SC", "DAILY",
    "/ST", $RunTime,
    "/TR", "powershell.exe $pwshArgs",
    "/RL", "HIGHEST",
    "/F"
)
& schtasks.exe @createCmd
if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks /Create 失败，exit=$LASTEXITCODE"
    exit 1
}

Write-Host ""
Write-Host "已注册任务: $TaskName  (每日 $RunTime)"
Write-Host "  -> powershell.exe $pwshArgs"
Write-Host ""
Write-Host "查看：schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "卸载：scripts\unregister_task.ps1 -TaskName $TaskName"
