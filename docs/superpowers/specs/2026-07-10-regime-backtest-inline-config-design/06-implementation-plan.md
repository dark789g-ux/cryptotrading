# Regime 回测内联配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Regime 配置并入回测创建流；象限必填仓位；单笔买入改为现金切分；暴露 trailing_lock 全参数；下线独立配置页。

**Architecture:** 后端先改校验与引擎 sizing（现金公式 + `budget_full`），再改创建 API 为必填内联 `config`；前端先改 `RegimeConfigEditor`（仓位必填 + trailing_lock UI），再改 `RegimeBacktestCreateModal` 内嵌编辑器并下线路由/菜单。回测执行仍只读 `run.config` 快照。

**Tech Stack:** NestJS 10 + Jest；Vue 3 + Naive UI + Vitest（若有）；TypeORM jsonb 快照。

**Spec:** 同目录 [index.md](./index.md)（01–05）。

---

## SubAgent 编排

```text
Wave 1（可并行，文件域不相交）
  ├─ Agent-A: Task 1–3  现金仓位算法 + SkipReason + 引擎单测
  └─ Agent-B: Task 4–5  配置校验（仓位必填/trailing_lock）+ RegimeConfigEditor UI

Wave 2（依赖 Wave 1 完成）
  ├─ Agent-C: Task 6–7  创建 API 内联 config + CreateModal 内嵌编辑器
  └─ Agent-D: Task 8    下线配置页 + 详情规则摘要 + 文案
        （C/D 若抢同一 router/Sidebar，改为串行：先 C 后 D）

Wave 3
  └─ Agent-Review: 对照 spec 05 验收清单做代码审查（只读）
```

**不相交依据（Wave 1）：** A 主要改 `core/sizing*`、`regime-backtest.engine*`、`core/types.ts`；B 主要改 `regime-engine.validation*`、`RegimeConfigEditor.vue`。

**风险：** Wave 2 的 CreateModal 依赖 Editor 的新 props（`embedded` / 无版本备注）；Agent-C 开始前确认 B 已合并或在同一分支可见。

执行时：**每个 Task 派一个新鲜 SubAgent**；Task 间由主 Agent 做简短 diff 审查后再派下一个（同 wave 可同时派 A+B）。

---

## 文件结构总览

### 后端

```text
apps/server/src/strategies/regime-engine/
  core/types.ts                         修改：SkipReason 增加 budget_full
  core/sizing.ts                        修改：新增 computeCashSplitAlloc
  core/sizing.spec.ts                   修改：现金切分单测
  regime-engine.validation.ts           修改：trade 仓位必填、r×maxN≤1、trailing_lock 参数
  regime-engine.validation.spec.ts      修改：对应用例
  backtest/regime-backtest.types.ts     修改：Capital 去掉必填 positionRatio/maxPositions
  backtest/dto/create-regime-backtest.dto.ts  修改：config 必填；regimeConfigId 可选
  backtest/regime-backtest.service.ts   修改：create/validateDto
  backtest/regime-backtest.engine.ts     修改：现金切分 + budget_full；不再读 capital 仓位
  backtest/regime-backtest.engine.spec.ts 修改/新增用例
```

### 前端

```text
apps/web/src/
  api/modules/strategy/regimeEngine.ts           修改：Create DTO / Quadrant 类型
  components/regime/RegimeConfigEditor.vue       修改：仓位必填；trailing_lock 分层 UI；embedded 模式
  components/strategy/regime-backtest/
    RegimeBacktestCreateModal.vue                修改：内嵌编辑器；去全局仓位
    RegimeBacktestDetailDrawer.vue               修改：规则摘要
    RegimeBacktestConfigSummary.vue              新建（可选拆分，控行数）
  views/strategy/RegimeBacktestView.vue          修改：副标题
  router/index.ts                                修改：/regime-config redirect
  components/layout/Sidebar.vue                  修改：移除 Regime 配置菜单
```

---

## UI 变更（ASCII）

### 新建回测弹窗（目标）

```text
┌─ 新建 Regime 回测 (~900px) ────────────────────────────┐
│ 方案名 / 回测区间 / 初始资金 / 成本预设                 │
│ （无仓位比例、无最大持仓、无配置下拉、无覆盖提示）       │
│                                                        │
│ ── Regime 规则（embedded editor，无版本/备注）──        │
│ [+ 添加象限]                                           │
│ ┌ tab ───────────────────────────────────────────────┐ │
│ │ trade: 仓位比例* 最大持仓* 分桶 入场 出场          │ │
│ │   trailing_lock → maxHold / 止损系数 / 保本地板    │ │
│ │                 ▸ 高级：地板系数 / MA5需下行       │ │
│ └────────────────────────────────────────────────────┘ │
│                              [取消] [新建并运行]       │
└────────────────────────────────────────────────────────┘
```

### Sidebar

```text
前: [Regime 回测] [Regime 配置]
后: [Regime 回测]
```

---

## Task 1: `computeCashSplitAlloc` + SkipReason

**Files:**
- Modify: `apps/server/src/strategies/regime-engine/core/types.ts`
- Modify: `apps/server/src/strategies/regime-engine/core/sizing.ts`
- Modify: `apps/server/src/strategies/regime-engine/core/sizing.spec.ts`

- [ ] **Step 1: 扩展 SkipReason**

在 `SkipReason` 联合类型增加：

```typescript
| 'budget_full' // 1 - positionRatio * n <= 0，开仓停开（非强平）
```

- [ ] **Step 2: 写失败单测（现金切分）**

在 `sizing.spec.ts` 新增：

```typescript
import { computeCashSplitAlloc } from './sizing';

describe('computeCashSplitAlloc', () => {
  it('n=0 → cash * r', () => {
    expect(computeCashSplitAlloc({ cash: 1_000_000, positionRatio: 0.2, openCount: 0 })).toBe(200_000);
  });
  it('n=1,r=0.2 → cash * 0.25', () => {
    expect(computeCashSplitAlloc({ cash: 800_000, positionRatio: 0.2, openCount: 1 })).toBe(200_000);
  });
  it('n=3,r=0.2 → cash * 0.5', () => {
    expect(computeCashSplitAlloc({ cash: 400_000, positionRatio: 0.2, openCount: 3 })).toBe(200_000);
  });
  it('1 - r*n <= 0 → null (budget_full)', () => {
    expect(computeCashSplitAlloc({ cash: 100, positionRatio: 0.4, openCount: 3 })).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测确认失败**

```powershell
pnpm --filter @cryptotrading/server exec jest sizing.spec --no-cache
```

Expected: FAIL（`computeCashSplitAlloc` 未定义）

- [ ] **Step 4: 实现函数**

在 `sizing.ts` 增加（保留原 `computeAlloc` 供 anchor/非 fixed 旧路径）：

```typescript
export function computeCashSplitAlloc(params: {
  cash: number;
  positionRatio: number;
  openCount: number;
}): number | null {
  const { cash, positionRatio: r, openCount: n } = params;
  const denom = 1 - r * n;
  if (!(denom > 0) || !(cash > 0) || !(r > 0)) return null;
  return cash * (r / denom);
}
```

- [ ] **Step 5: 跑测确认通过**

```powershell
pnpm --filter @cryptotrading/server exec jest sizing.spec --no-cache
```

Expected: PASS

- [ ] **Step 6: Commit（仅当用户要求提交时执行）**

```powershell
git add apps/server/src/strategies/regime-engine/core/types.ts apps/server/src/strategies/regime-engine/core/sizing.ts apps/server/src/strategies/regime-engine/core/sizing.spec.ts
git commit -m "feat(regime): add cash-split alloc helper and budget_full skip reason"
```

---

## Task 2: 引擎接入现金切分

**Files:**
- Modify: `apps/server/src/strategies/regime-engine/backtest/regime-backtest.types.ts`
- Modify: `apps/server/src/strategies/regime-engine/backtest/regime-backtest.engine.ts`
- Modify: `apps/server/src/strategies/regime-engine/backtest/regime-backtest.engine.spec.ts`

- [ ] **Step 1: 放宽 Capital 类型**

`RegimeBacktestCapital`：将 `positionRatio` / `maxPositions` 改为可选（兼容旧快照）；新产品路径不依赖它们。

```typescript
export interface RegimeBacktestCapital {
  initialCapital: number;
  cost: PortfolioSimCostRates;
  /** @deprecated 产品层已移除；旧快照可能仍有 */
  positionRatio?: number;
  maxPositions?: number | null;
  sizing?: SizingConfig;
  circuitBreaker?: CircuitBreaker;
  anchorMode?: boolean;
}
```

- [ ] **Step 2: 写/改引擎单测**

在 `regime-backtest.engine.spec.ts`：

1. 改现有依赖 `capital.positionRatio` 的用例：改为象限上设置 `positionRatio`/`maxPositions`。  
2. 新增：

```typescript
it('cash split: second buy uses cash * r/(1-r*n)', () => { /* ... */ });
it('budget_full when 1-r*n<=0', () => { /* ... */ });
it('slots_full when n>=maxPositions from quadrant', () => { /* 改自现有 slots_full */ });
```

构造方式沿用现有 helper（`makeSignal` / calendar / snapshots）；象限 `positionRatio: 0.2`, `maxPositions: 4`；断言第二笔 `alloc` 与 `computeCashSplitAlloc` 一致。

- [ ] **Step 3: 跑测确认失败或旧断言失败**

```powershell
pnpm --filter @cryptotrading/server exec jest regime-backtest.engine.spec --no-cache
```

- [ ] **Step 4: 改引擎开仓 sizing**

关键替换逻辑（`regime-backtest.engine.ts`）：

- 删除对 `capital.positionRatio` / `capital.maxPositions` 的初始化依赖（可删 `let positionRatio = capital.positionRatio` 等）。  
- 每日从象限读取：

```typescript
const r = entry?.positionRatio;
const maxPositions = entry?.maxPositions ?? null;
// trade 象限缺 r → 视为配置错误：skip sized_out 或抛错；单测保证校验层已拦
```

- 用现金切分替换 `computeAlloc({..., navRef: prevNav})`（非 `anchorMode`）：

```typescript
const split = computeCashSplitAlloc({
  cash,
  positionRatio: r as number,
  openCount: positions.length,
});
if (split === null) {
  tradeRec.skipReason = 'budget_full';
  trades.push(tradeRec);
  nSkipped++;
  continue;
}
const alloc = split;
```

- `slots_full`：`maxPositions !== null && positions.length >= maxPositions`（在算 alloc 前或后均可，建议**先** slots_full 再 budget_full）。  
- `anchorMode`：保持旧 `computeAlloc` + `positionRatio`（UI 不暴露；若象限无 r 则 skip）。

- [ ] **Step 5: 跑测通过**

```powershell
pnpm --filter @cryptotrading/server exec jest regime-backtest.engine.spec sizing.spec --no-cache
```

Expected: PASS

- [ ] **Step 6: Commit（用户要求时）**

```powershell
git add apps/server/src/strategies/regime-engine/backtest/regime-backtest.types.ts apps/server/src/strategies/regime-engine/backtest/regime-backtest.engine.ts apps/server/src/strategies/regime-engine/backtest/regime-backtest.engine.spec.ts
git commit -m "feat(regime-backtest): size entries by cash split from quadrant params"
```

---

## Task 3: 配置校验 — 仓位必填 + trailing_lock 参数

**Files:**
- Modify: `apps/server/src/strategies/regime-engine/regime-engine.validation.ts`
- Modify: `apps/server/src/strategies/regime-engine/regime-engine.validation.spec.ts`

- [ ] **Step 1: 写失败用例**

```typescript
it('trade 象限 positionRatio/maxPositions 必填', () => { /* null → fail */ });
it('trade 象限 r*maxN > 1 拒绝', () => {
  // positionRatio 0.3, maxPositions 4 → fail
});
it('trailing_lock stopRatio 非法', () => {
  // stopRatio 1.5 → fail
});
it('trailing_lock 合法全参通过', () => {
  // stopRatio 0.999, floorRatio 0.999, floorEnabled true, ma5RequireDown true
});
```

- [ ] **Step 2: 跑测确认失败**

```powershell
pnpm --filter @cryptotrading/server exec jest regime-engine.validation.spec --no-cache
```

- [ ] **Step 3: 实现校验**

`validateTradeQuadrant` / 仓位：

- `positionRatio`：必须为 `(0, 1]` 数字（**禁止 null**）  
- `maxPositions`：必须为正整数（**禁止 null**）  
- 若 `positionRatio * maxPositions > 1` → fail  

`trailing_lock` 分支补充：

```typescript
const stopRatio = params.stopRatio ?? 0.999;
const floorRatio = params.floorRatio ?? 0.999;
// 若字段存在则校验 ∈ (0,1]；boolean 字段类型检查
if (params.stopRatio !== undefined && params.stopRatio !== null) {
  // validate (0,1]
}
// floorEnabled / ma5RequireDown：若存在须为 boolean
```

保留：缺省字段在校验层可用默认语义通过（与 hydrate 一致）。

- [ ] **Step 4: 更新旧「null 通过」用例**（改为 trade 必填失败 / flat 仍可无仓位）

- [ ] **Step 5: 跑测通过**

```powershell
pnpm --filter @cryptotrading/server exec jest regime-engine.validation.spec --no-cache
```

- [ ] **Step 6: Commit（用户要求时）**

```powershell
git add apps/server/src/strategies/regime-engine/regime-engine.validation.ts apps/server/src/strategies/regime-engine/regime-engine.validation.spec.ts
git commit -m "feat(regime): require quadrant sizing and validate trailing_lock params"
```

---

## Task 4: RegimeConfigEditor — 仓位必填

**Files:**
- Modify: `apps/web/src/components/regime/RegimeConfigEditor.vue`
- Modify: `apps/web/src/api/modules/strategy/regimeEngine.ts`（类型：trade 仓位非可选）

- [ ] **Step 1: UI**

- `trade` 象限：仓位比例 / 最大持仓去掉「可选」placeholder；保存时必填校验。  
- 增加校验：`positionRatio * maxPositions <= 1`，否则 `message.warning`。  
- `makeDefaultQuadrant`：`trade` 默认给 `positionRatio: 0.2`, `maxPositions: 4`（或产品默认；与示例一致即可）。

- [ ] **Step 2: 类型**

`QuadrantEntry`：`positionRatio` / `maxPositions` 在 trade 语义下为 `number`（flat 仍可 null）。

- [ ] **Step 3: 手动/类型检查**

```powershell
pnpm --filter @cryptotrading/web type-check
```

- [ ] **Step 4: Commit（用户要求时）**

---

## Task 5: RegimeConfigEditor — trailing_lock 分层 UI

**Files:**
- Modify: `apps/web/src/components/regime/RegimeConfigEditor.vue`  
  （若单文件将超 500 行：拆出 `TrailingLockParamsForm.vue` 到同目录）

**对照：** [04-trailing-lock-params-ui.md](./04-trailing-lock-params-ui.md)

- [ ] **Step 1: 常驻区**

在 `exitMode === 'trailing_lock'` 下：

```text
maxHold ?     [input-number clearable]
止损系数 ?    [input-number 0~1 step 0.001 default 0.999]
保本地板 ?    [n-switch]
```

Label 旁 `n-tooltip` + `n-icon` 问号；文案用 04 表。

- [ ] **Step 2: 高级折叠**

```text
n-collapse 「高级参数」[+ 已自定义 badge]
  地板系数 ?  [disabled when !floorEnabled]
  MA5 需下行 ? [switch]
  [恢复默认] → floorRatio=0.999, ma5RequireDown=true
```

「已自定义」：`floorRatio !== 0.999 || ma5RequireDown !== true`（只标记，不强制展开）。

- [ ] **Step 3: hydrate / 保存**

选中 trailing_lock 或加载旧配置时：缺字段用默认值填入表单；保存时**显式写入**五字段到 `exitParams`。

- [ ] **Step 4: embedded 模式 props（供 Task 7）**

```typescript
embedded?: boolean  // true → 隐藏版本号、备注、底部「保存」（由父级提交）
```

`embedded` 时 emit `update:config` 或暴露 `getConfig(): RegimeConfigMap | null`（校验失败返回 null）。推荐：

```typescript
defineExpose({ validateAndGetConfig })
```

- [ ] **Step 5: 行数**

```powershell
pnpm --filter @cryptotrading/web lint:quant-lines
```

超限则拆 `TrailingLockParamsForm.vue`。

- [ ] **Step 6: type-check + Commit（用户要求时）**

---

## Task 6: 创建回测 API — 内联 config

**Files:**
- Modify: `apps/server/src/strategies/regime-engine/backtest/dto/create-regime-backtest.dto.ts`
- Modify: `apps/server/src/strategies/regime-engine/backtest/regime-backtest.service.ts`
- Modify: `apps/web/src/api/modules/strategy/regimeEngine.ts`
- Test: 扩展现有 service spec（若无则补最小单测 / 手工用 jest 测 validate 路径）

- [ ] **Step 1: DTO**

```typescript
export interface CreateRegimeBacktestDto {
  name: string;
  note?: string;
  config: RegimeConfigMap; // 必填
  regimeConfigId?: string; // 可选，仅溯源
  capital: {
    initialCapital: number;
    cost: Record<string, number>;
    // positionRatio / maxPositions 可选；若传入则忽略
    positionRatio?: number;
    maxPositions?: number | null;
    sizing?: Record<string, unknown>;
    circuitBreaker?: Record<string, unknown>;
    anchorMode?: boolean;
  };
  dateStart: string;
  dateEnd: string;
}
```

- [ ] **Step 2: `create` + `validateDto`**

```typescript
async create(dto: CreateRegimeBacktestDto) {
  this.validateDto(dto);
  validateRegimeConfig(dto.config);

  let regimeConfigId: string | null = dto.regimeConfigId ?? null;
  let regimeConfigVersion: number | null = null;
  if (regimeConfigId) {
    const ent = await this.configRepo.findOne({ where: { id: regimeConfigId } });
    if (!ent) throw new BadRequestException(`regime config ${regimeConfigId} not found`);
    regimeConfigVersion = ent.version;
  }

  const capital = { ...dto.capital };
  if (capital.positionRatio !== undefined || capital.maxPositions !== undefined) {
    this.logger.warn('ignoring capital.positionRatio/maxPositions (deprecated)');
    delete capital.positionRatio;
    delete capital.maxPositions;
  }

  const entity = this.runRepo.create({
    regimeConfigId,
    regimeConfigVersion,
    name: dto.name.trim(),
    note: dto.note ?? null,
    config: { config: dto.config, capital },
    dateStart: dto.dateStart,
    dateEnd: dto.dateEnd,
    status: 'pending',
    progressDone: 0,
    progressTotal: 0,
  });
  return this.runRepo.save(entity);
}
```

注意：实体 `regimeConfigId` 若 DB 非空约束，需确认 column nullable（`onDelete SET NULL` 已暗示可空）；若 NOT NULL，则隐式建一条 draft 配置——**优先确认 schema**；若非空，Task 6 增加「自动 insert draft」分支并在 plan 执行时写清。

- [ ] **Step 3: 去掉对 capital.positionRatio 的必填校验**

- [ ] **Step 4: 前端 API 类型同步 `CreateRegimeBacktestDto`**

- [ ] **Step 5: 后端相关单测 / 编译**

```powershell
pnpm --filter @cryptotrading/server build
```

- [ ] **Step 6: Commit（用户要求时）**

---

## Task 7: CreateModal 内嵌编辑器

**Files:**
- Modify: `apps/web/src/components/strategy/regime-backtest/RegimeBacktestCreateModal.vue`
- Modify: `apps/web/src/views/strategy/RegimeBacktestView.vue`（副标题）

- [ ] **Step 1: 布局**

- 弹窗宽度 → `min(900px, 96vw)`  
- 删除：配置下拉、仓位比例、最大持仓、覆盖提示  
- 保留：方案名、初始资金、成本、区间  
- 嵌入：`<RegimeConfigEditor embedded ref="editorRef" />`

- [ ] **Step 2: 提交**

```typescript
const cfg = editorRef.value?.validateAndGetConfig()
if (!cfg) return
await regimeEngineApi.createBacktest({
  name: form.value.name,
  config: cfg,
  capital: {
    initialCapital: form.value.initialCapital,
    cost: resolveCost(costTier.value),
  },
  dateStart,
  dateEnd,
})
// 再 triggerRun（保持现有流程）
```

- [ ] **Step 3: 副标题**

`RegimeBacktestView.vue`：`配置 Regime 规则并运行组合回测`

- [ ] **Step 4: type-check**

```powershell
pnpm --filter @cryptotrading/web type-check
```

- [ ] **Step 5: Commit（用户要求时）**

---

## Task 8: 下线配置页 + 详情摘要

**Files:**
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/components/layout/Sidebar.vue`
- Modify: `apps/web/src/components/strategy/regime-backtest/RegimeBacktestDetailDrawer.vue`
- Create (若行数需要): `apps/web/src/components/strategy/regime-backtest/RegimeBacktestConfigSummary.vue`

- [ ] **Step 1: Sidebar** 删除 `Regime 配置` 菜单项

- [ ] **Step 2: 路由**

将 `/regime-config` 改为 redirect：

```typescript
{ path: '/regime-config', redirect: { name: 'regime-backtest' } }
```

可保留组件文件不删（YAGNI 删除）；或删 View 仅留 redirect。

- [ ] **Step 3: 详情摘要**

从 `run.config.config.quadrants` 渲染可折叠卡片：

```text
┌─ 本次规则摘要 ─────────────────────┐
│ 象限 key/label | action | r | maxN │
│ exitMode (+ trailing 关键参一行)    │
└────────────────────────────────────┘
```

- [ ] **Step 4: type-check + lint:quant-lines**

- [ ] **Step 5: Commit（用户要求时）**

---

## Task 9: 验收与代码审查（SubAgent）

- [ ] **Step 1: 跑后端相关单测**

```powershell
pnpm --filter @cryptotrading/server exec jest sizing.spec regime-backtest.engine.spec regime-engine.validation.spec --no-cache
```

- [ ] **Step 2: 前端 type-check**

```powershell
pnpm --filter @cryptotrading/web type-check
```

- [ ] **Step 3: 对照 [05-api-and-acceptance.md](./05-api-and-acceptance.md) 验收清单 1–7 逐条勾选**

- [ ] **Step 4: 派发只读 Review SubAgent**，要求输出：缺陷列表（blocker/major/minor）+ 是否建议合并

---

## Spec 覆盖自检

| Spec 要求 | Task |
|-----------|------|
| 现金切分公式 / budget_full / 同日逐笔更新 n,cash | 1–2 |
| 跨 regime 开仓停开、出场用开仓快照（不改 exit 绑定） | 2（仅改开仓；exit 路径不动） |
| trade 仓位必填、r×maxN≤1 | 3–4 |
| trailing_lock 五参数 + ？+ 高级折叠 | 5 |
| POST 必填 config；忽略 capital 仓位字段 | 6 |
| 新建弹窗内嵌；去全局仓位 | 7 |
| 下线配置页；详情摘要 | 8 |
| 日常/0AMV 不改 | —（非目标） |
| anchorMode / 非 fixed UI 不暴露 | 2 注释 + 7 不传 |

---

## 执行说明

1. Wave 1 并行派 Agent-A（Task 1–3 中引擎侧）与 Agent-B（Task 3 校验可与 A 的 validation 协调：建议 **Task 3 归 B**，A 只做 1–2）。  
   **修正编排：**  
   - Agent-A: Task 1–2  
   - Agent-B: Task 3–5  
2. Wave 2: Agent-C Task 6–7 → Agent-D Task 8（或合并为一 Agent 若人力不足）。  
3. Wave 3: Review SubAgent。  
4. **不要**在未获用户明确「提交代码」指示时执行 git commit 步骤。
