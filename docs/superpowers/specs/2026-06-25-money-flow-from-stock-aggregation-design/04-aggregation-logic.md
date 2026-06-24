# 04 聚合逻辑

## 4.1 聚合原则

- **等权聚合**：所有维度均按 `SUM(money_flow_stocks.net_amount)` 计算，不按市值/权重加权。
  - 特别说明：宽基指数聚合使用 `index_weight` 表仅用于获取 PIT 成分股列表，`index_weight.weight` 列**不参与计算**；未来若需加权聚合，再替换为 `SUM(m.net_amount * w.weight)`。
- **PIT 成分**：宽基指数使用 `index_weight` 版本链；申万行业使用 `raw.index_member` 最新有效记录；同花顺行业/概念使用 `ths_member_stocks` 当前映射。
- **同步时预计算**：在 `MoneyFlowSyncService` 中完成，写入聚合表。

## 4.2 各维度聚合 SQL

### 1. 申万三级行业

```sql
INSERT INTO money_flow_industries (
  ts_code, trade_date, industry, pct_change, net_buy_amount, net_sell_amount, net_amount
)
SELECT
  s.sw_industry_l3_code AS ts_code,
  m.trade_date,
  c.name AS industry,
  NULL AS pct_change,
  NULL AS net_buy_amount,
  NULL AS net_sell_amount,
  SUM(m.net_amount) AS net_amount
FROM money_flow_stocks m
JOIN a_share_symbols s ON s.ts_code = m.ts_code
JOIN sw_index_catalog c ON c.ts_code = s.sw_industry_l3_code AND c.level = 3
WHERE m.trade_date BETWEEN :start AND :end
GROUP BY s.sw_industry_l3_code, m.trade_date, c.name
ON CONFLICT (ts_code, trade_date) DO UPDATE SET
  net_amount = EXCLUDED.net_amount,
  updated_at = now();
```

### 2. 同花顺行业

```sql
INSERT INTO money_flow_ths_industries (
  ts_code, trade_date, industry, pct_change, net_buy_amount, net_sell_amount, net_amount
)
SELECT
  t.ts_code,
  m.trade_date,
  c.name,
  NULL AS pct_change,
  NULL AS net_buy_amount,
  NULL AS net_sell_amount,
  SUM(m.net_amount) AS net_amount
FROM money_flow_stocks m
JOIN ths_member_stocks t ON t.con_code = m.ts_code
JOIN ths_index_catalog c ON c.ts_code = t.ts_code AND c.type = 'I'
WHERE m.trade_date BETWEEN :start AND :end
GROUP BY t.ts_code, m.trade_date, c.name
ON CONFLICT (ts_code, trade_date) DO UPDATE SET
  net_amount = EXCLUDED.net_amount,
  updated_at = now();
```

### 3. 同花顺概念/板块

```sql
INSERT INTO money_flow_sectors (
  ts_code, trade_date, sector, pct_change, net_buy_amount, net_sell_amount, net_amount
)
SELECT
  t.ts_code,
  m.trade_date,
  c.name,
  NULL AS pct_change,
  NULL AS net_buy_amount,
  NULL AS net_sell_amount,
  SUM(m.net_amount) AS net_amount
FROM money_flow_stocks m
JOIN ths_member_stocks t ON t.con_code = m.ts_code
JOIN ths_index_catalog c ON c.ts_code = t.ts_code AND c.type = 'N'
WHERE m.trade_date BETWEEN :start AND :end
GROUP BY t.ts_code, m.trade_date, c.name
ON CONFLICT (ts_code, trade_date) DO UPDATE SET
  net_amount = EXCLUDED.net_amount,
  updated_at = now();
```

### 4. 宽基指数

```sql
INSERT INTO money_flow_index (
  ts_code, trade_date, net_amount, buy_lg_amount, buy_md_amount, buy_sm_amount
)
SELECT
  w.index_code AS ts_code,
  m.trade_date,
  SUM(m.net_amount),
  SUM(m.buy_lg_amount),
  SUM(m.buy_md_amount),
  SUM(m.buy_sm_amount)
FROM money_flow_stocks m
JOIN index_weight w ON w.con_code = m.ts_code
WHERE m.trade_date BETWEEN :start AND :end
  AND w.effective_date <= m.trade_date
  AND (w.expire_date IS NULL OR w.expire_date >= m.trade_date)
GROUP BY w.index_code, m.trade_date
ON CONFLICT (ts_code, trade_date) DO UPDATE SET
  net_amount = EXCLUDED.net_amount,
  buy_lg_amount = EXCLUDED.buy_lg_amount,
  buy_md_amount = EXCLUDED.buy_md_amount,
  buy_sm_amount = EXCLUDED.buy_sm_amount;
```

**PIT 条件**：`w.effective_date <= trade_date AND (expire_date IS NULL OR expire_date >= trade_date)`。

### 5. 全市场大盘

```sql
INSERT INTO money_flow_market (
  trade_date, net_amount, buy_lg_amount, buy_md_amount, buy_sm_amount
)
SELECT
  trade_date,
  SUM(net_amount),
  SUM(buy_lg_amount),
  SUM(buy_md_amount),
  SUM(buy_sm_amount)
FROM money_flow_stocks
WHERE trade_date BETWEEN :start AND :end
GROUP BY trade_date
ON CONFLICT (trade_date) DO UPDATE SET
  net_amount = EXCLUDED.net_amount,
  buy_lg_amount = EXCLUDED.buy_lg_amount,
  buy_md_amount = EXCLUDED.buy_md_amount,
  buy_sm_amount = EXCLUDED.buy_sm_amount;
```

## 4.3 聚合服务设计

建议新增 `MoneyFlowAggregationService`：

```typescript
@Injectable()
export class MoneyFlowAggregationService {
  async aggregateAll(
    startDate: string,
    endDate: string,
    onProgress?: (phase: string, current: number, total: number) => void,
  ): Promise<MoneyFlowAggregationResult>;

  private async aggregateSwIndustries(startDate: string, endDate: string): Promise<number>;
  private async aggregateThsIndustries(startDate: string, endDate: string): Promise<number>;
  private async aggregateThsSectors(startDate: string, endDate: string): Promise<number>;
  private async aggregateMarketIndices(startDate: string, endDate: string): Promise<number>;
  private async aggregateMarket(startDate: string, endDate: string): Promise<number>;
}
```

## 4.4 性能优化

1. **按日期分批**：每次只聚合本次同步的交易日，避免全量扫描。
2. **并行执行**：5 个维度之间无依赖，可 `Promise.all` 并行。
3. **索引**：确保 `money_flow_stocks(trade_date, ts_code)` 有索引。
4. **大区间历史回填**：按月份循环，每轮只聚合一个月，避免单次事务过大。

## 4.5 数据一致性校验

每次聚合完成后，应校验：

```sql
-- 全市场校验
SELECT trade_date,
       m.net_amount AS market_net,
       (SELECT SUM(net_amount) FROM money_flow_stocks WHERE trade_date = m.trade_date) AS stock_sum
FROM money_flow_market m
WHERE trade_date BETWEEN :start AND :end;

-- 申万行业校验（抽样某行业某日）
SELECT ts_code, trade_date, net_amount
FROM money_flow_industries
WHERE trade_date = :d AND ts_code = :code;
-- 对比手动 SUM(money_flow_stocks.net_amount) WHERE sw_industry_l3_code = :code AND trade_date = :d
```

校验失败应记录 warn，但不阻塞同步（避免单条异常导致整个任务失败）。
