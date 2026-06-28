# 02 数据模型变更

> **查库场景**见 [doc/db/quick-guide/index.md](../../../doc/db/quick-guide/index.md)。本文档保留设计决策；表结构按需 `\d` 查真库。

## 2.1 `a_share_symbols` 表

表结构：`public.a_share_symbols`

### 变更内容

- 删除 `industry` 列及索引。
- 新增 `sw_industry_l1_code`、`sw_industry_l2_code`、`sw_industry_l3_code`。

### Migration

DDL 已迁移至 doc/db/。列变更 migration 见 `apps/server/src/migration/20260625000001-drop-a-share-industry-add-sw-fields.sql`。

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

表结构：`public.index_weight`（列定义按需 `\d schema.table`）

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

表结构：`public.money_flow_industries`（列定义按需 `\d schema.table`）

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

表结构：`public.money_flow_ths_industries`（列定义按需 `\d schema.table`）

### `money_flow_sectors`：同花顺概念/板块

原表复用，数据含义不变（同花顺概念/板块），但 `pct_change` / `net_buy` / `net_sell` 填 `NULL`。

表结构：`public.money_flow_sectors`（列定义按需 `\d schema.table`）

### `money_flow_index`（新增）：宽基指数

表结构：`public.money_flow_index`（列定义按需 `\d schema.table`）

### `money_flow_market`：全市场大盘

当前表已有 `net_amount` / `buy_lg_amount` / `buy_sm_amount`，本次新增 `buy_md_amount`。

表结构：`public.money_flow_market`（列定义按需 `\d`；`buy_md_amount` 列 migration 见 `20260625000005-alter-money-flow-market.sql`）

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
