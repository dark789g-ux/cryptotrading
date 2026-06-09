# 02 · 后端 B2：trades 服务端排序/筛选 + 名称注入 + 索引

← [01](./01-backend-a-shares-kline-window.md) ｜ [index](./index.md) ｜ 下一篇 [03](./03-frontend-api-store-contracts.md)

## 目标

`listTrades` 支持服务端**全量**排序与筛选，并在响应中注入 `标的名称`。

## 现状（file:line）

- Service `signal-stats.service.ts:212`
  ```ts
  const [items, total] = await this.tradeRepo.findAndCount({
    where: { runId },
    order: { signalDate: 'ASC', tsCode: 'ASC' },  // 写死
    skip, take: safeSize,                          // safeSize = min(max(1,pageSize),500)
  });
  ```
- Controller `signal-stats.controller.ts:36`：`GET runs/:runId/trades?page&pageSize`。
- 实体 `signal-test-trade.entity.ts`（表 `signal_test_trade`）属性→列：`tsCode→ts_code`、`signalDate→signal_date`、`buyDate→buy_date`、`exitDate→exit_date`、`buyPrice→buy_price`、`exitPrice→exit_price`、`ret→ret`(numeric)、`holdDays→hold_days`(int)、`exitReason→exit_reason`(varchar16)。
- 名称源：`a_share_symbols`（`a-share-symbol.entity.ts`，PK `tsCode`、列 `name`）。

## 改动 1：动态排序/筛选

仍用 `findAndCount`（单表无 join，不踩「同表 leftJoin+getManyAndCount+orderBy」坑）。

### 排序白名单

前端列 key → 实体属性，经 const map 翻译（**禁裸拼字段名**，database-sql 规范）：

```ts
const SORT_COLUMN_MAP = {
  tsCode:'tsCode', signalDate:'signalDate', buyDate:'buyDate', exitDate:'exitDate',
  buyPrice:'buyPrice', exitPrice:'exitPrice', ret:'ret', holdDays:'holdDays', exitReason:'exitReason',
} as const
```

```ts
const col = SORT_COLUMN_MAP[opts.sortField as keyof typeof SORT_COLUMN_MAP]
const dir: 'ASC'|'DESC' = opts.sortOrder === 'desc' ? 'DESC' : 'ASC'
// computed key 的对象 TS 推断为 Record<string,...>，须断言到 FindOptionsOrder 才过类型检查
const order = (col
  ? { [col]: dir, id: 'ASC' }              // id 二级序 → 分页确定性（ret 等并列时翻页不串）
  : { signalDate: 'ASC', tsCode: 'ASC' }   // 非法/缺省回落现默认
) as FindOptionsOrder<SignalTestTradeEntity>
```

### 筛选（TypeORM operators）

```ts
const where: FindOptionsWhere<SignalTestTradeEntity> = { runId }
if (opts.tsCode)      where.tsCode = ILike(`%${opts.tsCode}%`)        // ts_code varchar，大小写不敏感
if (opts.exitReason && VALID_EXIT_REASONS.has(opts.exitReason))
                      where.exitReason = opts.exitReason              // 校验枚举后等值
// ret（小数；前端已把百分比换算为小数传入）
where.ret = rangeOp(opts.retMin, opts.retMax)         // Between / MoreThanOrEqual / LessThanOrEqual / 不设
// holdDays（整数）
where.holdDays = rangeOp(opts.holdDaysMin, opts.holdDaysMax)
```

`rangeOp(min,max)` 工具：两边都有 → `Between(min,max)`；仅 min → `MoreThanOrEqual(min)`；仅 max → `LessThanOrEqual(max)`；都无 → 不写该键。

`VALID_EXIT_REASONS = new Set(['max_hold','signal','delist','stop','ma5_exit'])`（与实体枚举一致；非法值忽略，不报错）。

> **ret 为 numeric**：以 JS number 作参数，Postgres numeric 比较数值序，正确。单测须走真查询验证（mock QueryBuilder 验不出，database-sql 规范）。

## 改动 2：名称注入（响应期，非 join）

```ts
const [items, total] = await this.tradeRepo.findAndCount({ where, order, skip, take: safeSize })
const codes = [...new Set(items.map(t => t.tsCode))]
const rows = codes.length
  ? await this.symbolRepo.find({ where: { tsCode: In(codes) }, select: { tsCode: true, name: true } })
  : []
const nameMap = new Map(rows.map(r => [r.tsCode, r.name]))
const enriched = items.map(t => ({ ...t, name: nameMap.get(t.tsCode) ?? null }))
return { total, items: enriched }
```

- 只查当前页 distinct codes（≤ pageSize），`IN` 查询廉价。
- 响应项类型新增 `name: string | null`（实体不变，仅响应增强）。
- `name` **不可排序**（跨全量按名称排序需 join，YAGNI）；排序仍按 `ts_code`。

### 模块注册（TypeORM 双注册）

- `signal-stats.module.ts` 的 `TypeOrmModule.forFeature([...])` **补 `AShareSymbolEntity`**，构造注入 `@InjectRepository(AShareSymbolEntity) symbolRepo`。
- 根 `app.module.ts` entities 数组**已含** `AShareSymbolEntity`（a-shares 模块在用），无需再加；实现时 grep 确认一次。

## 改动 3：Controller + DTO

新建 `dto/list-trades-query.dto.ts` 收编 query（string 入参，service 内解析）：

```ts
export class ListTradesQueryDto {
  page?: string; pageSize?: string;
  sortField?: string; sortOrder?: 'asc'|'desc';
  tsCode?: string; exitReason?: string;
  retMin?: string; retMax?: string;          // 百分比换算后的小数字符串
  holdDaysMin?: string; holdDaysMax?: string;
}
```

Controller：`@Query() q: ListTradesQueryDto`，把数值字段 `Number()` 解析（空串/NaN → undefined），组装 `opts` 调 service。Service `listTrades(runId, page, pageSize, opts)`。

## 改动 4：索引 migration（默认②）

`signal_test_trade` 现仅 `(run_id)`、`(run_id, signal_date)`。补一条覆盖最高频「按收益排序 / 收益区间筛选」：

```sql
-- apps/server/migrations/20260609_signal_test_trade_run_ret_index.sql
CREATE INDEX IF NOT EXISTS idx_signal_test_trade_run_ret
  ON signal_test_trade (run_id, ret);
```

- 配套**同名 `.ps1`**（内置 `docker exec crypto-postgres psql ...`），与既有 `apps/server/migrations/20260609_*.{sql,ps1}` 成对同规格。
- 冷门排序（buyPrice/exitDate 等）回落内存排序（单 run 有界，可接受）。
- 索引创建在大表上为一次性成本；`IF NOT EXISTS` 幂等。

## 验证

1. `pnpm --filter @cryptotrading/server build`。
2. jest 单测（真 repo 或贴近真实的集成）：
   - 排序：`sortField=ret&sortOrder=desc` 返回按 ret 降序；非法 sortField 回落默认序。
   - 筛选：tsCode 模糊命中；exitReason 等值；retMin/retMax 区间；holdDays 区间；组合条件。
   - 名称：返回项含正确 `name`；未知 code → `name=null`。
   - 分页确定性：ret 并列时翻页无重复/遗漏（id 二级序）。
3. migration：执行 `.ps1` 后 `docker exec ... psql -c "\d signal_test_trade"` 确认 `idx_signal_test_trade_run_ret` 存在。
4. **重启后端进程**后真机/HTTP 验证（nest 无 watch）。

## 文件清单

- `apps/server/src/strategy-conditions/signal-stats/signal-stats.service.ts`
- `apps/server/src/strategy-conditions/signal-stats/signal-stats.controller.ts`
- `apps/server/src/strategy-conditions/signal-stats/dto/list-trades-query.dto.ts`（新）
- `apps/server/src/strategy-conditions/signal-stats/signal-stats.module.ts`
- `apps/server/migrations/20260609_signal_test_trade_run_ret_index.sql` + 同名 `.ps1`（新）
- 对应 `*.spec.ts`
