# 4. 后端 recalc 接口设计

## 4.1 公共 KDJ 纯函数

**新文件**：`apps/server/src/indicators/kdj.ts`

```ts
export function calcKdjSeries(
  bars: Array<{ high: number; low: number; close: number }>,
  n: number,
  m1: number,
  m2: number,
): Array<{ k: number; d: number; j: number }>
```

- 实现通达信标准 KDJ 公式，与现有 `precomputeAllKdj` 算法完全一致；
- 不依赖 DB，仅读取 `high/low/close`，便于单测；
- `bt-indicators.ts` 中的 `precomputeAllKdj` 可改为内部调用它，消除重复。

## 4.2 Crypto 端点

**新 DTO**：`apps/server/src/market-data/klines/dto/kdj-params.dto.ts`

```ts
class KdjParamsDto {
  @IsInt() @Min(2) @Max(99) n: number
  @IsInt() @Min(1) @Max(50) m1: number
  @IsInt() @Min(1) @Max(50) m2: number
}
```

**文件**：`apps/server/src/market-data/klines/klines.controller.ts`

新增接口：

```text
POST /api/klines/:symbol/:interval/recalc
Body: { kdjParams?: KdjParamsDto }
```

**文件**：`apps/server/src/market-data/klines/klines.service.ts`

新增 `recalcKlines(symbol, interval, kdjParams?)`：
- 从 `KlineEntity` 查询 `symbol + interval` 的全量 OHLC，按 `openTime ASC`；
- 若传 `kdjParams`，调用 `calcKdjSeries` 重算整条 KDJ；
- 其它指标字段（MACD/MA/BRICK 等）保持原值；
- 返回字段形状与 `getKlines()` 完全一致，仅 `'KDJ.K'/'KDJ.D'/'KDJ.J'` 可能被替换。

## 4.3 A 股端点

**文件**：`apps/server/src/market-data/a-shares/a-shares.controller.ts`

新增接口：

```text
POST /api/a-shares/:tsCode/klines/recalc
Query: limit, priceMode, startDate, endDate
Body: { kdjParams?: KdjParamsDto }
```

**文件**：`apps/server/src/market-data/a-shares/a-shares.service.ts`

新增 `recalcKlines(tsCode, query, kdjParams?)`：
- 执行与 `getKlines()` 相同 SQL（`raw.daily_quote` + `raw.daily_indicator` + `raw.daily_basic`）；
- 若 `kdjParams` 自定义，根据 `query.priceMode` 选择 OHLC 列：
  - `priceMode === 'raw'` → 使用 `raw.daily_quote` 的 `high/low/close`；
  - 其它任何值（含未传，即默认 `qfq`）→ 使用 `qfq_high/qfq_low/qfq_close`；
- 用选定的 OHLC 调用 `calcKdjSeries` 重新算 KDJ，替换输出中的 `'KDJ.K'/'KDJ.D'/'KDJ.J'`；
- 保持资金流、AMV、估值等其它列不变。

## 4.4 前端 API 层

**文件**：`apps/web/src/api/modules/market/symbols.ts`（或拆出 `klines.ts`）

新增：

```ts
recalcKlines: (
  symbol: string,
  interval: string,
  body: { kdjParams?: KdjSubplotParams },
) => post<KlineChartBar[]>(`/api/klines/${symbol}/${interval}/recalc`, body)
```

**文件**：`apps/web/src/api/modules/market/aShares.ts`

新增：

```ts
recalcKlines: (
  tsCode: string,
  limit: number,
  priceMode: ASharePriceMode,
  range: { startDate?: string; endDate?: string } | undefined,
  body: { kdjParams?: KdjSubplotParams },
) => post<AShareKlineBar[]>(`/api/a-shares/${tsCode}/klines/recalc?...`, body)
```

Query 构建逻辑与现有 `getKlines` 一致。
