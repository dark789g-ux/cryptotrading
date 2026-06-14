# 03 · Part A 数据模型与 migration

[← 返回总入口](./index.md)

## 3.1 核实基线（真 DB + 实体，2026-06-14）

已 `docker exec psql` + 读实体核实：

- `signal_test`（`signal-test.entity.ts`）：列含 `exit_mode varchar(16) 无 CHECK`、`band_lock_params jsonb`、`phase_lock_params jsonb`、`universe jsonb`、`date_start/date_end varchar(8)`。**无 backtest 相关列**。
- `signal_test_run`（`signal-test-run.entity.ts`）：`status varchar(16) 无 CHECK`、`phase varchar(16) 无 CHECK`，聚合列 `win_rate/avg_win/avg_loss/payoff_ratio/profit_factor/kelly_f/avg_hold_days/worst_trade_ret/best_trade_ret`（均 `numeric` nullable）+ `sample_count int`。**无 equity/capital/nav 列**。
- `numeric` 列在 TypeORM 侧以 `string|null` 存（既有约定，注意 JS 侧转换）。
- 表均在 `public` schema，由 **NestJS migration**（非 alembic）管理。

> `status`/`phase` 均 varchar 无 CHECK ⇒ 新增 `phase='replaying'` 枚举值**无需 migration**（仅改实体类型联合）。

## 3.2 新增 1：`signal_test.backtest_config`（jsonb，nullable）

承载迷你回测的「资金/仓位/排序/熔断/成本」配置；`null` = 不跑回测（存量行零漂移）。

形状＝单源 PortfolioSimConfig 的扁平化（字段语义见 `portfolio-sim.types.ts`）：

```jsonc
// signal_test.backtest_config (null 或如下)
{
  "initialCapital": 1000000,
  "cost": { "commissionPerSide": 0.0003, "transferPerSide": 0.00002,
            "stampSellBefore20230828": 0.001, "stampSellFrom20230828": 0.0005,
            "slippagePerSide": 0.0005 },
  "anchorMode": false,
  "positionRatio": 0.1,
  "maxPositions": null,
  "exposureCap": null,
  "rankSpec": { "factors": [] },            // [] = 不排序
  "sizing": { "mode": "fixed", "floorMult": 0.5, "capMult": 1.5,
              "kellyFraction": 0.5, "kellyMaxMult": 1.0 },
  "circuitBreaker": null                     // null = 全关
}
```

> 设计选择：**扁平化单源**而非嵌 `sources:[...]`。理由：signal_test 永远是单源，嵌套 sources 数组徒增校验面与歧义；后端适配层（[04](./04-minibacktest-backend.md)）负责组装成引擎要的 `PortfolioSimConfig{sources:[{...}]}`。

## 3.3 新增 2：`signal_test_run` 回测指标列（均 numeric/int，nullable）

`null` = 该 run 未跑回测层（与 `backtest_config IS NULL` 对应）。映射 `EngineSummary`：

| DB 列 | 类型 | 来源 `EngineSummary` |
|-------|------|----------------------|
| `final_nav` | numeric | `finalNav` |
| `total_ret` | numeric | `totalRet` |
| `annual_ret` | numeric | `annualRet`（可 null） |
| `max_drawdown` | numeric | `maxDrawdown` |
| `sharpe` | numeric | `sharpe`（可 null） |
| `calmar` | numeric | `calmar`（可 null） |
| `daily_win_rate` | numeric | `dailyWinRate`（可 null） |
| `daily_kelly` | numeric | `dailyKelly`（可 null） |
| `n_taken` | int | `nTaken` |
| `n_skipped` | int | `nSkipped` |
| `total_costs` | numeric | `totalCosts` |

> 既有 9 个信号质量聚合列（win_rate/kelly_f/…）**全部保留不动**——一次运行同时有「信号质量层」+「回测层」两组指标（D2 决策：叠加）。

## 3.4 新增 3：`signal_test_equity` 新表（逐日净值曲线）

结构参考 `portfolio_sim_daily`（`portfolio-sim-daily.entity.ts`）的子集，映射 `EngineDailyRow`（PK 用自有 `uuid` 风格，不跟随 portfolio_sim_daily 的 bigint 自增）：

```sql
CREATE TABLE signal_test_equity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES signal_test_run(id) ON DELETE CASCADE,
  trade_date    varchar(8) NOT NULL,             -- YYYYMMDD
  nav           numeric NOT NULL,
  cash          numeric NOT NULL,
  daily_ret     numeric NOT NULL,
  exposure      numeric NOT NULL,                -- Σmv / nav
  position_count integer NOT NULL,
  CONSTRAINT uq_signal_test_equity_run_date UNIQUE (run_id, trade_date)
);
CREATE INDEX idx_signal_test_equity_run ON signal_test_equity (run_id, trade_date);
```

> 不存 `strategyExposure`（单源时即 `{label: exposure}`，冗余）；不存 `fills`（逐笔 taken/skip 判定 `signal_test_trade` 已覆盖，本期不落引擎 fills）。重跑幂等：runner 写 equity 前先 `DELETE FROM signal_test_equity WHERE run_id=$1`（与 signal_test_trade 重跑清理同事务）。

## 3.5 migration 文件（NestJS）

按项目约定：`apps/server/migrations/*.sql` + 同名 `.ps1`（内置 `docker exec` 调用）。建议命名 `2026-06-14-signaltest-minibacktest`：

```sql
-- 2026-06-14-signaltest-minibacktest.sql
ALTER TABLE signal_test       ADD COLUMN IF NOT EXISTS backtest_config jsonb;

ALTER TABLE signal_test_run
  ADD COLUMN IF NOT EXISTS final_nav      numeric,
  ADD COLUMN IF NOT EXISTS total_ret      numeric,
  ADD COLUMN IF NOT EXISTS annual_ret     numeric,
  ADD COLUMN IF NOT EXISTS max_drawdown   numeric,
  ADD COLUMN IF NOT EXISTS sharpe         numeric,
  ADD COLUMN IF NOT EXISTS calmar         numeric,
  ADD COLUMN IF NOT EXISTS daily_win_rate numeric,
  ADD COLUMN IF NOT EXISTS daily_kelly    numeric,
  ADD COLUMN IF NOT EXISTS n_taken        integer,
  ADD COLUMN IF NOT EXISTS n_skipped      integer,
  ADD COLUMN IF NOT EXISTS total_costs    numeric;

CREATE TABLE IF NOT EXISTS signal_test_equity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES signal_test_run(id) ON DELETE CASCADE,
  trade_date varchar(8) NOT NULL,
  nav numeric NOT NULL, cash numeric NOT NULL, daily_ret numeric NOT NULL,
  exposure numeric NOT NULL, position_count integer NOT NULL,
  CONSTRAINT uq_signal_test_equity_run_date UNIQUE (run_id, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_signal_test_equity_run ON signal_test_equity (run_id, trade_date);
```

`.ps1` 形如（参考既有 migration 的 ps1）：`docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f - < 该 sql`，或内联 `-c`。**实现时按现有 ps1 模板对齐**。

## 3.6 实体改动清单（TypeORM）

- `signal-test.entity.ts`：加 `@Column({ type:'jsonb', nullable:true, name:'backtest_config' }) backtestConfig: SignalTestBacktestConfig | null`（新类型定义可放该文件或共享类型）。
- `signal-test-run.entity.ts`：加上述 11 个列（numeric→`string|null`，int→`number|null`）。
- 新建 `signal-test-equity.entity.ts`（`@Entity('signal_test_equity')`）。
- **双注册**：新实体须同时加入对应 module 的 `forFeature` **和** `app.module` 根 `entities` 数组（漏后者编译绿但运行时 `EntityMetadataNotFound` 500，见 memory）。
