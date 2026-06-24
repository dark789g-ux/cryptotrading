# 02 数据模型变更

## 2.1 `a_share_symbols` 表

### 变更内容

- 删除 `industry` 列及索引。
- 新增 `sw_industry_l1_code`、`sw_industry_l2_code`、`sw_industry_l3_code`。

### Migration

```sql
-- 20260625000001-drop-a-share-industry-add-sw-fields.sql
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

### 实体变更

`apps/server/src/entities/a-share/a-share-symbol.entity.ts`：

```typescript
@Column({ name: 'sw_industry_l1_code', nullable: true })
swIndustryL1Code: string | null;

@Column({ name: 'sw_industry_l2_code', nullable: true })
swIndustryL2Code: string | null;

@Column({ name: 'sw_industry_l3_code', nullable: true })
swIndustryL3Code: string | null;
```

### 回填来源

从 `raw.index_member` 取每只股票的最新有效申万三级行业：

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

## 2.2 新增 `index_weight` 表

用于存储宽基指数成分股版本链。

```sql
-- 20260625000002-create-index-weight.sql
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

### 实体

`apps/server/src/entities/index-catalog/index-weight.entity.ts`：

```typescript
@Entity('index_weight')
export class IndexWeightEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'index_code', length: 20 })
  indexCode: string;

  @Column({ name: 'con_code', length: 20 })
  conCode: string;

  @Column({ name: 'effective_date', length: 8 })
  effectiveDate: string;

  @Column({ name: 'expire_date', length: 8, nullable: true })
  expireDate: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 10, nullable: true })
  weight: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
```

## 2.3 资金流向聚合结果表

> **字段命名约定**：以下聚合结果表中的 `ts_code` 字段，在不同表中语义不同：
> - `money_flow_stocks.ts_code` = 个股代码（如 `000001.SZ`）
> - `money_flow_industries.ts_code` = 申万三级行业代码（如 `850531.SI`）
> - `money_flow_ths_industries.ts_code` = 同花顺行业指数代码（如 `881267.TI`）
> - `money_flow_sectors.ts_code` = 同花顺概念/板块指数代码（如 `885748.TI`）
> - `money_flow_index.ts_code` = 宽基指数代码（如 `000300.SH`）
>
> 虽然字段名都是 `ts_code`，但结合表名可明确其语义。所有聚合表的主键/唯一约束均为 `(ts_code, trade_date)`。

### `money_flow_industries`：申万三级行业

原表用于存储同花顺行业资金流，本次改造后数据含义改为申万三级行业。由于表结构不变，无需 migration，只需清空/重算数据。

完整表结构（与现有表一致）：

```sql
CREATE TABLE IF NOT EXISTS money_flow_industries (
  id BIGSERIAL PRIMARY KEY,
  ts_code VARCHAR(16) NOT NULL,      -- 改造后：申万三级行业代码，如 850531.SI
  trade_date VARCHAR(8) NOT NULL,
  industry VARCHAR(64) NOT NULL,
  pct_change NUMERIC(20,4),
  net_buy_amount NUMERIC(20,4),
  net_sell_amount NUMERIC(20,4),
  net_amount NUMERIC(20,4),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_money_flow_industries_ts_date 
  ON money_flow_industries(ts_code, trade_date);
```

| 字段 | 说明 |
|---|---|
| `ts_code` | **申万三级行业代码**，如 `850531.SI` |
| `trade_date` | 交易日 |
| `industry` | 申万三级行业名称 |
| `pct_change` | `NULL`（从行情表补） |
| `net_buy_amount` | `NULL` |
| `net_sell_amount` | `NULL` |
| `net_amount` | 成分股 `net_amount` 之和 |

### `money_flow_ths_industries`（新增）：同花顺行业

```sql
-- 20260625000004-create-money-flow-ths-industries.sql
CREATE TABLE IF NOT EXISTS money_flow_ths_industries (
  id BIGSERIAL PRIMARY KEY,
  ts_code VARCHAR(20) NOT NULL,      -- 同花顺行业指数代码，如 881267.TI
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

### `money_flow_sectors`：同花顺概念/板块

原表复用，数据含义不变（同花顺概念/板块），但 `pct_change` / `net_buy` / `net_sell` 填 `NULL`。

完整表结构（与现有表一致）：

```sql
CREATE TABLE IF NOT EXISTS money_flow_sectors (
  id BIGSERIAL PRIMARY KEY,
  ts_code VARCHAR(16) NOT NULL,      -- 同花顺概念/板块指数代码，如 885748.TI
  trade_date VARCHAR(8) NOT NULL,
  name VARCHAR(64) NOT NULL,
  pct_change NUMERIC(20,4),
  net_buy_amount NUMERIC(20,4),
  net_sell_amount NUMERIC(20,4),
  net_amount NUMERIC(20,4),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_money_flow_sectors_ts_date 
  ON money_flow_sectors(ts_code, trade_date);
```

### `money_flow_index`（新增）：宽基指数

```sql
-- 20260625000003-create-money-flow-index.sql
CREATE TABLE IF NOT EXISTS money_flow_index (
  id BIGSERIAL PRIMARY KEY,
  ts_code VARCHAR(20) NOT NULL,      -- 宽基指数代码，如 000300.SH
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

### `money_flow_market`：全市场大盘

当前表已有 `net_amount` / `buy_lg_amount` / `buy_sm_amount`，本次新增 `buy_md_amount`：

```sql
-- 20260625000005-alter-money-flow-market.sql
ALTER TABLE money_flow_market
  ADD COLUMN IF NOT EXISTS buy_md_amount NUMERIC(20,4);
```

`buy_lg_amount` / `buy_sm_amount` 保留，但来源从东方财富改为同花顺个股加总。

## 2.4 ER 关系图

```text
a_share_symbols
  ├── ts_code (PK)
  ├── sw_industry_l1_code ──▶ sw_index_catalog.ts_code (level=1)
  ├── sw_industry_l2_code ──▶ sw_index_catalog.ts_code (level=2)
  └── sw_industry_l3_code ──▶ sw_index_catalog.ts_code (level=3)

money_flow_stocks
  ├── ts_code
  ├── trade_date
  └── net_amount ──┬──▶ money_flow_industries (via a_share_symbols.sw_industry_l3_code)
                   ├──▶ money_flow_ths_industries (via ths_member_stocks, type='I')
                   ├──▶ money_flow_sectors (via ths_member_stocks, type='N')
                   ├──▶ money_flow_index (via index_weight)
                   └──▶ money_flow_market (all A-shares)
```
