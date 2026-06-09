# 01 · 后端 B1：A 股日 K 加日期窗口

← 返回 [index](./index.md) ｜ 下一篇 [02-backend-trades-sort-filter](./02-backend-trades-sort-filter.md)

## 目标

给 A 股日 K 接口新增**可选**日期区间参数，使详情 K 线能取到「交易当时那段」行情。不传时行为完全不变（现有调用方零影响）。

## 现状（file:line 为证）

- Service `a-shares.service.ts:175`
  ```sql
  SELECT * FROM (
    SELECT q.trade_date AS "tradeDate", ... 各指标 ...
    FROM raw.daily_quote q
    LEFT JOIN raw.daily_indicator i ON i.ts_code=q.ts_code AND i.trade_date=q.trade_date
    LEFT JOIN raw.daily_basic m     ON m.ts_code=q.ts_code AND m.trade_date=q.trade_date
    WHERE q.ts_code = $1
      AND <openCol> IS NOT NULL AND <highCol> IS NOT NULL
      AND <lowCol> IS NOT NULL AND <closeCol> IS NOT NULL
    ORDER BY q.trade_date DESC
    LIMIT $2
  ) recent
  ORDER BY "tradeDate" ASC
  ```
  - `safeLimit = Math.min(1000, Math.max(30, Number(limit) || 300))`（`:176`）。
  - `q.trade_date` 是 Tushare `YYYYMMDD`；出参 `open_time = formatTradeDateLabel(tradeDate)` → `'YYYY-MM-DD'`（`:239`）。
  - 参数数组当前 `[tsCode, safeLimit]`。
- Controller `a-shares.controller.ts:56`：`GET :tsCode/klines?limit&priceMode`，仅透传 limit/priceMode。

## 改动

### Service

签名扩展（保持位置参数向后兼容）：

```ts
async getKlines(
  tsCode: string,
  limit = 300,
  priceMode: 'qfq' | 'raw' = 'qfq',
  range?: { startDate?: string; endDate?: string },  // 新增，YYYYMMDD
): Promise<AShareKlineRow[]>
```

SQL 改为动态拼接 WHERE 与参数数组（保留 `$n` 占位顺序）：

```text
params = [tsCode]
where  = [ q.ts_code = $1, OHLC IS NOT NULL ... ]
if range?.startDate: params.push(startDate); where += ` AND q.trade_date >= $${params.length}`
if range?.endDate:   params.push(endDate);   where += ` AND q.trade_date <= $${params.length}`
params.push(safeLimit); LIMIT = `$${params.length}`
```

- `trade_date` 与 `startDate/endDate` 同为 `YYYYMMDD` 字符串，**直接字符串比较**（字典序 == 日期序），无需转型、无需 `::date`。
- `ORDER BY q.trade_date DESC LIMIT $n` 仍保留：区间有界时 LIMIT 充当安全帽（不截断小区间）。
- 复权列选择（`priceCols`，`:177`）逻辑不变。

### Controller

```ts
@Get(':tsCode/klines')
getKlines(
  @Param('tsCode') tsCode: string,
  @Query('limit') limit: string | undefined,
  @Query('priceMode') priceMode: 'qfq' | 'raw' | undefined,
  @Query('startDate') startDate: string | undefined,  // 新增
  @Query('endDate') endDate: string | undefined,       // 新增
) {
  return this.aSharesService.getKlines(
    tsCode, Number(limit), priceMode === 'raw' ? 'raw' : 'qfq',
    (startDate || endDate) ? { startDate, endDate } : undefined,
  );
}
```

- 仅传一个边界（只 startDate 或只 endDate）合法：另一侧不加约束。
- 入参不做日历校验（YYYYMMDD 非法时区间为空，返回空数组即可——前端窗口由代码生成，不会非法）。

## 前端窗口计算（在 F1 调用方，本文件仅约定口径）

给定 trade 的 `signalDate` / `exitDate`（`YYYYMMDD`）：

```text
startDate = ymd(parse(signalDate) − 30 天)
endDate   = ymd(parse(exitDate)   + 20 天)
```

- YYYYMMDD → Date **必须插分隔符**（datetime 规范）：`new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`)`，加减天用 `setUTCDate`，回拼 `YYYYMMDD`。
- padding 为自然日的近似（默认①），交易日落在区间内即可，无需精确交易日历。

## 验证

1. `pnpm --filter @cryptotrading/server build` 通过。
2. jest 单测（新增）：
   - 不传 range → SQL 与现状一致（参数仍 `[tsCode, safeLimit]`），快照/参数断言。
   - 传 `{startDate,endDate}` → 参数数组含两边界且 `$n` 顺序正确；只传一侧时只加一个约束。
3. 真 DB 抽样：
   ```bash
   docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
   "SELECT trade_date FROM raw.daily_quote WHERE ts_code='000001.SZ' AND trade_date BETWEEN '20260301' AND '20260331' ORDER BY trade_date;"
   ```
   核对接口返回的 `open_time` 集合（YYYY-MM-DD）与该区间交易日一致。
4. 回归：现有 A 股详情 Drawer（`aShareDetailFetcher` 调 `getKlines(tsCode, limit, priceMode)`）不受影响。

## 文件清单

- `apps/server/src/market-data/a-shares/a-shares.service.ts`
- `apps/server/src/market-data/a-shares/a-shares.controller.ts`
- 新增/扩展对应 `*.spec.ts`
