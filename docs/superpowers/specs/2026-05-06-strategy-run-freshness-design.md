# 策略条件运行与新鲜度管理设计文档

## 概述

本设计将策略条件的运行入口从标的筛选页面迁移到策略条件管理页面，并增加运行状态追踪、进度反馈、结果持久化和数据新鲜度判断功能。

## 用户故事

1. 用户希望在策略条件管理页面看到策略条件是否使用最新数据运行过
2. 用户希望在策略条件管理页面运行特定策略，然后在标的筛选页面进行筛选
3. 用户希望看到运行进度，即使是在后台运行的
4. 删除标的筛选页面中的选择策略条件组件

## 设计方案

### 1. 数据库设计

#### 1.1 新增 `strategy_condition_runs` 表

```sql
CREATE TABLE strategy_condition_runs (
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

CREATE INDEX idx_strategy_condition_runs_condition_id ON strategy_condition_runs(condition_id);
CREATE INDEX idx_strategy_condition_runs_user_id ON strategy_condition_runs(user_id);
```

**字段说明：**
- `status`: 运行状态，取值 `running`/`completed`/`failed`
- `progress_scanned`: 已扫描标的数
- `progress_total`: 总标的数
- `total_hits`: 命中标的数
- `error_message`: 运行失败时的错误信息

#### 1.2 新增 `strategy_condition_hits` 表

```sql
CREATE TABLE strategy_condition_hits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES strategy_condition_runs(id) ON DELETE CASCADE,
  ts_code VARCHAR(30) NOT NULL,
  name VARCHAR(100),
  matched_conditions JSONB DEFAULT '[]'
);

CREATE INDEX idx_strategy_condition_hits_run_id ON strategy_condition_hits(run_id);
CREATE INDEX idx_strategy_condition_hits_ts_code ON strategy_condition_hits(ts_code);
```

**字段说明：**
- `ts_code`: 标的代码（如 `BTCUSDT` 或 `000001.SZ`）
- `name`: 标的名称
- `matched_conditions`: 匹配的条件列表（JSON 数组）

#### 1.3 修改 `strategy_conditions` 表

```sql
ALTER TABLE strategy_conditions ADD COLUMN last_run_id UUID REFERENCES strategy_condition_runs(id);
```

**字段说明：**
- `last_run_id`: 关联最后一次运行记录

### 2. 后端 API 设计

#### 2.1 新增端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/strategy-conditions/:id/run` | 启动运行（返回 run_id） |
| GET | `/strategy-conditions/:id/run/progress` | 查询运行进度 |
| GET | `/strategy-conditions/:id/run/result` | 查询命中结果 |
| GET | `/strategy-conditions/last-run-status` | 批量查询所有条件的最后运行状态和新鲜度 |

#### 2.2 运行流程

```
前端                    后端
  │                       │
  │ POST /:id/run         │
  │──────────────────────>│
  │                       │ 1. 创建 run 记录 (status=running)
  │     { run_id }        │ 2. 异步启动扫描
  │<──────────────────────│
  │                       │
  │ GET /:id/run/progress │ 3. 每扫描一批更新 progress_scanned
  │──────────────────────>│
  │  { scanned, total }   │
  │<──────────────────────│
  │                       │ (重复轮询直到 completed)
  │                       │
  │ GET /:id/run/result   │ 4. 返回命中列表
  │──────────────────────>│
  │  { hits[], total }    │
  │<──────────────────────│
```

#### 2.3 新鲜度判断逻辑

```typescript
// 伪代码
async function getFreshness(conditionId: string): Promise<'fresh' | 'stale' | 'never'> {
  const condition = await findOne(conditionId);
  if (!condition.lastRunId) return 'never';

  const run = await runRepository.findOne(condition.lastRunId);
  if (!run || run.status !== 'completed') return 'never';

  // 获取数据最新更新时间
  const dataUpdateTime = condition.targetType === 'crypto'
    ? await getMaxOpenTime()  // klines 表的 MAX(open_time)
    : await getMaxTradeDate(); // a_share_daily_indicators 表的 MAX(trade_date)

  return run.completedAt >= dataUpdateTime ? 'fresh' : 'stale';
}
```

#### 2.4 标的筛选 API 改造

`querySymbols` 方法新增 `strategyHitIds` 参数：

```typescript
// 新增参数
strategyHitIds?: string[]  // 策略条件 ID 数组

// SQL 逻辑
if (strategyHitIds?.length) {
  // 子查询：获取指定策略条件最新一次运行命中的标的
  const hitCodes = await dataSource.query(`
    SELECT DISTINCT h.ts_code
    FROM strategy_condition_hits h
    JOIN strategy_condition_runs r ON h.run_id = r.id
    JOIN strategy_conditions c ON c.last_run_id = r.id
    WHERE c.id = ANY($1)
      AND r.status = 'completed'
  `, [strategyHitIds]);

  // 添加 WHERE 条件
  whereClauses.push(`k.symbol = ANY($N)`);
  params.push(hitCodes.map(h => h.ts_code));
}
```

### 3. 前端设计

#### 3.1 策略条件管理页面改造

**表格新增列：**

| 列名 | 内容 | 样式 |
|------|------|------|
| 状态 | 「最新」/「过期」/「未运行」 | 绿色/红色/灰色标签 |
| 操作 | 「运行」按钮 + 「查看结果」链接 | 运行中显示进度条 |

**运行交互：**
1. 点击「运行」按钮
2. 按钮变为 loading 状态，下方显示进度条（已扫描/总数）
3. 运行完成后，进度条消失，显示「查看结果」链接
4. 点击链接跳转到标的筛选页面

**进度轮询：**
- 使用 `setInterval` 每 500ms 查询一次进度
- 运行完成后清除定时器
- 刷新页面后重新查询进度（如果 status=running 继续轮询）

#### 3.2 标的筛选页面改造

**移除组件：**
- 移除 `StrategyConditionPicker` 组件
- 移除相关导入和引用

**新增筛选条件：**
- 新增「策略命中」多选下拉框
- 选项为所有策略条件（带状态标记）
- 用户可选择多个策略条件
- 筛选出命中任意一个条件的标的

**保留功能：**
- 「买入信号」列保留
- 从数据库读取运行结果
- 显示命中了哪些策略条件

### 4. 关键实现细节

#### 4.1 进度更新机制

```typescript
// 后端 Service
async run(id: string, userId: string): Promise<void> {
  const condition = await this.findOne(id, userId);

  // 删除该条件之前的运行记录（级联删除 hits）
  await this.deletePreviousRuns(condition.id);

  // 创建新的运行记录
  const run = await this.runRepository.save({
    conditionId: condition.id,
    userId,
    status: 'running',
    progressTotal: 0,  // 稍后更新
  });

  // 更新条件的 last_run_id
  await this.conditionRepository.update(condition.id, { lastRunId: run.id });

  try {
    // 获取总标的数（扫描全量，不做 limit/offset 筛选）
    const total = await this.countTotalSymbols(condition.targetType);
    await this.runRepository.update(run.id, { progressTotal: total });

    // 分批扫描：每批用 LIMIT/OFFSET 遍历标的，对每批运行条件 SQL
    const batchSize = 100;
    const hits = [];
    for (let offset = 0; offset < total; offset += batchSize) {
      const batch = await this.scanBatch(condition, offset, batchSize);
      hits.push(...batch);

      await this.runRepository.update(run.id, {
        progressScanned: Math.min(offset + batchSize, total),
      });
    }

    // 保存命中结果
    await this.hitsRepository.save(
      hits.map(hit => ({ runId: run.id, ...hit }))
    );

    // 更新运行记录为完成
    await this.runRepository.update(run.id, {
      status: 'completed',
      totalHits: hits.length,
      completedAt: new Date(),
    });
  } catch (error) {
    // 更新运行记录为失败
    await this.runRepository.update(run.id, {
      status: 'failed',
      errorMessage: error.message,
    });
  }
}
```

#### 4.2 前端进度轮询

```typescript
// Pinia Store
async runCondition(id: string) {
  // 启动运行
  const { runId } = await strategyConditionsApi.startRun(id);

  // 轮询进度
  const pollInterval = setInterval(async () => {
    const progress = await strategyConditionsApi.getRunProgress(id, runId);

    this.runProgress.set(id, progress);

    if (progress.status === 'completed' || progress.status === 'failed') {
      clearInterval(pollInterval);
      this.runningId = null;

      if (progress.status === 'completed') {
        // 获取结果
        const result = await strategyConditionsApi.getRunResult(id, runId);
        this.runResults.set(id, result);
      }
    }
  }, 500);

  this.runningId = id;
}
```

#### 4.3 标的筛选集成

```typescript
// 标的筛选页面
const selectedStrategyIds = ref<string[]>([]);

// 监听策略选择变化，重新查询
watch(selectedStrategyIds, () => {
  fetchSymbols();
});

// 查询参数
const queryParams = computed(() => ({
  // ... 其他筛选条件
  strategyHitIds: selectedStrategyIds.value,
}));
```

### 5. 错误处理

#### 5.1 运行失败
- 后端捕获异常，更新 `status=failed` 和 `error_message`
- 前端显示错误提示
- 用户可点击「重试」重新运行

#### 5.2 网络中断
- 前端轮询失败时，停止轮询并提示用户
- 刷新页面后自动恢复轮询（如果 status=running）

#### 5.3 并发运行
- 同一策略条件同时只能有一个运行任务
- 如果已有运行中的任务，返回错误提示

### 6. 性能考虑

#### 6.1 数据库索引
- `strategy_condition_runs(condition_id)`: 快速查询条件的运行记录
- `strategy_condition_hits(run_id)`: 快速查询运行的命中结果
- `strategy_condition_hits(ts_code)`: 支持标的筛选查询

#### 6.2 查询优化
- 新鲜度查询通过 `last_run_id` 直接关联，避免全表扫描
- 标的筛选通过子查询获取命中标的，避免全表 JOIN

#### 6.3 数据清理
- 每次运行前删除该条件之前的运行记录（级联删除 hits）
- 避免数据无限增长

### 7. 测试计划

#### 7.1 单元测试
- 策略条件运行逻辑
- 新鲜度判断逻辑
- 进度更新逻辑

#### 7.2 集成测试
- 完整运行流程（启动→轮询→完成）
- 标的筛选集成
- 错误处理流程

#### 7.3 E2E 测试
- 策略条件管理页面交互
- 标的筛选页面交互
- 跨页面数据一致性

## 实现步骤

### 阶段一：数据库和后端 API
1. 创建数据库表和索引
2. 实现 Entity 和 Repository
3. 实现运行 API（启动、进度、结果）
4. 实现新鲜度判断逻辑

### 阶段二：前端改造
1. 改造策略条件管理页面
2. 实现进度轮询
3. 实现新鲜度展示
4. 改造标的筛选页面

### 阶段三：集成和测试
1. 标的筛选 API 集成
2. 错误处理完善
3. 性能优化
4. 测试和调试

## 风险和缓解措施

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 运行时间过长 | 用户体验差 | 分批扫描，实时更新进度 |
| 数据量大 | 内存溢出 | 流式处理，避免一次性加载 |
| 并发运行 | 数据不一致 | 加锁机制，同一条件只能一个运行 |
| 网络中断 | 进度丢失 | 进度持久化，刷新后恢复 |
