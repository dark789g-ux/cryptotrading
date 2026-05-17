# scripts/ — quant 任务计划脚本（M4 Part L 交付物 #5）

每日 22:00 触发链：`sync → quality → infer → monitor`。

> Spec：`doc/specs/2026-05-17-quant-model-training/m4-monitoring-frontend-v2.md`
> 附录 raw 表当日最早可用时点：`adj_factor` T 日 18:30-20:00 不稳定，
> 22:00 给 1 小时缓冲；若需更早可改为 T+1 早 09:00（稳但延迟一天）。

## 文件

| 文件 | 用途 |
|---|---|
| `daily_pipeline.ps1` | 主流程：通过 NestJS REST API 串行触发 4 条 ml.jobs，逐条轮询直到终态 |
| `register_task.ps1`  | 注册 Windows 任务计划项 `QuantDailyPipeline`（每日 22:00 触发主流程） |
| `unregister_task.ps1`| 卸载任务计划项 |

## 退出码（任务计划据此判定重试）

| ExitCode | 含义 |
|---|---|
| 0 | 4 条 job 全成功 |
| 1 | 参数 / 环境校验失败 |
| 2 | sync 失败 / blocked |
| 3 | quality 失败 / blocked |
| 4 | infer 失败 / blocked |
| 5 | monitor 失败（不阻断上游 → 仍发邮件提醒） |
| 6 | 轮询超时（job > MaxPollMinutes 仍未终态） |

## 使用

### 手动跑一次（DryRun，不真的发请求）

```powershell
.\scripts\daily_pipeline.ps1 -DryRun
```

### 手动跑（真实）

```powershell
$env:QUANT_MODEL_VERSION = "lgb-lambdarank-v1-20260517-seedavg5"
.\scripts\daily_pipeline.ps1 -ApiBaseUrl http://localhost:3000 -Date 20260517
```

### 注册任务计划

```powershell
.\scripts\register_task.ps1 -RunTime "22:00" -ModelVersion "lgb-lambdarank-v1-20260517-seedavg5"
```

### 查看 / 卸载

```powershell
schtasks /Query /TN QuantDailyPipeline /V /FO LIST
.\scripts\unregister_task.ps1
```

## 邮件通知

设置 SMTP 环境变量后再运行：

```powershell
$env:SMTP_SERVER = "smtp.example.com"
$env:SMTP_FROM   = "quant-daily@example.com"
.\scripts\daily_pipeline.ps1 -MailTo "ops@example.com"
```

若 SMTP 未配置但 `-MailTo` 提供，会写一条 WARN 到日志但不阻断。

## 日志

- 路径：`./logs/daily_pipeline_<YYYYMMDD>.log`
- UTF-8 编码（CLAUDE.md 硬约束）
- 关键 4 段：`sync`/`quality`/`infer`/`monitor`，每条 job 一段
- 失败时同时 `Write-Host` + `Add-Content`

## 与 `scripts/quant-daily/` 的关系

`scripts/quant-daily/` 是 M3 阶段直接调用 `uv run quant ...` 的版本（CLI 直跑）；
本目录的 `daily_pipeline.ps1` 是 M4 升级版：

- 走 **NestJS REST API**（`POST /api/quant/jobs`），与 SSE 进度推送通道一致
- 链中多一步 **monitor**（IC drop / PSI 漂移检测，每日推理后自动触发）
- 失败时按阶段返回不同 ExitCode 便于任务计划程序按需重试

两个目录并存，无冲突：选其一注册即可。
