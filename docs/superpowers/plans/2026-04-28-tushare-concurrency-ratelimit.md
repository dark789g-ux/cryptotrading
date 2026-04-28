# Tushare 并发 + 自适应限速 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 A 股同步从串行 for 循环改为按交易日并发，并在 TushareClientService 层加入固定间隔 + 遇限流自动降速的限速机制。

**Architecture:** `TushareClientService` 用 `p-limit` 控制并发请求数、用 `lastRequestAt` + `currentIntervalMs` 控制最小请求间隔，遇限流响应时翻倍间隔、成功时缩减间隔。`ASharesSyncService` 将串行 for 循环改为 `Promise.all`，实际并发由 TushareClientService 的 p-limit 统一约束。

**Tech Stack:** NestJS 10 + TypeScript (CommonJS)、`p-limit@3`（最后一个 CJS 兼容版本）

---

## 文件变更清单

| 文件 | 操作 |
|------|------|
| `apps/server/package.json` | 新增 `p-limit@3` 依赖 |
| `apps/server/.env` | 新增三个配置变量 |
| `apps/server/.env.example` | 新增三个配置变量 |
| `apps/server/src/market-data/a-shares/services/tushare-client.service.ts` | 改造：加并发控制 + 自适应限速 |
| `apps/server/src/market-data/a-shares/sync/a-shares-sync.service.ts` | 改造：for 循环 → Promise.all |

---

## Task 1: 安装 p-limit 并新增环境变量

**Files:**
- Modify: `apps/server/package.json`
- Modify: `apps/server/.env`
- Modify: `apps/server/.env.example`

- [ ] **Step 1: 安装 p-limit@3（最后一个 CJS 兼容版本）**

在 `apps/server` 目录下执行（项目用 pnpm workspaces，需在 workspace 根目录指定 filter）：

```bash
cd c:/codes/cryptotrading
pnpm add p-limit@3 --filter @cryptotrading/server
```

执行后 `apps/server/package.json` 的 `dependencies` 里应出现 `"p-limit": "^3.x.x"`。

- [ ] **Step 2: 在 .env 追加三个变量**

在 `apps/server/.env` 末尾追加：

```env

# Tushare 并发与限速
TUSHARE_CONCURRENCY=5
TUSHARE_MIN_INTERVAL_MS=200
TUSHARE_MAX_INTERVAL_MS=5000
```

- [ ] **Step 3: 在 .env.example 追加三个变量**

在 `apps/server/.env.example` 末尾追加：

```env

# Tushare 并发与限速
TUSHARE_CONCURRENCY=5
TUSHARE_MIN_INTERVAL_MS=200
TUSHARE_MAX_INTERVAL_MS=5000
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/.env apps/server/.env.example
git commit -m "chore: 安装 p-limit@3，新增 Tushare 限速配置变量"
```

---

## Task 2: 改造 TushareClientService — 加并发控制与自适应限速

**Files:**
- Modify: `apps/server/src/market-data/a-shares/services/tushare-client.service.ts`

**改造逻辑说明：**

- `query()` 把请求交给 `this.limiter`（p-limit 实例）排队，实际并发上限 = `TUSHARE_CONCURRENCY`
- 在 `limiter` 内部执行 `throttledQuery()`，每次先算出距上次请求的等待时间并 sleep，再发请求
- 成功后 `currentIntervalMs × 0.9`（不低于 min）；检测到限流时 `currentIntervalMs × 2`（不超过 max）
- 限流检测复用现有 `shouldRetryTusharePayload`，在 `postWithRetry` 识别到限流时调用 `this.onRateLimit()`

- [ ] **Step 1: 完整替换 tushare-client.service.ts**

将文件内容替换为：

```typescript
import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosError } from 'axios';
import pLimit, { type LimitFunction } from 'p-limit';

interface TushareResponse {
  code: number;
  msg: string | null;
  data?: {
    fields: string[];
    items: unknown[][];
  };
}

export type TushareRow = Record<string, string | number | null>;

@Injectable()
export class TushareClientService {
  private readonly endpoint = 'http://api.tushare.pro';
  private readonly maxAttempts = 3;
  private readonly retryDelaysMs = [1000, 2000, 4000];

  private readonly limiter: LimitFunction;
  private lastRequestAt = 0;
  private currentIntervalMs: number;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;

  constructor(private readonly configService: ConfigService) {
    const concurrency = Number(configService.get('TUSHARE_CONCURRENCY') ?? 5);
    this.minIntervalMs = Number(configService.get('TUSHARE_MIN_INTERVAL_MS') ?? 200);
    this.maxIntervalMs = Number(configService.get('TUSHARE_MAX_INTERVAL_MS') ?? 5000);
    this.currentIntervalMs = this.minIntervalMs;
    this.limiter = pLimit(concurrency);
  }

  async query(apiName: string, params: Record<string, string | number> = {}, fields = ''): Promise<TushareRow[]> {
    return this.limiter(() => this.throttledQuery(apiName, params, fields));
  }

  private async throttledQuery(
    apiName: string,
    params: Record<string, string | number>,
    fields: string,
  ): Promise<TushareRow[]> {
    const token = this.configService.get<string>('TUSHARE_TOKEN');
    if (!token) {
      throw new BadRequestException('TUSHARE_TOKEN 未配置，无法同步 A 股数据');
    }

    const wait = this.currentIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.delay(wait);
    this.lastRequestAt = Date.now();

    const response = await this.postWithRetry(apiName, token, params, fields);

    this.currentIntervalMs = Math.max(this.currentIntervalMs * 0.9, this.minIntervalMs);

    const payload = response.data;
    if (payload.code !== 0) {
      throw new ServiceUnavailableException(`TuShare ${apiName} 调用失败：${payload.msg ?? payload.code}`);
    }

    const data = payload.data;
    if (!data) return [];
    return data.items.map((item) => this.toRow(data.fields, item));
  }

  private async postWithRetry(
    apiName: string,
    token: string,
    params: Record<string, string | number>,
    fields: string,
  ) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const response = await axios.post<TushareResponse>(
          this.endpoint,
          { api_name: apiName, token, params, fields },
          { timeout: 30000 },
        );
        const payload = response.data;
        if (payload.code !== 0) {
          const error = new ServiceUnavailableException(`TuShare ${apiName} 调用失败：${payload.msg ?? payload.code}`);
          if (!this.shouldRetryTusharePayload(payload)) throw error;
          this.onRateLimit();
          lastError = error;
        } else {
          return response;
        }
      } catch (err: unknown) {
        if (!this.shouldRetryError(err)) throw err;
        lastError = err;
      }

      if (attempt < this.maxAttempts) {
        await this.delay(this.retryDelaysMs[attempt - 1] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1]);
      }
    }

    throw lastError instanceof Error ? lastError : new ServiceUnavailableException(`TuShare ${apiName} 调用失败`);
  }

  private onRateLimit(): void {
    this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxIntervalMs);
  }

  private shouldRetryTusharePayload(payload: TushareResponse): boolean {
    const msg = String(payload.msg ?? '').toLowerCase();
    return [
      'timeout', 'timed out', 'rate', 'too many', 'limit', 'busy', 'temporar',
      '超时', '频率', '限流', '稍后', '繁忙', '服务忙',
    ].some((pattern) => msg.includes(pattern));
  }

  private shouldRetryError(err: unknown): boolean {
    if (!axios.isAxiosError(err)) return false;
    const error = err as AxiosError;
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return true;
    if (!error.response) return true;
    const status = error.response.status;
    return status === 429 || status >= 500;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toRow(fields: string[], item: unknown[]): TushareRow {
    const row: TushareRow = {};
    fields.forEach((field, index) => {
      const value = item[index];
      const normalized: string | number | null =
        value == null ? null
        : typeof value === 'string' || typeof value === 'number' ? value
        : String(value);
      row[field] = normalized;
    });
    return row;
  }
}
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

```bash
cd c:/codes/cryptotrading/apps/server && npx tsc --noEmit
```

预期：无报错输出。若报 `p-limit` 类型找不到，执行 `pnpm add -D @types/p-limit --filter @cryptotrading/server`（p-limit@3 自带类型，一般不需要）。

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/market-data/a-shares/services/tushare-client.service.ts
git commit -m "feat(tushare): 新增并发控制与自适应限速机制"
```

---

## Task 3: 改造 ASharesSyncService — for 循环改为 Promise.all

**Files:**
- Modify: `apps/server/src/market-data/a-shares/sync/a-shares-sync.service.ts`

**改造说明：**
- 将 `for` 循环体抽成每个 `tradeDate` 的异步函数，用 `Promise.all` 并发执行
- 删除循环内部的分阶段 emit（'同步日线行情'/'同步每日指标'/'同步复权因子'），改为每完成一个日期 emit 一次汇总进度
- 共享计数器（`quotes`、`metrics` 等）和集合（`changedRanges`、`latestAdjFactorChanged`）仍直接累加，JS 单线程无竞态风险

- [ ] **Step 1: 完整替换 syncWithProgress 方法**

将 `apps/server/src/market-data/a-shares/sync/a-shares-sync.service.ts` 中的 `syncWithProgress` 方法替换为：

```typescript
async syncWithProgress(
  dto: SyncASharesDto,
  emit: (event: ASharesSyncEvent) => void = () => undefined,
): Promise<ASharesSyncResult> {
  const syncMode = normalizeSyncMode(dto.syncMode);
  emit({ type: 'start' });
  emit({ type: 'progress', phase: '同步股票列表', current: 0, total: 1, percent: 0 });
  const symbols = await syncSymbols(this.fetcherDeps);

  const range = await resolveSyncRange(this.tushareClient, dto);
  emit({
    type: 'progress',
    phase: '获取交易日历',
    current: 0,
    total: 1,
    percent: 5,
    message: `${range.startDate} - ${range.endDate}`,
  });
  const tradeDates = await resolveOpenTradeDates(this.tushareClient, range);
  const total = tradeDates.length;

  let quotes = 0;
  let metrics = 0;
  let adjFactors = 0;
  let indicators = 0;
  let skippedDates = 0;
  let skippedDatasets = 0;
  let completedDates = 0;
  const changedRanges = new Map<string, string>();
  const latestAdjFactorChanged = new Set<string>();
  const failedItems: ASharesSyncFailedItem[] = [];

  if (!total) {
    return createResult('done', symbols, quotes, metrics, adjFactors, indicators, failedItems, range, skippedDates, skippedDatasets);
  }

  await Promise.all(tradeDates.map(async (tradeDate) => {
    let syncedDatasetsForDate = 0;
    let skippedDatasetsForDate = 0;

    try {
      if (await shouldSyncDataset(this.quoteRepo, syncMode, 'daily', tradeDate)) {
        const result = await syncDailyQuotesByTradeDate(this.fetcherDeps, tradeDate);
        quotes += result.count;
        syncedDatasetsForDate++;
        mergeChangedDates(changedRanges, result.tsCodes, tradeDate);
      } else {
        skippedDatasets++;
        skippedDatasetsForDate++;
      }
    } catch (err: unknown) {
      failedItems.push(createFailedItem('daily', tradeDate, err));
    }

    try {
      if (await shouldSyncDataset(this.quoteRepo, syncMode, 'daily_basic', tradeDate)) {
        metrics += await syncDailyMetricsByTradeDate(this.fetcherDeps, tradeDate);
        syncedDatasetsForDate++;
      } else {
        skippedDatasets++;
        skippedDatasetsForDate++;
      }
    } catch (err: unknown) {
      failedItems.push(createFailedItem('daily_basic', tradeDate, err));
    }

    try {
      if (await shouldSyncDataset(this.quoteRepo, syncMode, 'adj_factor', tradeDate)) {
        const result = await syncAdjFactorsByTradeDate(this.fetcherDeps, tradeDate);
        adjFactors += result.count;
        syncedDatasetsForDate++;
        mergeChangedDates(changedRanges, result.tsCodes, tradeDate);
        result.latestChangedTsCodes.forEach((tsCode) => latestAdjFactorChanged.add(tsCode));
      } else {
        skippedDatasets++;
        skippedDatasetsForDate++;
      }
    } catch (err: unknown) {
      failedItems.push(createFailedItem('adj_factor', tradeDate, err));
    }

    if (syncedDatasetsForDate === 0 && skippedDatasetsForDate === 3) skippedDates++;

    completedDates++;
    emit({
      type: 'progress',
      phase: '同步交易日',
      current: completedDates,
      total,
      percent: calculateSyncPercent(completedDates, total),
      message: `${tradeDate} 日线 ${quotes}，指标 ${metrics}，复权因子 ${adjFactors}，跳过 ${skippedDatasets}`,
    });
  }));

  if (quotes + metrics + adjFactors <= 0 && failedItems.length > 0 && skippedDatasets < total * 3) {
    failedItems.push({
      apiName: 'technical_indicators',
      message: '没有成功写入日线行情，已跳过技术指标计算',
    });
    return createResult('error', symbols, quotes, metrics, adjFactors, indicators, failedItems, range, skippedDates, skippedDatasets);
  }

  emit({
    type: 'progress',
    phase: '标记脏区间',
    current: 0,
    total: changedRanges.size,
    percent: 95,
    message: `${changedRanges.size} 只股票`,
  });
  await markDirtyRanges(this.dirtyRangeDeps, changedRanges, latestAdjFactorChanged);

  if (changedRanges.size > 0) {
    emit({
      type: 'progress',
      phase: '增量计算前复权',
      current: 0,
      total: changedRanges.size,
      percent: 96,
      message: `${changedRanges.size} 只股票`,
    });
    await recalculateDirtyQfqQuotes(this.dirtyRangeDeps, [...changedRanges.keys()], (current, total, tsCode) => {
      emit({
        type: 'progress',
        phase: '增量计算前复权',
        current,
        total,
        percent: 96 + (current / total) * 2,
        message: tsCode,
      });
    });

    emit({
      type: 'progress',
      phase: '增量计算技术指标',
      current: 0,
      total: changedRanges.size,
      percent: 98,
      message: `${changedRanges.size} 只股票`,
    });
    indicators = await this.indicatorService.recalculateDirtyIndicatorsForSymbols(
      [...changedRanges.keys()],
      (current, total, tsCode) => {
        emit({
          type: 'progress',
          phase: '增量计算技术指标',
          current,
          total,
          percent: 98 + (current / total) * 2,
          message: tsCode,
        });
      },
    );
  }

  const status: ASharesSyncStatus = failedItems.length > 0 ? 'partial' : 'done';
  return createResult(status, symbols, quotes, metrics, adjFactors, indicators, failedItems, range, skippedDates, skippedDatasets);
}
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

```bash
cd c:/codes/cryptotrading/apps/server && npx tsc --noEmit
```

预期：无报错输出。

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/market-data/a-shares/sync/a-shares-sync.service.ts
git commit -m "feat(sync): A 股同步改为按交易日并发（Promise.all）"
```

---

## Task 4: 集成验证

无自动化测试框架，用手动验证代替。

- [ ] **Step 1: 启动服务**

```bash
cd c:/codes/cryptotrading/apps/server && node -e "
const { NestFactory } = require('@nestjs/core');
" 2>&1 | head -3
```

实际启动方式按项目习惯执行 `pnpm dev`（在 apps/server 目录或根目录 filter），确保服务启动无报错。

- [ ] **Step 2: 触发一个小范围同步，观察并发行为**

通过 API 触发同步（传一个短区间，如 3 个交易日），观察服务日志，确认：

1. 多个交易日的请求几乎同时发出（日志中不同日期的进度 emit 交错出现）
2. 每个请求间隔约 200ms（`TUSHARE_MIN_INTERVAL_MS` 默认值）

- [ ] **Step 3: 验证限流自适应（可选，若有限流条件）**

将 `.env` 中 `TUSHARE_CONCURRENCY` 临时调高至 20，触发同步，观察日志中是否出现限流重试，以及 `currentIntervalMs` 是否被间接体现（请求变慢）。验证后还原。

- [ ] **Step 4: 数据库验证**

同步完成后查询数据，确认写入行数与预期一致：

```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
SELECT trade_date, COUNT(*) as cnt
FROM a_share_daily_metrics
WHERE trade_date IN ('20260424','20260425','20260428')
GROUP BY trade_date ORDER BY trade_date;
"
```

---

## 自检记录

**Spec 覆盖检查：**
- ✅ 按交易日并发（Promise.all）→ Task 3
- ✅ p-limit 控制并发上限 → Task 2（TushareClientService.limiter）
- ✅ 固定最小间隔 → Task 2（`lastRequestAt` + `currentIntervalMs`）
- ✅ 遇限流翻倍间隔 → Task 2（`onRateLimit()`）
- ✅ 成功后收敛间隔 → Task 2（`× 0.9`）
- ✅ 三个环境变量 → Task 1
- ✅ 进度上报按完成数驱动 → Task 3

**类型一致性：**
- `TushareRow`、`ASharesSyncFailedItem`、`ASharesSyncEvent`、`ASharesSyncResult` 均沿用现有定义，无新增类型。
- `mergeChangedDates`、`createFailedItem`、`calculateSyncPercent` 签名未变。
