# =====================================================================
# quant-weekly / seed-avg.ps1
#
# 用途：每周（建议周日 22:00 后跑完当周最后一日的 daily 再触发）跑一次 5-seed
#       平均集成训练，把产物升为 prod，旧 prod 降为 shadow。
#
# spec 2026-05-29 P2.3：seed-avg 不进 daily 22:00 路径（耗时高、不是每日必需）。
#
# 参数：
#   -BaseModelVersion  基准模型（默认取 ml.model_runs 最新 status='prod' 之外
#                      的 max(created_at) 单 seed 版本）
#   -Seeds             逗号分隔的 5 个 seed（默认 42,123,456,789,999，与 runbook 一致）
#   -DryRun            只打印命令
#
# 退出码：
#   0  → seed-avg 跑完 + status 升级成功
#   1  → seed-avg 训练失败
#   2  → 参数 / 环境校验失败
#   3  → status 升级 SQL 失败
# =====================================================================

[CmdletBinding()]
param(
    [string]$BaseModelVersion,
    [string]$Seeds = '42,123,456,789,999',
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$env:PYTHONIOENCODING = 'utf-8'

function Write-Stage {
    param([string]$Stage, [string]$Msg)
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ')
    Write-Host "[$ts] [$Stage] $Msg"
}

function Get-RepoRoot {
    $here = $PSScriptRoot
    if (-not $here) {
        throw '无法解析 $PSScriptRoot'
    }
    return (Resolve-Path (Join-Path $here '..\..')).Path
}

function Invoke-Psql {
    param([Parameter(Mandatory)] [string]$Sql)
    if ($DryRun) {
        Write-Stage 'psql' "DRY RUN: $Sql"
        return
    }
    $output = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -c $Sql
    if ($LASTEXITCODE -ne 0) {
        throw "psql 失败 (exit=$LASTEXITCODE): $Sql"
    }
    return $output
}

# ---------- Stage 0: 确定 BaseModelVersion ----------
if (-not $BaseModelVersion) {
    if ($DryRun) {
        $BaseModelVersion = '<DryRun:auto-discovered>'
    } else {
        # 取最新一个**非集成**的单 seed 模型作为 base
        $sql = "SELECT model_version FROM ml.model_runs " +
               "WHERE model_version NOT LIKE '%seedavg%' " +
               "ORDER BY created_at DESC LIMIT 1;"
        $raw = docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -t -A -c $sql
        if ($LASTEXITCODE -ne 0 -or -not $raw) {
            Write-Error '无法自动定位 base 模型；请显式传 -BaseModelVersion'
            exit 2
        }
        $BaseModelVersion = $raw.Trim()
    }
}
Write-Stage 'init' "base_model=$BaseModelVersion seeds=$Seeds dry_run=$DryRun"

# ---------- Stage 1: seed-avg 训练 ----------
$root = Get-RepoRoot
Push-Location (Join-Path $root 'apps/quant-pipeline')
try {
    Write-Stage 'seed-avg' "uv run quant seed-avg --base $BaseModelVersion --seeds $Seeds"
    if (-not $DryRun) {
        & uv run quant seed-avg --base $BaseModelVersion --seeds $Seeds
        $code = $LASTEXITCODE
        Write-Stage 'seed-avg' "exit_code=$code"
        if ($code -ne 0) {
            Write-Error "seed-avg 训练失败 (exit=$code)"
            exit 1
        }
    }
} finally {
    Pop-Location
}

# ---------- Stage 2: status 升级 ----------
# 升 prod：把新跑的 seedavg5 集成模型升为 prod（model_version 命名约定见
# apps/quant-pipeline/src/quant_pipeline/training/seed_avg.py）。
# 降 shadow：把之前的 prod（非本次 seedavg）降级避免双 prod。
#
# 必须**先查到新 seedavg5 才操作**，否则空 NOT IN 会把现有 prod 全部降级，
# 导致 daily infer 选不到 prod 模型。
$promoteSql = @'
DO $$
DECLARE
    new_prod_id uuid;
BEGIN
    SELECT id INTO new_prod_id
      FROM ml.model_runs
     WHERE model_version LIKE '%seedavg5%'
       AND status <> 'prod'
     ORDER BY created_at DESC
     LIMIT 1;

    IF new_prod_id IS NULL THEN
        RAISE NOTICE 'no new seedavg5 model found; skip prod promotion';
        RETURN;
    END IF;

    UPDATE ml.model_runs SET status = 'shadow'
     WHERE status = 'prod'
       AND id <> new_prod_id;

    UPDATE ml.model_runs SET status = 'prod'
     WHERE id = new_prod_id;
END$$;
'@

Write-Stage 'promote' '把最新 seedavg5 升 prod；旧 prod 降 shadow'
Invoke-Psql -Sql $promoteSql | Out-Null

# 校验：当前 prod 应该唯一且是 seedavg5
if (-not $DryRun) {
    Write-Stage 'promote' '==== 校验当前 prod 模型 ===='
    Invoke-Psql -Sql "SELECT model_version, status, created_at FROM ml.model_runs WHERE status='prod' ORDER BY created_at DESC;"
}

Write-Stage 'done' "seed-avg 完成，prod 已升级"
exit 0
