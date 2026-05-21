# 幸存者偏差安全闸修复设计

## 背景

quant-pipeline 的 `labels/runner.py` 中有两个数据加载函数存在契约不一致，导致幸存者偏差的三个安全闸全部失效：

1. **`_load_suspend()`**：查询 `suspend_date` 列，但 `raw.suspend_d` 实际列名是 `trade_date` → SQL 报错 → `except` 静默返回空 DF → 停牌过滤失效
2. **`_load_listing_info()`**：查询 `raw.stock_basic`，但该表从未建表 → SQL 报错 → `except` 静默返回空 DF → 新股过滤 + 退市强平均失效

两个异常都被 `except Exception` 捕获后 `logger.warning` + return 空数据，属于 CLAUDE.md 禁止的静默降级模式。

## 目标

- 修复列名/表名不一致，恢复幸存者偏差安全闸
- 将静默降级改为 fail-fast，让 job 失败而非产出错误标签

## 改动范围

### 文件清单

| 文件 | 改动类型 |
|------|---------|
| `apps/quant-pipeline/src/quant_pipeline/labels/runner.py` | 修复 + error handling |
| `apps/quant-pipeline/src/quant_pipeline/labels/strategy_aware.py` | 列名同步 + docstring |

### 改动 1：`runner.py` — `_load_suspend()` (第 94-110 行)

**问题**：SQL 查 `suspend_date`，实际列 `trade_date`。

**修改**：
- SQL 列名 `suspend_date` → `trade_date`（SELECT + WHERE）
- DataFrame 列名 `suspend_date` → `trade_date`
- `except` 分支：`logger.warning` + return 空 → `logger.error` + `raise`
- 空结果分支（查询成功但 0 行）：保留 `logger.warning` + return 空 DF（区间内确实可能无停牌）

### 改动 2：`runner.py` — `_load_listing_info()` (第 113-142 行)

**问题**：查 `raw.stock_basic`，该表不存在。数据实际在 `public.a_share_symbols`。

**修改**：
- 表名 `raw.stock_basic` → `public.a_share_symbols`
- 空结果分支：`logger.error` + `raise RuntimeError`（A 股列表为空 = 系统性故障）
- `except` 分支：`logger.error` + `raise`
- 更新函数 docstring

### 改动 3：`strategy_aware.py` — `derive_suspended_set()` (第 248-256 行)

**问题**：set comprehension 引用 `r["suspend_date"]`，但 DataFrame 列名已改为 `trade_date`。

**修改**：
- `r["suspend_date"]` → `r["trade_date"]`
- 更新 docstring

### 改动 4：`strategy_aware.py` — `LabelInputs` docstring (第 282 行)

**修改**：`suspend_d: raw.suspend_d（[ts_code, suspend_date]）` → `suspend_d: raw.suspend_d（[ts_code, trade_date]）`

## 不改的部分

- `filter_suspended_on_entry()` — 入参是 `suspended_set`（set），不涉及列名
- `_augment_quotes_for_exit()` — 使用 `suspended_set`，不涉及列名
- `apply_delisting_force_close()` / `filter_new_listing()` / `derive_delist_map()` / `derive_list_date_map()` — 逻辑正确，数据来源变更对它们透明
- `public.a_share_symbols` 的 schema 或同步逻辑 — 已由 NestJS 侧维护（entity 确认含 `list_date`、`delist_date` 列：`apps/server/src/entities/a-share/a-share-symbol.entity.ts` 第 29-33 行）
- `_load_daily_quotes()` / `_load_stk_limit()` — 当前 SQL 契约正确（表名、列名均与 migration 一致），不会因契约不一致而静默吞错，其 `except` 模式暂可接受

## 错误处理策略

```
┌─────────────────────────────────┬────────────────────────────────┐
│  场景                           │  行为                          │
├─────────────────────────────────┼────────────────────────────────┤
│  SQL 报错（表不存在/列名错）     │  logger.error + raise          │
│  查询成功但 0 行                │  suspend: warn + return 空 DF  │
│                                 │  listing: error + raise        │
│  查询成功且有数据               │  正常返回 DataFrame            │
└─────────────────────────────────┴────────────────────────────────┘
```

区分理由：
- SQL 报错 = 契约不一致，必须 fail-fast
- suspend_d 0 行 = 目标区间可能确实无停牌，warning 足够
- a_share_symbols 0 行 = 系统性故障，必须 fail-fast

## 验证

1. 确认 `raw.suspend_d` 实际列名：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d raw.suspend_d"`（预期含 `trade_date` 列，无 `suspend_date` 列）
2. 确认 `public.a_share_symbols` 列存在：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d public.a_share_symbols"`（预期含 `list_date`、`delist_date` 列）
3. 验证数据可读：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT ts_code, trade_date FROM raw.suspend_d LIMIT 3"`
4. 验证数据可读：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT ts_code, list_date, delist_date FROM public.a_share_symbols LIMIT 3"`
5. `pnpm --filter @cryptotrading/server build` — 确认后端无影响
6. 运行 labels job 观察是否正常产出标签（不再静默降级）
