# 03 · 维护与集成

## A. 增量维护：挂进 A股同步链

`a-shares-sync.service.ts` 的 `syncWithProgress` 同步链：

```text
105 syncDailyQuotesByTradeDate          → raw.daily_quote
126 syncDailyMetricsByTradeDate         → daily_basic
145 syncAdjFactorsByTradeDate           → 复权因子（latestAdjFactorChanged）
196 markDirtyRanges                     → 写 a_share_sync_states.qfq_dirty_from_date（按变化范围）
211 recalculateDirtyQfqQuotes           → qfq 重算（消费 qfq 脏，顺手写 indicator_dirty_from_date）
234 indicatorService.recalculateDirtyIndicatorsForSymbols  → 技术指标重算（消费 indicator 脏）
▶   【新增】signalRollingService.recalculateDirtyForSymbols → 本设计的滚动指标重算（消费 signal_rolling 脏）
```

挂载点：第 234 行技术指标重算**之后**新增一步（约 248 行）。
注意 AMV（`stock_amv_daily`）**不在**此链上（独立 API 触发）；但技术指标重算在链上，本设计**对齐技术指标的脏机制**入链。

## B. qfq 脏对齐（关键，避免竞态）

`a_share_sync_states` 按 **ts_code 一条**（`entities/a-share/a-share-sync-state.entity.ts:5` `@PrimaryColumn ts_code`）。
qfq 重算清脏时（`market-data/a-shares/sync/a-shares-sync-dirty-ranges.ts` 的 `recalculateDirtyQfqQuotesForSymbol`，第 134-150 行
`ON CONFLICT DO UPDATE`）已经顺手写 `indicator_dirty_from_date = MIN(existing, dirtyFrom)`。

**本设计照此再加一列** `signal_rolling_dirty_from_date`：

1. migration 给 `a_share_sync_states` 加列 `signal_rolling_dirty_from_date varchar(8) NULL`。
2. 改 `a-shares-sync-dirty-ranges.ts` 清 qfq 脏的 `ON CONFLICT DO UPDATE`，**同时**写
   `signal_rolling_dirty_from_date = LEAST/MIN(existing, dirtyFrom)`（与 `indicator_dirty_from_date` 并列同值）。
3. 新 service `recalculateDirtyForSymbols` 读该列、重算、清该列（置 NULL）。

> **为什么不复用 `indicator_dirty_from_date`**：它在第 234 行被技术指标重算消费并清空；本设计在其后运行，
> 若读同一列会读到已清空的 NULL → 漏算。独立一列彻底避开顺序耦合。

**重算范围**：对每个脏 ts_code，从 `signal_rolling_dirty_from_date` 起、向前取 **120 个交易 bar 热身**
（覆盖最大窗口），跑 `02` 的同款窗口 SQL 限定 `ts_code` + `trade_date >= dirty_from`，upsert 覆盖。

**新增交易日的覆盖**：已核实 `syncDailyQuotesByTradeDate` 返回当日写入的全部 `tsCodes`，经
`mergeChangedDates` 喂入 `markDirtyRanges`，故新交易日的每只票都会落进脏区间 → 自动被本步重算。
（"最新交易日尚无 `signal_rolling` 行"的标的另补，仅作防御兜底，非必需。）

**全量回填入口**：仿 AMV 的 `POST /api/active-mv/stock/sync`，提供
`POST /api/signal-rolling-indicator/backfill`（service `backfillAll()`，按 ts_code 分批跑回填 SQL），一次性铺底。
回填是重负载管理操作，controller 须加 `@AdminOnly()`（同款见 `market-data/active-mv/active-mv.controller.ts:18-19`），避免任意登录用户触发全市场回填。

## C. 四处集成编辑点（file:line）

| # | 改动 | 文件 | 位置 | 内容 |
|---|------|------|------|------|
| 1 | 字段映射加 5 项 → 别名 `d` | `strategy-conditions/strategy-conditions.types.ts` | `ASHARE_FIELD_COL_MAP` 第 39 行后 | 见下 |
| 2 | 枚举器 FROM 加 join | `strategy-conditions/signal-stats/signal-stats.enumerator.ts` | 第 148 行后 | `LEFT JOIN signal_rolling_indicator d ON d.ts_code=i.ts_code AND d.trade_date=i.trade_date` |
| 3 | 实时扫描器 FROM 加 join | `strategy-conditions/strategy-conditions.runner.ts` | 第 110 行后 | `LEFT JOIN signal_rolling_indicator d ON d.ts_code=s.ts_code AND d.trade_date=i.trade_date` |
| 4 | 前端字段下拉加 5 项 | `apps/web/src/components/strategy-conditions/ConditionRows.vue` | `A_SHARE_FIELDS` 第 144 行后 | 见下 |

> ⚠️ 字段映射被枚举器 + 实时扫描器**两处共享**（均经 `queryBuilder.buildAShareQuery`）。
> 只加映射不在**两处** FROM 都 join，则实时条件扫描用到这些字段会 500。两处缺一不可。

**改动 1**（`ASHARE_FIELD_COL_MAP` 追加）：
```typescript
pos_120:          'd.pos_120',
pos_60:           'd.pos_60',
close_ma60_ratio: 'd.close_ma60_ratio',
vol_ratio_60:     'd.vol_ratio_60',
vol_ratio_120:    'd.vol_ratio_120',
```

**改动 4**（`A_SHARE_FIELDS` 追加，跨表字段 `supportsCross:false`，同 `amv_dif` 处理）：
```typescript
{ label: '120日区间位置', value: 'pos_120',          supportsCross: false },
{ label: '60日区间位置',  value: 'pos_60',           supportsCross: false },
{ label: '收盘/MA60',     value: 'close_ma60_ratio', supportsCross: false },
{ label: '量比(60日均量)', value: 'vol_ratio_60',     supportsCross: false },
{ label: '量比(120日均量)',value: 'vol_ratio_120',    supportsCross: false },
```

`strategy-conditions.service.ts` **无需改**（只做 CRUD + 调 runner，不构造扫描 SQL）。

## D. Migration + .ps1

仿 `migrations/20260607_create_signal_test_tables.{sql,ps1}` 与 `20260608_*.ps1` 结构：

- `migrations/<ts>_create_signal_rolling_indicator.sql`：`02` 的建表 + 给 `a_share_sync_states` 加
  `signal_rolling_dirty_from_date` 列（`ALTER TABLE … ADD COLUMN IF NOT EXISTS`）。
- 同名 `.ps1`：标准 `docker exec` 写法（核对自 `20260608_signal_test_run_best_trade_ret.ps1:30-33`）：
  ```powershell
  Get-Content -Raw -Encoding utf8 $scriptPath |
    docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
  if ($LASTEXITCODE -ne 0) { throw "psql execution failed, exit code $LASTEXITCODE" }
  ```
  固定量：容器 `crypto-postgres` / 用户 `cryptouser` / 库 `cryptodb`。建表后用 `Invoke-Scalar` 校验表与列存在。

> migration 只建 schema（表 + 加列）；全量回填走 `POST .../backfill`，不塞进 migration（数据量大、可重跑）。

## E. 新建模块结构（仿 active-mv）

```text
market-data/signal-rolling-indicator/
  signal-rolling-indicator.module.ts        # forFeature(实体) + controller + service
  signal-rolling-indicator.controller.ts    # POST /backfill（一次性回填，@AdminOnly()）
  signal-rolling-indicator.service.ts       # backfillAll() / recalculateDirtyForSymbols()
entities/strategy/signal-rolling-indicator.entity.ts   # 实体（亦注册进 app.module 根 entities）
```

`a-shares-sync.service.ts` 注入该 service，在第 234 行后调 `recalculateDirtyForSymbols(changedTsCodes)`。

---
*硬事实核对（2026-06-09，后端路径相对 `apps/server/src/`）：
同步链 `market-data/a-shares/sync/a-shares-sync.service.ts:105/126/145/196/211/234`；
qfq 脏设/清 `market-data/a-shares/sync/a-shares-sync-dirty-ranges.ts:19-49/65-151`；
`a_share_sync_states` 主键 ts_code `entities/a-share/a-share-sync-state.entity.ts:5`；
字段映射 `strategy-conditions/strategy-conditions.types.ts:4-39`；
两处 FROM `strategy-conditions/signal-stats/signal-stats.enumerator.ts:147-148` /
`strategy-conditions/strategy-conditions.runner.ts:109-110`；
前端字段 `apps/web/src/components/strategy-conditions/ConditionRows.vue:104-145`。*
