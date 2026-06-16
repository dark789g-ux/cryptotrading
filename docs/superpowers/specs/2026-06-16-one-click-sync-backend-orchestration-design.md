# 一键同步：后端托管 + 持久化任务 设计 spec

- **日期**：2026-06-16
- **主题**：把「一键同步 A 股核心数据」从前端驱动改造为后端托管的持久化任务
- **状态**：设计已批准，待实现

---

## 1. 背景与目标

### 1.1 现状痛点（已落源头核实）

「一键同步」当前是**纯前端编排**：点击「开始同步」后，`useOneClickSync.ts` 的 `start()`
在浏览器 JS 事件循环里依次 `await` 8 个步骤（[useOneClickSync.ts:519-577](../../../apps/web/src/components/sync/useOneClickSync.ts)）。
所有进度状态是 **函数作用域内的实例 `ref`**（[useOneClickSync.ts:32-40](../../../apps/web/src/components/sync/useOneClickSync.ts)，函数定义在第 30 行），
`SyncView` 不在 keep-alive 白名单（[Layout.vue:8](../../../apps/web/src/components/layout/Layout.vue) 仅 `SymbolsView`）。

由此产生两个独立问题：

1. **切走视图 → 进度条归零**：组件销毁，实例 `ref` 被回收，重挂时 `buildInitialSteps()` 重置为零，
   且无任何 `onMounted/onActivated` 从后端恢复的逻辑。
2. **切走视图 → 编排链断裂**：SSE 步骤（1-4）靠 `awaitFinished()`（Vue `watch`）等待
   （[useOneClickSync.ts:163-204](../../../apps/web/src/components/sync/useOneClickSync.ts)），
   组件销毁时 watch 随作用域回收 → promise 永不 resolve → `start()` 永久挂起 → **后续步骤永不触发**。
   同时 [useSSE.ts:17](../../../apps/web/src/composables/hooks/useSSE.ts) 的 `onScopeDispose` abort 当前 fetch。

后端侧：当前正在跑的那一步**会继续跑完写库**（[base-data-sync.controller.ts:34-41](../../../apps/server/src/market-data/base-data-sync/base-data-sync.controller.ts)
的 `res.on('close')` 只 `unsubscribe`，真正干活在 [base-data-sync.service.ts:273-307](../../../apps/server/src/market-data/base-data-sync/base-data-sync.service.ts)
脱离的 `setTimeout(async…)` 里，无 abort、无事务），但**没存任何任务状态**——后端只有各 service 私有的内存 `isSyncing` 锁，
没有任何持久化任务进度表。

### 1.2 目标

完整后端托管：点击开始后，**即使关闭浏览器 / 换台设备登录，同步在服务器继续跑到完**；
任何端打开 `/sync` 都能看到实时进度并接管；进度持久化到 DB，刷新/导航不丢。

### 1.3 已决定的方向（brainstorming 结论）

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 托管强度 | **完整后端托管** | 「换设备接管」语义必然要求编排在后端 |
| 实时机制 | **轮询**（非 SSE） | 复用 signalStats/portfolioSim 现成范式；分钟级同步 2s 足够 |
| 执行基底 | **专用表 + NestJS 进程内编排器** | ml.jobs 执行者是 Python worker，8 步全是 NestJS 逻辑，硬塞要双份重写 |

### 1.4 设计精神

**后端做「今天前端做的同一件事」，前端从「驱动者」退成「观察者」**：
零碰 Python、零改 8 个 sync service、复用两套已验证范式（signalStats 轮询 + ml.jobs 状态机字段）。

---

## 2. 架构与数据流

把现在前端那条「8 步 `await` 链」原样搬到后端，**复用每一步现有的 `startSync()` / POST 方法（锁和逻辑零改）**，
改由后端编排器订阅、把进度写进一张 DB 行；前端退化成纯「读」。

```text
[浏览器/任意端]
   │ POST /api/one-click-sync/runs {start_date,end_date}
   ▼
[OneClickSyncController] ──► [OneClickSyncOrchestrator (service)]
   │ INSERT one_click_sync_runs(status=running)      │ detached async:
   │ 返回 runId(或已存在的活跃 run)                   │  for 步骤 1..8:
   ▼                                                 │   订阅 startSync() / await POST 方法
[Pinia store] ─2s 轮询─► GET /runs/:id ◄─节流写回─┐  │   onProgress → 改内存态 → 节流刷 DB
   │                                              └──┤   done/error → 写 status/finished_at
   ▼                                                  ▼
[OneClickSyncPanel 渲染 steps/进度/日志]      [8 个现有 sync service(完全不动)]
```

**关键设计**：编排器对步骤 1/2/3/4 走它们已有的 `startSync()`（返回 `Subject`，订阅它拿到与今天前端
一模一样的 progress/done 事件，**且天然复用各 service 的 `isSyncing` 锁**——手动同步与一键同步的冲突保护
和今天完全一致）；步骤 5/6/7/8 是普通 `await`（今天也没锁，不变）。**不新增任何 service 方法，blast radius 最小。**

### 2.1 8 步对应的底层 service（已逐个核实签名）

| # | 步骤 | Service.方法 | 类型 | 锁 |
|---|------|-------------|------|----|
| 0 | 基础数据 | `BaseDataSyncService.startSync(dto): Subject<SyncEvent>` | SSE Subject | `isSyncing` |
| 1 | A 股数据 | `ASharesService.startSync(): Subject`（核心 `ASharesSyncService.syncWithProgress`） | SSE Subject | `isSyncing` |
| 2 | 资金流向 | `MoneyFlowSyncService.startSync(dto): Subject<MoneyFlowSyncEvent>` | SSE Subject | `isSyncing` |
| 3 | 指数日线 | `ThsIndexDailySyncService.startSync(dto): Subject` | SSE Subject | `isSyncing` |
| 4 | 个股 AMV | `ActiveMvService.syncStock(opts): Promise<AmvSyncResult>` | 普通 await | 无 |
| 5 | 行业指数 AMV | `ActiveMvService.syncIndustry(opts): Promise<AmvSyncResult>` | 普通 await | 无 |
| 6 | 板块(概念) AMV | `ActiveMvService.syncConcept(opts): Promise<AmvSyncResult>` | 普通 await | 无 |
| 7 | 大盘 0AMV | `OamvService.sync0amv({startDate,endDate,syncMode}): Promise<{synced}>` | 普通 await | 无 |

> 步骤索引沿用前端 `oneClickSync.types.ts` 的 0-based（基础数据=0 … 0AMV=7），UI 显示为「1.~8.」。

### 2.2 订阅 Subject → Promise 的桥接

编排器对 SSE 步骤用一个 helper 把 `Subject` 转成可 `await` 的 Promise：

```text
awaitSubject(subject, onEvent):
  return new Promise((resolve, reject) => {
    subject.subscribe({
      next:  e => onEvent(e),        // progress / done 事件转发到 run 行
      complete: resolve,             // startSync 在推完 done/error 后 complete
      error:    reject,
    })
  })
```

- `done` 事件携带 `result`（含 `errors` / `warnings` / `success` 行数），编排器据此判定该步
  **success vs failed**（此判定逻辑今天在前端 `runBaseData` 等里，需原样移植到编排器）。
- 步骤间 progress 写内存态、节流刷 DB；步骤边界与终态强制刷 DB。

---

## 3. 数据模型

新表 `one_click_sync_runs`（**public schema**，纯 NestJS 自用、不属 ml.jobs 体系，故不碰 alembic）。

```text
one_click_sync_runs
┌─────────────────┬───────────────┬──────────────────────────────────┐
│ id              │ uuid PK       │ gen_random_uuid()                │
│ status          │ text NOT NULL │ running|success|failed|cancelled │
│ start_date      │ varchar(8)    │ YYYYMMDD 同步起                  │
│ end_date        │ varchar(8)    │ YYYYMMDD 同步止                  │
│ progress        │ smallint      │ 0-100 总进度(镜像 totalPercent)  │
│ current_step    │ smallint NULL │ 0..7 当前步; 终态置 null         │
│ steps           │ jsonb NOT NULL│ 8 步明细(见 3.1)                 │
│ logs            │ jsonb NOT NULL│ 滚动日志, 上限 ≤500 条           │
│ error_text      │ text NULL     │ 编排级失败原因                   │
│ cancel_requested│ boolean       │ NOT NULL default false           │
│ created_by      │ text NULL     │ user.id                          │
│ started_at      │ timestamptz   │ NOT NULL default now()           │
│ updated_at      │ timestamptz   │ NOT NULL, 每次写回刷新(新鲜度)   │
│ finished_at     │ timestamptz   │ NULL, 终态写入                   │
└─────────────────┴───────────────┴──────────────────────────────────┘

约束:
  CHECK status IN ('running','success','failed','cancelled')
  CHECK progress >= 0 AND progress <= 100
索引:
  ix_ocsr_status_started ON (status, started_at DESC)   -- 查活跃/最近
```

- **多行历史**（每次同步一行，非单行覆盖）——基本免费，方便看「上次同步结果」。
- 时间列一律 `timestamptz`（遵循 [datetime.md](../../规范/conventions.md) 与 `.claude/rules/datetime.md`）。
- `start_date`/`end_date` 存 YYYYMMDD 字符串：前端用本地 TZ 方法（`getFullYear` 等）从 n-date-picker
  的本地午夜 ms 转出 YYYYMMDD 再 POST（**禁用 `getUTC*`**，否则 CST 用户日期漂前 1 天——
  见 `.claude/rules/datetime.md` 「日期选择器是本地 TZ 例外」）。

### 3.1 `steps` jsonb 结构

直接对齐前端现有 `OneClickStepState`（[oneClickSync.types.ts](../../../apps/web/src/components/sync/oneClickSync.types.ts)），
恢复时能 1:1 重建当前那套富 UI（8 张步骤卡 + 行数 + 错误）：

```text
steps: [
  {
    step:       'base-data' | 'a-shares' | 'money-flow' | 'ths-index-daily'
              | 'stock-amv' | 'industry-amv' | 'concept-amv' | 'oamv',
    status:     'pending'|'running'|'success'|'failed'|'skipped',
    percent:    0-100,
    phase:      string,          // 当前阶段文案
    message:    string,
    rowsWritten:number,
    errors:     [{ step, level, apiName?, message }],
    startedAt:  epoch ms | null,
    finishedAt: epoch ms | null,
  }, ... ×8
]
```

> 步骤级 `startedAt/finishedAt` 是 **epoch ms**（对齐前端 `OneClickStepState`，真实类型 `number | null`），
> 与 run 行**顶层**的 `timestamptz` 列（`started_at`/`finished_at`/`updated_at`）不同源，刻意保留。

### 3.2 `logs` jsonb 结构

```text
logs: [{ ts: epoch ms, step: OneClickStepKey|'system', level:'info'|'warn'|'error', text: string }]
```

上限沿用前端 `LOG_LIMIT`（当前 **500** 条，定义于 `oneClickSync.types.ts`），超出丢弃最早的。

### 3.3 迁移与注册（已知陷阱）

- 迁移文件：`apps/server/migrations/<ts>-create-one-click-sync-runs.sql` + 同名 `.ps1`
  （`.ps1` 标准写法：`Get-Content -Raw -Encoding utf8 $sql | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -`，
  参考 `20260601120000-create-active-mv.{sql,ps1}`）。
- **TypeORM 实体双注册**（踩过坑）：新实体须同时加 module 的 `forFeature` **和** `app.module.ts` 根
  `entities` 数组，漏后者编译绿但运行时 `EntityMetadataNotFound` 500。

---

## 4. 后端：编排器 + 端点 + 并发

新 module `apps/server/src/market-data/one-click-sync/`，按职责拆文件（守 500 行）：
`one-click-sync.controller.ts` / `one-click-sync-orchestrator.service.ts` / `one-click-sync-run.entity.ts`
（放 `entities/` 子目录）/ `dto/` / `types.ts`。

### 4.1 端点（均 `@AdminOnly()`）

| 端点 | 作用 |
|------|------|
| `POST /api/one-click-sync/runs` | 开始。body `{start_date, end_date}`（YYYYMMDD）。**单飞**：若已有 `status=running` 的 run，直接返回它（前端附着，不新建） |
| `GET /api/one-click-sync/runs/active` | 取当前活跃 run；无活跃则返回最近一条（供 onMounted 恢复） |
| `GET /api/one-click-sync/runs/:id` | 轮询单条进度 |
| `POST /api/one-click-sync/runs/:id/cancel` | 置 `cancel_requested=true` |

> AuthGuard 已全局注册（`APP_GUARD`），controller **禁止**再 `@UseGuards(AuthGuard)`
> （见 `.claude/rules/nestjs.md`）；`@AdminOnly()` 用既有 admin 装饰器。

### 4.2 进程内 detached 编排

`POST /runs` 流程：
1. 校验 `start_date`/`end_date` 为 8 位 YYYYMMDD 且 `start <= end`（非法 400）。
2. 查单飞：`SELECT … WHERE status='running' LIMIT 1`；命中则直接返回该行（200）。
3. `INSERT` 一行 `status='running'`，`steps` 初始化为 8 个 pending（`buildInitialSteps` 的后端等价）。
4. 甩一个 detached async（不 `await`，类似现有 `setTimeout` 模式）跑编排，**立即**把新行返回前端。

编排 async 主体（移植自前端 `start()`）：
```text
for i in 0..7:
  if run.cancel_requested(从内存/DB读): mark 剩余 skipped; break
  step[i].status = running; 刷 DB
  执行第 i 步(订阅 Subject / await POST), onProgress → 改内存 → 节流刷 DB
  按结果判定 success/failed, 记 rowsWritten/errors; 刷 DB
finally: status = (cancelled|failed|success); current_step=null; finished_at=now(); 刷 DB
```

- **节流刷 DB**：progress 事件最多每 ~1s 落一次库；**步骤状态切换、终态必刷**。
  前端 2s 轮询，1s 刷库足够新鲜。
- **DB 是真相源**：所有 GET 一律读库，所以另一台设备 / 重启后都能读到。

### 4.3 并发模型

1. **一键 run 全局单飞**：表级保证（POST 命中 running 直接复用，不新建）。
2. **一键 vs 手动同步**：编排器复用各 service 的 `startSync()`，**保留其 `isSyncing` 锁**
   ——若用户在一键同步进行中又去 `/symbols` 等页手动触发某步，会撞该 service 的锁并收到
   「…已在运行中」错误，**与今天行为完全一致**（不引入新的跨模块全局锁）。
3. 步骤 5/6/7/8（AMV/0AMV）今天无锁，保持现状；写入均为幂等 upsert，并发只是浪费、不致脏数据。

---

## 5. 重启 / 孤儿处理

NestJS 是**单实例**（项目现有 per-service `isSyncing` 内存锁本就依赖此前提），用最简洁方案：

```text
OneClickSyncOrchestrator implements OnModuleInit:
  onModuleInit():
    UPDATE one_click_sync_runs
       SET status='failed', error_text='服务重启中断', finished_at=now()
     WHERE status='running'
```

- 进程重启 → 旧 run 立刻被标 `failed`，不留僵尸 `running`。
- 同步全幂等，用户重跑安全。
- **不引入 heartbeat/reaper**（YAGNI；单实例下 boot sweep 足够）。

---

## 6. 状态机 / 取消 / 错误

```text
(开始) ──► running ──┬─ 8 步全完成 ──────────► success
                     ├─ 某步抛错 / 编排异常 ──► failed   (error_text)
                     ├─ cancel_requested ────► cancelled (剩余步骤标 skipped)
                     └─ NestJS 重启 ─────────► failed   (boot sweep)
```

- **取消语义与今天一致**：在步骤之间检查 `cancel_requested`，标记剩余 `skipped`；
  **当前正在跑的那一步无法中断**（底层 service 无 abort 句柄）——这条限制今天就有，如实保留，
  不假装能秒停。当前步会继续跑完，下一次循环检查才生效。
- **错误处理**：每步错误进 `steps[i].errors`（忠实搬运各 service 已有的双路径 warn/errors，
  符合 `.claude/rules/data-integrity.md`「外部服务返回空数据双路径 warn」「同步任务 fetcher 返回 0 行
  显式 failedItems」）；编排级异常进 `error_text` + `status='failed'`。
- 失败不阻断：某步 failed 后**继续后续步骤**（沿用今天 `start()` 不中断、仅在 summary 计 failedCount 的语义）。

---

## 7. 前端

### 7.1 新建 Pinia store `stores/oneClickSync.ts`

**照搬 signalStats/portfolioSim 范式**（setup-store，模块级单 `setInterval(2s)`）：

```text
state:    currentRun(ref<Run|null>)
actions:
  startRun({startDate, endDate}):  POST /runs → set currentRun → ensurePolling()
  fetchActive():                   GET /runs/active → set currentRun
  cancelRun():                     POST /runs/:id/cancel
  ensurePolling():                 已有 timer 则 noop; 否则 2s 轮 GET /runs/:id → patch currentRun
  resumeAllPolling():              currentRun?.status==='running' 时 ensurePolling()
  stopPolling():                   clearInterval
getters:  steps / totalPercent / logs / running / elapsedMs(由 startedAt 派生)
```

参考实现：[signalStats.ts](../../../apps/web/src/stores/signalStats.ts) 全文、
[portfolioSim.ts](../../../apps/web/src/stores/portfolioSim.ts) 全文。

### 7.2 `useOneClickSync.ts` 瘦身

- `start()` → 改成调 `store.startRun()`（前端先把 n-date-picker ms 用本地 TZ 转 YYYYMMDD）。
- `cancel()` → 改调 `store.cancelRun()`。
- **删除**：客户端 8 步编排链（`runBaseData`…`runOamv`、`start()` 的 await 链）、
  各 SSE 订阅（`installSseWatcher`/`awaitFinished`/`awaitASharesDone`）、本地计时器。
- 各底层 sync composable（`useBaseDataSync` 等）在一键同步路径不再被调用（其各自页面手动同步保持不变）。

### 7.3 `OneClickSyncPanel.vue` / `SyncView.vue`

- Panel 模板基本不动：`steps`/`totalPercent`/`logs` 形状不变，数据来源从 composable refs 换成 store getter。
- `SyncView`：
  - `onMounted`：`await store.fetchActive()`；若 `running` 则 `store.resumeAllPolling()`。
  - `onUnmounted`：`store.stopPolling()`。
  - **不需要 keep-alive**——状态在 Pinia store（导航不销毁 store），组件重挂直接读 store。

---

## 8. 测试

1. **后端编排器单测**（jest）：mock 8 个 service，模拟
   progress/done/error 事件、步骤间取消、单飞拒绝（已有 running 时复用）、boot sweep（OnModuleInit 标 failed）、
   某步 failed 不中断后续。迁移落真 DB 验证建表。
2. **前端 store 单测**（vitest）：轮询 patch、`resumeAllPolling` 仅在 running 时启、终态停轮询；
   `type-check` + **`vite build`**（SFC 编译，type-check 查不出编译错——见 `.claude/rules/vue3-frontend.md`）。
3. **真机 e2e**（小区间真同步）：
   - 开始 → 切走/切回（进度从 store 恢复，不归零）
   - 刷新页面（`fetchActive` 恢复 + 继续轮询）
   - 跑到 success
   - 中途取消（剩余 skipped；当前步跑完）
   - 中途重启后端（run 变 failed「服务重启中断」）
   - e2e 触发了写库的用户偏好须验完恢复（见 CLAUDE.md 工作方法）。

---

## 9. 不做（YAGNI / 边界）

- ❌ SSE 实时推送（已选轮询）。
- ❌ heartbeat/reaper（boot sweep 够用）。
- ❌ 跨模块全局同步锁（复用现有 per-service 锁）。
- ❌ 全量回填进一键同步（一键同步一律 `incremental`，全量走各自页面——沿用今天约束，
  见 [useOneClickSync.ts:445-449](../../../apps/web/src/components/sync/useOneClickSync.ts)）。
- ❌ 在导航其它页时仍显示一键同步进度的全局指示器（轮询仅在 `/sync` 页；后端照跑，回页即恢复）。

---

## 10. 文件清单（实现导航）

**后端新增**：
- `apps/server/src/market-data/one-click-sync/one-click-sync.module.ts`
- `apps/server/src/market-data/one-click-sync/one-click-sync.controller.ts`
- `apps/server/src/market-data/one-click-sync/one-click-sync-orchestrator.service.ts`
- `apps/server/src/market-data/one-click-sync/dto/*.ts`
- `apps/server/src/market-data/one-click-sync/types.ts`
- `apps/server/src/entities/market-data/one-click-sync-run.entity.ts`（+ app.module 根 entities 数组）
- `apps/server/migrations/<ts>-create-one-click-sync-runs.{sql,ps1}`

**后端复用（不改）**：`BaseDataSyncService` / `ASharesService` / `MoneyFlowSyncService` /
`ThsIndexDailySyncService` / `ActiveMvService` / `OamvService`。

**前端新增/改**：
- 新增 `apps/web/src/stores/oneClickSync.ts`
- 新增 `apps/web/src/api/modules/.../one-click-sync.ts`（api client）
- 改 `apps/web/src/components/sync/useOneClickSync.ts`（瘦身）
- 改 `apps/web/src/components/sync/OneClickSyncPanel.vue`（数据源换 store）
- 改 `apps/web/src/views/sync/SyncView.vue`（onMounted 恢复）
