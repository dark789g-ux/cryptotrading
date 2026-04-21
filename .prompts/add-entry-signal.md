你是一个熟悉本回测系统架构的工程师。根据用户的描述，为回测引擎添加一个新的入场信号。

---

## 本系统新增入场信号的标准工作流

每次新增一个入场信号，需要按顺序改动以下 **6 个文件**。严格遵守下面的模式。

---

### 约定：参数哨兵（启用/禁用机制）

信号的启用状态**不使用独立 boolean**，而是通过关键参数的哨兵值判断：

| 参数类型 | 禁用哨兵 | 启用条件 |
|---------|---------|---------|
| 数值型（阈值/比例） | `0` | `!== 0` |
| boolean 型 | `false` | `=== true` |

> 例外：若信号有多个参数，以"主参数"作哨兵，其余参数在主参数禁用时一并置为默认值。

---

### 文件 1：`apps/server/src/backtest/engine/models.ts`

在 `BacktestConfig` 接口的 `// 入场信号` 区块末尾新增参数字段，并在 `DEFAULT_CONFIG` 中设置默认（禁用）值。

```typescript
// BacktestConfig 接口
// 入场信号
// ...现有字段...
mySignalKeyParam: number;   // 0 = 禁用
mySignalOtherParam: number; // 辅助参数

// DEFAULT_CONFIG
mySignalKeyParam: 0,
mySignalOtherParam: 0,
```

---

### 文件 2：`apps/server/src/backtest/engine/bt-indicators.ts`

若信号需要预计算指标（跨根 K 线的递归/窗口计算），在此文件新增：
1. 结果接口（如 `export interface MySignalBar { value: number; ... }`）
2. 单 symbol 预计算函数 `precomputeMySignal(df: KlineBarRow[]): MySignalBar[]`
3. 全量预计算函数 `precomputeMySignalAll(data: Map<string, KlineBarRow[]>): Map<string, MySignalBar[]>`

> 若信号仅需读取行内已有字段（如 `row.MA60`、`row['KDJ.J']`），可跳过此文件。

---

### 文件 3：`apps/server/src/backtest/engine/signal-scanner.ts`

1. 从 `bt-indicators` 导入结果接口
2. 在 `scanSignals` 函数签名末尾新增可选参数 `mySignalMap?: Map<string, MySignalBar[]>`
3. 在扫描循环内、`candidates.push` 之前，添加过滤逻辑：

```typescript
// ── MySignal 条件 ──
if (config.mySignalKeyParam !== 0 && mySignalMap) {
  const bars = mySignalMap.get(symbol);
  if (!bars || idx < MIN_LOOKBACK) continue;
  // ... 判断逻辑 ...
  if (!passed) continue;
}
```

---

### 文件 4：`apps/server/src/backtest/engine/engine.ts`

1. 从 `bt-indicators` 导入全量预计算函数
2. 在 `precomputeAllKdj` 附近添加预计算（条件执行）：

```typescript
const mySignalMap = config.mySignalKeyParam !== 0
  ? precomputeMySignalAll(data)
  : undefined;
```

3. 将 `mySignalMap` 传入 `scanSignals` 调用

---

### 文件 5：`apps/web/src/composables/backtest/useStrategyForm.ts`

1. 在 `StrategyParams` 接口中新增参数（与后端 `BacktestConfig` 对应字段一致）
2. 在 `defaultParams()` 中新增默认（禁用）值

```typescript
// StrategyParams
mySignalKeyParam: number
mySignalOtherParam: number

// defaultParams()
mySignalKeyParam: 0,
mySignalOtherParam: 0,
```

---

### 文件 6：`apps/web/src/components/backtest/strategy/EntrySignalSection.vue`

这是前端入口，改动最集中。

**a. `EntrySignalParams` 接口**（新增字段，与 `StrategyParams` 对应）

**b. `SignalType` 联合类型**（新增 `'mySignal'`）

**c. 四个常量对象**（均需新增 `mySignal` 条目）：

```typescript
SIGNAL_LABELS.mySignal = 'My 信号显示名'

SIGNAL_ORDER: SignalType[] = [..., 'mySignal']  // 决定显示顺序

SIGNAL_DEFAULTS.mySignal = () => ({
  mySignalKeyParam: DEFAULT_VALUE,
  mySignalOtherParam: 0,
})

SIGNAL_SENTINELS.mySignal = () => ({
  mySignalKeyParam: 0,   // 哨兵值 = 禁用
  mySignalOtherParam: 0,
})
```

**d. `deriveActive` 函数**（添加启用判断）：

```typescript
if (params.mySignalKeyParam !== 0) s.add('mySignal')
```

**e. template 中添加 UI 卡片**（在最后一个 `</template>` 信号块之后）：

```html
<!-- My 信号 -->
<template v-if="type === 'mySignal'">
  <n-form-item :show-feedback="false">
    <template #label>
      <span class="label-with-tip">参数名
        <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
          参数说明
        </n-tooltip>
      </span>
    </template>
    <n-input-number v-model:value="p.mySignalKeyParam" :min="..." :max="..." style="width:100%" size="small" />
  </n-form-item>
</template>
```

---

### 验证步骤

完成所有改动后，必须运行以下两条类型检查，确保**零新增报错**：

```bash
# 后端
cd apps/server && pnpm exec tsc --noEmit

# 前端
cd apps/web && pnpm exec vue-tsc --noEmit
```

---

## 执行指令

现在根据用户描述的新信号，按上述工作流逐步实现。先向用户确认：
1. 信号名称和触发条件是什么？
2. 参数有哪些？哪个作为启用哨兵？
3. 是否需要在 `bt-indicators.ts` 中预计算？
