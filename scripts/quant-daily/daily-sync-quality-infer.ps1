# =====================================================================
# quant-daily / daily-sync-quality-infer.ps1
#
# 用途：每日 22:00 由 Windows 任务计划程序触发，按以下严格顺序执行 7 个阶段，
#       让"为当日 T 出 ml.scores_daily 评分"端到端跑通。
#         1. sync-ashares-nest    （NestJS POST /api/a-shares/sync → raw.daily_quote/...）
#         2. sync-quant-tables    （Python `quant sync raw` 同步 stk_limit/suspend_d）
#         3. factors-compute      （`quant factors compute` → factors.daily_factors）
#         4. labels               （`quant labels build` 仅算 T-30 这一天）
#         5. features-build       （`quant features build-inference` labels-optional 路径）
#         6. quality              （`quant quality check --strict`）
#         7. infer                （`quant infer` 自动选最新 lgb-% 模型）
#
# 设计依据：
#   - doc/specs/2026-05-29-inference-only-feature-matrix.md
#   - CLAUDE.md / .claude/rules/data-integrity.md（fetcher 返 0 行必显式 failedItems）
#   - CLAUDE.md PowerShell 规范：禁用 `&&`，改用 `;` / `if ($?)`
#
# 退出语义（PowerShell ExitCode → 任务计划「上次运行结果」）：
#   0  → 7 阶段全成功
#   1  → sync-ashares-nest 失败（HTTP 非 2xx 或 failedItems 非空）
#   2  → quality 阻断
#   3  → infer 失败
#   4  → 参数 / 环境校验失败
#   5  → sync-quant-tables 失败
#   6  → factors-compute 失败
#   7  → labels 失败（含 trade-cal offset 数据不足）
#   8  → features-build 失败
#
# 鉴权（sync-ashares-nest 走 /api/auth/login 拿 ct_session cookie）：
#   .env 必须配 DAILY_PIPELINE_EMAIL 和 DAILY_PIPELINE_PASSWORD；账号需 admin 角色。
#
# 注意：本脚本必须在【项目仓库根目录】或仓库下任意子目录运行（脚本自动定位仓库根），
#       并要求 apps/quant-pipeline 已通过 `uv sync` 安装好依赖；
#       TUSHARE_TOKEN 必须配在 `.env` 或环境变量。
# =====================================================================

[CmdletBinding()]
param(
    # YYYYMMDD；省略时 = 今日（按本机 TZ）。手动补跑历史日期时显式传入。
    [string]$TradeDate,

    # 干跑：只打印各阶段命令、不真正执行。用于人工验证步骤顺序与参数。
    [switch]$DryRun,

    # NestJS 服务地址；本地默认 http://localhost:3000
    [string]$ServerBaseUrl = $env:DAILY_PIPELINE_SERVER_URL,

    # labels 阶段回填偏移（交易日数；正数；strategy-aware MAX_HOLD_DAYS=20 + T+1 ≈ 30；
    # 实际计算 T - LabelOffsetDays 这一天的 labels，保守取 30 不会少算只会重复 upsert）
    [int]$LabelOffsetDays = 30,

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

if (-not $ServerBaseUrl) { $ServerBaseUrl = 'http://localhost:3000' }

function Write-Stage {
    param([string]$Stage, [string]$Msg)
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ')
    Write-Host "[$ts] [$Stage] $Msg"
}

function Get-RepoRoot {
    $here = $PSScriptRoot
    if (-not $here) {
        throw '无法解析 $PSScriptRoot；请用 PowerShell 直接调度此脚本而非 powershell -Command "..."'
    }
    return (Resolve-Path (Join-Path $here '..\..')).Path
}

function Get-DefaultTradeDate {
    return (Get-Date).ToString('yyyyMMdd')
}

function Invoke-UvCmd {
    <#
    .SYNOPSIS
        在 apps/quant-pipeline 目录下调用 uv；返回 exit code（不抛异常）。
    #>
    param(
        [Parameter(Mandatory)] [string]$Stage,
        [Parameter(Mandatory)] [string[]]$UvArgs
    )
    Write-Stage $Stage ("uv " + ($UvArgs -join ' '))
    if ($DryRun) {
        Write-Stage $Stage 'DRY RUN：跳过实际执行'
        return 0
    }
    Push-Location (Join-Path (Get-RepoRoot) 'apps/quant-pipeline')
    try {
        & uv @UvArgs
        $code = $LASTEXITCODE
        Write-Stage $Stage "exit_code=$code"
        return $code
    } finally {
        Pop-Location
    }
}

function Invoke-UvCmdCapture {
    <#
    .SYNOPSIS
        与 Invoke-UvCmd 类似，但捕获 stdout 单行返回；非 0 退出码抛异常。
        用于 `quant trade-cal offset` 等"取一个值"场景。
    #>
    param(
        [Parameter(Mandatory)] [string]$Stage,
        [Parameter(Mandatory)] [string[]]$UvArgs
    )
    Write-Stage $Stage ("uv " + ($UvArgs -join ' '))
    if ($DryRun) {
        Write-Stage $Stage 'DRY RUN：跳过实际执行，回显占位值'
        return ''
    }
    Push-Location (Join-Path (Get-RepoRoot) 'apps/quant-pipeline')
    try {
        $output = & uv @UvArgs 2>&1
        $code = $LASTEXITCODE
        Write-Stage $Stage "exit_code=$code stdout_lines=$($output.Count)"
        if ($code -ne 0) {
            throw "uv 命令失败 (exit_code=$code): $($output -join ' | ')"
        }
        # 取最后一行非空（uv 可能先打 warning，再打结果）
        $lines = @($output | Where-Object { $_ -and $_.ToString().Trim() })
        if ($lines.Count -eq 0) {
            throw 'uv 命令无 stdout 输出'
        }
        return $lines[-1].ToString().Trim()
    } finally {
        Pop-Location
    }
}

function Invoke-LoginAndGetCookie {
    <#
    .SYNOPSIS
        登录 NestJS /api/auth/login，返回 ct_session cookie 值；失败抛异常。
    #>
    $email = $env:DAILY_PIPELINE_EMAIL
    $password = $env:DAILY_PIPELINE_PASSWORD
    if (-not $email -or -not $password) {
        throw 'DAILY_PIPELINE_EMAIL / DAILY_PIPELINE_PASSWORD 未在 .env 配置；admin 账号必填'
    }
    $body = @{ email = $email; password = $password } | ConvertTo-Json -Compress
    # 必须用 -SessionVariable 才能拿到 Set-Cookie；Invoke-RestMethod 默认丢弃
    $session = $null
    Invoke-RestMethod -Method Post -Uri "$ServerBaseUrl/api/auth/login" `
        -Body $body -ContentType 'application/json' `
        -SessionVariable session -TimeoutSec 30 | Out-Null
    $cookie = $session.Cookies.GetCookies($ServerBaseUrl) | Where-Object { $_.Name -eq 'ct_session' }
    if (-not $cookie) {
        throw '/api/auth/login 未返回 ct_session cookie'
    }
    return $cookie.Value
}

function Invoke-AsharesSync {
    <#
    .SYNOPSIS
        POST /api/a-shares/sync 同步指定交易日的 daily_quote/daily_basic/adj_factor/daily_indicator；
        返回 ASharesSyncResult，结构详见 apps/server/src/market-data/a-shares/a-shares.types.ts。
        失败抛异常。
    #>
    param(
        [Parameter(Mandatory)] [string]$TradeDate,
        [Parameter(Mandatory)] [string]$CookieValue
    )
    $body = @{ tradeDate = $TradeDate } | ConvertTo-Json -Compress
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $session.Cookies.Add((New-Object System.Net.Cookie('ct_session', $CookieValue, '/', ([Uri]$ServerBaseUrl).Host)))
    # 单日 sync 通常 < 60s；保守给 30 min（极端补历史可能慢）
    $result = Invoke-RestMethod -Method Post -Uri "$ServerBaseUrl/api/a-shares/sync" `
        -Body $body -ContentType 'application/json' `
        -WebSession $session -TimeoutSec 1800
    return $result
}

function Send-FailureAlert {
    param([string]$Stage, [int]$ExitCode, [string]$Msg)
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

if ($LabelOffsetDays -lt 1 -or $LabelOffsetDays -gt 60) {
    Send-FailureAlert -Stage 'validate' -ExitCode 4 -Msg "LabelOffsetDays 必须 [1,60]，实际=$LabelOffsetDays"
    exit 4
}

$root = Get-RepoRoot
Write-Stage 'init' "repo_root=$root trade_date=$TradeDate label_offset=$LabelOffsetDays dry_run=$DryRun server=$ServerBaseUrl"

# ---------- Stage 1: sync-ashares-nest ----------
# 同步 raw.daily_quote / daily_basic / adj_factor / daily_indicator（NestJS 责任表）
if ($DryRun) {
    Write-Stage 'sync-ashares-nest' "DRY RUN：POST $ServerBaseUrl/api/a-shares/sync { tradeDate=$TradeDate }"
} else {
    try {
        Write-Stage 'sync-ashares-nest' 'login → /api/auth/login'
        $cookie = Invoke-LoginAndGetCookie
        Write-Stage 'sync-ashares-nest' "POST /api/a-shares/sync { tradeDate=$TradeDate }"
        $r = Invoke-AsharesSync -TradeDate $TradeDate -CookieValue $cookie
        $failed = if ($r.PSObject.Properties.Match('failedCount')) { [int]$r.failedCount } else { 0 }
        Write-Stage 'sync-ashares-nest' "ok=$($r.ok) status=$($r.status) quotes=$($r.quotes) failed=$failed"
        if (-not $r.ok -or $failed -gt 0) {
            $items = if ($r.PSObject.Properties.Match('failedItems')) { ($r.failedItems | ConvertTo-Json -Compress -Depth 5) } else { '[]' }
            Send-FailureAlert -Stage 'sync-ashares-nest' -ExitCode 1 -Msg "ok=$($r.ok) failedCount=$failed failedItems=$items"
            exit 1
        }
    } catch {
        Send-FailureAlert -Stage 'sync-ashares-nest' -ExitCode 1 -Msg "异常：$($_.Exception.Message)"
        exit 1
    }
}

# ---------- Stage 2: sync-quant-tables ----------
# Python 拥有的 6 张表里 daily 路径只需 stk_limit / suspend_d；trade_cal / fina_indicator /
# index_classify / index_member 走人工触发或月度脚本，不属于 22:00 路径。
$syncCode = Invoke-UvCmd -Stage 'sync-quant-tables' -UvArgs @(
    'run', 'quant', 'sync', 'raw',
    '--date-range', "${TradeDate}:${TradeDate}",
    '--tables', 'stk_limit,suspend_d'
)
if ($syncCode -ne 0) {
    Send-FailureAlert -Stage 'sync-quant-tables' -ExitCode 5 -Msg "Python sync raw 失败 ($TradeDate)"
    exit 5
}

# ---------- Stage 3: factors-compute ----------
$facCode = Invoke-UvCmd -Stage 'factors-compute' -UvArgs @(
    'run', 'quant', 'factors', 'compute',
    '--version', 'v1',
    '--date-range', "${TradeDate}:${TradeDate}"
)
if ($facCode -ne 0) {
    Send-FailureAlert -Stage 'factors-compute' -ExitCode 6 -Msg "factors compute 失败 ($TradeDate)"
    exit 6
}

# ---------- Stage 4: labels（仅算 T-LabelOffsetDays 这一天） ----------
# strategy-aware 标签需 MAX_HOLD_DAYS=20+T+1≈30 个未来交易日才能闭出场窗。
# T - LabelOffsetDays 是"今天可计算的最新一天"；只算这一天即可（之前的日子已在前几日补齐）。
if ($DryRun) {
    Write-Stage 'labels' "DRY RUN：quant trade-cal offset --base $TradeDate --days -$LabelOffsetDays"
    $labelDate = "<DryRun:T-$LabelOffsetDays>"
} else {
    try {
        $labelDate = Invoke-UvCmdCapture -Stage 'labels:offset' -UvArgs @(
            'run', 'quant', 'trade-cal', 'offset',
            '--base', $TradeDate,
            '--days', "-$LabelOffsetDays"
        )
        Write-Stage 'labels' "label_date=$labelDate"
    } catch {
        Send-FailureAlert -Stage 'labels' -ExitCode 7 -Msg "trade-cal offset 失败：$($_.Exception.Message)"
        exit 7
    }
}

$labCode = Invoke-UvCmd -Stage 'labels' -UvArgs @(
    'run', 'quant', 'labels', 'build',
    '--scheme', 'strategy-aware',
    '--date-range', "${labelDate}:${labelDate}"
)
if ($labCode -ne 0) {
    Send-FailureAlert -Stage 'labels' -ExitCode 7 -Msg "labels build 失败 (label_date=$labelDate)"
    exit 7
}

# ---------- Stage 5: features-build（inference 路径） ----------
# labels-optional：T 当日无 label 仍写 feature_matrix，与训练共享同一 feature_set_id；
# inference 仅 SELECT features 列，label NaN 行不影响。
# 同时也写 T-LabelOffsetDays 那一天的 matrix（labels 已算齐），保证训练可读完整 fold。
$buildCode = Invoke-UvCmd -Stage 'features-build' -UvArgs @(
    'run', 'quant', 'features', 'build-inference',
    '--factor-version', 'v1',
    '--label-scheme', 'strategy-aware',
    '--date-range', "${TradeDate}:${TradeDate}",
    '--new-listing-min-days', '60'
)
if ($buildCode -ne 0) {
    Send-FailureAlert -Stage 'features-build' -ExitCode 8 -Msg "features build-inference 失败 ($TradeDate)"
    exit 8
}

# ---------- Stage 6: quality check ----------
$qualityCode = Invoke-UvCmd -Stage 'quality' -UvArgs @(
    'run', 'quant', 'quality', 'check',
    '--date', $TradeDate,
    '--strict'
)
if ($qualityCode -ne 0) {
    Send-FailureAlert -Stage 'quality' -ExitCode 2 -Msg "quality check 阻断 ($TradeDate) — 不可推理"
    exit 2
}

# ---------- Stage 7: infer ----------
# 不传 --model-version：CLI 自动选 max(created_at) 的 lgb-% 模型。
# 若需固定版本，运维侧改：--model-version lgb-...
$inferCode = Invoke-UvCmd -Stage 'infer' -UvArgs @(
    'run', 'quant', 'infer',
    '--date', $TradeDate
)
if ($inferCode -ne 0) {
    Send-FailureAlert -Stage 'infer' -ExitCode 3 -Msg "infer 失败 ($TradeDate)"
    exit 3
}

Write-Stage 'done' "trade_date=$TradeDate 7 阶段全部成功"
exit 0
