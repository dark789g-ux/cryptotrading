# 资金流向同步进度可视化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「同步资金流向数据」Modal 中实时显示同步进度（含重试反馈与失败列表），用 SSE 替换现有的并行 4 个 REST 调用。

**Architecture:** 后端删除 4 个 POST 接口，新增 1 个 `GET /money-flow/sync/run` SSE 端点；service 层按维度串行（stocks → industries → sectors → market）执行，每个 tradeDate 失败时单点重试 2 次（退避 1s/2s），失败累加到 `MoneyFlowSyncResult.errors` 后继续；前端复用现有 `useSSE` composable 与 `DataSyncModal` 的 `<slot name="extra">`。

**Tech Stack:** NestJS 10 + RxJS Subject + TypeORM；Vue 3 + naive-ui + 现有 `useSSE.ts`；类型在 `packages/shared-types` 中前后端共享。

**Spec:** `docs/superpowers/specs/2026-05-10-money-flow-sync-progress-design.md`

---

## File Structure

**Created:**
- `apps/web/src/components/sync/MoneyFlowSyncProgress.vue` —— 进度面板与完成态汇总组件
- `apps/server/src/market-data/money-flow/money-flow-sync.service.spec.ts` —— TDD 单测

**Modified:**
- `packages/shared-types/src/money-flow.ts` —— 新增 `MoneyFlowSyncEvent` / `MoneyFlowSyncSummary`
- `apps/server/src/market-data/money-flow/money-flow-sync.service.ts` —— 加 `runWithRetry`、扩展 4 个 sync 方法签名、新增 `startSync()`
- `apps/server/src/market-data/money-flow/money-flow-sync.controller.ts` —— 删除 4 个 POST，新增 SSE GET
- `apps/web/src/api/modules/moneyFlow.ts` —— 删除 4 个 sync 方法，新增 `syncRunUrl`
- `apps/web/src/components/sync/useMoneyFlowSync.ts` —— 改为 `useSSE` 驱动
- `apps/web/src/components/sync/DataSyncModal.vue` —— 新增 `finished` prop 与按钮变体逻辑
- `apps/web/src/views/sync/SyncView.vue` —— 解构新字段、传入 slot

---

## Task 1: shared-types 中新增 SSE 事件类型

**Files:**
- Modify: `packages/shared-types/src/money-flow.ts`

- [ ] **Step 1: 在文件末尾追加事件与汇总类型**

```ts
/** SSE 事件 —— GET /money-flow/sync/run */
export type MoneyFlowSyncEvent =
  | {
      type: 'progress'
      percent: number
      phase: string
      current: number
      total: number
      message: string
    }
  | {
      type: 'done'
      message: string
      summary: MoneyFlowSyncSummary
    }
  | {
      type: 'error'
      message: string
    }

export interface MoneyFlowSyncSummary {
  stocks: MoneyFlowSyncResult
  industries: MoneyFlowSyncResult
  sectors: MoneyFlowSyncResult
  market: MoneyFlowSyncResult
}
```

- [ ] **Step 2: 构建 shared-types 包验证类型导出**

Run: `pnpm --filter @cryptotrading/shared-types build`
Expected: 构建成功，`dist/money-flow.d.ts` 包含 `MoneyFlowSyncEvent`/`MoneyFlowSyncSummary`。

- [ ] **Step 3: 提交**

```bash
git add packages/shared-types/src/money-flow.ts
git commit -m "feat(shared-types): 新增 MoneyFlowSyncEvent 与 MoneyFlowSyncSummary"
```

---

## Task 2: 后端 service 单测骨架（TDD —— 先红）

**Files:**
- Create: `apps/server/src/market-data/money-flow/money-flow-sync.service.spec.ts`

- [ ] **Step 1: 写失败的单测**

参照 `apps/server/src/preferences/preferences.service.spec.ts` 的 `Test.createTestingModule` 模式。

```ts
// apps/server/src/market-data/money-flow/money-flow-sync.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { firstValueFrom, toArray } from 'rxjs';
import { MoneyFlowSyncService } from './money-flow-sync.service';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import * as syncUtils from '../a-shares/sync/a-shares-sync-utils';

describe('MoneyFlowSyncService - SSE & retry', () => {
  let service: MoneyFlowSyncService;
  let tushareClient: { query: jest.Mock };
  const mockRepo = () => {
    const qb: any = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
      getRawMany: jest.fn().mockResolvedValue([]),
      getMany: jest.fn().mockResolvedValue([]),
    };
    return {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      upsert: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockImplementation((x: any) => x),
    };
  };

  beforeEach(async () => {
    tushareClient = { query: jest.fn() };
    jest.spyOn(syncUtils, 'resolveOpenTradeDates').mockResolvedValue(['20260501', '20260502']);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoneyFlowSyncService,
        { provide: getRepositoryToken(MoneyFlowStockEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowIndustryEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowSectorEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowMarketEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(AShareSymbolEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(ThsMemberStockEntity), useValue: mockRepo() },
        { provide: TushareClientService, useValue: tushareClient },
      ],
    }).compile();

    service = module.get(MoneyFlowSyncService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('runWithRetry: 第二次成功 → 累计 1 条 retry 事件 + 不抛异常', async () => {
    jest.useFakeTimers();
    tushareClient.query
      .mockRejectedValueOnce(new Error('limit'))
      .mockResolvedValueOnce([]);
    const events: any[] = [];
    const promise = (service as any).runWithRetry(
      () => tushareClient.query('x', {}, ''),
      (attempt: number, err: unknown) => events.push({ attempt, err: String(err) }),
    );
    await jest.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].attempt).toBe(1);
  });

  it('runWithRetry: 连续 3 次失败 → 抛出最后一次错误', async () => {
    jest.useFakeTimers();
    tushareClient.query
      .mockRejectedValue(new Error('limit'));
    const events: any[] = [];
    const promise = (service as any).runWithRetry(
      () => tushareClient.query('x', {}, ''),
      (attempt: number, err: unknown) => events.push({ attempt, err: String(err) }),
    ).catch((e: Error) => e);
    await jest.advanceTimersByTimeAsync(3000);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.attempt)).toEqual([1, 2]);
  });

  it('startSync: 4 维度各 1 个 tradeDate, 全部 Tushare mock 抛错 → done 事件 summary 含 4 条 errors', async () => {
    jest.useFakeTimers();
    jest.spyOn(syncUtils, 'resolveOpenTradeDates').mockResolvedValue(['20260501']);
    tushareClient.query.mockRejectedValue(new Error('boom'));

    const subject = service.startSync({ start_date: '20260501', end_date: '20260501', syncMode: 'overwrite' });
    const eventsPromise = firstValueFrom(subject.pipe(toArray()));
    await jest.advanceTimersByTimeAsync(20000);
    const events = await eventsPromise;

    const done = events.find((e: any) => e.type === 'done') as any;
    expect(done).toBeDefined();
    expect(done.summary.stocks.errors).toHaveLength(1);
    expect(done.summary.industries.errors).toHaveLength(1);
    expect(done.summary.sectors.errors).toHaveLength(1);
    expect(done.summary.market.errors).toHaveLength(1);
    expect(done.message).toContain('4 个交易日失败');

    const phases = events.filter((e: any) => e.type === 'progress').map((e: any) => e.phase);
    expect(new Set(phases)).toEqual(new Set(['同步个股资金流', '同步行业资金流', '同步板块资金流', '同步大盘资金流']));
  });
});
```

- [ ] **Step 2: 运行单测确认全部失败**

Run: `pnpm --filter @cryptotrading/server test money-flow-sync.service`
Expected: 3 个 case 全部 FAIL（`runWithRetry`/`startSync` 还未实现 → `is not a function`）。

- [ ] **Step 3: 提交红测**

```bash
git add apps/server/src/market-data/money-flow/money-flow-sync.service.spec.ts
git commit -m "test(money-flow): 新增 SSE 与重试单测骨架（红）"
```

---

## Task 3: 实现 `runWithRetry` 私有方法

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.service.ts`

- [ ] **Step 1: 在 `MoneyFlowSyncService` 类中（`getTradeDates` 之前）插入**

```ts
private async runWithRetry<T>(
  fn: () => Promise<T>,
  onRetry: (attempt: number, err: unknown) => void,
): Promise<T> {
  const backoffs = [1000, 2000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < backoffs.length) {
        onRetry(attempt + 1, e);
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
      }
    }
  }
  throw lastErr;
}
```

- [ ] **Step 2: 运行 `runWithRetry` 相关 2 个单测**

Run: `pnpm --filter @cryptotrading/server test money-flow-sync.service -t runWithRetry`
Expected: 2 个 PASS。

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/market-data/money-flow/money-flow-sync.service.ts
git commit -m "feat(money-flow): 新增 runWithRetry 重试工具（指数退避 1s/2s）"
```

---

## Task 4: 扩展 4 个 sync 方法签名以接受 ctx

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.service.ts`

- [ ] **Step 1: 在文件顶部 import shared-types**

```ts
import type { MoneyFlowSyncEvent } from '@cryptotrading/shared-types';
```

并删除当前文件中本地定义的 `export interface MoneyFlowSyncResult { ... }`，改为：
```ts
import type { MoneyFlowSyncResult } from '@cryptotrading/shared-types';
// （保留 re-export 以最小化对外部 import 的影响）
export type { MoneyFlowSyncResult };
```

> 验证：grep `import.*MoneyFlowSyncResult.*money-flow-sync.service` 应仍可正常解析。

- [ ] **Step 2: 新增内部 ctx 类型**

在 `runWithRetry` 方法之前插入：
```ts
type SyncCtx = {
  phase: string;
  baseCurrent: number;
  total: number;
  grandTotal: number;
  emit: (e: MoneyFlowSyncEvent) => void;
};

function pctOf(c: number, g: number): number {
  return Math.round((c / Math.max(g, 1)) * 100);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
```

- [ ] **Step 3: 修改 `syncStocks` 内层循环**

把 `syncStocks` 方法签名改为：
```ts
async syncStocks(dto: SyncFlowDto, ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
```
把 `for (const date of tradeDates)` 循环替换为：
```ts
for (let i = 0; i < tradeDates.length; i++) {
  const date = tradeDates[i];
  let rows: any[] = [];
  try {
    rows = await this.runWithRetry(
      () => this.tushareClient.query('moneyflow_ths', { start_date: date, end_date: date }, STOCK_FIELDS),
      (attempt, err) => ctx?.emit({
        type: 'progress',
        phase: ctx.phase,
        current: ctx.baseCurrent + i,
        total: ctx.total,
        percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
        message: `重试中：${date}（第 ${attempt}/2 次） ${truncate(String(err), 60)}`,
      }),
    );
  } catch (e) {
    errors.push(`[${date}] ${String(e)}`);
  }

  if (rows.length >= 6000) {
    this.logger.warn(`moneyflow_ths ${date} 返回 ${rows.length} 条，可能截断`);
  }

  for (const row of rows) {
    allEntities.push(this.stockRepo.create({
      tsCode: asString(row.ts_code),
      tradeDate: asString(row.trade_date),
      name: asString(row.name) || null,
      pctChange: asNullableNumeric(row.pct_change),
      latest: asNullableNumeric(row.latest),
      netAmount: asNullableNumeric(row.net_amount),
      netD5Amount: asNullableNumeric(row.net_d5_amount),
      buyLgAmount: asNullableNumeric(row.buy_lg_amount),
      buyLgAmountRate: asNullableNumeric(row.buy_lg_amount_rate),
      buyMdAmount: asNullableNumeric(row.buy_md_amount),
      buyMdAmountRate: asNullableNumeric(row.buy_md_amount_rate),
      buySmAmount: asNullableNumeric(row.buy_sm_amount),
      buySmAmountRate: asNullableNumeric(row.buy_sm_amount_rate),
    }));
  }

  ctx?.emit({
    type: 'progress',
    phase: ctx.phase,
    current: ctx.baseCurrent + i + 1,
    total: ctx.total,
    percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
    message: date,
  });
}
```

- [ ] **Step 4: 同样修改 `syncIndustries`**

签名：`async syncIndustries(dto: SyncFlowDto, ctx?: SyncCtx)`
循环体（`toWanYuan` 与 `industryRepo.create` 部分保留不动）：
```ts
for (let i = 0; i < tradeDates.length; i++) {
  const date = tradeDates[i];
  let rows: any[] = [];
  try {
    rows = await this.runWithRetry(
      () => this.tushareClient.query('moneyflow_ind_ths', { start_date: date, end_date: date }, INDUSTRY_FIELDS),
      (attempt, err) => ctx?.emit({
        type: 'progress', phase: ctx.phase,
        current: ctx.baseCurrent + i, total: ctx.total,
        percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
        message: `重试中：${date}（第 ${attempt}/2 次） ${truncate(String(err), 60)}`,
      }),
    );
  } catch (e) {
    errors.push(`[${date}] ${String(e)}`);
  }

  if (rows.length >= 6000) {
    this.logger.warn(`moneyflow_ind_ths ${date} 返回 ${rows.length} 条，可能截断`);
  }

  for (const row of rows) {
    allEntities.push(this.industryRepo.create({
      tradeDate: asString(row.trade_date),
      tsCode: asString(row.ts_code),
      industry: asString(row.industry),
      pctChange: asNullableNumeric(row.pct_change),
      netBuyAmount: toWanYuan(row.net_buy_amount),
      netSellAmount: toWanYuan(row.net_sell_amount),
      netAmount: toWanYuan(row.net_amount),
    }));
  }

  ctx?.emit({
    type: 'progress', phase: ctx.phase,
    current: ctx.baseCurrent + i + 1, total: ctx.total,
    percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
    message: date,
  });
}
```

- [ ] **Step 5: 同样修改 `syncSectors`**

签名：`async syncSectors(dto: SyncFlowDto, ctx?: SyncCtx)`
循环体仿 industries，`tushareClient.query` 第一参数改为 `'moneyflow_cnt_ths'`，`SECTOR_FIELDS`，`sectorRepo.create({ ..., sector: asString(row.name), ... })` 保留。

```ts
for (let i = 0; i < tradeDates.length; i++) {
  const date = tradeDates[i];
  let rows: any[] = [];
  try {
    rows = await this.runWithRetry(
      () => this.tushareClient.query('moneyflow_cnt_ths', { start_date: date, end_date: date }, SECTOR_FIELDS),
      (attempt, err) => ctx?.emit({
        type: 'progress', phase: ctx.phase,
        current: ctx.baseCurrent + i, total: ctx.total,
        percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
        message: `重试中：${date}（第 ${attempt}/2 次） ${truncate(String(err), 60)}`,
      }),
    );
  } catch (e) {
    errors.push(`[${date}] ${String(e)}`);
  }

  if (rows.length >= 6000) {
    this.logger.warn(`moneyflow_cnt_ths ${date} 返回 ${rows.length} 条，可能截断`);
  }

  for (const row of rows) {
    allEntities.push(this.sectorRepo.create({
      tradeDate: asString(row.trade_date),
      tsCode: asString(row.ts_code),
      sector: asString(row.name),
      pctChange: asNullableNumeric(row.pct_change),
      netBuyAmount: toWanYuan(row.net_buy_amount),
      netSellAmount: toWanYuan(row.net_sell_amount),
      netAmount: toWanYuan(row.net_amount),
    }));
  }

  ctx?.emit({
    type: 'progress', phase: ctx.phase,
    current: ctx.baseCurrent + i + 1, total: ctx.total,
    percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
    message: date,
  });
}
```

- [ ] **Step 6: 同样修改 `syncMarket`**

签名：`async syncMarket(dto: SyncFlowDto, ctx?: SyncCtx)`
循环体仿 stocks，`tushareClient.query` 第一参数为 `'moneyflow_mkt_dc'`，`MARKET_FIELDS`，`marketRepo.create({ tradeDate, netAmount, buyLgAmount, buySmAmount })`。

```ts
for (let i = 0; i < tradeDates.length; i++) {
  const date = tradeDates[i];
  let rows: any[] = [];
  try {
    rows = await this.runWithRetry(
      () => this.tushareClient.query('moneyflow_mkt_dc', { start_date: date, end_date: date }, MARKET_FIELDS),
      (attempt, err) => ctx?.emit({
        type: 'progress', phase: ctx.phase,
        current: ctx.baseCurrent + i, total: ctx.total,
        percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
        message: `重试中：${date}（第 ${attempt}/2 次） ${truncate(String(err), 60)}`,
      }),
    );
  } catch (e) {
    errors.push(`[${date}] ${String(e)}`);
  }

  if (rows.length >= 6000) {
    this.logger.warn(`moneyflow_mkt_dc ${date} 返回 ${rows.length} 条，可能截断`);
  }

  for (const row of rows) {
    allEntities.push(this.marketRepo.create({
      tradeDate: asString(row.trade_date),
      netAmount: asNullableNumeric(row.net_amount, amountDivisor),
      buyLgAmount: asNullableNumeric(row.buy_lg_amount, amountDivisor),
      buySmAmount: asNullableNumeric(row.buy_sm_amount, amountDivisor),
    }));
  }

  ctx?.emit({
    type: 'progress', phase: ctx.phase,
    current: ctx.baseCurrent + i + 1, total: ctx.total,
    percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
    message: date,
  });
}
```

- [ ] **Step 7: 验证编译通过**

Run: `pnpm --filter @cryptotrading/server build`
Expected: 构建成功，无 TS 错误。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/market-data/money-flow/money-flow-sync.service.ts
git commit -m "feat(money-flow): 4 个 sync 方法接入 SSE 进度回调与重试"
```

---

## Task 5: 实现 `startSync()` 编排方法

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.service.ts`

- [ ] **Step 1: 文件顶部 import**

```ts
import { Subject } from 'rxjs';
import type { MoneyFlowSyncEvent, MoneyFlowSyncSummary } from '@cryptotrading/shared-types';
```

- [ ] **Step 2: 在类末尾（`syncMembers` 之后）插入**

```ts
startSync(dto: SyncFlowDto): Subject<MoneyFlowSyncEvent> {
  const subject = new Subject<MoneyFlowSyncEvent>();

  setTimeout(async () => {
    try {
      const allTradeDates = await this.getTradeDates(dto);
      if (!allTradeDates.length) {
        subject.next({ type: 'error', message: '未获取到交易日列表' });
        subject.complete();
        return;
      }

      const dims = [
        { key: 'stocks' as const,     label: '同步个股资金流', method: 'syncStocks' as const },
        { key: 'industries' as const, label: '同步行业资金流', method: 'syncIndustries' as const },
        { key: 'sectors' as const,    label: '同步板块资金流', method: 'syncSectors' as const },
        { key: 'market' as const,     label: '同步大盘资金流', method: 'syncMarket' as const },
      ];

      // total 取 allTradeDates.length（含 skipped）以保证维度切换百分比单调
      const totals = dims.map(() => allTradeDates.length);
      const grandTotal = totals.reduce((a, b) => a + b, 0) || 1;

      const summary: Partial<MoneyFlowSyncSummary> = {};
      let baseCurrent = 0;
      for (let i = 0; i < dims.length; i++) {
        const ctx: SyncCtx = {
          phase: dims[i].label,
          baseCurrent,
          total: totals[i],
          grandTotal,
          emit: (e) => subject.next(e),
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        summary[dims[i].key] = await (this[dims[i].method] as any).call(this, dto, ctx);
        baseCurrent += totals[i];
      }

      const failedCount = (Object.values(summary) as MoneyFlowSyncResult[])
        .reduce((n, r) => n + (r?.errors.length ?? 0), 0);
      subject.next({
        type: 'done',
        message: failedCount ? `同步完成，${failedCount} 个交易日失败` : '同步完成',
        summary: summary as MoneyFlowSyncSummary,
      });
      subject.complete();
    } catch (err) {
      this.logger.error(`startSync 失败: ${err instanceof Error ? err.stack : String(err)}`);
      subject.next({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      subject.complete();
    }
  }, 0);

  return subject;
}
```

- [ ] **Step 3: 运行 `startSync` 单测**

Run: `pnpm --filter @cryptotrading/server test money-flow-sync.service`
Expected: 3 个 case 全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/market-data/money-flow/money-flow-sync.service.ts
git commit -m "feat(money-flow): 新增 startSync 编排方法（4 维度串行 + done summary）"
```

---

## Task 6: 控制器替换为 SSE 端点

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.controller.ts`

- [ ] **Step 1: 替换文件全文**

```ts
import { Body, Controller, Get, Header, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { MoneyFlowSyncService } from './money-flow-sync.service';
import { SyncFlowDto } from './dto/sync-flow.dto';
import { QueryMemberDto } from './dto/query-member.dto';

@Controller('money-flow/sync')
export class MoneyFlowSyncController {
  constructor(private readonly syncService: MoneyFlowSyncService) {}

  @Get('run')
  @AdminOnly()
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  runSync(@Query() query: SyncFlowDto, @Res() res: Response) {
    res.flushHeaders();
    const subject = this.syncService.startSync(query);
    const subscription = subject.subscribe({
      next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      complete: () => res.end(),
      error: () => res.end(),
    });
    res.on('close', () => subscription.unsubscribe());
  }

  @Post('members')
  @AdminOnly()
  syncMembers(@Body() dto: QueryMemberDto) {
    const dimension = dto.ts_code === 'sector' ? 'sector' : 'industry';
    return this.syncService.syncMembers(dimension);
  }
}
```

> 注：移除了 4 个 POST 处理器；`Body` import 仍需保留供 `syncMembers` 使用。

- [ ] **Step 2: 构建并启动 server 验证**

Run: `pnpm --filter @cryptotrading/server build`
Expected: 构建成功。

启动开发服务器：`pnpm --filter @cryptotrading/server start:dev`
用浏览器或 curl 访问：`curl -N "http://localhost:3000/money-flow/sync/run?start_date=20260501&end_date=20260501&syncMode=overwrite" -H "Cookie: <admin cookie>"`
Expected: 返回 `data: {"type":"progress",...}` 流式输出，最终 `data: {"type":"done",...}`。

> 若没有 admin cookie 可暂跳过此手动验证，留待 Task 11 集成验证。

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/market-data/money-flow/money-flow-sync.controller.ts
git commit -m "feat(money-flow): 控制器替换为 SSE 端点 GET /money-flow/sync/run"
```

---

## Task 7: 前端 API 模块更新

**Files:**
- Modify: `apps/web/src/api/modules/moneyFlow.ts`

- [ ] **Step 1: 在 type 导出区追加新类型**

在原有 `export type { ... } from '@cryptotrading/shared-types'` 块中追加 `MoneyFlowSyncEvent`、`MoneyFlowSyncSummary`，并在下方 `import type` 块同步追加。

```ts
export type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowSyncResult,
  MoneyFlowSyncEvent,
  MoneyFlowSyncSummary,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
  MoneyFlowMemberRow,
} from '@cryptotrading/shared-types'

import type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowSyncResult,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
  MoneyFlowMemberRow,
} from '@cryptotrading/shared-types'
```

> 上下两块差异：上块多导出 `MoneyFlowSyncEvent` 与 `MoneyFlowSyncSummary` 给消费方；下块仅 import 本文件用到的类型。

- [ ] **Step 2: 删除旧 sync 方法 + 删除 `post` import**

把 `syncStocks` / `syncIndustries` / `syncSectors` / `syncMarket` 4 段从 `moneyFlowApi` 对象中整体删除，并把：
```ts
import { API_BASE, post, request } from '../client'
```
改为：
```ts
import { API_BASE, request } from '../client'
```

- [ ] **Step 3: 在 `moneyFlowApi` 中（`queryMarket` 之后）新增 `syncRunUrl`**

```ts
syncRunUrl: (params: MoneyFlowSyncParams) => {
  const qs = new URLSearchParams({
    start_date: params.start_date,
    end_date: params.end_date,
  })
  if (params.syncMode) qs.set('syncMode', params.syncMode)
  return `${API_BASE}/money-flow/sync/run?${qs.toString()}`
},
```

- [ ] **Step 4: 验证 vue-tsc 通过**

Run: `pnpm --filter @cryptotrading/web typecheck`
Expected: 类型检查通过；若 `useMoneyFlowSync.ts` 因引用旧方法报错，留到 Task 8 修复时一并通过。

> 若该 step 仍报错（旧 sync\* 方法找不到），暂时**接受失败**，由 Task 8 修复后整体通过。本任务先单独提交。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/api/modules/moneyFlow.ts
git commit -m "refactor(money-flow): API 模块去除 4 个 sync 方法, 新增 syncRunUrl"
```

---

## Task 8: 重写 `useMoneyFlowSync` 改为 useSSE 驱动

**Files:**
- Modify: `apps/web/src/components/sync/useMoneyFlowSync.ts`

- [ ] **Step 1: 替换全文**

```ts
import { computed, ref } from 'vue'
import { moneyFlowApi } from '@/api/modules/moneyFlow'
import type { MoneyFlowSyncSummary, MoneyFlowSyncResult } from '@/api/modules/moneyFlow'
import { useSSE } from '@/composables/hooks/useSSE'

type SyncMode = 'incremental' | 'overwrite'

interface FinishedState {
  summary: MoneyFlowSyncSummary
  errors: Array<{ phase: string; error: string }>
}

function buildDefaultDateRange(): [number, number] {
  const end = Date.now()
  const start = end - 30 * 86400000
  return [start, end]
}

function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

function formatDateLabel(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '暂无本地数据'
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

const PHASE_LABEL_MAP: Record<keyof MoneyFlowSyncSummary, string> = {
  stocks: '个股',
  industries: '行业',
  sectors: '板块',
  market: '大盘',
}

export function useMoneyFlowSync(message: {
  error: (msg: string) => void
  success: (msg: string) => void
}) {
  const sse = useSSE()
  const show = ref(false)
  const syncing = ref(false)
  const syncMode = ref<SyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())
  const dateRangeLabel = ref('读取中...')
  const dateRangeLoading = ref(false)
  const finished = ref<FinishedState | null>(null)

  const canConfirm = computed(() => {
    const r = syncDateRange.value
    return Boolean(r && r[0] && r[1]) && !syncing.value && !finished.value
  })

  const syncProgressVisible = computed(
    () => sse.status.value !== 'idle' || finished.value !== null,
  )

  async function loadDateRange() {
    dateRangeLoading.value = true
    try {
      const range = await moneyFlowApi.getDateRange()
      if (!range.min || !range.max) {
        dateRangeLabel.value = '暂无本地数据'
      } else {
        dateRangeLabel.value = `${formatDateLabel(range.min)} 至 ${formatDateLabel(range.max)}`
      }
    } catch {
      dateRangeLabel.value = '读取失败'
    } finally {
      dateRangeLoading.value = false
    }
  }

  function openModal() {
    if (!syncDateRange.value) syncDateRange.value = buildDefaultDateRange()
    if (!syncing.value) {
      sse.reset()
      finished.value = null
    }
    show.value = true
    void loadDateRange()
  }

  async function confirmSync() {
    if (!syncDateRange.value) return
    syncing.value = true
    finished.value = null
    await sse.start(
      moneyFlowApi.syncRunUrl({
        start_date: toYYYYMMDD(syncDateRange.value[0]),
        end_date: toYYYYMMDD(syncDateRange.value[1]),
        syncMode: syncMode.value,
      }),
      {
        method: 'GET',
        onDone: (data?: { summary?: MoneyFlowSyncSummary; message?: string }) => {
          if (data?.summary) {
            const errs = (Object.entries(data.summary) as Array<[keyof MoneyFlowSyncSummary, MoneyFlowSyncResult]>)
              .flatMap(([key, r]) =>
                (r?.errors ?? []).map(error => ({ phase: PHASE_LABEL_MAP[key], error })),
              )
            finished.value = { summary: data.summary, errors: errs }
            if (errs.length) message.error(`同步完成，${errs.length} 个交易日失败`)
            else message.success('资金流向同步完成')
          }
          syncing.value = false
          void loadDateRange()
        },
        onError: (msg) => {
          message.error(msg)
          syncing.value = false
        },
      },
    )
  }

  return {
    show,
    syncing,
    syncMode,
    syncDateRange,
    dateRangeLabel,
    dateRangeLoading,
    canConfirm,
    syncProgressVisible,
    sse,
    finished,
    openModal,
    confirmSync,
  }
}
```

- [ ] **Step 2: 验证 vue-tsc 通过**

Run: `pnpm --filter @cryptotrading/web typecheck`
Expected: 整体类型检查通过（含 Task 7 之前未通过的部分）。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/sync/useMoneyFlowSync.ts
git commit -m "refactor(money-flow): useMoneyFlowSync 改为 useSSE 驱动, 新增 finished 状态"
```

---

## Task 9: 新增 `MoneyFlowSyncProgress.vue` 进度面板组件

**Files:**
- Create: `apps/web/src/components/sync/MoneyFlowSyncProgress.vue`

- [ ] **Step 1: 创建文件**

```vue
<!-- apps/web/src/components/sync/MoneyFlowSyncProgress.vue -->
<template>
  <div v-if="visible" class="mfsp-panel">
    <div class="mfsp-head">
      <span>{{ headLabel }}</span>
      <span>{{ Math.round(sse.percent.value) }}%</span>
    </div>
    <n-progress
      type="line"
      :percentage="Math.round(sse.percent.value)"
      :status="progressStatus"
      indicator-placement="inside"
    />
    <div class="mfsp-meta">
      <span>{{ countLabel }}</span>
      <span>{{ sse.message.value }}</span>
    </div>

    <div v-if="finished" class="mfsp-summary">
      <div class="mfsp-summary-row">
        <span v-for="item in summaryRows" :key="item.label" class="mfsp-summary-item">
          {{ item.label }}：写入 {{ item.success }} / 跳过 {{ item.skipped }} / 失败 {{ item.failed }}
        </span>
      </div>
      <n-collapse v-if="finished.errors.length" class="mfsp-errors">
        <n-collapse-item :title="`失败明细（${finished.errors.length} 条）`" name="errors">
          <ul class="mfsp-error-list">
            <li v-for="(e, idx) in finished.errors.slice(0, 10)" :key="idx">
              [{{ e.phase }}] {{ e.error }}
            </li>
            <li v-if="finished.errors.length > 10" class="mfsp-error-more">
              还有 {{ finished.errors.length - 10 }} 条…
            </li>
          </ul>
        </n-collapse-item>
      </n-collapse>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NCollapse, NCollapseItem, NProgress } from 'naive-ui'
import type { useSSE } from '@/composables/hooks/useSSE'
import type { MoneyFlowSyncSummary } from '@/api/modules/moneyFlow'

const props = defineProps<{
  visible: boolean
  sse: ReturnType<typeof useSSE>
  finished: { summary: MoneyFlowSyncSummary; errors: Array<{ phase: string; error: string }> } | null
}>()

const headLabel = computed(() => {
  if (props.finished) return '同步完成'
  return props.sse.phase.value || '准备中'
})

const progressStatus = computed(() => {
  if (props.sse.status.value === 'error') return 'error'
  if (props.finished) return 'success'
  return 'default'
})

const countLabel = computed(() => {
  const c = props.sse.current.value
  const t = props.sse.total.value
  if (!t) return ''
  return `${c} / ${t}`
})

const summaryRows = computed(() => {
  if (!props.finished) return []
  const labels: Array<[keyof MoneyFlowSyncSummary, string]> = [
    ['stocks', '个股'],
    ['industries', '行业'],
    ['sectors', '板块'],
    ['market', '大盘'],
  ]
  return labels.map(([key, label]) => {
    const r = props.finished!.summary[key]
    return {
      label,
      success: r?.success ?? 0,
      skipped: r?.skipped ?? 0,
      failed: r?.errors.length ?? 0,
    }
  })
})
</script>

<style scoped>
.mfsp-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
.mfsp-head, .mfsp-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--color-text-secondary); font-size: 12px; }
.mfsp-head { color: var(--color-text); font-weight: 700; }
.mfsp-meta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mfsp-summary { margin-top: 4px; padding-top: 10px; border-top: 1px dashed var(--color-border); display: flex; flex-direction: column; gap: 8px; }
.mfsp-summary-row { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--color-text); }
.mfsp-summary-item { padding: 4px 8px; border-radius: 6px; background: color-mix(in srgb, var(--color-primary) 8%, var(--color-surface)); }
.mfsp-errors { margin-top: 4px; }
.mfsp-error-list { margin: 0; padding-left: 18px; font-size: 12px; color: var(--color-text-secondary); line-height: 1.6; }
.mfsp-error-more { color: var(--color-text-tertiary); font-style: italic; list-style: none; padding-left: 0; }
</style>
```

- [ ] **Step 2: 验证 typecheck**

Run: `pnpm --filter @cryptotrading/web typecheck`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/sync/MoneyFlowSyncProgress.vue
git commit -m "feat(money-flow): 新增 MoneyFlowSyncProgress.vue 进度与汇总面板"
```

---

## Task 10: 扩展 `DataSyncModal.vue` 支持 finished 态

**Files:**
- Modify: `apps/web/src/components/sync/DataSyncModal.vue`

- [ ] **Step 1: props 增加 `finished?: boolean`**

把 `defineProps<{...}>()` 块（约 104-115 行）的最后一行追加：
```ts
finished?: boolean
```

- [ ] **Step 2: modal 顶层属性按 finished 切换**

把：
```vue
:mask-closable="!syncing"
:closable="!syncing"
```
改为：
```vue
:mask-closable="!syncing || !!finished"
:closable="!syncing || !!finished"
```

- [ ] **Step 3: footer 按钮逻辑切换**

把现有 footer：
```vue
<template #footer>
  <div class="dsm-actions">
    <n-button :disabled="syncing" @click="emit('update:show', false)">取消</n-button>
    <n-button
      type="primary"
      :loading="syncing"
      :disabled="!canConfirm"
      @click="emit('confirm')"
    >
      确认同步
    </n-button>
  </div>
</template>
```
替换为：
```vue
<template #footer>
  <div class="dsm-actions">
    <n-button v-if="!finished" :disabled="syncing" @click="emit('update:show', false)">取消</n-button>
    <n-button
      v-if="!finished"
      type="primary"
      :loading="syncing"
      :disabled="!canConfirm"
      @click="emit('confirm')"
    >
      确认同步
    </n-button>
    <n-button
      v-else
      type="primary"
      @click="emit('update:show', false)"
    >
      关闭
    </n-button>
  </div>
</template>
```

- [ ] **Step 4: 验证 typecheck**

Run: `pnpm --filter @cryptotrading/web typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/sync/DataSyncModal.vue
git commit -m "feat(sync): DataSyncModal 新增 finished 态, 完成后按钮切换为关闭"
```

---

## Task 11: 把进度面板挂到 `SyncView.vue`

**Files:**
- Modify: `apps/web/src/views/sync/SyncView.vue`

- [ ] **Step 1: 顶部 import**

在现有 import 区追加：
```ts
import MoneyFlowSyncProgress from '../../components/sync/MoneyFlowSyncProgress.vue'
```

- [ ] **Step 2: 解构 useMoneyFlowSync 时追加新字段**

把现有 `useMoneyFlowSync(message)` 解构改为：
```ts
const {
  show: moneyFlowShow,
  syncing: moneyFlowSyncing,
  syncMode: moneyFlowSyncMode,
  syncDateRange: moneyFlowSyncDateRange,
  dateRangeLabel: moneyFlowDateRangeLabel,
  dateRangeLoading: moneyFlowDateRangeLoading,
  canConfirm: moneyFlowCanConfirm,
  syncProgressVisible: moneyFlowProgressVisible,
  sse: moneyFlowSse,
  finished: moneyFlowFinished,
  openModal: openMoneyFlowModal,
  confirmSync: confirmMoneyFlowSync,
} = useMoneyFlowSync(message)
```

- [ ] **Step 3: 更新资金流向 `<data-sync-modal>` 元素**

把：
```vue
<data-sync-modal
  v-model:show="moneyFlowShow"
  title="同步资金流向数据"
  description="同花顺/东方财富资金流向，同步个股、行业、板块、大盘四个维度。"
  :icon="SwapHorizontalOutline"
  :syncing="moneyFlowSyncing"
  v-model:sync-mode="moneyFlowSyncMode"
  v-model:sync-date-range="moneyFlowSyncDateRange"
  :data-date-range-label="moneyFlowDateRangeLabel"
  :data-date-range-loading="moneyFlowDateRangeLoading"
  :can-confirm="moneyFlowCanConfirm"
  @confirm="confirmMoneyFlowSync"
/>
```
替换为：
```vue
<data-sync-modal
  v-model:show="moneyFlowShow"
  title="同步资金流向数据"
  description="同花顺/东方财富资金流向，同步个股、行业、板块、大盘四个维度。"
  :icon="SwapHorizontalOutline"
  :syncing="moneyFlowSyncing"
  v-model:sync-mode="moneyFlowSyncMode"
  v-model:sync-date-range="moneyFlowSyncDateRange"
  :data-date-range-label="moneyFlowDateRangeLabel"
  :data-date-range-loading="moneyFlowDateRangeLoading"
  :can-confirm="moneyFlowCanConfirm"
  :finished="!!moneyFlowFinished"
  @confirm="confirmMoneyFlowSync"
>
  <template #extra>
    <MoneyFlowSyncProgress
      :visible="moneyFlowProgressVisible"
      :sse="moneyFlowSse"
      :finished="moneyFlowFinished"
    />
  </template>
</data-sync-modal>
```

- [ ] **Step 4: 验证 typecheck + lint**

Run: `pnpm --filter @cryptotrading/web typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/views/sync/SyncView.vue
git commit -m "feat(sync): SyncView 接入 MoneyFlowSyncProgress 与 finished 态"
```

---

## Task 12: 集成手动验收

**Files:**
- 仅运行验证，无代码改动。

- [ ] **Step 1: 启动后端与前端**

```bash
pnpm --filter @cryptotrading/server start:dev
pnpm --filter @cryptotrading/web dev
```

- [ ] **Step 2: 验收清单逐项验证**

按 spec 第 8.3 节执行：
1. 30 天 `incremental` 同步：进度条平滑 0→100%，phase 文字依次切换 4 个维度（同步个股资金流 / 同步行业资金流 / 同步板块资金流 / 同步大盘资金流）。
2. 30 天 `overwrite` 同步：同上，且总耗时显著长于 incremental。
3. 模拟 Tushare 限流（临时把 `tushare-client.service` 加一行 `if (Math.random() < 0.3) throw new Error('limit')` 测试用，验证完恢复）：能看到「重试中：YYYYMMDD（第 N/2 次）…」的灰色小字。
4. 模拟单日彻底失败（重试 3 次都失败）：完成后展开「失败明细」能看到该日条目；4 列汇总数字正确。
5. 完成后 Modal 不自动关闭；按钮变为「关闭」；点击关闭后再次打开 Modal，进度面板消失（不残留旧状态）。
6. 同步进行中点击 Modal 遮罩与右上角 X：均无响应。

- [ ] **Step 3: 验收通过后无需提交**

如发现 bug，回到对应 Task 修复并 squash commit。

---

## Self-Review Notes

**Spec coverage** —— 逐节核对：
- §3 决策摘要 7 条全部落到 Tasks 1-11。
- §5 SSE 协议 → Tasks 1, 4, 5 实现，Task 8 消费。
- §6.1 控制器删 4 加 1 → Task 6。
- §6.2.1 `runWithRetry` → Task 3，单测 Task 2。
- §6.2.2 4 个 sync 方法签名扩展 → Task 4。
- §6.2.3 `startSync` → Task 5，单测 Task 2。
- §6.3 `industries`/`sectors` 内部 `memberResult` 保留 → Task 4 步骤 4-5 仅修改循环体，未触动 `memberResult` 区块。
- §7.1 shared-types → Task 1。
- §7.2 API 模块 → Task 7。
- §7.3 useMoneyFlowSync → Task 8。
- §7.4 MoneyFlowSyncProgress → Task 9。
- §7.5 DataSyncModal → Task 10。
- §7.6 SyncView → Task 11。
- §8.1 后端单测 3 个 case → Task 2。
- §8.3 手动验收 6 条 → Task 12。
- §9 删除清单：4 POST 处理器（Task 6）、4 个前端 sync 方法（Task 7）、`lastResult`（Task 8 全文替换中删除）。

**Type consistency** —— `MoneyFlowSyncEvent`、`MoneyFlowSyncSummary` 在 Task 1 定义，后续 Tasks 4/5/7/8/9 全部 import 自 `@cryptotrading/shared-types`，命名一致；`SyncCtx` 仅在 service 内部使用（Task 4-5），未跨文件传递。

**Placeholder scan** —— 已检查无 TBD/TODO/「类似 Task X」/裸描述。每个代码步骤均给出完整代码块。Task 12 step 3 中提到的「临时改 tushare-client.service」是有意为之的临时测试手段，非生产代码。
