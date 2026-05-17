# =====================================================================
# quant-daily / daily-sync-quality-infer.ps1
#
# 用途：每日 22:00 由 Windows 任务计划程序触发，按以下严格顺序执行三个阶段，
#       为下一交易日提供完整的 raw 数据 + 数据质量检查通过 + 当日推理评分。
#         1. sync raw    （TuShare → raw.*）
#         2. quality check（PIT / 行级硬约束 / 跨表行数对齐）
#         3. infer       （写 ml.scores_daily）
#
# 设计依据：
#   - doc/specs/2026-05-17-quant-model-training/m4-monitoring-frontend-v2.md
#       · 交付物 #7 / §附录 raw 表当日最早可用时点
#       · 22:00 选择理由：avoid 18:00（adj_factor 尚未稳定到位）
#   - CLAUDE.md / Shell 规范：PowerShell 禁用 `&&`，改用 `;` 或 `if ($?)`
#                            CLAUDE.md / 第三方 API 集成规范：fetcher 返回空必须 failedItems
#                            CLAUDE.md / 数据集完整性检查的最弱可接受标准（跨表行数对齐）
#   - 03-nestjs-vue.md §1 / 00-index.md §3：NestJS 已切 PG LISTEN/NOTIFY，
#       脚本无需关心进度回报，Python 侧 progress.py 自动 NOTIFY
#
# 退出语义（PowerShell ExitCode → 任务计划「上次运行结果」）：
#   0  → 三步全成功
#   1  → sync 失败
#   2  → quality 阻断（critical 级数据质量门槛未过 → 不可推理）
#   3  → infer 失败
#   4  → 参数 / 环境校验失败（在跑任何阶段之前）
#
# 注意：本脚本必须在【项目仓库根目录】或仓库下任意子目录运行（脚本自动定位仓库根），
#       并要求 apps/quant-pipeline 已通过 `uv sync` 安装好依赖；TuShare token 必须配在
#       `.env` 或环境变量 `TUSHARE_TOKEN`。
# =====================================================================

[CmdletBinding()]
param(
    # YYYYMMDD；省略时 = 今日（按本机 TZ）。手动补跑历史日期时显式传入。
    [string]$TradeDate,

    # 干跑：只打印 uv 命令、不真正执行。用于人工验证步骤顺序与参数。
    [switch]$DryRun,

    # 邮件告警地址（占位；本里程碑暂不实现 SMTP 发送，仅写日志 TODO）。
    [string]$AlertEmail
)

# ---------- 严格模式 ----------
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 任务计划程序默认在 UTF-16 控制台下运行；强制 UTF-8 输出避免中文日志乱码
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$env:PYTHONIOENCODING = 'utf-8'

function Write-Stage {
    param([string]$Stage, [string]$Msg)
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ')
    Write-Host "[$ts] [$Stage] $Msg"
}

function Get-RepoRoot {
    # 任务计划程序触发时 $PSScriptRoot 是脚本物理路径所在目录
    # scripts/quant-daily/ → 仓库根：上溯两级
    $here = $PSScriptRoot
    if (-not $here) {
        throw '无法解析 $PSScriptRoot；请用 PowerShell 直接调度此脚本而非 powershell -Command "..."'
    }
    return (Resolve-Path (Join-Path $here '..\..')).Path
}

function Get-DefaultTradeDate {
    # CLAUDE.md A 股日期规范：trade_date 用 YYYYMMDD 字面量
    # 任务计划运行时区取本机；本机已设为 Asia/Shanghai，22:00 触发即「今日」收盘
    return (Get-Date).ToString('yyyyMMdd')
}

function Invoke-UvCmd {
    param(
        [Parameter(Mandatory)] [string]$Stage,
        [Parameter(Mandatory)] [string[]]$Args
    )
    Write-Stage $Stage ("uv " + ($Args -join ' '))
    if ($DryRun) {
        Write-Stage $Stage 'DRY RUN：跳过实际执行'
        return 0
    }
    # 直接调用 uv，让其在 apps/quant-pipeline 子目录内执行（pyproject.toml 在那里）
    Push-Location (Join-Path (Get-RepoRoot) 'apps/quant-pipeline')
    try {
        & uv @Args
        $code = $LASTEXITCODE
        Write-Stage $Stage "exit_code=$code"
        return $code
    } finally {
        Pop-Location
    }
}

function Send-FailureAlert {
    param([string]$Stage, [int]$ExitCode, [string]$Msg)
    # TODO(M4 followup)：接入项目内统一告警通道（SMTP / 企业微信 / 钉钉）；
    # 目前先用日志 + 控制台标记，让任务计划「上次运行结果」非 0 即可在 Windows 任务计划程序 UI 看到失败
    $line = "[ALERT] stage=$Stage exit_code=$ExitCode msg=$Msg alert_email=$AlertEmail"
    Write-Host $line
    Write-Error $line -ErrorAction Continue
}

# =====================================================================
# main
# =====================================================================

if (-not $TradeDate) {
    $TradeDate = Get-DefaultTradeDate
}

if ($TradeDate -notmatch '^\d{8}$') {
    Send-FailureAlert -Stage 'validate' -ExitCode 4 -Msg "TradeDate 必须为 YYYYMMDD，实际=$TradeDate"
    exit 4
}

$root = Get-RepoRoot
Write-Stage 'init' "repo_root=$root trade_date=$TradeDate dry_run=$DryRun"

# ---------- Stage 1: sync raw ----------
# m4-monitoring-frontend-v2.md §附录：22:00 触发时 daily / daily_basic / adj_factor /
#   daily_indicator / stk_limit / suspend_d 都已稳定到位
# 单一日期窗：--date-range 用同日起止，便于补跑
$syncCode = Invoke-UvCmd -Stage 'sync' -Args @(
    'run', 'quant', 'sync', 'raw',
    '--date-range', "${TradeDate}:${TradeDate}",
    '--tables', 'daily,daily_basic,adj_factor,daily_indicator,stk_limit,suspend_d'
)
if ($syncCode -ne 0) {
    Send-FailureAlert -Stage 'sync' -ExitCode 1 -Msg "sync raw 失败 ($TradeDate)"
    exit 1
}

# ---------- Stage 2: quality check ----------
# --strict：critical 级数据质量问题（行级硬约束 / 跨表行数对齐失败）→ 非 0 退出
# 即使 sync exit_code=0，也可能因 fetcher 返回 0 行而 raw 数据残缺；quality 是最后兜底
$qualityCode = Invoke-UvCmd -Stage 'quality' -Args @(
    'run', 'quant', 'quality', 'check',
    '--date', $TradeDate,
    '--strict'
)
if ($qualityCode -ne 0) {
    Send-FailureAlert -Stage 'quality' -ExitCode 2 -Msg "quality check 阻断 ($TradeDate) — 不可推理"
    exit 2
}

# ---------- Stage 3: infer ----------
# 不显式传 --model-version：让 CLI 自己读取最新 prod 模型（M3 已实现）。
# 若需固定版本，运维侧改：--model-version lgb-v1-YYYYMMDD
$inferCode = Invoke-UvCmd -Stage 'infer' -Args @(
    'run', 'quant', 'infer',
    '--date', $TradeDate
)
if ($inferCode -ne 0) {
    Send-FailureAlert -Stage 'infer' -ExitCode 3 -Msg "infer 失败 ($TradeDate)"
    exit 3
}

Write-Stage 'done' "trade_date=$TradeDate sync+quality+infer 全部成功"
exit 0
