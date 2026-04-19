# symbols/query 返回空指标列

## 背景
`POST /api/symbols/query` 返回的 `items` 中每条记录只有 `{ symbol }`，所有指标字段（close、MA、KDJ 等）均缺失，前端表格显示 NaN 或 `-`。

## 结论
`querySymbols` 用 `fields` 参数控制 SELECT 列，前端不传 `fields` 时只 SELECT `k.symbol`。修复方法：固定 SELECT 默认列集合，不依赖 `fields`。

## 详情

### 问题根源（修复前）

```ts
// symbols.service.ts
const displayFields = fields.length > 0
  ? fields.filter((f) => INDICATOR_COLUMNS[f])
  : [];                                        // fields 为空 → 不 SELECT 任何指标列
for (const f of displayFields) {
  sql += `, k.${INDICATOR_COLUMNS[f]} AS "${f}"`;
}
```

前端 `buildQuery()` 从不传 `fields`，导致 SELECT 只有 `k.symbol`。

### 修复方案

直接在 SQL 中硬编码默认列，camelCase 别名与前端字段名对齐：

```sql
SELECT
  k.symbol,
  k.close,
  k.ma5,
  k.ma30,
  k.ma60,
  k.kdj_j            AS "kdjJ",
  k.risk_reward_ratio AS "riskRewardRatio",
  k.stop_loss_pct     AS "stopLossPct",
  k.open_time         AS "openTime"
FROM klines k ...
```

同时排序字段映射也需从旧的 CSV 大写 key（`INDICATOR_COLUMNS`）改为 camelCase：

```ts
const SORT_COL_MAP: Record<string, string> = {
  symbol: 'k.symbol', close: 'k.close',
  ma5: 'k.ma5', ma30: 'k.ma30', ma60: 'k.ma60',
  kdjJ: 'k.kdj_j', riskRewardRatio: 'k.risk_reward_ratio',
  stopLossPct: 'k.stop_loss_pct', openTime: 'k.open_time',
};
const sortCol = SORT_COL_MAP[sort.field] ?? 'k.symbol';
```
