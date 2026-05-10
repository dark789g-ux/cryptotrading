# 行业/概念目录与成分股同步独立模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"行业/板块成分股"同步从资金流向同步中解耦为独立模块，新增 `ths_index_catalog` 目录表与「数据同步」页面卡片，实现"拉目录 → 循环成分股 → 清理孤儿"五阶段 SSE 同步流程。

**Architecture:** 后端新增 `apps/server/src/market-data/index-catalog/` 模块，复用 money-flow 的 `SyncCtx`/SSE 事件协议；共享工具函数（asString/batchUpsert/deduplicateBy/SyncCtx 等）从 money-flow-sync.helpers 提升到 `_shared/sync-helpers.ts`。前端新增 `useIndexCatalogSync` composable 与 SyncView 第 5 张卡片，复用 `useSSE`。

**Tech Stack:** NestJS 10 + TypeORM + RxJS Subject (SSE) / Vue 3 + Naive UI / PostgreSQL / Jest / Vitest

**参考 Spec:** [docs/superpowers/specs/2026-05-11-index-catalog-sync-design.md](docs/superpowers/specs/2026-05-11-index-catalog-sync-design.md)

---

## Task 1: 数据库迁移 + ThsIndexCatalog 实体

**Files:**
- Create: `apps/server/src/migration/2026-05-11-ths-index-catalog.sql`
- Create: `apps/server/src/entities/index-catalog/ths-index-catalog.entity.ts`

- [ ] **Step 1: 写迁移 SQL**

`apps/server/src/migration/2026-05-11-ths-index-catalog.sql`：

```sql
CREATE TABLE IF NOT EXISTS ths_index_catalog (
  ts_code     VARCHAR(20) PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  count       INTEGER,
  exchange    VARCHAR(8) NOT NULL,
  list_date   VARCHAR(8),
  type        VARCHAR(4) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ths_index_catalog_type ON ths_index_catalog (type);
```

- [ ] **Step 2: 在 Docker 中执行迁移**

```powershell
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb < apps/server/src/migration/2026-05-11-ths-index-catalog.sql
```

预期输出：`CREATE TABLE` 与 `CREATE INDEX`（或 `NOTICE: ... already exists`）。

- [ ] **Step 3: 验证表结构**

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d ths_index_catalog"
```

预期：列出 8 列，`ts_code` 为 PK，`type` 上有 index。

- [ ] **Step 4: 创建实体文件**

`apps/server/src/entities/index-catalog/ths-index-catalog.entity.ts`：

```typescript
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('ths_index_catalog')
@Index(['type'])
export class ThsIndexCatalogEntity {
  @PrimaryColumn({ name: 'ts_code', length: 20 })
  tsCode: string;

  @Column({ name: 'name', length: 100 })
  name: string;

  @Column({ name: 'count', type: 'int', nullable: true })
  count: number | null;

  @Column({ name: 'exchange', length: 8 })
  exchange: string;

  @Column({ name: 'list_date', length: 8, nullable: true })
  listDate: string | null;

  @Column({ name: 'type', length: 4 })
  type: 'I' | 'N';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

注意：`@CreateDateColumn`/`@UpdateDateColumn` 必须显式指定 `type: 'timestamptz'`（CLAUDE.md 时间规范）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/migration/2026-05-11-ths-index-catalog.sql apps/server/src/entities/index-catalog/ths-index-catalog.entity.ts
git commit -m "feat(index-catalog): 新增 ths_index_catalog 表与实体"
```

---

## Task 2: 提取共享工具函数到 _shared

**Files:**
- Create: `apps/server/src/market-data/_shared/sync-helpers.ts`
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.helpers.ts`
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.service.ts`

将 `SyncCtx` 类型与无领域耦合的工具函数迁出，使 index-catalog 模块复用而无需 import money-flow 内部文件。

- [ ] **Step 1: 创建 _shared/sync-helpers.ts**

`apps/server/src/market-data/_shared/sync-helpers.ts`：

```typescript
import { Repository } from 'typeorm';
import type { MoneyFlowSyncEvent } from '@cryptotrading/shared-types';

export type SyncCtx = {
  phase: string;
  baseCurrent: number;
  total: number;
  grandTotal: number;
  emit: (e: MoneyFlowSyncEvent) => void;
};

export function pctOf(c: number, g: number): number {
  return Math.round((c / Math.max(g, 1)) * 100);
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function asNullableNumeric(v: unknown, divisor?: number): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (isNaN(n)) return null;
  if (divisor != null && divisor !== 0) return String(n / divisor);
  return String(n);
}

export function asString(v: unknown): string {
  return v == null ? '' : String(v);
}

/**
 * 按一组字段对实体数组去重，保留每组最后一条，防止 ON CONFLICT DO UPDATE 同批次重复键报错。
 */
export function deduplicateBy<T extends object>(entities: T[], keys: (keyof T)[]): T[] {
  const map = new Map<string, T>();
  for (const entity of entities) {
    const conflictKey = keys.map((k) => String(entity[k])).join('|');
    map.set(conflictKey, entity);
  }
  return Array.from(map.values());
}

const RETRY_BACKOFFS = [1000, 2000];

export async function runWithRetry<T>(
  fn: () => Promise<T>,
  onRetry: (attempt: number, err: unknown) => void,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFFS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY_BACKOFFS.length) {
        onRetry(attempt + 1, e);
        await new Promise((r) => setTimeout(r, RETRY_BACKOFFS[attempt]));
      }
    }
  }
  throw lastErr;
}

export const RETRY_MAX_ATTEMPTS = RETRY_BACKOFFS.length;

export async function batchUpsert<T extends object>(
  repo: Repository<T>,
  entities: T[],
  conflictKeys: (keyof T)[],
): Promise<number> {
  const deduped = deduplicateBy(entities, conflictKeys);
  const chunkSize = 1000;
  for (let i = 0; i < deduped.length; i += chunkSize) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await repo.upsert(deduped.slice(i, i + chunkSize) as any, conflictKeys as string[]);
  }
  return deduped.length;
}
```

- [ ] **Step 2: 改写 money-flow-sync.helpers.ts，从 _shared 重导出**

删除 L1-81 中已迁移到 `_shared/sync-helpers.ts` 的全部定义（`SyncCtx` 类型、`pctOf`、`truncate`、`asNullableNumeric`、`asString`、`deduplicateBy`、`runWithRetry`、`RETRY_MAX_ATTEMPTS`、`batchUpsert`），改为从 `_shared` 重导出，仅保留 `filterExistingDates` 与 `fetchByDates` 在本文件。

最终文件内容：

```typescript
import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { TushareClientService } from '../a-shares/services/tushare-client.service';
import {
  type SyncCtx,
  pctOf,
  runWithRetry,
  RETRY_MAX_ATTEMPTS,
  truncate,
} from '../_shared/sync-helpers';

export type { SyncCtx } from '../_shared/sync-helpers';
export {
  pctOf,
  truncate,
  asNullableNumeric,
  asString,
  deduplicateBy,
  runWithRetry,
  RETRY_MAX_ATTEMPTS,
  batchUpsert,
} from '../_shared/sync-helpers';

/** 增量模式：从交易日列表中过滤掉指定 repo 中已有数据的日期 */
export async function filterExistingDates<T extends { tradeDate: string }>(
  repo: Repository<T>,
  tradeDates: string[],
): Promise<{ dates: string[]; skipped: number }> {
  const existing = await repo
    .createQueryBuilder('e')
    .select('DISTINCT e.trade_date', 'tradeDate')
    .where('e.trade_date IN (:...dates)', { dates: tradeDates })
    .getRawMany<{ tradeDate: string }>();
  const existingSet = new Set(existing.map((r) => r.tradeDate));
  const dates = tradeDates.filter((d) => !existingSet.has(d));
  return { dates, skipped: tradeDates.length - dates.length };
}

export interface FetchByDatesOptions<TRow> {
  apiName: string;
  fields: string;
  dates: string[];
  ctx?: SyncCtx;
  logger: Logger;
  client: TushareClientService;
  truncationThreshold?: number;
  buildParams?: (date: string) => Record<string, string | number>;
}

export interface FetchByDatesResult<TRow> {
  rowsByDate: Array<{ date: string; rows: TRow[] }>;
  errors: string[];
}

export async function fetchByDates<TRow>(
  opts: FetchByDatesOptions<TRow>,
): Promise<FetchByDatesResult<TRow>> {
  const { apiName, fields, dates, ctx, logger, client, buildParams } = opts;
  const truncationThreshold = opts.truncationThreshold ?? 6000;
  const errors: string[] = [];
  const rowsByDate: Array<{ date: string; rows: TRow[] }> = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const params = buildParams ? buildParams(date) : { start_date: date, end_date: date };
    let rows: TRow[] = [];
    try {
      rows = (await runWithRetry(
        () => client.query(apiName, params, fields),
        (attempt, err) => ctx?.emit({
          type: 'progress',
          phase: ctx.phase,
          current: ctx.baseCurrent + i,
          total: ctx.total,
          percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
          message: `重试中：${date}（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次） ${truncate(String(err), 60)}`,
        }),
      )) as TRow[];
    } catch (e: unknown) {
      const msg = `${apiName} ${date} 调用失败: ${e instanceof Error ? e.message : String(e)}`;
      logger.error(msg, e instanceof Error ? e.stack : undefined);
      errors.push(`[${date}] ${msg}`);
    }

    if (rows.length === 0) {
      logger.warn(`${apiName} ${date} 返回空数据，参数=${JSON.stringify(params)}`);
    } else if (rows.length >= truncationThreshold) {
      logger.warn(`${apiName} ${date} 返回 ${rows.length} 条，可能截断（阈值 ${truncationThreshold}）`);
    }

    rowsByDate.push({ date, rows });

    ctx?.emit({
      type: 'progress',
      phase: ctx.phase,
      current: ctx.baseCurrent + i + 1,
      total: ctx.total,
      percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
      message: date,
    });
  }

  return { rowsByDate, errors };
}
```

- [ ] **Step 3: money-flow-sync.service.ts import 路径无需改动**

由于 helpers 重导出了所有函数与类型，`money-flow-sync.service.ts` 的 import 行（L16-24）保持不变。

- [ ] **Step 4: 构建验证**

```powershell
pnpm --filter @cryptotrading/server build
```

预期：构建成功，无类型错误。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/market-data/_shared/sync-helpers.ts apps/server/src/market-data/money-flow/money-flow-sync.helpers.ts
git commit -m "refactor(market-data): 提取通用同步工具到 _shared/sync-helpers"
```

---

## Task 3: 删除资金流中的 syncMembers 调用与残留入口

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.service.ts`
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.controller.ts`
- Modify: `apps/server/src/market-data/money-flow/money-flow.module.ts`

money-flow.module.ts 中 `ThsMemberStockEntity` 注册**保留不动**（[money-flow.controller.ts:41](apps/server/src/market-data/money-flow/money-flow.controller.ts#L41) 的 `queryMembers` 读端点仍依赖它）。`QueryMemberDto` 文件**保留不动**（同样被读端点使用）。

- [ ] **Step 1: 编辑 money-flow-sync.service.ts，删除 syncMembers 相关代码**

具体改动：

1. 删除 `import { ThsMemberStockEntity }` 行（L11）
2. 删除常量 `MEMBER_FIELDS`（L36-37 的 `// ths_member: ...` 注释 + L37）
3. 删除构造函数中 `memberRepo` 注入：
   ```typescript
   @InjectRepository(ThsMemberStockEntity)
   private readonly memberRepo: Repository<ThsMemberStockEntity>,
   ```
4. `syncIndustries` 方法内：
   - 删除 L169-172（`if (!resolved.dates.length)` 内的 `memberResult` 调用块）改回直接 `return { success: 0, skipped: resolved.skipped, errors }`
   - 删除 L203-205（资金流 upsert 后的 `syncMembers('industry')` 调用与 `this.logger.log` 行），return 简化为：
     ```typescript
     return { success, skipped: resolved.skipped, errors };
     ```
5. `syncSectors` 方法内：同样删除 L213-216 与 L246-248
6. 删除整段私有方法 `syncMembers(dimension)`（L286-346 含上方注释）
7. 删除未使用的 `DataSource` 注入（仅当 grep 后确认仅 syncMembers 用到——现状是仅它使用），同时移除顶部 `import { DataSource, Repository } from 'typeorm'` 改为 `import { Repository } from 'typeorm'` 与 `import { InjectRepository } from '@nestjs/typeorm'`（不再需要 InjectDataSource）

构造函数最终形态（参考）：

```typescript
constructor(
  @InjectRepository(MoneyFlowStockEntity)
  private readonly stockRepo: Repository<MoneyFlowStockEntity>,
  @InjectRepository(MoneyFlowIndustryEntity)
  private readonly industryRepo: Repository<MoneyFlowIndustryEntity>,
  @InjectRepository(MoneyFlowSectorEntity)
  private readonly sectorRepo: Repository<MoneyFlowSectorEntity>,
  @InjectRepository(MoneyFlowMarketEntity)
  private readonly marketRepo: Repository<MoneyFlowMarketEntity>,
  @InjectRepository(AShareSymbolEntity)
  private readonly symbolRepo: Repository<AShareSymbolEntity>,
  private readonly tushareClient: TushareClientService,
) {}
```

- [ ] **Step 2: 编辑 money-flow-sync.controller.ts，删除 POST /sync/members**

删除 L6 `import { QueryMemberDto } from './dto/query-member.dto';`，删除 L28-33 整段 `@Post('members') syncMembers(...)` 端点。

最终文件内容：

```typescript
import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { MoneyFlowSyncService } from './money-flow-sync.service';
import { SyncFlowDto } from './dto/sync-flow.dto';

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
}
```

- [ ] **Step 3: 构建验证**

```powershell
pnpm --filter @cryptotrading/server build
```

预期：构建通过。如果报 `ThsMemberStockEntity` 在 money-flow.module 中已注册但无 service 使用——保留即可（`queryMembers` 读端点用到）。

- [ ] **Step 4: 启动服务回归资金流向同步（手动）**

```powershell
pnpm --filter @cryptotrading/server start:dev
```

人工触发一次资金流向同步（前端 SyncView → 资金流向卡片 → 起一段日期）。日志中**不得出现** `ths_member(...)` 字样或 `syncMembers` 相关日志。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/market-data/money-flow/money-flow-sync.service.ts apps/server/src/market-data/money-flow/money-flow-sync.controller.ts
git commit -m "refactor(money-flow): 删除资金流同步中的成分股同步逻辑"
```

---

## Task 4: shared-types 添加 IndexCatalogSyncSummary

**Files:**
- Modify: `packages/shared-types/src/index.ts`（或 money-flow.ts，按现有约定）

- [ ] **Step 1: 定位现有 MoneyFlowSyncSummary 类型位置**

```powershell
grep -rn "MoneyFlowSyncSummary" packages/shared-types/src/
```

记录类型导出文件路径（假设为 `packages/shared-types/src/money-flow.ts`）。

- [ ] **Step 2: 在同一文件追加 IndexCatalogSyncSummary**

在 `MoneyFlowSyncSummary` 定义之后追加：

```typescript
export interface IndexCatalogSyncSummary {
  industryCatalog: MoneyFlowSyncResult;
  conceptCatalog:  MoneyFlowSyncResult;
  industryMembers: MoneyFlowSyncResult;
  conceptMembers:  MoneyFlowSyncResult;
  cleanup:         MoneyFlowSyncResult;
}
```

- [ ] **Step 3: 确认 barrel 导出**

如果文件不在 `index.ts` 的 `export *` 范围内，在 `packages/shared-types/src/index.ts` 中追加导出：

```typescript
export type { IndexCatalogSyncSummary } from './money-flow';
```

- [ ] **Step 4: 构建 shared-types**

```powershell
pnpm --filter @cryptotrading/shared-types build
```

预期：成功。

- [ ] **Step 5: 提交**

```bash
git add packages/shared-types/src/
git commit -m "feat(shared-types): 新增 IndexCatalogSyncSummary 类型"
```

---

## Task 5: index-catalog 模块骨架（DTO + Module 注册）

**Files:**
- Create: `apps/server/src/market-data/index-catalog/dto/sync-catalog.dto.ts`
- Create: `apps/server/src/market-data/index-catalog/index-catalog.module.ts`
- Create: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts`（仅骨架）
- Create: `apps/server/src/market-data/index-catalog/index-catalog-sync.controller.ts`
- Modify: `apps/server/src/app.module.ts`

- [ ] **Step 1: 创建 DTO**

`apps/server/src/market-data/index-catalog/dto/sync-catalog.dto.ts`：

```typescript
/**
 * 行业/概念目录同步入参（极简：当前无字段，预留扩展位）。
 */
export class SyncCatalogDto {}
```

- [ ] **Step 2: 创建 Service 骨架**

`apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts`：

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Subject } from 'rxjs';
import type { MoneyFlowSyncEvent, MoneyFlowSyncResult, IndexCatalogSyncSummary } from '@cryptotrading/shared-types';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { SyncCtx, asString, batchUpsert, deduplicateBy } from '../_shared/sync-helpers';

// ths_index: https://tushare.pro/wctapi/documents/259.md
const CATALOG_FIELDS = 'ts_code,name,count,exchange,list_date,type';
// ths_member: https://tushare.pro/wctapi/documents/261.md
const MEMBER_FIELDS = 'ts_code,con_code,con_name,is_new';

interface RawRow {
  [k: string]: unknown;
}

@Injectable()
export class IndexCatalogSyncService {
  private readonly logger = new Logger(IndexCatalogSyncService.name);
  private isSyncing = false;

  constructor(
    @InjectRepository(ThsIndexCatalogEntity)
    private readonly catalogRepo: Repository<ThsIndexCatalogEntity>,
    @InjectRepository(ThsMemberStockEntity)
    private readonly memberRepo: Repository<ThsMemberStockEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tushareClient: TushareClientService,
  ) {}

  // 各方法在后续 Task 中实现
  async syncCatalog(_type: 'I' | 'N', _ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
    return { success: 0, skipped: 0, errors: [] };
  }

  async syncMembers(_type: 'I' | 'N', _ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
    return { success: 0, skipped: 0, errors: [] };
  }

  async cleanupOrphans(): Promise<MoneyFlowSyncResult> {
    return { success: 0, skipped: 0, errors: [] };
  }

  startSync(): Subject<MoneyFlowSyncEvent> {
    const subject = new Subject<MoneyFlowSyncEvent>();
    subject.next({ type: 'error', message: 'startSync 尚未实现' });
    subject.complete();
    return subject;
  }
}
```

- [ ] **Step 3: 创建 Controller**

`apps/server/src/market-data/index-catalog/index-catalog-sync.controller.ts`：

```typescript
import { Controller, Get, Header, Res } from '@nestjs/common';
import { Response } from 'express';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { IndexCatalogSyncService } from './index-catalog-sync.service';

@Controller('index-catalog/sync')
export class IndexCatalogSyncController {
  constructor(private readonly syncService: IndexCatalogSyncService) {}

  @Get('run')
  @AdminOnly()
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  runSync(@Res() res: Response) {
    res.flushHeaders();
    const subject = this.syncService.startSync();
    const subscription = subject.subscribe({
      next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      complete: () => res.end(),
      error: () => res.end(),
    });
    res.on('close', () => subscription.unsubscribe());
  }
}
```

- [ ] **Step 4: 创建 Module**

`apps/server/src/market-data/index-catalog/index-catalog.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { IndexCatalogSyncController } from './index-catalog-sync.controller';
import { IndexCatalogSyncService } from './index-catalog-sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ThsIndexCatalogEntity, ThsMemberStockEntity]),
  ],
  controllers: [IndexCatalogSyncController],
  providers: [IndexCatalogSyncService, TushareClientService],
})
export class IndexCatalogModule {}
```

- [ ] **Step 5: 注册到 AppModule**

打开 `apps/server/src/app.module.ts`，找到 `MoneyFlowModule` 的 import 与 `imports[]` 数组中的位置，在其后追加：

```typescript
import { IndexCatalogModule } from './market-data/index-catalog/index-catalog.module';
```

并把 `IndexCatalogModule` 加入 `imports[]`（紧随 `MoneyFlowModule` 之后）。

- [ ] **Step 6: 构建验证**

```powershell
pnpm --filter @cryptotrading/server build
```

预期：构建通过，无依赖解析错误。

- [ ] **Step 7: 启动并验证 SSE 端点存在**

```powershell
pnpm --filter @cryptotrading/server start:dev
```

新窗口中：

```powershell
curl -N http://localhost:3000/index-catalog/sync/run
```

预期：返回一行 `data: {"type":"error","message":"startSync 尚未实现"}\n\n` 后连接关闭。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/market-data/index-catalog/ apps/server/src/app.module.ts
git commit -m "feat(index-catalog): 模块骨架 + SSE 端点占位"
```

---

## Task 6: 实现 syncCatalog 方法（TDD）

**Files:**
- Create: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts`
- Modify: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts`

- [ ] **Step 1: 编写失败测试**

`apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts`（新建）：

```typescript
// TODO: 需集成测试验证 API 契约（ths_index / ths_member 接口名与参数）
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IndexCatalogSyncService } from './index-catalog-sync.service';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';

function makeRepoMock<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    upsert: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(),
    create: jest.fn().mockImplementation((x) => x),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    query: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('IndexCatalogSyncService', () => {
  let service: IndexCatalogSyncService;
  let catalogRepo: jest.Mocked<Repository<ThsIndexCatalogEntity>>;
  let memberRepo: jest.Mocked<Repository<ThsMemberStockEntity>>;
  let tushare: { query: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    catalogRepo = makeRepoMock();
    memberRepo = makeRepoMock();
    tushare = { query: jest.fn() };
    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) =>
        cb({
          delete: jest.fn().mockResolvedValue({ affected: 0 }),
          upsert: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexCatalogSyncService,
        { provide: getRepositoryToken(ThsIndexCatalogEntity), useValue: catalogRepo },
        { provide: getRepositoryToken(ThsMemberStockEntity), useValue: memberRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: TushareClientService, useValue: tushare },
      ],
    }).compile();

    service = module.get(IndexCatalogSyncService);
  });

  describe('syncCatalog', () => {
    it('调用 ths_index 时 type=I exchange=A 字段完整', async () => {
      tushare.query.mockResolvedValue([
        { ts_code: '881101.TI', name: '采掘', count: 50, exchange: 'A', list_date: '20100101', type: 'I' },
      ]);

      const result = await service.syncCatalog('I');

      expect(tushare.query).toHaveBeenCalledWith(
        'ths_index',
        { type: 'I', exchange: 'A' },
        'ts_code,name,count,exchange,list_date,type',
      );
      expect(catalogRepo.upsert).toHaveBeenCalled();
      expect(result.success).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('返回空数据时记 warn 并 success=0', async () => {
      tushare.query.mockResolvedValue([]);
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation();

      const result = await service.syncCatalog('N');

      expect(result.success).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ths_index type=N'));
    });

    it('同 ts_code 重复行去重后仅 upsert 一条', async () => {
      tushare.query.mockResolvedValue([
        { ts_code: 'X.TI', name: 'A', count: 1, exchange: 'A', list_date: '20100101', type: 'I' },
        { ts_code: 'X.TI', name: 'B', count: 2, exchange: 'A', list_date: '20100101', type: 'I' },
      ]);

      const result = await service.syncCatalog('I');

      expect(result.success).toBe(1);
    });

    it('ths_index 调用失败时 errors 透出且不 upsert', async () => {
      tushare.query.mockRejectedValue(new Error('rate limit'));

      const result = await service.syncCatalog('I');

      expect(catalogRepo.upsert).not.toHaveBeenCalled();
      expect(result.errors[0]).toContain('ths_index type=I');
    });
  });
});
```

- [ ] **Step 2: 运行测试，确认全部失败**

```powershell
pnpm --filter @cryptotrading/server test -- index-catalog-sync.service.spec.ts
```

预期：4 个用例全部失败（service 中是占位实现）。

- [ ] **Step 3: 实现 syncCatalog**

替换 `index-catalog-sync.service.ts` 中的 `syncCatalog` 方法体：

```typescript
async syncCatalog(type: 'I' | 'N', _ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
  const errors: string[] = [];
  let rows: RawRow[] = [];
  try {
    rows = (await this.tushareClient.query(
      'ths_index',
      { type, exchange: 'A' },
      CATALOG_FIELDS,
    )) as RawRow[];
  } catch (e: unknown) {
    const msg = `ths_index type=${type} 调用失败: ${e instanceof Error ? e.message : String(e)}`;
    this.logger.error(msg, e instanceof Error ? e.stack : undefined);
    errors.push(msg);
    return { success: 0, skipped: 0, errors };
  }

  if (!rows.length) {
    this.logger.warn(`[ths_index type=${type}] 返回空数据，参数={type:'${type}',exchange:'A'}`);
    return { success: 0, skipped: 0, errors };
  }

  const entities = rows.map((r) => this.catalogRepo.create({
    tsCode: asString(r.ts_code),
    name: asString(r.name),
    count: r.count != null ? Number(r.count) : null,
    exchange: asString(r.exchange),
    listDate: r.list_date != null ? asString(r.list_date) : null,
    type,
  }));

  const success = await batchUpsert(this.catalogRepo, entities, ['tsCode']);
  return { success, skipped: 0, errors };
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

```powershell
pnpm --filter @cryptotrading/server test -- index-catalog-sync.service.spec.ts
```

预期：4 个用例全部通过。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/market-data/index-catalog/
git commit -m "feat(index-catalog): 实现 syncCatalog（TDD）"
```

---

## Task 7: 实现 syncMembers 方法（TDD）

**Files:**
- Modify: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts`
- Modify: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts`

- [ ] **Step 1: 在测试文件追加 syncMembers 用例**

在 spec 文件 describe('IndexCatalogSyncService') 内，于 `syncCatalog` 之后追加：

```typescript
  describe('syncMembers', () => {
    function setupCatalogQuery(tsCodes: string[]) {
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(tsCodes.map((t) => ({ tsCode: t }))),
      };
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb) as never;
    }

    it('对每个 ts_code 各调一次 ths_member 并事务式写入', async () => {
      setupCatalogQuery(['881101.TI', '881102.TI']);
      tushare.query.mockResolvedValue([
        { ts_code: '881101.TI', con_code: '000001.SZ', con_name: '平安银行', is_new: 'Y' },
      ]);

      const result = await service.syncMembers('I');

      expect(tushare.query).toHaveBeenCalledTimes(2);
      expect(tushare.query).toHaveBeenNthCalledWith(
        1,
        'ths_member',
        { ts_code: '881101.TI' },
        'ts_code,con_code,con_name,is_new',
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it('某个 ts_code 调用失败时记 errors 但继续后续', async () => {
      setupCatalogQuery(['A.TI', 'B.TI']);
      tushare.query
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce([
          { ts_code: 'B.TI', con_code: '000001.SZ', con_name: 'X', is_new: 'Y' },
        ]);

      const result = await service.syncMembers('I');

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('A.TI');
      expect(result.success).toBe(1);
    });

    it('某个 ts_code 返回空数据时记 warn 跳过', async () => {
      setupCatalogQuery(['EMPTY.TI']);
      tushare.query.mockResolvedValue([]);
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation();

      const result = await service.syncMembers('I');

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EMPTY.TI'));
      expect(result.success).toBe(0);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('目录中无指定 type 的 ts_code 时记 warn 并 success=0', async () => {
      setupCatalogQuery([]);
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation();

      const result = await service.syncMembers('N');

      expect(result.success).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('type=N'));
      expect(tushare.query).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm --filter @cryptotrading/server test -- index-catalog-sync.service.spec.ts
```

预期：4 个新用例失败。

- [ ] **Step 3: 实现 syncMembers**

替换 `syncMembers` 方法体：

```typescript
async syncMembers(type: 'I' | 'N', _ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
  const errors: string[] = [];

  const rows = await this.catalogRepo
    .createQueryBuilder('c')
    .select('c.ts_code', 'tsCode')
    .where('c.type = :type', { type })
    .getRawMany<{ tsCode: string }>();
  const tsCodes = rows.map((r) => r.tsCode).filter(Boolean);

  if (!tsCodes.length) {
    this.logger.warn(`syncMembers(type=${type}): ths_index_catalog 中无对应记录，请先同步目录`);
    return { success: 0, skipped: 0, errors };
  }

  let success = 0;
  for (const tsCode of tsCodes) {
    try {
      const memberRows = (await this.tushareClient.query(
        'ths_member',
        { ts_code: tsCode },
        MEMBER_FIELDS,
      )) as RawRow[];

      if (!memberRows.length) {
        this.logger.warn(`ths_member(${tsCode}) 返回空数据`);
        continue;
      }

      const entities = memberRows.map((r) => this.memberRepo.create({
        tsCode: asString(r.ts_code),
        conCode: asString(r.con_code),
        conName: asString(r.con_name) || null,
        isNew: asString(r.is_new) || null,
      }));
      const deduped = deduplicateBy(entities, ['tsCode', 'conCode']);

      await this.dataSource.transaction(async (manager) => {
        await manager.delete(ThsMemberStockEntity, { tsCode });
        const chunkSize = 1000;
        for (let i = 0; i < deduped.length; i += chunkSize) {
          await manager.upsert(
            ThsMemberStockEntity,
            deduped.slice(i, i + chunkSize),
            ['tsCode', 'conCode'],
          );
        }
      });
      success += 1;
    } catch (e: unknown) {
      const msg = `ths_member(${tsCode}) 失败: ${e instanceof Error ? e.message : String(e)}`;
      this.logger.error(msg, e instanceof Error ? e.stack : undefined);
      errors.push(`[${tsCode}] ${msg}`);
    }
  }

  return { success, skipped: 0, errors };
}
```

注意：`success` 现在按"成功的 ts_code 数"计（与 spec 第 1 个用例预期一致）。

- [ ] **Step 4: 运行测试确认通过**

```powershell
pnpm --filter @cryptotrading/server test -- index-catalog-sync.service.spec.ts
```

预期：8 个用例（4 旧 + 4 新）全部通过。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/market-data/index-catalog/
git commit -m "feat(index-catalog): 实现 syncMembers（TDD）"
```

---

## Task 8: 实现 cleanupOrphans 方法（TDD）

**Files:**
- Modify: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts`
- Modify: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts`

- [ ] **Step 1: 追加测试**

在 spec 文件 describe 内追加：

```typescript
  describe('cleanupOrphans', () => {
    it('执行 NOT IN 子查询并返回受影响行数', async () => {
      memberRepo.query = jest.fn().mockResolvedValue([{ count: '17' }]) as never;
      // 真实实现下，TypeORM Repository.query 返回的形态依赖驱动；这里仅断言 SQL 文本与 success
      // 见实现：使用 createQueryBuilder().delete().where(...).execute()

      const qb = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 17 }),
      };
      memberRepo.createQueryBuilder = jest.fn().mockReturnValue(qb) as never;

      const result = await service.cleanupOrphans();

      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining('ts_code NOT IN'),
      );
      expect(result.success).toBe(17);
      expect(result.errors).toHaveLength(0);
    });

    it('SQL 失败时 errors 透出', async () => {
      const qb = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockRejectedValue(new Error('boom')),
      };
      memberRepo.createQueryBuilder = jest.fn().mockReturnValue(qb) as never;

      const result = await service.cleanupOrphans();

      expect(result.success).toBe(0);
      expect(result.errors[0]).toContain('cleanupOrphans');
    });
  });
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm --filter @cryptotrading/server test -- index-catalog-sync.service.spec.ts
```

- [ ] **Step 3: 实现 cleanupOrphans**

```typescript
async cleanupOrphans(): Promise<MoneyFlowSyncResult> {
  const errors: string[] = [];
  try {
    const result = await this.memberRepo
      .createQueryBuilder()
      .delete()
      .from(ThsMemberStockEntity)
      .where('ts_code NOT IN (SELECT ts_code FROM ths_index_catalog)')
      .execute();
    const affected = result.affected ?? 0;
    if (affected > 0) {
      this.logger.log(`cleanupOrphans 删除 ${affected} 条孤儿成分股`);
    }
    return { success: affected, skipped: 0, errors };
  } catch (e: unknown) {
    const msg = `cleanupOrphans 失败: ${e instanceof Error ? e.message : String(e)}`;
    this.logger.error(msg, e instanceof Error ? e.stack : undefined);
    errors.push(msg);
    return { success: 0, skipped: 0, errors };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
pnpm --filter @cryptotrading/server test -- index-catalog-sync.service.spec.ts
```

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/market-data/index-catalog/
git commit -m "feat(index-catalog): 实现 cleanupOrphans（TDD）"
```

---

## Task 9: 实现 startSync 编排（TDD）

**Files:**
- Modify: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts`
- Modify: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts`

- [ ] **Step 1: 追加 startSync 测试**

在 spec 文件 describe 内追加：

```typescript
  describe('startSync', () => {
    function collect(subject: ReturnType<IndexCatalogSyncService['startSync']>) {
      const events: MoneyFlowSyncEvent[] = [];
      return new Promise<MoneyFlowSyncEvent[]>((resolve, reject) => {
        subject.subscribe({
          next: (e) => events.push(e),
          complete: () => resolve(events),
          error: reject,
        });
      });
    }

    it('正常流程：发出 progress + done，summary 含五个字段', async () => {
      jest.spyOn(service, 'syncCatalog')
        .mockResolvedValueOnce({ success: 100, skipped: 0, errors: [] })
        .mockResolvedValueOnce({ success: 200, skipped: 0, errors: [] });
      jest.spyOn(service, 'syncMembers')
        .mockResolvedValueOnce({ success: 50, skipped: 0, errors: [] })
        .mockResolvedValueOnce({ success: 80, skipped: 0, errors: [] });
      jest.spyOn(service, 'cleanupOrphans')
        .mockResolvedValue({ success: 3, skipped: 0, errors: [] });

      const events = await collect(service.startSync());

      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      const summary = (done as { summary: IndexCatalogSyncSummary }).summary;
      expect(summary.industryCatalog.success).toBe(100);
      expect(summary.conceptCatalog.success).toBe(200);
      expect(summary.industryMembers.success).toBe(50);
      expect(summary.conceptMembers.success).toBe(80);
      expect(summary.cleanup.success).toBe(3);
    });

    it('industryCatalog 失败时立即 error 不进入下一阶段', async () => {
      jest.spyOn(service, 'syncCatalog').mockResolvedValueOnce({
        success: 0, skipped: 0, errors: ['ths_index type=I 调用失败: boom'],
      });
      const memberSpy = jest.spyOn(service, 'syncMembers');

      const events = await collect(service.startSync());

      expect(events.some((e) => e.type === 'error')).toBe(true);
      expect(memberSpy).not.toHaveBeenCalled();
    });

    it('并发 startSync 第二次返回 error', async () => {
      jest.spyOn(service, 'syncCatalog').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { success: 1, skipped: 0, errors: [] };
      });
      jest.spyOn(service, 'syncMembers').mockResolvedValue({ success: 0, skipped: 0, errors: [] });
      jest.spyOn(service, 'cleanupOrphans').mockResolvedValue({ success: 0, skipped: 0, errors: [] });

      const first = collect(service.startSync());
      const second = collect(service.startSync());
      const [, secondEvents] = await Promise.all([first, second]);

      expect(secondEvents.some(
        (e) => e.type === 'error' && /已在运行中/.test(e.message ?? ''),
      )).toBe(true);
    });
  });
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm --filter @cryptotrading/server test -- index-catalog-sync.service.spec.ts
```

- [ ] **Step 3: 实现 startSync**

替换 `startSync()`：

```typescript
startSync(): Subject<MoneyFlowSyncEvent> {
  const subject = new Subject<MoneyFlowSyncEvent>();

  if (this.isSyncing) {
    subject.next({ type: 'error', message: '行业/概念目录同步任务已在运行中，请稍后再试' });
    subject.complete();
    return subject;
  }
  this.isSyncing = true;

  setTimeout(async () => {
    const summary: Partial<IndexCatalogSyncSummary> = {};
    try {
      // Stage 1: 同步行业目录（type=I）
      subject.next({ type: 'progress', phase: '同步行业目录', current: 0, total: 1, percent: 0, message: '开始' });
      summary.industryCatalog = await this.syncCatalog('I');
      subject.next({ type: 'progress', phase: '同步行业目录', current: 1, total: 1, percent: 25, message: `成功 ${summary.industryCatalog.success}` });
      if (summary.industryCatalog.errors.length) {
        subject.next({ type: 'error', message: '行业目录拉取失败：' + summary.industryCatalog.errors.join('; ') });
        subject.complete();
        return;
      }

      // Stage 2: 同步概念目录（type=N）
      subject.next({ type: 'progress', phase: '同步概念目录', current: 0, total: 1, percent: 25, message: '开始' });
      summary.conceptCatalog = await this.syncCatalog('N');
      subject.next({ type: 'progress', phase: '同步概念目录', current: 1, total: 1, percent: 50, message: `成功 ${summary.conceptCatalog.success}` });
      if (summary.conceptCatalog.errors.length) {
        subject.next({ type: 'error', message: '概念目录拉取失败：' + summary.conceptCatalog.errors.join('; ') });
        subject.complete();
        return;
      }

      // Stage 3 & 4: 成分股
      subject.next({ type: 'progress', phase: '同步行业成分股', current: 0, total: 0, percent: 50, message: '开始' });
      summary.industryMembers = await this.syncMembers('I');
      subject.next({ type: 'progress', phase: '同步行业成分股', current: 1, total: 1, percent: 75, message: `成功 ${summary.industryMembers.success}` });

      subject.next({ type: 'progress', phase: '同步概念成分股', current: 0, total: 0, percent: 75, message: '开始' });
      summary.conceptMembers = await this.syncMembers('N');
      subject.next({ type: 'progress', phase: '同步概念成分股', current: 1, total: 1, percent: 95, message: `成功 ${summary.conceptMembers.success}` });

      // Stage 5: 清理孤儿
      subject.next({ type: 'progress', phase: '清理孤儿成分股', current: 0, total: 1, percent: 95, message: '开始' });
      summary.cleanup = await this.cleanupOrphans();
      subject.next({ type: 'progress', phase: '清理孤儿成分股', current: 1, total: 1, percent: 100, message: `删除 ${summary.cleanup.success}` });

      const failedCount = (Object.values(summary) as MoneyFlowSyncResult[])
        .reduce((n, r) => n + (r?.errors.length ?? 0), 0);
      subject.next({
        type: 'done',
        message: failedCount ? `同步完成，${failedCount} 项有错误` : '同步完成',
        summary: summary as IndexCatalogSyncSummary,
      });
      subject.complete();
    } catch (err) {
      this.logger.error(`startSync 失败: ${err instanceof Error ? err.stack : String(err)}`);
      subject.next({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        summary: summary as IndexCatalogSyncSummary,
      });
      subject.complete();
    } finally {
      this.isSyncing = false;
    }
  }, 0);

  return subject;
}
```

注意：当前 `MoneyFlowSyncEvent` 的 `done` 事件 `summary` 字段类型若严格绑定 `MoneyFlowSyncSummary`，需在 shared-types 中将其放宽为联合类型 `MoneyFlowSyncSummary | IndexCatalogSyncSummary`，或为 done 事件添加泛型。**实现时**：先 grep `MoneyFlowSyncEvent` 类型定义，把 `summary?: MoneyFlowSyncSummary` 改为 `summary?: MoneyFlowSyncSummary | IndexCatalogSyncSummary`。

- [ ] **Step 4: 改 shared-types（如步骤 3 末段所述）**

打开 shared-types 中 `MoneyFlowSyncEvent` 定义文件（通常与 `MoneyFlowSyncSummary` 同文件），把 `done` 与 `error` 事件的 `summary` 字段类型改为：

```typescript
summary?: MoneyFlowSyncSummary | IndexCatalogSyncSummary;
```

重建：

```powershell
pnpm --filter @cryptotrading/shared-types build
```

- [ ] **Step 5: 运行测试确认通过**

```powershell
pnpm --filter @cryptotrading/server test -- index-catalog-sync.service.spec.ts
```

预期：所有用例通过。

- [ ] **Step 6: 整体后端构建**

```powershell
pnpm --filter @cryptotrading/server build
```

预期：成功。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/market-data/index-catalog/ packages/shared-types/
git commit -m "feat(index-catalog): 实现 startSync 五阶段编排（TDD）"
```

---

## Task 10: 后端集成回归（手动）

**Files:** 无（仅运行验证）

- [ ] **Step 1: 启动服务**

```powershell
pnpm --filter @cryptotrading/server start:dev
```

- [ ] **Step 2: 触发同步并观察 SSE**

新窗口：

```powershell
curl -N "http://localhost:3000/index-catalog/sync/run" -H "Cookie: <admin-session>"
```

预期：依次接收 progress 事件（5 阶段共 11 条 progress + 1 条 done），耗时数分钟。

- [ ] **Step 3: 验证数据库**

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT type, COUNT(*) FROM ths_index_catalog GROUP BY type;"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT COUNT(DISTINCT ts_code) FROM ths_member_stocks;"
```

预期：两类各有数百到数千行；ths_member_stocks 的 distinct ts_code 与 ths_index_catalog 行数相近（差值 = 当日空成员的板块数）。

- [ ] **Step 4: 资金流向同步回归**

通过 SyncView 触发资金流向同步，观察日志**不出现** `ths_member` 字样。

- [ ] **Step 5: 记录验证结果**

将以上 SQL 输出与日志摘录（不含敏感信息）记入本地笔记，后续 PR 描述粘贴。

- [ ] **Step 6: 提交（仅当本任务有任何代码 hotfix）**

如无代码改动则跳过；否则：

```bash
git commit -m "chore(index-catalog): 集成回归 hotfix"
```

---

## Task 11: 前端 API 模块

**Files:**
- Create: `apps/web/src/api/modules/indexCatalog.ts`

- [ ] **Step 1: 定位 API_BASE 来源**

```powershell
grep -n "API_BASE\|baseURL" apps/web/src/api/modules/moneyFlow.ts
```

记录其 import 来源（假设 `@/api/config` 或 `../config`）。

- [ ] **Step 2: 创建 API 模块**

`apps/web/src/api/modules/indexCatalog.ts`：

```typescript
import { API_BASE } from '../config'; // 与 moneyFlow.ts 同源，按上一步实际路径调整

export const indexCatalogApi = {
  syncRunUrl(): string {
    return `${API_BASE}/index-catalog/sync/run`;
  },
};
```

如果 `moneyFlow.ts` 中 SSE URL 是相对路径（让浏览器同源拼接），保持一致：

```typescript
export const indexCatalogApi = {
  syncRunUrl(): string {
    return `/api/index-catalog/sync/run`; // 按 moneyFlow.ts 实际写法对齐
  },
};
```

实现时**严格对齐 moneyFlow.ts** 的 URL 拼接风格，避免出现一处带 `/api` 一处不带的不一致。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/api/modules/indexCatalog.ts
git commit -m "feat(web/index-catalog): 新增前端 API 模块"
```

---

## Task 12: 前端 composable useIndexCatalogSync

**Files:**
- Create: `apps/web/src/components/sync/useIndexCatalogSync.ts`

- [ ] **Step 1: 阅读现有 composable 作为模板**

```powershell
cat apps/web/src/components/sync/useMoneyFlowSync.ts
```

记录：useSSE 的导入路径、状态字段命名、暴露 API 形态。

- [ ] **Step 2: 创建 useIndexCatalogSync.ts**

`apps/web/src/components/sync/useIndexCatalogSync.ts`：

```typescript
import { ref } from 'vue';
import { useSSE } from '@/composables/useSSE'; // 按 useMoneyFlowSync 实际路径对齐
import { indexCatalogApi } from '@/api/modules/indexCatalog';
import type { IndexCatalogSyncSummary, MoneyFlowSyncEvent } from '@cryptotrading/shared-types';
import { useMessage } from 'naive-ui';

export function useIndexCatalogSync() {
  const message = useMessage();
  const sse = useSSE<MoneyFlowSyncEvent>();
  const syncing = ref(false);
  const finished = ref(false);
  const summary = ref<IndexCatalogSyncSummary | null>(null);
  const lastSyncAt = ref<string | null>(null);

  function start() {
    if (syncing.value) return;
    syncing.value = true;
    finished.value = false;
    summary.value = null;

    sse.start(indexCatalogApi.syncRunUrl(), {
      onEvent(event) {
        if (event.type === 'done') {
          summary.value = (event.summary ?? null) as IndexCatalogSyncSummary | null;
          finished.value = true;
          syncing.value = false;
          lastSyncAt.value = new Date().toISOString();
          message.success(event.message || '同步完成');
        } else if (event.type === 'error') {
          syncing.value = false;
          message.error(event.message || '同步失败');
        }
      },
      onClose() {
        syncing.value = false;
      },
      onError() {
        syncing.value = false;
        message.error('SSE 连接异常');
      },
    });
  }

  function stop() {
    sse.stop();
    syncing.value = false;
  }

  return { sse, syncing, finished, summary, lastSyncAt, start, stop };
}
```

注意：`useSSE` 的具体 API（onEvent/onClose/onError 还是别的命名）以现有 `useMoneyFlowSync.ts` 为准——实现时严格对齐。

- [ ] **Step 3: 类型检查**

```powershell
pnpm --filter @cryptotrading/web typecheck
```

预期：无错误。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/sync/useIndexCatalogSync.ts
git commit -m "feat(web/index-catalog): 新增 useIndexCatalogSync composable"
```

---

## Task 13: 前端 SyncView 卡片

**Files:**
- Modify: `apps/web/src/views/sync/SyncView.vue`

- [ ] **Step 1: 阅读 SyncView 现有"资金流向"卡片结构**

```powershell
grep -n "资金流向\|moneyFlow\|MoneyFlow" apps/web/src/views/sync/SyncView.vue | head -20
```

记录卡片所在区段（例如 L73-130），找到其紧邻 `</div>` 闭合位置。

- [ ] **Step 2: 在资金流向卡片之后插入新卡片**

`apps/web/src/views/sync/SyncView.vue` script setup 区追加 import：

```typescript
import { useIndexCatalogSync } from '@/components/sync/useIndexCatalogSync';

const indexCatalog = useIndexCatalogSync();
```

template 中（资金流向卡片 `</div>` 之后）追加：

```vue
<div class="data-source-card">
  <div class="data-source-header">
    <h3>行业/概念目录与成分股</h3>
    <p class="desc">
      同步同花顺行业指数（type=I）和概念指数（type=N）目录，并刷新各板块的成分股关系。
    </p>
  </div>
  <div class="data-source-body">
    <div v-if="indexCatalog.lastSyncAt.value" class="last-sync">
      上次同步：{{ indexCatalog.lastSyncAt.value }}
    </div>

    <div v-if="indexCatalog.syncing.value" class="progress-inline">
      <div class="progress-phase">{{ indexCatalog.sse.lastPhase?.value || '准备中…' }}</div>
      <n-progress
        :percentage="indexCatalog.sse.percent?.value ?? 0"
        :show-indicator="true"
        type="line"
      />
      <div class="progress-msg">{{ indexCatalog.sse.lastMessage?.value }}</div>
    </div>

    <div v-if="indexCatalog.finished.value && indexCatalog.summary.value" class="summary-list">
      <div class="summary-row">
        <span>行业目录</span>
        <span>success={{ indexCatalog.summary.value.industryCatalog.success }}, errors={{ indexCatalog.summary.value.industryCatalog.errors.length }}</span>
      </div>
      <div class="summary-row">
        <span>概念目录</span>
        <span>success={{ indexCatalog.summary.value.conceptCatalog.success }}, errors={{ indexCatalog.summary.value.conceptCatalog.errors.length }}</span>
      </div>
      <div class="summary-row">
        <span>行业成分股</span>
        <span>success={{ indexCatalog.summary.value.industryMembers.success }}, errors={{ indexCatalog.summary.value.industryMembers.errors.length }}</span>
      </div>
      <div class="summary-row">
        <span>概念成分股</span>
        <span>success={{ indexCatalog.summary.value.conceptMembers.success }}, errors={{ indexCatalog.summary.value.conceptMembers.errors.length }}</span>
      </div>
      <div class="summary-row">
        <span>孤儿清理</span>
        <span>deleted={{ indexCatalog.summary.value.cleanup.success }}</span>
      </div>
    </div>
  </div>
  <div class="data-source-actions">
    <n-button
      type="primary"
      :loading="indexCatalog.syncing.value"
      :disabled="indexCatalog.syncing.value"
      @click="indexCatalog.start()"
    >
      开始同步
    </n-button>
  </div>
</div>
```

注意：`sse.lastPhase` / `sse.percent` / `sse.lastMessage` 的字段名以 `useMoneyFlowSync` 中 `useSSE` 实际暴露字段为准——实现时**先 grep**再写，不要照抄。

- [ ] **Step 3: 复用现有 .data-source-card 样式**

不新增 SCSS 类（除非 `.progress-inline` / `.summary-list` 在现有样式中不存在）。如需新增，参考"加密货币"卡片的 inline progress 样式块复制粘贴并调整类名。

- [ ] **Step 4: 类型检查 + 构建**

```powershell
pnpm --filter @cryptotrading/web typecheck
pnpm --filter @cryptotrading/web build
```

- [ ] **Step 5: 浏览器手动验证（CLAUDE.md "UI 改动需浏览器验证"）**

```powershell
pnpm --filter @cryptotrading/web dev
```

打开 SyncView 页面：

1. 卡片显示在"资金流向"之后，标题、描述、按钮齐全
2. 点击"开始同步"：按钮变 loading，进度区出现并实时滚动 phase + percent
3. 完成后：summary 区显示 5 行结果，按钮恢复
4. 控制台无报错

记录验证结果（截图或文字描述），后续 PR 粘贴。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/views/sync/SyncView.vue
git commit -m "feat(web/index-catalog): SyncView 新增行业/概念目录同步卡片"
```

---

## Task 14: 全局回归 + 文档化验证清单

**Files:** 无新增（验证 + 必要时 hotfix）

- [ ] **Step 1: 后端整体单测**

```powershell
pnpm --filter @cryptotrading/server test
```

预期：全部通过；如有未受影响的既有失败，单独标注并修复（不属本次范围则忽略）。

- [ ] **Step 2: 前端整体类型检查与构建**

```powershell
pnpm --filter @cryptotrading/web typecheck
pnpm --filter @cryptotrading/web build
```

- [ ] **Step 3: 资金流向同步回归（再做一次确认）**

启动后端 + 前端，触发资金流向同步：
- 后端日志中**禁止**出现 `ths_member`、`syncMembers` 字样
- SyncView 页面"资金流向"卡片行为不变

- [ ] **Step 4: 验证清单逐项打勾**

参照 spec [docs/superpowers/specs/2026-05-11-index-catalog-sync-design.md](docs/superpowers/specs/2026-05-11-index-catalog-sync-design.md) 末尾的验证清单，逐项勾选并记录到 PR 描述。

- [ ] **Step 5: 最终提交（如有 hotfix）**

如全程无新代码改动则跳过；否则：

```bash
git commit -m "chore(index-catalog): 回归验证修订"
```

---

## 实施完成后

调用 `finishing-a-development-branch` 技能决定后续 PR/合并流程。
