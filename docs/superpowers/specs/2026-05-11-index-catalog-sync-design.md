# 行业/概念目录与成分股同步独立模块

- 创建日期：2026-05-11
- 状态：设计已确认，待实现

## 背景

当前「行业/板块 ↔ 个股」成分股关系（`ths_member_stocks` 表）的同步逻辑挂在资金流向同步任务内部：[`MoneyFlowSyncService.syncMembers`](apps/server/src/market-data/money-flow/money-flow-sync.service.ts#L289-L346) 在 `syncIndustries` / `syncSectors` 末尾被强制触发，且 ts_code 列表来自 `money_flow_industries` / `money_flow_sector` 表的 distinct。

这种耦合存在三个问题：

1. **职责混淆**：成分股关系与资金流是两类独立数据，前者按需求维护，后者按交易日累积。
2. **隐式依赖**：成分股同步必须先有资金流数据，无法独立维护。
3. **目录数据缺失**：行业/概念指数本身的元信息（`ts_code, name, count, list_date, type`）未持久化，未来选股器/策略层无法基于行业目录筛选。

## 目标

- 解除资金流同步与成分股同步的耦合。
- 独立持久化同花顺行业（type=I）与概念（type=N）指数目录。
- 在「数据同步」页面提供独立卡片，UI 极简，一键触发完整流程。

## 非目标

- 不引入交易日维度的成分股变更历史（`ths_member` 接口不支持，且当前业务无此需求）。
- 不调整 `ths_member_stocks` 表结构。
- 不改动现有的资金流业务查询逻辑（仅删除其中的 `syncMembers` 调用链）。

## 数据流总览

```
[用户点击「开始同步」]
        │
        ▼
GET /index-catalog/sync/run (SSE)
        │
        ├── Stage 1: ths_index(type=I, exchange=A) → upsert ths_index_catalog
        ├── Stage 2: ths_index(type=N, exchange=A) → upsert ths_index_catalog
        ├── Stage 3: SELECT ts_code FROM ths_index_catalog WHERE type='I'
        │            └─ for each: ths_member(ts_code) → tx{ delete + upsert ths_member_stocks }
        ├── Stage 4: SELECT ts_code FROM ths_index_catalog WHERE type='N'
        │            └─ for each: ths_member(ts_code) → tx{ delete + upsert ths_member_stocks }
        └── Cleanup: DELETE FROM ths_member_stocks
                     WHERE ts_code NOT IN (SELECT ts_code FROM ths_index_catalog)
```

## 后端

### 模块结构

新增 `apps/server/src/market-data/index-catalog/`：

```
index-catalog/
├── dto/
│   └── sync-catalog.dto.ts              # 极简 DTO（当前无字段，预留扩展）
├── index-catalog.module.ts
├── index-catalog-sync.controller.ts     # GET /index-catalog/sync/run (SSE)
└── index-catalog-sync.service.ts
```

新增实体：[apps/server/src/entities/index-catalog/ths-index-catalog.entity.ts](apps/server/src/entities/index-catalog/ths-index-catalog.entity.ts)

### 数据库表

新增表 `ths_index_catalog`：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `ts_code` | `varchar` | PK | 同花顺指数代码（如 `885835.TI`） |
| `name` | `varchar` | NOT NULL | 指数名称 |
| `count` | `int` | NULL | 成分股个数（来自 `ths_index.count`，仅参考） |
| `exchange` | `varchar` | NOT NULL | 交易所（同步时固定 `A`） |
| `list_date` | `varchar(8)` | NULL | 上市日期，Tushare 原始 `YYYYMMDD` 格式 |
| `type` | `varchar(4)` | NOT NULL | `I`=行业指数 / `N`=概念指数 |
| `created_at` | `timestamptz` | NOT NULL | |
| `updated_at` | `timestamptz` | NOT NULL | |

索引：
- 主键 `ts_code`
- 普通索引 `idx_ths_index_catalog_type` on `(type)`

迁移 SQL 提供以 `docker exec` 可执行格式：

```sql
-- apps/server/src/migration/2026-05-11-ths-index-catalog.sql
CREATE TABLE IF NOT EXISTS ths_index_catalog (
  ts_code     VARCHAR PRIMARY KEY,
  name        VARCHAR NOT NULL,
  count       INTEGER,
  exchange    VARCHAR NOT NULL,
  list_date   VARCHAR(8),
  type        VARCHAR(4) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ths_index_catalog_type ON ths_index_catalog (type);
```

执行命令：
```
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb < apps/server/src/migration/2026-05-11-ths-index-catalog.sql
```

### Service 接口

`IndexCatalogSyncService`：

| 方法 | 签名 | 职责 |
|---|---|---|
| `syncCatalog(type, ctx?)` | `(type: 'I' \| 'N', ctx?: SyncCtx) => Promise<MoneyFlowSyncResult>` | 调 `ths_index({ type, exchange: 'A' })`，按 `ts_code` 去重后 upsert 到 `ths_index_catalog`，冲突键 `['tsCode']` |
| `syncMembers(type, ctx?)` | `(type: 'I' \| 'N', ctx?: SyncCtx) => Promise<MoneyFlowSyncResult>` | 从 `ths_index_catalog` 按 type 取所有 ts_code，逐个调 `ths_member`，事务内 `delete + upsert` 到 `ths_member_stocks`（保留现有的 chunkSize=1000 分块、`['tsCode','conCode']` 冲突键、`deduplicateBy` 去重） |
| `cleanupOrphans()` | `() => Promise<MoneyFlowSyncResult>` | `DELETE FROM ths_member_stocks WHERE ts_code NOT IN (SELECT ts_code FROM ths_index_catalog)`，返回受影响行数到 `success` 字段 |
| `startSync(): Subject<MoneyFlowSyncEvent>` | 编排 4 阶段 + cleanup，发 SSE 事件，`isSyncing` 互斥 |

### SSE 进度模型

复用 [`SyncCtx`](apps/server/src/market-data/money-flow/money-flow-sync.helpers.ts) 与 `MoneyFlowSyncEvent`：

| Stage | label | total | 推进单位 |
|---|---|---|---|
| 1 | `同步行业目录` | 1 | 整段（一次 ths_index 调用） |
| 2 | `同步概念目录` | 1 | 整段 |
| 3 | `同步行业成分股` | N（行业 ts_code 数） | 每个 ts_code 一格 |
| 4 | `同步概念成分股` | M（概念 ts_code 数） | 每个 ts_code 一格 |
| 5 | `清理孤儿成分股` | 1 | 整段 |

`grandTotal = 2 + N + M + 1`。Stage 1/2 完成后才知道 N/M，所以在 Stage 2 结束时**重新计算并发送一次 grandTotal 更新事件**（前端据此重渲染进度条比例）。

### Summary 类型

新增到 [`packages/shared-types`](packages/shared-types/)：

```ts
export interface IndexCatalogSyncSummary {
  industryCatalog: MoneyFlowSyncResult;
  conceptCatalog:  MoneyFlowSyncResult;
  industryMembers: MoneyFlowSyncResult;
  conceptMembers:  MoneyFlowSyncResult;
  cleanup:         MoneyFlowSyncResult;
}
```

### 错误处理（遵循 CLAUDE.md 第三方 API 规范）

| 场景 | 处理 |
|---|---|
| `ths_index` 任一 type 调用失败 | 整体中止，发 `error` 事件，**不进入下一阶段** |
| `ths_index` 返回空数组 | `logger.warn('[ths_index type=X] 返回空数据')` + 记入 errors，但继续后续阶段 |
| 单个 ts_code 的 `ths_member` 调用失败 | `logger.error` + 记入 errors[]，**继续下一个 ts_code** |
| `ths_member` 返回空数据 | `logger.warn('ths_member(ts_code) 返回空数据')`，跳过该板块（沿用现有逻辑） |
| Cleanup SQL 失败 | 记入 errors，不影响整体 done（成分股已落库） |

**禁止**：`.catch(() => [])` 静默吞错。

### 共享工具提升

将 [`money-flow-sync.helpers.ts`](apps/server/src/market-data/money-flow/money-flow-sync.helpers.ts) 中的纯工具函数（`asString`、`asNullableNumeric`、`deduplicateBy`、`batchUpsert`、`SyncCtx` 类型）提升到 `apps/server/src/market-data/_shared/sync-helpers.ts`，money-flow 模块改 import 路径。`fetchByDates` 与 `filterExistingDates` 留在 money-flow（仅按交易日同步的模块需要）。

### 旧逻辑删除清单

[apps/server/src/market-data/money-flow/money-flow-sync.service.ts](apps/server/src/market-data/money-flow/money-flow-sync.service.ts)：

- 删除 L11 `import { ThsMemberStockEntity }`
- 删除 L36-37 `// ths_member` 注释与 `MEMBER_FIELDS` 常量
- 删除 L59-60 构造函数中 `memberRepo` 注入
- 删除 `syncIndustries` 内 L169-172、L203-205 两处 `syncMembers` 调用与日志
- 删除 `syncSectors` 内 L213-216、L246-248 两处 `syncMembers` 调用与日志
- 删除 L286-346 整段 `syncMembers(dimension)` 私有方法

[apps/server/src/market-data/money-flow/money-flow.module.ts](apps/server/src/market-data/money-flow/money-flow.module.ts)：

- 移除 `ThsMemberStockEntity` 的 `TypeOrmModule.forFeature` 注册（仅当 money-flow 模块内不再有其他用途时——实现阶段需 grep 确认）

`ThsMemberStockEntity` 实体本体保留，新模块继续复用。

## 前端

### 新增文件

| 文件 | 职责 |
|---|---|
| [apps/web/src/api/modules/indexCatalog.ts](apps/web/src/api/modules/indexCatalog.ts) | `indexCatalogApi.syncRunUrl()` 拼接 `GET /index-catalog/sync/run` |
| [apps/web/src/components/sync/useIndexCatalogSync.ts](apps/web/src/components/sync/useIndexCatalogSync.ts) | composable：封装 SSE 启动/停止、进度状态、summary 解析 |

### SyncView 改动

[apps/web/src/views/sync/SyncView.vue](apps/web/src/views/sync/SyncView.vue)：

- 在 `data-source-grid` 中**「资金流向」卡片之后**插入第 5 张卡片「行业/概念目录与成分股」。
- 卡片内联进度（不弹 Modal），与「加密货币」卡片风格一致。
- 卡片结构：

```
┌─ 行业/概念目录与成分股 ──────────────┐
│ 同步同花顺行业指数（type=I）和概念   │
│ 指数（type=N）目录，并刷新各板块的   │
│ 成分股关系。                         │
│                                      │
│ 上次同步：[lastSyncTime]              │
│                                      │
│        [开始同步]                    │
│                                      │
│ ── 进度（同步中显示）──              │
│ 阶段 3/5 · 同步行业成分股            │
│ ████████░░░░░░░░ 1234 / 5678         │
│                                      │
│ ── 完成后显示 summary ──             │
│ 行业目录    success=N1  errors=0     │
│ 概念目录    success=N2  errors=0     │
│ 行业成分股  success=K1  errors=2 [展开]│
│ 概念成分股  success=K2  errors=0     │
│ 孤儿清理    deleted=D                │
└──────────────────────────────────────┘
```

### 进度组件复用决策

[apps/web/src/components/sync/MoneyFlowSyncProgress.vue](apps/web/src/components/sync/MoneyFlowSyncProgress.vue)：实现阶段先 grep 确认其是否已通用化。

- 若已通用（不绑定 money-flow 域字段）：直接复用
- 若有 money-flow 域耦合：抽取为 `SyncProgress.vue` 通用组件，两处共用

实现阶段决定，spec 不强制方案。

### Modal 复用

不使用 Modal（极简卡片直接内联进度），但若进度展示复杂度后续上升，可改用 [apps/web/src/components/sync/DataSyncModal.vue](apps/web/src/components/sync/DataSyncModal.vue) 的简化变体。当前不引入。

## 测试策略

### 单元测试

`IndexCatalogSyncService` 的三个方法各一组测试，全部 mock `TushareClient.query`：

- `syncCatalog`：断言 `ths_index` 调用参数（`type=I` / `type=N`、`exchange=A`），upsert 字段映射正确，去重生效（同 ts_code 重复行只保留最后一条）
- `syncMembers`：mock `ths_index_catalog` 读取，断言每个 ts_code 触发独立事务的 delete+upsert，分块大小 1000，单个失败不中断其余
- `startSync`：mock 各方法返回值，订阅 Subject 验证事件序列：progress 事件数 = 2 + N + M + 1，done 事件 summary 完整，任一 catalog 失败时立即 error 不进入下一 stage

涉及 Tushare 接口名/参数的测试，注释开头标注：

```ts
// TODO: 需集成测试验证 API 契约
```

### 集成验证（手动）

实施完成后必须执行并将结果记入 PR 描述：

1. 执行迁移 SQL，确认 `ths_index_catalog` 表存在
2. 在 SyncView 点击「开始同步」，观察进度从 1/grandTotal 推进到完成
3. SQL 验证：
   - `SELECT type, COUNT(*) FROM ths_index_catalog GROUP BY type` → I / N 两类各有数百到数千行
   - `SELECT COUNT(DISTINCT ts_code) FROM ths_member_stocks` ≈ `SELECT COUNT(*) FROM ths_index_catalog`
4. 跑一次资金流向同步，日志中**不应出现** `ths_member(...)` 字样

### 前端测试

- composable 单测（mock EventSource）：覆盖 progress 解析、grandTotal 重算、错误终止
- 视图层手动浏览器验证（CLAUDE.md「UI 改动需浏览器验证」）

## 验证清单

合入前必须满足：

- [ ] 迁移 SQL 在本地 Docker postgres 执行成功，表结构与索引存在
- [ ] `pnpm --filter @cryptotrading/server build` 通过（CLAUDE.md NestJS 规范）
- [ ] `pnpm --filter @cryptotrading/web build` 通过
- [ ] 后端单元测试通过
- [ ] 一次完整同步在本地跑通，summary 各项 errors 列表为可解释空集或受控错误
- [ ] 资金流向同步回归：日志确认无 `ths_member` 调用
- [ ] 浏览器端点击「开始同步」UI 行为符合 §前端 描述
