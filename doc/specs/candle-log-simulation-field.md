# 回测详情-K线记录「模拟/实盘」字段显示修复 SPEC

> 面向 AI 编程助手。最后更新：2026-04-25

## 1. 概述

K 线记录表格的「模拟/实盘」列当前只在有出场操作的行显示值，有入场但无出场的行显示 '—'。应改为：有出场取出场，否则取入场，两者都没有才显示 '—'。

## 2. 背景与上下文

- **相关文件**：`apps/web/src/composables/backtest/useBacktestCandleLog.ts`
- **数据库表**：不涉及
- **依赖接口**：不涉及，仅前端渲染逻辑

当前有问题的代码位置：`useBacktestCandleLog.ts` 第 333–341 行，`isSimulation` 列的 `render` 函数：

```ts
render: (row: CandleLogRow) => {
  const lastExit = row.exits[row.exits.length - 1] as { isSimulation?: boolean } | undefined
  if (!lastExit) return '—'
  return lastExit.isSimulation ? '模拟' : '实盘'
},
```

`CandleLogEntry`（`row.entries` 的元素类型）同样有 `isSimulation: boolean` 字段，但当前逻辑完全忽略了入场记录。

## 3. 功能需求

- **有出场的行**：从 `row.exits` 的最后一条取 `isSimulation`，显示「模拟」或「实盘」
- **只有入场的行**：从 `row.entries` 的第一条取 `isSimulation`，显示「模拟」或「实盘」
- **无任何操作的行**：显示 '—'（与当前行为一致）

## 4. 明确不做的事

- 不修改后端接口或筛选逻辑
- 不调整整体收益率、累计胜率等其他仅在出场时才有意义的列
- 不改变行的样式或交互

## 5. 技术方案

### 前端

- **文件**：`apps/web/src/composables/backtest/useBacktestCandleLog.ts`
- **改动**：仅修改 `candleLogColumns` 中 `isSimulation` 列的 `render` 函数

新逻辑：

```ts
render: (row: CandleLogRow) => {
  const lastExit = row.exits[row.exits.length - 1] as { isSimulation?: boolean } | undefined
  if (lastExit) return lastExit.isSimulation ? '模拟' : '实盘'
  const firstEntry = row.entries[0] as { isSimulation?: boolean } | undefined
  if (firstEntry) return firstEntry.isSimulation ? '模拟' : '实盘'
  return '—'
},
```

## 6. 验收标准

- [ ] 只有入场操作（无出场）的 K 线记录行，「模拟/实盘」列正确显示「模拟」或「实盘」
- [ ] 同时有入场和出场的行，仍从出场取值（行为不变）
- [ ] 无任何操作的行，仍显示 '—'
- [ ] `pnpm exec vue-tsc --noEmit` 无新增报错
