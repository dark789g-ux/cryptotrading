# =====================================================================
# scripts/daily_pipeline.ps1
#
# 用途（M4 Part L 交付物 #5）：每日 22:00 由 Windows 任务计划程序触发，
#       通过 NestJS REST API 调度 4 条 ml.jobs，按依赖顺序串行执行：
#         1. sync     （raw.*）
#         2. quality  （行级硬约束 + PIT 三铁律 + 跨表对齐）
#         3. infer    （ml.scores_daily）
#         4. monitor  （IC drop / 评分分布漂移 / 特征 PSI）
#       每条 job 触发后轮询 GET /api/quant/jobs/:id 直到 status ∈ {success, failed, blocked}。
#
# 设计依据：
#   - doc/specs/2026-05-17-quant-model-training/m4-monitoring-frontend-v2.md
#       · 交付物 #7（cron / 任务计划脚本模板）
#       · 附录"raw 表当日最早可用时点"：22:00 给 adj_factor 留 1 小时缓冲
#   - 01-pg-schema.md §4.1：ml.jobs.params 各 run_type 的 schema
#   - CLAUDE.md Shell 规范：禁用 `&&`，用 `;` 或 `if ($?) { ... }`
#
# 退出码（任务计划程序据此判定是否重试）：
#   0  → 4 条 job 全成功
#   1  → 参数 / 环境校验失败
#   2  → sync 失败 / blocked
#   3  → quality 失败 / blocked
#   4  → infer 失败 / blocked
#   5  → monitor 失败（监控本身失败不阻断上游，但需邮件提醒）
#   6  → 轮询超时（job 超过 max_poll_minutes 仍未终态）
#
# 用法：
#   .\scripts\daily_pipeline.ps1 -ApiBaseUrl http://localhost:3000 -Date 20260517
#   .\scripts\daily_pipeline.ps1 -DryRun
#
# 通知（任一失败时触发）：
#   1) 写本地日志到 ./logs/daily_pipeline_<YYYYMMDD>.log
#   2) 若 -MailTo 提供则用 Send-MailMessage 发邮件（SMTP 配置走环境变量）
# =====================================================================

[CmdletBinding()]
param(
    [string]$ApiBaseUrl = $env:QUANT_API_BASE_URL,
    [string]$Date = (Get-Date).ToString("yyyyMMdd"),
    [string]$ModelVersion = $env:QUANT_MODEL_VERSION,
    [int]$MaxPollMinutes = 120,
    [int]$PollIntervalSec = 30,
    [string]$MailTo = "",
    [string]$SmtpServer = $env:SMTP_SERVER,
    [string]$SmtpFrom = $env:SMTP_FROM,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# ---------- 1. 参数 / 环境校验 ----------
if (-not $ApiBaseUrl) { $ApiBaseUrl = "http://localhost:3000" }
if ($Date.Length -ne 8 -or ($Date -notmatch '^\d{8}$')) {
    Write-Error "Date 必须是 YYYYMMDD 格式，got: $Date"
    exit 1
}

# 日志目录
$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$LogDir = Join-Path $RepoRoot "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir "daily_pipeline_$Date.log"

function Write-Log {
    param([string]$Level, [string]$Msg)
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $line = "[$ts][$Level] $Msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Send-Notification {
    param([string]$Subject, [string]$Body)
    if (-not $MailTo) { return }
    if (-not $SmtpServer) { Write-Log "WARN" "MailTo 已设但 SMTP_SERVER 未配置，跳过邮件"; return }
    if (-not $SmtpFrom) { $SmtpFrom = "quant-daily@localhost" }
    try {
        Send-MailMessage -To $MailTo -From $SmtpFrom -Subject $Subject `
                         -Body $Body -SmtpServer $SmtpServer -Encoding UTF8
        Write-Log "INFO" "邮件已发送到 $MailTo"
    } catch {
        Write-Log "WARN" "邮件发送失败: $_"
    }
}

Write-Log "INFO" "daily_pipeline start: ApiBaseUrl=$ApiBaseUrl Date=$Date DryRun=$DryRun"

# ---------- 2. 工具：创建 job + 轮询 ----------
function New-QuantJob {
    param([string]$RunType, [hashtable]$Params)
    if ($DryRun) {
        Write-Log "DRY" "POST $ApiBaseUrl/api/quant/jobs run_type=$RunType params=$(($Params | ConvertTo-Json -Compress))"
        return "dryrun-$RunType-id"
    }
    $body = @{ run_type = $RunType; params = $Params } | ConvertTo-Json -Depth 6
    try {
        $resp = Invoke-RestMethod -Method Post -Uri "$ApiBaseUrl/api/quant/jobs" `
                                  -Body $body -ContentType "application/json"
    } catch {
        Write-Log "ERROR" "POST /api/quant/jobs 失败 run_type=$RunType err=$_"
        throw
    }
    if (-not $resp.id) { throw "POST /api/quant/jobs 未返回 id; resp=$resp" }
    Write-Log "INFO" "job created: id=$($resp.id) run_type=$RunType"
    return [string]$resp.id
}

function Wait-QuantJob {
    param([string]$JobId, [string]$RunType)
    if ($DryRun) {
        Write-Log "DRY" "Wait job $JobId ($RunType) → 假装 success"
        return "success"
    }
    $deadline = (Get-Date).AddMinutes($MaxPollMinutes)
    while ((Get-Date) -lt $deadline) {
        try {
            $row = Invoke-RestMethod -Method Get -Uri "$ApiBaseUrl/api/quant/jobs/$JobId"
        } catch {
            Write-Log "WARN" "GET job $JobId 暂时失败，10s 后重试: $_"
            Start-Sleep -Seconds 10
            continue
        }
        $status = [string]$row.status
        $progress = [int]$row.progress
        Write-Log "INFO" "poll job=$JobId run_type=$RunType status=$status progress=$progress"
        if ($status -in @("success","failed","blocked","cancelled")) {
            return $status
        }
        Start-Sleep -Seconds $PollIntervalSec
    }
    Write-Log "ERROR" "Wait-QuantJob 轮询超时 job=$JobId run_type=$RunType > $MaxPollMinutes min"
    return "timeout"
}

# ---------- 3. 链式 4 条 job ----------
$failures = @()
try {
    # --- step 1: sync ---
    $syncParams = @{
        date_range = "$Date" + ":" + "$Date"
        tables = @("trade_cal","stk_limit","suspend_d","index_classify","index_member","fina_indicator")
    }
    $syncId = New-QuantJob -RunType "sync" -Params $syncParams
    $syncStatus = Wait-QuantJob -JobId $syncId -RunType "sync"
    if ($syncStatus -ne "success") {
        Write-Log "ERROR" "sync job 终态=$syncStatus，链式终止"
        Send-Notification "[daily_pipeline] sync $syncStatus" "job_id=$syncId status=$syncStatus date=$Date"
        if ($syncStatus -eq "timeout") { exit 6 }
        exit 2
    }

    # --- step 2: quality ---
    $qualityParams = @{ date = $Date; strict = $true }
    $qualityId = New-QuantJob -RunType "quality" -Params $qualityParams
    $qualityStatus = Wait-QuantJob -JobId $qualityId -RunType "quality"
    if ($qualityStatus -ne "success") {
        Write-Log "ERROR" "quality job 终态=$qualityStatus，链式终止"
        Send-Notification "[daily_pipeline] quality $qualityStatus" "job_id=$qualityId status=$qualityStatus date=$Date"
        if ($qualityStatus -eq "timeout") { exit 6 }
        exit 3
    }

    # --- step 3: infer ---
    if (-not $ModelVersion) {
        Write-Log "ERROR" "QUANT_MODEL_VERSION 未设置 / -ModelVersion 未传，跳过 infer + monitor"
        Send-Notification "[daily_pipeline] no model_version" "date=$Date 缺 QUANT_MODEL_VERSION"
        exit 4
    }
    $inferParams = @{ model_version = $ModelVersion; date = $Date }
    $inferId = New-QuantJob -RunType "infer" -Params $inferParams
    $inferStatus = Wait-QuantJob -JobId $inferId -RunType "infer"
    if ($inferStatus -ne "success") {
        Write-Log "ERROR" "infer job 终态=$inferStatus，链式终止"
        Send-Notification "[daily_pipeline] infer $inferStatus" "job_id=$inferId status=$inferStatus date=$Date"
        if ($inferStatus -eq "timeout") { exit 6 }
        exit 4
    }

    # --- step 4: monitor（失败不阻塞整体退出码，但通知） ---
    $monitorParams = @{ date = $Date; model_version = $ModelVersion }
    $monitorId = New-QuantJob -RunType "monitor" -Params $monitorParams
    $monitorStatus = Wait-QuantJob -JobId $monitorId -RunType "monitor"
    if ($monitorStatus -ne "success") {
        Write-Log "WARN" "monitor job 终态=$monitorStatus（不阻断整体退出码）"
        Send-Notification "[daily_pipeline] monitor $monitorStatus" "job_id=$monitorId status=$monitorStatus date=$Date"
        $failures += "monitor=$monitorStatus"
    }

    if ($failures.Count -eq 0) {
        Write-Log "INFO" "daily_pipeline OK"
        exit 0
    } else {
        Write-Log "WARN" "daily_pipeline 完成但有警告: $($failures -join ', ')"
        exit 5
    }
} catch {
    Write-Log "ERROR" "daily_pipeline 异常: $_"
    Send-Notification "[daily_pipeline] crash" "$_"
    exit 1
}
