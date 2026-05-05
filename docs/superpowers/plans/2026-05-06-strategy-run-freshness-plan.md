# 策略条件运行与新鲜度管理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将策略条件运行入口从标的筛选页面迁移到策略条件管理页面，实现运行进度轮询、结果持久化和数据新鲜度展示。

**Architecture:** 新增 `StrategyConditionRunEntity` 和 `StrategyConditionHitEntity` 两张表存储运行记录与命中结果，重构 `run` 方法为分批扫描模式以支持进度更新，前端通过 500ms 轮询查询进度，标的筛选页面移除 StrategyConditionPicker 后新增「策略命中」多选筛选条件。

**Tech Stack:** NestJS + TypeORM + PostgreSQL, Vue 3 + Naive UI + Pinia

---

## 文件结构

```
新建:
  apps/server/src/entities/strategy-condition-run.entity.ts   -- Run 实体
  apps/server/src/entities/strategy-condition-hit.entity.ts   -- Hit 实体

修改:
  apps/server/src/entities/strategy-condition.entity.ts       -- 添加 lastRunId 字段
  apps/server/src/strategy-conditions/strategy-conditions.module.ts -- 注册新实体
  apps/server/src/strategy-conditions/strategy-conditions.controller.ts -- 新增端点
  apps/server/src/strategy-conditions/strategy-conditions.service.ts -- 重构 run + 新增方法
  apps/web/src/api/modules/strategyConditions.ts              -- 新增 API 类型和方法
  apps/web/src/stores/strategyConditions.ts                   -- 新增进度/状态管理
  apps/web/src/views/StrategyConditionsView.vue               -- 新增状态列/运行按钮/进度
  apps/web/src/components/symbols/CryptoSymbolsPanel.vue      -- 移除 Picker + 新增策略命中筛选
  apps/web/src/components/symbols/ASharesPanel.vue            -- 移除 Picker + 新增策略命中筛选
  apps/web/src/components/symbols/common/StrategyConditionPicker.vue -- 删除或废弃
  apps/server/src/catalog/symbols/symbols.service.ts          -- querySymbols 新增 strategyHitIds
  apps/server/src/market-data/a-shares/a-shares.types.ts      -- QueryASharesDto 新增 strategyHitIds
  apps/server/src/market-data/a-shares/data-access/a-shares-query.sql.ts -- 新增 strategyHitIds 筛选逻辑
  apps/web/src/api/modules/symbols.ts                         -- SymbolQueryBody 新增 strategyHitIds
  apps/web/src/api/modules/aShares.ts                         -- AShareQueryBody 新增 strategyHitIds
```

---

### Task 1: 数据库 Entity 创建

**Files:**
- Create: `apps/server/src/entities/strategy-condition-run.entity.ts`
- Create: `apps/server/src/entities/strategy-condition-hit.entity.ts`
- Modify: `apps/server/src/entities/strategy-condition.entity.ts`
- Modify: `apps/server/src/strategy-conditions/strategy-conditions.module.ts`

- [ ] **Step 1: 创建 Run Entity**

```typescript
// apps/server/src/entities/strategy-condition-run.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { StrategyConditionEntity } from './strategy-condition.entity';

@Entity('strategy_condition_runs')
export class StrategyConditionRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'condition_id' })
  conditionId: string;

  @Column({ type: 'varchar', length: 36, name: 'user_id' })
  userId: string;

  @Column({ type: 'varchar', length: 20, default: 'running' })
  status: 'running' | 'completed' | 'failed';

  @Column({ type: 'int', default: 0, name: 'progress_scanned' })
  progressScanned: number;

  @Column({ type: 'int', default: 0, name: 'progress_total' })
  progressTotal: number;

  @Column({ type: 'int', default: 0, name: 'total_hits' })
  totalHits: number;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt: Date | null;

  @ManyToOne(() => StrategyConditionEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'condition_id' })
  condition: StrategyConditionEntity;
}
```

- [ ] **Step 2: 创建 Hit Entity**

```typescript
// apps/server/src/entities/strategy-condition-hit.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { StrategyConditionRunEntity } from './strategy-condition-run.entity';

@Entity('strategy_condition_hits')
export class StrategyConditionHitEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId: string;

  @Column({ type: 'varchar', length: 30, name: 'ts_code' })
  tsCode: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name: string | null;

  @Column({ type: 'jsonb', default: '[]', name: 'matched_conditions' })
  matchedConditions: string[];

  @ManyToOne(() => StrategyConditionRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: StrategyConditionRunEntity;
}
```

- [ ] **Step 3: 修改 StrategyConditionEntity 添加 lastRunId**

```typescript
// 在 apps/server/src/entities/strategy-condition.entity.ts 中，
// 在 updatedAt 字段之后添加：

  @Column({ type: 'uuid', nullable: true, name: 'last_run_id' })
  lastRunId: string | null;

  @ManyToOne(() => StrategyConditionRunEntity, { nullable: true })
  @JoinColumn({ name: 'last_run_id' })
  lastRun: StrategyConditionRunEntity | null;
```

同时在文件顶部添加 import：
```typescript
import { StrategyConditionRunEntity } from './strategy-condition-run.entity';
```

- [ ] **Step 4: 注册新实体到模块**

```typescript
// apps/server/src/strategy-conditions/strategy-conditions.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategyConditionEntity } from '../entities/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy-condition-hit.entity';
import { StrategyConditionsController } from './strategy-conditions.controller';
import { StrategyConditionsService } from './strategy-conditions.service';

@Module({
  imports: [TypeOrmModule.forFeature([
    StrategyConditionEntity,
    StrategyConditionRunEntity,
    StrategyConditionHitEntity,
  ])],
  controllers: [StrategyConditionsController],
  providers: [StrategyConditionsService],
  exports: [StrategyConditionsService],
})
export class StrategyConditionsModule {}
```

- [ ] **Step 5: 执行数据库迁移**

```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
ALTER TABLE strategy_conditions ADD COLUMN IF NOT EXISTS last_run_id UUID;

CREATE TABLE IF NOT EXISTS strategy_condition_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_id UUID NOT NULL REFERENCES strategy_conditions(id) ON DELETE CASCADE,
  user_id VARCHAR(36) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  progress_scanned INT DEFAULT 0,
  progress_total INT DEFAULT 0,
  total_hits INT DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_strategy_condition_runs_condition_id ON strategy_condition_runs(condition_id);
CREATE INDEX IF NOT EXISTS idx_strategy_condition_runs_user_id ON strategy_condition_runs(user_id);

CREATE TABLE IF NOT EXISTS strategy_condition_hits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES strategy_condition_runs(id) ON DELETE CASCADE,
  ts_code VARCHAR(30) NOT NULL,
  name VARCHAR(100),
  matched_conditions JSONB DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_strategy_condition_hits_run_id ON strategy_condition_hits(run_id);
CREATE INDEX IF NOT EXISTS idx_strategy_condition_hits_ts_code ON strategy_condition_hits(ts_code);
"
```

- [ ] **Step 6: 验证后端编译通过**

```bash
cd c:\codes\cryptotrading; npx nest build --path apps/server 2>&1 | Select-Object -Last 20
```

预期: 编译成功，无 TypeScript 错误。

---

### Task 2: 后端 Service 重构（分批运行 + 进度持久化 + 新鲜度）

**Files:**
- Modify: `apps/server/src/strategy-conditions/strategy-conditions.service.ts`

- [ ] **Step 1: 更新构造函数注入新 Repository**

```typescript
// 在 StrategyConditionsService 构造函数中，替换为：
constructor(
  @InjectRepository(StrategyConditionEntity)
  private readonly repo: Repository<StrategyConditionEntity>,
  @InjectRepository(StrategyConditionRunEntity)
  private readonly runRepo: Repository<StrategyConditionRunEntity>,
  @InjectRepository(StrategyConditionHitEntity)
  private readonly hitRepo: Repository<StrategyConditionHitEntity>,
  @InjectDataSource()
  private readonly dataSource: DataSource,
) {}
```

添加新 import：
```typescript
import { StrategyConditionRunEntity } from '../entities/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy-condition-hit.entity';
```

- [ ] **Step 2: 实现 `countTotalSymbols` 私有方法**

在类中添加：
```typescript
private async countTotalSymbols(targetType: string): Promise<number> {
  if (targetType === 'a-share') {
    const rows = await this.dataSource.query<Array<{ count: string }>>(`
      SELECT COUNT(*) FROM a_share_symbols WHERE list_status = 'L'
    `);
    return parseInt(rows[0].count, 10);
  } else {
    const rows = await this.dataSource.query<Array<{ count: string }>>(`
      SELECT COUNT(DISTINCT symbol) FROM klines WHERE interval = '1d'
    `);
    return parseInt(rows[0].count, 10);
  }
}
```

- [ ] **Step 3: 实现 `scanBatch` 私有方法**

```typescript
private async scanBatch(
  condition: StrategyConditionEntity,
  offset: number,
  limit: number,
): Promise<Array<{ tsCode: string; name: string; matchedConditions: string[] }>> {
  const { conditions, targetType } = condition;
  if (conditions.length === 0) return [];

  const conditionDescriptions = conditions.map(c => {
    if (c.compareField) return `${c.field} ${c.operator} ${c.compareField}`;
    return `${c.field} ${c.operator} ${c.value}`;
  });

  let query: string;
  if (targetType === 'a-share') {
    const whereClause = this.buildAShareQuery(conditions);
    query = `
      SELECT s.ts_code as "tsCode", s.name
      FROM a_share_symbols s
      JOIN a_share_daily_indicators i ON s.ts_code = i.ts_code
      WHERE i.trade_date = (SELECT MAX(trade_date) FROM a_share_daily_indicators)
        AND s.list_status = 'L'
        AND ${whereClause}
      ORDER BY s.ts_code
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    const whereClause = this.buildCryptoQuery(conditions);
    query = `
      SELECT k.symbol as "tsCode", k.symbol as name
      FROM klines k
      WHERE k.interval = '1d'
        AND k.open_time = (
          SELECT MAX(open_time) FROM klines WHERE symbol = k.symbol AND interval = '1d'
        )
        AND ${whereClause}
      ORDER BY k.symbol
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  const result = await this.dataSource.query(query);
  return result.map((row: any) => ({
    tsCode: row.tsCode,
    name: row.name,
    matchedConditions: conditionDescriptions,
  }));
}
```

- [ ] **Step 4: 重构 `run` 方法为分批扫描 + 进度持久化**

将现有的 `run` 方法完整替换为：
```typescript
async run(id: string, userId: string): Promise<{ runId: string }> {
  const entity = await this.findOne(id, userId);

  // 检查是否有正在运行的任务
  const existing = await this.runRepo.findOne({
    where: { conditionId: entity.id, status: 'running' },
  });
  if (existing) {
    throw new ConflictException('该策略条件已有运行中的任务');
  }

  // 删除该条件之前的运行记录（级联删除 hits）
  await this.runRepo.delete({ conditionId: entity.id });

  // 创建新的运行记录
  const run = this.runRepo.create({
    conditionId: entity.id,
    userId,
    status: 'running',
    progressScanned: 0,
    progressTotal: 0,
  });
  await this.runRepo.save(run);

  // 更新条件的 last_run_id
  await this.repo.update(entity.id, { lastRunId: run.id });

  // 异步执行扫描
  this.executeRun(entity, run.id).catch(err => {
    console.error('Strategy run failed:', err);
  });

  return { runId: run.id };
}
```

需要添加 `ConflictException` 的 import：
```typescript
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
```

- [ ] **Step 5: 实现 `executeRun` 异步执行方法**

```typescript
private async executeRun(condition: StrategyConditionEntity, runId: string): Promise<void> {
  try {
    const total = await this.countTotalSymbols(condition.targetType);
    await this.runRepo.update(runId, { progressTotal: total });

    const batchSize = 100;
    const allHits: Array<{ tsCode: string; name: string; matchedConditions: string[] }> = [];

    for (let offset = 0; offset < total; offset += batchSize) {
      const batch = await this.scanBatch(condition, offset, batchSize);
      allHits.push(...batch);
      await this.runRepo.update(runId, {
        progressScanned: Math.min(offset + batchSize, total),
      });
    }

    // 批量保存命中结果
    if (allHits.length > 0) {
      const hitEntities = allHits.map(hit => this.hitRepo.create({
        runId,
        tsCode: hit.tsCode,
        name: hit.name,
        matchedConditions: hit.matchedConditions,
      }));
      await this.hitRepo.save(hitEntities);
    }

    // 标记完成
    await this.runRepo.update(runId, {
      status: 'completed',
      totalHits: allHits.length,
      completedAt: new Date(),
    });
  } catch (error: any) {
    await this.runRepo.update(runId, {
      status: 'failed',
      errorMessage: error?.message ?? String(error),
    });
  }
}
```

- [ ] **Step 6: 实现进度查询方法**

```typescript
async getRunProgress(conditionId: string, userId: string): Promise<{
  runId: string;
  status: string;
  progressScanned: number;
  progressTotal: number;
  totalHits: number;
  errorMessage: string | null;
}> {
  await this.findOne(conditionId, userId); // 确保存在且属于当前用户
  const run = await this.runRepo.findOne({
    where: { conditionId, userId },
    order: { createdAt: 'DESC' },
  });
  if (!run) {
    throw new NotFoundException('No run record found');
  }
  return {
    runId: run.id,
    status: run.status,
    progressScanned: run.progressScanned,
    progressTotal: run.progressTotal,
    totalHits: run.totalHits,
    errorMessage: run.errorMessage,
  };
}
```

- [ ] **Step 7: 实现命中结果查询方法**

```typescript
async getRunResult(conditionId: string, userId: string): Promise<{
  hits: Array<{ tsCode: string; name: string; matchedConditions: string[] }>;
  totalHits: number;
}> {
  await this.findOne(conditionId, userId);
  const run = await this.runRepo.findOne({
    where: { conditionId, userId, status: 'completed' },
    order: { createdAt: 'DESC' },
  });
  if (!run) {
    return { hits: [], totalHits: 0 };
  }
  const hits = await this.hitRepo.find({ where: { runId: run.id } });
  return {
    hits: hits.map(h => ({
      tsCode: h.tsCode,
      name: h.name ?? '',
      matchedConditions: h.matchedConditions,
    })),
    totalHits: run.totalHits,
  };
}
```

- [ ] **Step 8: 实现批量新鲜度查询方法**

```typescript
async getLastRunStatus(userId: string): Promise<Array<{
  conditionId: string;
  freshness: 'fresh' | 'stale' | 'never' | 'running' | 'failed';
  lastRunAt: string | null;
  totalHits: number;
}>> {
  const conditions = await this.repo.find({ where: { userId } });
  if (conditions.length === 0) return [];

  // 批量获取运行记录
  const runIds = conditions
    .map(c => c.lastRunId)
    .filter((id): id is string => id != null);

  const runs = runIds.length > 0
    ? await this.runRepo.findByIds(runIds)
    : [];

  const runMap = new Map(runs.map(r => [r.id, r]));

  // 获取数据最新更新时间
  const [cryptoMax] = await this.dataSource.query<Array<{ max: Date | null }>>(`
    SELECT MAX(open_time) as max FROM klines WHERE interval = '1d'
  `);
  const [aShareMax] = await this.dataSource.query<Array<{ max: string | null }>>(`
    SELECT MAX(trade_date) as max FROM a_share_daily_indicators
  `);

  return conditions.map(c => {
    const run = c.lastRunId ? runMap.get(c.lastRunId) : undefined;
    if (!run) return { conditionId: c.id, freshness: 'never' as const, lastRunAt: null, totalHits: 0 };
    if (run.status === 'running') return { conditionId: c.id, freshness: 'running' as const, lastRunAt: run.createdAt.toISOString(), totalHits: 0 };
    if (run.status === 'failed') return { conditionId: c.id, freshness: 'failed' as const, lastRunAt: run.createdAt.toISOString(), totalHits: 0 };

    const dataUpdateTime = c.targetType === 'crypto'
      ? (cryptoMax?.max ?? new Date(0))
      : (aShareMax?.max ? new Date(aShareMax.max) : new Date(0));

    return {
      conditionId: c.id,
      freshness: run.completedAt && run.completedAt >= dataUpdateTime ? 'fresh' as const : 'stale' as const,
      lastRunAt: run.completedAt?.toISOString() ?? run.createdAt.toISOString(),
      totalHits: run.totalHits,
    };
  });
}
```

- [ ] **Step 9: 验证后端编译通过**

```bash
cd c:\codes\cryptotrading; npx nest build --path apps/server 2>&1 | Select-Object -Last 20
```

预期: 编译成功，无 TypeScript 错误。

---

### Task 3: 后端 Controller 新增端点

**Files:**
- Modify: `apps/server/src/strategy-conditions/strategy-conditions.controller.ts`

- [ ] **Step 1: 新增进度、结果、批量状态端点**

在 Controller 中添加以下方法（保留现有端点不变）：

```typescript
@Get('last-run-status')
getLastRunStatus(@Request() req: any) {
  return this.service.getLastRunStatus(req.user.id);
}

@Get(':id/run/progress')
getRunProgress(@Request() req: any, @Param('id') id: string) {
  return this.service.getRunProgress(id, req.user.id);
}

@Get(':id/run/result')
getRunResult(@Request() req: any, @Param('id') id: string) {
  return this.service.getRunResult(id, req.user.id);
}
```

**注意：** 新的 `GET last-run-status` 端点必须放在 `GET :id` 之前，否则 NestJS 会把 `last-run-status` 当作 `:id` 解析。

最终的 Controller 方法顺序应为：
1. `POST /` — create
2. `GET /last-run-status` — getLastRunStatus（在 `:id` 之前）
3. `GET /` — findAll
4. `GET /:id` — findOne
5. `PUT /:id` — update
6. `DELETE /:id` — remove
7. `POST /:id/run` — run
8. `GET /:id/run/progress` — getRunProgress
9. `GET /:id/run/result` — getRunResult

- [ ] **Step 2: 验证后端编译通过**

```bash
cd c:\codes\cryptotrading; npx nest build --path apps/server 2>&1 | Select-Object -Last 20
```

预期: 编译成功。

---

### Task 4: 前端 API 层更新

**Files:**
- Modify: `apps/web/src/api/modules/strategyConditions.ts`

- [ ] **Step 1: 新增类型定义和方法**

在文件末尾（`strategyConditionsApi` 对象之前）添加新接口：

```typescript
export interface RunProgress {
  runId: string;
  status: 'running' | 'completed' | 'failed';
  progressScanned: number;
  progressTotal: number;
  totalHits: number;
  errorMessage: string | null;
}

export interface RunResultDetail {
  hits: Array<{
    tsCode: string;
    name: string;
    matchedConditions: string[];
  }>;
  totalHits: number;
}

export interface LastRunStatus {
  conditionId: string;
  freshness: 'fresh' | 'stale' | 'never' | 'running' | 'failed';
  lastRunAt: string | null;
  totalHits: number;
}
```

在 `strategyConditionsApi` 对象中添加新方法：

```typescript
startRun(id: string) {
  return post<{ runId: string }>(`${API_BASE}/strategy-conditions/${id}/run`);
},

getRunProgress(id: string) {
  return request<RunProgress>(`${API_BASE}/strategy-conditions/${id}/run/progress`);
},

getRunResult(id: string) {
  return request<RunResultDetail>(`${API_BASE}/strategy-conditions/${id}/run/result`);
},

getLastRunStatus() {
  return request<LastRunStatus[]>(`${API_BASE}/strategy-conditions/last-run-status`);
},
```

---

### Task 5: 前端 Store 更新

**Files:**
- Modify: `apps/web/src/stores/strategyConditions.ts`

- [ ] **Step 1: 添加进度和状态管理**

替换整个 Store 文件内容：

```typescript
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { strategyConditionsApi } from '../api/modules/strategyConditions';
import type { StrategyCondition, RunProgress, LastRunStatus } from '../api/modules/strategyConditions';

export const useStrategyConditionsStore = defineStore('strategyConditions', () => {
  const conditions = ref<StrategyCondition[]>([]);
  const runStatuses = ref<Map<string, LastRunStatus>>(new Map());
  const runProgress = ref<Map<string, RunProgress>>(new Map());
  const loading = ref(false);
  const runningId = ref<string | null>(null);

  const getConditionsByTargetType = (targetType: 'crypto' | 'a-share') =>
    conditions.value.filter(c => c.targetType === targetType);

  async function fetchConditions(targetType?: string) {
    loading.value = true;
    try {
      const data = await strategyConditionsApi.findAll(targetType);
      conditions.value = data;
    } finally {
      loading.value = false;
    }
  }

  async function fetchLastRunStatus() {
    const data = await strategyConditionsApi.getLastRunStatus();
    runStatuses.value = new Map(data.map(s => [s.conditionId, s]));
  }

  async function createCondition(dto: {
    name: string;
    targetType: 'crypto' | 'a-share';
    conditions: any[];
  }) {
    const data = await strategyConditionsApi.create(dto);
    conditions.value.unshift(data);
    return data;
  }

  async function updateCondition(id: string, dto: { name?: string; conditions?: any[] }) {
    const data = await strategyConditionsApi.update(id, dto);
    const index = conditions.value.findIndex(c => c.id === id);
    if (index !== -1) conditions.value[index] = data;
    return data;
  }

  async function deleteCondition(id: string) {
    await strategyConditionsApi.remove(id);
    conditions.value = conditions.value.filter(c => c.id !== id);
    runStatuses.value.delete(id);
    runProgress.value.delete(id);
  }

  async function startRun(id: string) {
    runningId.value = id;
    try {
      const { runId } = await strategyConditionsApi.startRun(id);
      // 开始轮询
      const poll = setInterval(async () => {
        try {
          const progress = await strategyConditionsApi.getRunProgress(id);
          runProgress.value.set(id, progress);

          if (progress.status === 'completed' || progress.status === 'failed') {
            clearInterval(poll);
            runningId.value = null;
            // 刷新新鲜度状态
            await fetchLastRunStatus();
          }
        } catch {
          clearInterval(poll);
          runningId.value = null;
        }
      }, 500);

      // 安全：30 秒超时
      setTimeout(() => {
        clearInterval(poll);
        if (runningId.value === id) runningId.value = null;
      }, 30000);

      return { runId };
    } catch {
      runningId.value = null;
      throw new Error('启动运行失败');
    }
  }

  return {
    conditions,
    runStatuses,
    runProgress,
    loading,
    runningId,
    getConditionsByTargetType,
    fetchConditions,
    fetchLastRunStatus,
    createCondition,
    updateCondition,
    deleteCondition,
    startRun,
  };
});
```

---

### Task 6: 策略条件管理页面改造

**Files:**
- Modify: `apps/web/src/views/StrategyConditionsView.vue`

- [ ] **Step 1: 新增状态列和运行按钮**

在表格列定义 `columns` 数组中的「操作」列之前插入两个新列：

```typescript
// 在 columns 数组中，在「条件数」列之后、「操作」列之前插入：

{
  title: '状态',
  key: 'status',
  width: 100,
  render(row: StrategyCondition) {
    const status = store.runStatuses.get(row.id);
    if (!status || status.freshness === 'never') {
      return h(NTag, { type: 'default', size: 'small' }, { default: () => '未运行' });
    }
    if (status.freshness === 'running') {
      return h(NTag, { type: 'info', size: 'small' }, { default: () => '运行中' });
    }
    if (status.freshness === 'failed') {
      return h(NTag, { type: 'error', size: 'small' }, { default: () => '失败' });
    }
    if (status.freshness === 'fresh') {
      return h(NTag, { type: 'success', size: 'small' }, { default: () => '最新' });
    }
    return h(NTag, { type: 'warning', size: 'small' }, { default: () => '过期' });
  },
},
```

替换「操作」列为：

```typescript
{
  title: '操作',
  key: 'actions',
  render(row: StrategyCondition) {
    const isRunning = store.runningId === row.id;
    const progress = store.runProgress.get(row.id);

    return h(NSpace, { vertical: true, size: 4 }, {
      default: () => [
        h(NSpace, { size: 4 }, {
          default: () => [
            // 运行按钮
            h(NButton, {
              size: 'small',
              type: 'primary',
              loading: isRunning,
              disabled: isRunning,
              onClick: () => store.startRun(row.id),
            }, {
              default: () => isRunning ? '运行中' : '运行',
            }),
            // 编辑按钮
            h(NButton, {
              size: 'small',
              onClick: () => {
                editingId.value = row.id;
                showBuilder.value = true;
              },
            }, {
              icon: () => h(NIcon, null, { default: () => h(EditIcon) }),
              default: () => '编辑',
            }),
            // 删除按钮
            h(NPopconfirm, {
              onPositiveClick: () => store.deleteCondition(row.id),
            }, {
              trigger: () => h(NButton, {
                size: 'small',
                type: 'error',
              }, {
                icon: () => h(NIcon, null, { default: () => h(TrashIcon) }),
                default: () => '删除',
              }),
              default: () => '确定删除该条件组？',
            }),
          ],
        }),
        // 进度条（运行中显示）
        isRunning && progress
          ? h('div', { style: { width: '100%', display: 'flex', alignItems: 'center', gap: '8px' } }, [
              h('span', { style: { fontSize: '12px', color: '#666' } },
                `扫描 ${progress.progressScanned}/${progress.progressTotal}`),
            ])
          : null,
        // 查看结果链接（已完成且命中 > 0）
        !isRunning && progress && progress.status === 'completed' && progress.totalHits > 0
          ? h('a', {
              style: { fontSize: '12px' },
              href: '/symbols',
              onClick: (e: Event) => {
                e.preventDefault();
                window.open('/symbols', '_blank');
              },
            }, `查看 ${progress.totalHits} 个命中结果`)
          : null,
      ],
    });
  },
},
```

- [ ] **Step 2: 添加 onMounted 加载新鲜度状态**

在 `onMounted` 中，`store.fetchConditions()` 之后添加：
```typescript
onMounted(() => {
  store.fetchConditions();
  store.fetchLastRunStatus();
});
```

- [ ] **Step 3: 验证前端编译通过**

```bash
cd c:\codes\cryptotrading\apps\web; npx vue-tsc --noEmit 2>&1 | Select-Object -Last 20
```

---

### Task 7: 删除 StrategyConditionPicker + 改造标的筛选页面

**Files:**
- Modify: `apps/web/src/components/symbols/CryptoSymbolsPanel.vue`
- Modify: `apps/web/src/components/symbols/ASharesPanel.vue`

- [ ] **Step 1: CryptoSymbolsPanel — 移除 Picker，新增策略命中筛选**

移除 template 中：
```html
<strategy-condition-picker
  target-type="crypto"
  @run="handleStrategyRun"
/>
```

在 filter-card 的 filter-row 中，tag 筛选之后、NumericConditionFilter 之前，添加策略命中多选：
```html
<n-select
  v-model:value="selectedStrategyIds"
  :options="strategyFilterOptions"
  multiple
  filterable
  placeholder="策略命中"
  clearable
  style="width: 200px"
  @update:value="applyFilters"
/>
```

在 script 中：
- 移除 `import StrategyConditionPicker from './common/StrategyConditionPicker.vue'`
- 移除 `const strategyRunResults = ref<Map<string, any>>(new Map())`
- 移除 `function handleStrategyRun`
- 添加 `import { strategyConditionsApi } from '@/api/modules/strategyConditions'`

添加：
```typescript
const selectedStrategyIds = ref<string[]>([])
const strategyFilterOptions = computed(() => {
  return store.getConditionsByTargetType('crypto')
    .filter(c => {
      const status = store.runStatuses.get(c.id)
      return status && status.freshness === 'fresh'
    })
    .map(c => ({
      label: `${c.name} (${store.runStatuses.get(c.id)?.totalHits ?? 0} 命中)`,
      value: c.id,
    }))
})

// 保留 strategyStore 用于买入信号列
const strategyStore = useStrategyConditionsStore()
```

- [ ] **Step 2: CryptoSymbolsPanel — 添加命中结果缓存和买入信号列**

添加命中结果缓存（tsCode → 条件名集合），在 onMounted 和策略选择变化时更新：

```typescript
// 命中结果缓存: tsCode → Set<conditionName>
const hitLookup = ref<Map<string, Set<string>>>(new Map())

// 加载命中结果缓存
async function loadHitLookup() {
  const newLookup = new Map<string, Set<string>>()
  for (const condition of strategyStore.conditions) {
    if (condition.targetType !== 'crypto') continue
    const status = strategyStore.runStatuses.get(condition.id)
    if (!status || status.freshness !== 'fresh') continue
    try {
      const result = await strategyConditionsApi.getRunResult(condition.id)
      for (const hit of result.hits) {
        const names = newLookup.get(hit.tsCode) ?? new Set<string>()
        names.add(condition.name)
        newLookup.set(hit.tsCode, names)
      }
    } catch { /* ignore */ }
  }
  hitLookup.value = newLookup
}
```

买入信号列：
```typescript
render: (row: SymbolRow) => {
  const matchedNames = hitLookup.value.get(row.symbol)
  if (!matchedNames || matchedNames.size === 0) return '-'
  return h(NSpace, { size: 4 }, {
    default: () => [...matchedNames].map(name =>
      h(NTag, { type: 'success', size: 'small' }, { default: () => name })),
  })
},
```

- [ ] **Step 3: CryptoSymbolsPanel — 更新 buildQuery 添加 strategyHitIds**

```typescript
const buildQuery = () => ({
  interval: selectedInterval.value,
  q: searchQuery.value,
  conditions: conditions.value,
  watchlistIds: watchlistIds.value,
  strategyHitIds: selectedStrategyIds.value,
  sort: { field: sortKey.value ?? 'symbol', asc: sortOrder.value !== 'descend' },
  page: page.value,
  page_size: pageSize.value,
})
```

- [ ] **Step 4: CryptoSymbolsPanel — onMounted 加载状态**

```typescript
onMounted(async () => {
  void ensureWatchlistsLoaded()
  void loadFields()
  void loadColumnPreferences().catch(...)
  void loadData()
  await strategyStore.fetchConditions('crypto')
  await strategyStore.fetchLastRunStatus()
  await loadHitLookup()
})
```

注意：`onMounted` 回调需要改为 `async`。

- [ ] **Step 5: ASharesPanel — 同样的改造**

参照 Steps 1-4，对 ASharesPanel 做同样改造（targetType 为 `'a-share'`）。

移除：
```html
<strategy-condition-picker
  target-type="a-share"
  @run="handleStrategyRun"
/>
```
移除 `import StrategyConditionPicker`、`strategyRunResults`、`handleStrategyRun`。

在 ASharesFilters 组件内部或 ASharesPanel 中新增 `n-select` 策略命中多选，将 `selectedStrategyIds` 传递给查询。

- [ ] **Step 6: 验证前端编译通过**

```bash
cd c:\codes\cryptotrading\apps\web; npx vue-tsc --noEmit 2>&1 | Select-Object -Last 20
```

---

### Task 8: 后端标的筛选 API 集成 strategyHitIds

**Files:**
- Modify: `apps/server/src/catalog/symbols/symbols.service.ts`
- Modify: `apps/server/src/market-data/a-shares/a-shares.types.ts`
- Modify: `apps/server/src/market-data/a-shares/data-access/a-shares-query.sql.ts`

- [ ] **Step 1: symbols.service.ts — QuerySymbolsDto 添加 strategyHitIds**

在 `QuerySymbolsDto` interface 中添加：
```typescript
strategyHitIds?: string[];
```

- [ ] **Step 2: symbols.service.ts — querySymbols 添加策略命中筛选逻辑**

在 `watchlistIds` 筛选逻辑之后（大约 line 137），添加：
```typescript
if (dto.strategyHitIds && dto.strategyHitIds.length > 0) {
  sql += ` AND k.symbol IN (
    SELECT DISTINCT h.ts_code
    FROM strategy_condition_hits h
    JOIN strategy_condition_runs r ON h.run_id = r.id
    JOIN strategy_conditions c ON c.last_run_id = r.id
    WHERE c.id = ANY($${pi}::uuid[])
      AND r.status = 'completed'
  )`;
  params.push(dto.strategyHitIds);
  pi++;
}
```

- [ ] **Step 3: a-shares.types.ts — QueryASharesDto 添加 strategyHitIds**

```typescript
strategyHitIds?: string[];
```

- [ ] **Step 4: a-shares-query.sql.ts — buildASharesBaseQuery 添加策略命中筛选**

在 `watchlistIds` 筛选逻辑之后（大约 line 164），添加：
```typescript
if (dto.strategyHitIds && dto.strategyHitIds.length > 0) {
  sql += ` AND s.ts_code IN (
    SELECT DISTINCT h.ts_code
    FROM strategy_condition_hits h
    JOIN strategy_condition_runs r ON h.run_id = r.id
    JOIN strategy_conditions c ON c.last_run_id = r.id
    WHERE c.id = ANY($${paramIndex}::uuid[])
      AND r.status = 'completed'
  )`;
  params.push(dto.strategyHitIds);
  paramIndex++;
}
```

- [ ] **Step 5: 验证后端编译通过**

```bash
cd c:\codes\cryptotrading; npx nest build --path apps/server 2>&1 | Select-Object -Last 20
```

---

### Task 9: 前端 API 层 — symbols 和 aShares QueryBody 添加 strategyHitIds

**Files:**
- Modify: `apps/web/src/api/modules/symbols.ts`
- Modify: `apps/web/src/api/modules/aShares.ts`

- [ ] **Step 1: symbols.ts SymbolQueryBody 添加字段**

```typescript
strategyHitIds?: string[]
```

- [ ] **Step 2: aShares.ts AShareQueryBody 添加字段**

```typescript
strategyHitIds?: string[]
```

---

### Task 10: 端到端测试与验证

- [ ] **Step 1: 启动后端**

```bash
cd c:\codes\cryptotrading; npx nest start --path apps/server
```

- [ ] **Step 2: 验证 API**

```bash
# 测试运行
curl -X POST http://localhost:3000/strategy-conditions/<condition-id>/run

# 测试查询进度
curl http://localhost:3000/strategy-conditions/<condition-id>/run/progress

# 测试查询结果
curl http://localhost:3000/strategy-conditions/<condition-id>/run/result

# 测试批量状态
curl http://localhost:3000/strategy-conditions/last-run-status
```

- [ ] **Step 3: 启动前端验证交互**

```bash
cd c:\codes\cryptotrading\apps\web; npx vite --port 5173
```

- [ ] **Step 4: 验证完整流程**

1. 打开 `http://localhost:5173/strategy-conditions`
2. 确认「状态」列显示
3. 点击「运行」按钮，确认进度显示
4. 等待运行完成，确认「查看结果」链接出现
5. 点击链接跳转到标的筛选页面
6. 确认 `StrategyConditionPicker` 已移除
7. 确认「策略命中」多选筛选存在
8. 选择策略条件，确认筛选生效

---

### Task 11: Git 提交

- [ ] **Step 1: 提交所有变更**

```bash
git add apps/server/src/entities/strategy-condition-run.entity.ts
git add apps/server/src/entities/strategy-condition-hit.entity.ts
git add apps/server/src/entities/strategy-condition.entity.ts
git add apps/server/src/strategy-conditions/
git add apps/server/src/catalog/symbols/symbols.service.ts
git add apps/server/src/market-data/a-shares/
git add apps/web/src/api/modules/strategyConditions.ts
git add apps/web/src/api/modules/symbols.ts
git add apps/web/src/api/modules/aShares.ts
git add apps/web/src/stores/strategyConditions.ts
git add apps/web/src/views/StrategyConditionsView.vue
git add apps/web/src/components/symbols/CryptoSymbolsPanel.vue
git add apps/web/src/components/symbols/ASharesPanel.vue
git add docs/superpowers/specs/2026-05-06-strategy-run-freshness-design.md
git add docs/superpowers/plans/2026-05-06-strategy-run-freshness-plan.md
git commit -m "feat: 策略条件运行进度与新鲜度管理
- 新增 strategy_condition_runs 和 strategy_condition_hits 表
- 重构 run 为分批扫描支持进度轮询
- 策略条件管理页面新增状态列和运行按钮
- 标的筛选页面移除 StrategyConditionPicker，新增策略命中多选筛选
- 运行结果持久化到数据库"
```
