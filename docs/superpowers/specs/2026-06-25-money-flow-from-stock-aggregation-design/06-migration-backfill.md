# 06 迁移与回填

## 6.1 Migration 文件清单

按项目规范，每个 migration 包含同名 `.sql` + `.ps1`，PS1 用 `docker exec` 执行 SQL。

### 1. `20260625000001-drop-a-share-industry-add-sw-fields`

```sql
ALTER TABLE a_share_symbols
  DROP COLUMN IF EXISTS industry;

ALTER TABLE a_share_symbols
  ADD COLUMN IF NOT EXISTS sw_industry_l1_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS sw_industry_l2_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS sw_industry_l3_code VARCHAR(20);

DROP INDEX IF EXISTS idx_a_share_symbols_industry;
CREATE INDEX IF NOT EXISTS idx_a_share_symbols_sw_l1 ON a_share_symbols(sw_industry_l1_code);
CREATE INDEX IF NOT EXISTS idx_a_share_symbols_sw_l2 ON a_share_symbols(sw_industry_l2_code);
CREATE INDEX IF NOT EXISTS idx_a_share_symbols_sw_l3 ON a_share_symbols(sw_industry_l3_code);
```

### 2. `20260625000002-create-index-weight`

```sql
CREATE TABLE IF NOT EXISTS index_weight (
  id BIGSERIAL PRIMARY KEY,
  index_code VARCHAR(20) NOT NULL,
  con_code VARCHAR(20) NOT NULL,
  effective_date VARCHAR(8) NOT NULL,
  expire_date VARCHAR(8),
  weight NUMERIC(20, 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(index_code, con_code, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_index_weight_lookup 
  ON index_weight(index_code, con_code, effective_date);
CREATE INDEX IF NOT EXISTS idx_index_weight_active 
  ON index_weight(index_code) WHERE expire_date IS NULL;
```

### 3. `20260625000003-create-money-flow-index`

```sql
CREATE TABLE IF NOT EXISTS money_flow_index (
  id BIGSERIAL PRIMARY KEY,
  ts_code VARCHAR(20) NOT NULL,
  trade_date VARCHAR(8) NOT NULL,
  net_amount NUMERIC(20,4),
  buy_lg_amount NUMERIC(20,4),
  buy_md_amount NUMERIC(20,4),
  buy_sm_amount NUMERIC(20,4),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_money_flow_index_ts_date 
  ON money_flow_index(ts_code, trade_date);
```

### 4. `20260625000004-create-money-flow-ths-industries`

```sql
CREATE TABLE IF NOT EXISTS money_flow_ths_industries (
  id BIGSERIAL PRIMARY KEY,
  ts_code VARCHAR(20) NOT NULL,
  trade_date VARCHAR(8) NOT NULL,
  industry VARCHAR(64) NOT NULL,
  pct_change NUMERIC(20,4),
  net_buy_amount NUMERIC(20,4),
  net_sell_amount NUMERIC(20,4),
  net_amount NUMERIC(20,4),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_money_flow_ths_industries_ts_date 
  ON money_flow_ths_industries(ts_code, trade_date);
```

### 5. `20260625000005-alter-money-flow-market`

```sql
ALTER TABLE money_flow_market
  ADD COLUMN IF NOT EXISTS buy_md_amount NUMERIC(20,4);
```

## 6.2 一次性回填脚本

### 回填 `a_share_symbols` 申万行业字段

```sql
UPDATE a_share_symbols s
SET
  sw_industry_l1_code = im.l1_code,
  sw_industry_l2_code = im.l2_code,
  sw_industry_l3_code = im.l3_code
FROM (
  SELECT DISTINCT ON (ts_code)
    ts_code, l1_code, l2_code, l3_code
  FROM raw.index_member
  WHERE is_new = 'Y' OR out_date IS NULL
  ORDER BY ts_code, in_date DESC
) im
WHERE s.ts_code = im.ts_code;
```

### 同步 `index_weight` 当前月

对每个 `market_index_scope` 中的指数调用 `IndexWeightSyncService.syncForMonth(yearMonth)`。

### 历史聚合资金流重算

建议写 Node.js / TypeScript 脚本：

```typescript
// scripts/backfill-money-flow-aggregation.ts
async function backfill(startDate: string, endDate: string) {
  const tradeDates = await getTradeDates(startDate, endDate);
  for (const date of tradeDates) {
    await aggregationService.aggregateAll(date, date);
    console.log(`backfilled ${date}`);
  }
}
```

按交易日逐天聚合，便于进度控制和异常隔离。

## 6.3 上线顺序

1. **Schema 迁移**：先跑 5 个 migration，新增列/表。
2. **代码部署**：部署后端 + 前端新版本。
3. **回填数据**：
   - 回填 `a_share_symbols` 申万字段。
   - 同步 `index_weight` 当前月。
   - 重算历史聚合资金流（可选，若只关心新增数据可跳过）。
4. **重启服务**：`apps/server` 需要重启（NestJS `dev` 无热加载）。
5. **验证**：跑一键同步，检查各聚合表数据。

## 6.4 回滚策略

| 阶段 | 回滚方式 |
|---|---|
| 迁移后、代码部署前 | 执行反向 migration |
| 代码部署后、回填前 | 回滚代码，反向 migration |
| 回填后 | 保留 schema，删除回填数据，重新跑旧同步逻辑（需保留旧代码一段时间） |

建议保留旧 `moneyflow_ind_ths` / `moneyflow_cnt_ths` / `moneyflow_mkt_dc` 同步能力至少一个迭代，通过 feature flag 切换，确保出问题可快速回滚。
