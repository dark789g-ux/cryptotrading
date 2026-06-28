# 测试、清理与交付

## Jest 测试计划

| 测试文件 | 要点 | Python 对照 |
|----------|------|-------------|
| `custom-index-weight-resolver.spec.ts` | PIT 版本链、effective_date 边界 | `test_weight_resolver.py` |
| `custom-index-price-index.spec.ts` | 2 成分等权手工验算 | `test_price_index.py` |
| `custom-index-chain-link.spec.ts` | 版本切换日指数连续 | spec 有、Python **无** |
| `custom-index-compute.runner.spec.ts` | mock DataSource，小样本跑 Stage 1–7 | — |
| `custom-index-sse.controller.spec.ts` | 轮询终态 `ready`/`failed` 关闭流 | — |
| `custom-index.service.spec.ts` | 不再 mock `ml.jobs`；mock `scheduleCompute`；`remove()` computing → 409 | 更新现有 |

### 数值对齐（可选）

选 2 成分、10 交易日 fixture：Python 删前最后一次对照；或 Jest snapshot 与 handoff 手工验算表。

## 验证命令

```powershell
pnpm --filter @cryptotrading/server exec jest custom-index --no-cache
pnpm --filter @cryptotrading/server build
pnpm --filter @cryptotrading/web type-check
```

Python 测试在删除前可选对照：

```powershell
cd apps/quant-pipeline; uv run pytest tests/custom_index/ -q
```

删除 Python 后跳过。

## 端到端验收

**前提**：migration 已执行；**仅** `pnpm dev`（**无** quant worker）。

| # | 步骤 | 预期 |
|---|------|------|
| 1 | 登录 → 标的 → A 股数据 → A 股指数 → 我的指数 → 创建指数 | Modal 正常 |
| 2 | 2–5 只成分，等权，近期 base_date，价格指数 | POST 返回 `status=pending`，**无** `job_id` |
| 3 | 提交后列表 | `status=computing`，progress 递增，**无需** Python |
| 4 | 终态 ready → 点行 K 线 | OHLC + VOL/KDJ/MACD + 0AMV 副图 |
| 5 | 编辑成分 → 保存并重算 | chain link 无异常跳空 |
| 6 | 成分股跳转 | 股票 tab 仅 custom 成分 |
| 7 | computing 时点删除 | API 返回 409（前端按钮已 disabled） |

### DB 抽查

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT status, compute_progress, compute_stage FROM custom_index_definitions ORDER BY updated_at DESC LIMIT 5;"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT COUNT(*) FROM custom_index_daily_quotes WHERE custom_index_id = '<uuid>';"
```

### 重启恢复验收

1. 创建指数，等进入 `computing`
2. 重启 `pnpm dev`
3. 该指数应变为 `failed`，`last_error` 含 `interrupted`
4. 点「重算」可恢复至 `ready`

## Python 清理（Phase 4）

| 路径 | 动作 |
|------|------|
| `apps/quant-pipeline/src/quant_pipeline/custom_index/` | **删除**整目录 |
| `apps/quant-pipeline/src/quant_pipeline/worker/dispatcher.py` | 移除 `_runner_custom_index_compute` 路由 |
| `apps/quant-pipeline/tests/custom_index/` | **删除**（Jest 覆盖后） |

可选：单 PR 先 mark deprecated 再删；推荐与 PR2 一并删除。

## 前端改动清单

| 文件 | 改动 |
|------|------|
| `apps/web/src/api/modules/market/customIndex.ts` | `CreateCustomIndexResult` 去掉 `job_id` |
| Modal / Panel / `useCustomIndexSse.ts` | **预期零改** |

## PR 切分建议

```text
PR1  NestJS compute/ Runner + Jest 单元测试
     enqueue 仍走旧路径或 mock；不对外切换

PR2  ComputeService scheduleCompute + SSE token/guard/controller 全链路
     + startup hook + 删 Python custom_index + dispatcher 路由
     （一次性切换，不做长期 feature flag 双路径）

PR3  更新 custom-index-create-design/04 + index 总览图 + CLAUDE.md
     + handoff 移 prompts/archive/
```

## 不要做的事

- 不要把计算放回同步 HTTP（POST 超时）
- 不要重新引入 `POST /api/quant/jobs` 给普通用户
- 不要把 custom 指数写入 `index_daily_quotes`
- 不要在本任务改 Modal 步骤或行情表 UX

## handoff 归档

实现并验收通过后，将 `prompts/migrate-custom-index-compute-to-nestjs.md` 移至 `prompts/archive/`。
