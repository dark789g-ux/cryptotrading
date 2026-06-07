# 04 · API 与前端

[← 返回 index](./index.md)

## 4.1 DTO

新建 `apps/server/src/strategy-conditions/signal-stats/dto/`：

```typescript
// create-signal-test.dto.ts
export class CreateSignalTestDto {
  name: string;
  buyConditions: StrategyConditionItem[];          // 复用现有接口
  exitMode: 'fixed_n' | 'strategy';
  horizonN?: number;                               // exitMode='fixed_n' 必填
  exitConditions?: StrategyConditionItem[];        // exitMode='strategy' 必填
  maxHold?: number;                                // exitMode='strategy' 必填
  universe: SignalTestUniverse;                    // {type:'all'|'list', tsCodes?}
  dateStart: string;                               // YYYYMMDD
  dateEnd: string;
}
// update-signal-test.dto.ts — 同字段全部可选
```

**校验（fail-fast，class-validator + service 层）**：
- `exitMode='fixed_n'` → `horizonN` 必填且 ≥1；`exitMode='strategy'` → `exitConditions` 非空 + `maxHold` ≥1。
- `universe.type='list'` → `tsCodes` 非空。
- `dateStart ≤ dateEnd`，且都落在 `trade_cal` 覆盖范围内（否则 400）。
- `buyConditions` 非空。

## 4.2 Controller 路由

新建 `signal-stats.controller.ts`，基路由 `/api/signal-tests`（带 `req.user.id` 鉴权，对齐现有 controller）：

```text
POST   /api/signal-tests                      创建方案 → CreateSignalTestDto
GET    /api/signal-tests                      方案列表
GET    /api/signal-tests/:id                  方案详情
PUT    /api/signal-tests/:id                  更新 → UpdateSignalTestDto
DELETE /api/signal-tests/:id                  删除(级联 run/trade)
POST   /api/signal-tests/:id/run              触发运行(异步, 立即返回 runId)
GET    /api/signal-tests/:id/run/progress     当前/最近一次进度
GET    /api/signal-tests/:id/runs             历史运行聚合列表(留历史可对比)
GET    /api/signal-tests/runs/:runId/trades   逐笔明细(分页 ?page&pageSize)
```

> ⚠️ 路由顺序：静态段路由（如 `/runs/:runId/trades`）须避免被 `/:id` 吞掉，参考现有 `controller.ts:25-29` 把更具体的路由先声明。

## 4.3 Service 与 Runner 拆分（单文件 ≤500 行）

按职责拆多文件，避免单文件超限：

```text
signal-stats/
├─ signal-stats.controller.ts        路由入口
├─ signal-stats.service.ts           CRUD + 触发 run + 查询聚合/明细
├─ signal-stats.runner.ts            异步执行: 枚举→模拟→聚合→落库
├─ signal-stats.enumerator.ts        信号枚举(复用 query-builder, 锚定日遍历)
├─ signal-stats.simulator.ts         逐笔出场模拟 simulateExit + 入场过滤
├─ signal-stats.metrics.ts           calcSignalStats 指标聚合(纯函数, 易单测)
├─ signal-stats.module.ts            module(或并入 strategy-conditions.module)
└─ dto/
```

**`signal-stats.metrics.ts` 设计为纯函数**（输入 `ret[]` / `holdDays[]` → 输出指标对象），不依赖 DB，便于用构造数据单测（见 [05 文档 §5.2](./05-error-testing-tasks.md#52-单测清单jest)）。

module 可并入现有 `strategy-conditions.module.ts`（追加 controller/provider + 3 实体 forFeature），或独立 `signal-stats.module.ts` 由 `strategy-conditions.module` 导出。**推荐并入**（同业务域，减少 module 数）。

## 4.4 前端

新增视图 `apps/web/src/views/strategy/SignalStatsView.vue` + 路由 `/signal-stats`（顶层平级，对齐现有 strategy 视图无嵌套前缀）+ pinia store `stores/signalStats.ts` + API client `api/modules/strategy/signalStats.ts`。

页面布局：

```text
┌────────────────────────────────────────────────────────┐
│  信号前向统计           [新建方案]                       │
├────────────────────────────────────────────────────────┤
│  方案列表  │  方案详情                                   │
│  ┌───────┐ │  买入条件: [StrategyConditionBuilder 复用]   │
│  │ 方案A │ │  出场: ○固定N天[__]  ○卖出条件[Builder]+兜底│
│  │ 方案B │ │  区间:[起]~[止]  标的:○全市场 ○列表[____]    │
│  └───────┘ │  [运行] ──进度条(轮询)──▶                    │
│            │  ┌── 聚合指标卡 ──────────────────────┐     │
│            │  │ 样本 胜率 赔率b PF 凯利f* 均持仓 最差│     │
│            │  └────────────────────────────────────┘     │
│            │  历史运行对比表 + 逐笔明细表(分页/可手算核对)│
└────────────────────────────────────────────────────────┘
```

**组件复用与拆分**：
- 买入条件 + 卖出条件均嵌 `StrategyConditionBuilder.vue`（已支持 field/operator/compareMode/value/compareField，操作符含 cross_above/cross_below）。卖出条件沿用同约束（cross 仅 `daily_indicator` 字段）。
- `SignalStatsView.vue` 若超 500 行，拆出 `SignalTestForm.vue`（配置表单）/ `SignalStatsResult.vue`（指标卡 + 明细表）子组件（`lint:quant-lines` 不覆盖此目录，但项目规范同样 ≤500 行）。

**store**（对齐 `stores/strategyConditions.ts` 范式）：
- state：`tests[]`、`runProgress: Map`、`runningId`、`loading`。
- actions：`fetchTests / createTest / updateTest / deleteTest / startRun(轮询 progress) / fetchRuns / fetchTrades`。

**指标卡显示**：`null` 值（无亏损样本时的 PF/赔率/凯利）显示 "—" 并加 tooltip 说明。`win_rate` 以 % 显示。

## 4.5 shared-types

若前后端共享 `SignalTestUniverse` / 指标结果类型，加到 `packages/shared-types/`（对齐现有共享类型约定）；`StrategyConditionItem` 已有则复用。

[← index](./index.md) ｜ [下一篇：05 错误处理与测试 →](./05-error-testing-tasks.md)
