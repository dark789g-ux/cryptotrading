# 03 · 字段表与格式化映射

## 3.1 A 股（AStockInfoFields）

数据来源：`AShareRow`（`apps/web/src/api/modules/market/aShares.ts:18-49`）。

| 分组 | label（含单位） | 字段 | formatter | 示例 |
|---|---|---|---|---|
| 分类 | 市场板块 | `market` | 原值 `?? '-'` | `主板` |
| 分类 | 行业 | `industry` | 原值 `?? '-'` | `银行` |
| 市值/估值 | 流通市值(亿) | `circMv`（可选字段） | `formatMarketCap(row.circMv ?? null)` | `1234.56 亿` |
| 市值/估值 | 总市值(亿) | `totalMv`（可选字段） | `formatMarketCap(row.totalMv ?? null)` | `5678.90 亿` |
| 市值/估值 | 市盈率TTM(倍) | `peTtm` | `formatNumber(v,2)` | `15.32` |
| 市值/估值 | 市盈率(倍) | `pe` | `formatNumber(v,2)` | `18.50` |
| 市值/估值 | 市净率(倍) | `pb` | `formatNumber(v,2)` | `2.10` |
| 市值/估值 | 换手率(%) | `turnoverRate` | `formatPercent` | `3.45%` |
| 市值/估值 | 量比(倍) | `volumeRatio` | `formatVolumeRatio`（新增） | `1.23 倍` |

> A 股不显示现价/涨跌幅行情行（K 线 toolbar 与列表已显示，避免重复）。共 9 字段。
> **可选字段注意**：`AShareRow.totalMv` / `circMv` 在类型中为可选（`string | null | undefined`，见 `aShares.ts:33-34`），而 `formatMarketCap` 入参签名为 `string | null`。传入时需 `row.totalMv ?? null` 规整 `undefined → null`，避免 TS 报错。

## 3.2 美股（UsStockInfoFields）

数据来源：`UsStockRow`（`apps/web/src/api/modules/market/usStocks.ts:17-37`）。

| 分组 | label（含单位） | 字段 | formatter | 示例 |
|---|---|---|---|---|
| 分类 | 主题 | `theme` | 原值 `?? '-'` | `半导体` |
| 分类 | 类型 | `stockType` | 原值 `?? '-'` | `成长股` |
| 行情 | 现价(美元) | `close` | `formatNumber(v,2)` | `150.25` |
| 行情 | 涨跌幅(%) | `pctChg` | `formatPercent` + `trendClass` | `+2.34%` |
| 行情 | 成交量 | `volume` | `fmtCompact`（复用） | `1.23 亿` |
| 行情 | 成交额 | `amount` | `formatAmount` | `5.67 亿` |

> 美股无 PE/PB/市值等估值字段（`UsStockRow` 无此字段，Tushare 美股无权限，Yahoo 只有 OHLCV）。共 6 字段。

## 3.3 加密（CryptoInfoFields）

数据来源：`SymbolRow`（`apps/web/src/api/modules/market/symbols.ts:94-98`）。

| 分组 | label（含单位） | 字段 | formatter | 示例 |
|---|---|---|---|---|
| 行情 | 现价(USDT) | `close` | `formatNumber(v,2)` | `65000.50` |
| 行情 | 涨跌幅(%) | `pctChg` | `formatPercent` + `trendClass` | `+2.34%` |
| 行情 | 成交量 | `volume` | `fmtCompact`（复用） | `1.23 亿` |
| 行情 | 成交额 | `amount` | `formatAmount` | `5.67 亿` |

> 加密不显示 base/quote asset（quote 恒为 USDT，信息量低；后端 `symbols/query` 也未 SELECT base_asset/quote_asset，不补字段）。共 4 字段。
>
> **⚠️ 后端字段缺口（必须先补）**：`SymbolRow` 类型当前仅有 `symbol`/`name?`/`tags?` + 索引签名，**无 `close`/`pctChg`/`volume`/`amount` 的类型化字段**；后端 `symbols.service.ts` 的 `querySymbols` SQL（`:105-125`）当前只 SELECT 了 `symbol, close, ma5, ma30, ma60, kdjJ, riskRewardRatio, stopLossPct, openTime, tags`，**缺 `pct_chg`、`volume`、`amount` 三列**（`close` 已有）。实现本字段表前必须先做后端改动（见 `./05-implementation.md` §5.2）：SQL 补 SELECT 这三列 + `SymbolRow` 类型补这四个字段。

## 3.4 新增格式化函数

仅在 `aSharesFormatters.ts` 追加一个函数：

```ts
// 量比（保留2位 + "倍"后缀；null 时单独返回 '-'，避免拼出 '-倍'）
export function formatVolumeRatio(value: string | null): string {
  if (value == null) return '-'
  return formatNumber(value, 2) + '倍'
}
```

成交量复用 `fmtCompact`（`klineChartUtils.ts:12`），零新增。

## 3.5 数据口径

**固定显示最新交易日快照**：面板数字反映"最新交易日"（与列表行 `row` 一致），不随 K 线十字光标移动联动。

理由：列表行 `AShareRow` 的基本面字段已是 `/a-shares/query` 对齐最新交易日的快照（`a-shares-query.sql.ts:135-139` 的 latest 子查询），口径与列表一致，实现最简单。

## 3.6 字段数速查

| 标的 | 分类 | 市值/估值 | 行情 | 合计 |
|---|---|---|---|---|
| A 股 | 2 | 7 | 0 | 9 |
| 美股 | 2 | 0 | 4 | 6 |
| 加密 | 0 | 0 | 4 | 4 |
