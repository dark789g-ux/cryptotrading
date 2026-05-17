# =====================================================================
# scripts/unregister_task.ps1
#
# 卸载由 register_task.ps1 注册的 Windows 任务计划项。
# =====================================================================

[CmdletBinding()]
param(
    [string]$TaskName = "QuantDailyPipeline"
)

$ErrorActionPreference = "Stop"

& schtasks.exe /Delete /TN $TaskName /F
if ($LASTEXITCODE -eq 0) {
    Write-Host "已卸载任务: $TaskName"
} else {
    Write-Host "schtasks /Delete 返回 $LASTEXITCODE（任务可能本就不存在）" -ForegroundColor Yellow
}
