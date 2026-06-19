# KlineChart 初始挂载时按自定义 KDJ 参数自动重算

## 背景

在 e2e 测试中发现：当用户把 KDJ 参数改成非默认值（如 `N=6, M1=2, M2=2`）并持久化后，**刚打开 K 线图时**，设置面板显示自定义参数，但副图数据仍是后端按默认 `9/3/3` 预存的值，二者不一致。

之前的方案 2 已经补齐了后端 `recalc` 接口，并在各入口把 `recalc-indicators` 回调接入了 `KlineChart`。但 `KlineChart` 只在用户手动修改参数后触发 `recalcIndicators`，**不会**在初始数据加载完成后按已保存的自定义参数自动重算。

本设计在 `KlineChart` 内部增加"数据就绪后自动对齐参数"的逻辑，修复该问题。

---

## 目标

1. 刚打开 K 线图时，如果用户保存了自定义 KDJ 参数，图表数据必须按该参数重算并渲染。
2. 默认参数下不发起任何额外请求。
3. 切换标的（同一 KlineChart 实例复用）时，新数据到达后再次自动对齐。
4. 自动重算失败时给出提示，并保留用户自定义参数设置。

---

## 非目标

- 不改后端指标计算逻辑。
- 不改 `useKlineChartPrefs` 的持久化行为。
- 不新增除 KDJ 外的其他指标自动重算（架构预留扩展能力，但本次只实现 KDJ）。

---

## 方案概述

在 `KlineChart.vue` 内部，监听 `props.data` 从空数组变为非空数组的时刻：

- 检查 `prefs.value.params.KDJ` 是否存在且非默认。
- 若满足条件，调用 `props.recalcIndicators(prefs.value.params)`。
- 成功则父组件替换 `klineData`，图表自动重绘。
- 失败时由父组件传入的 `recalcIndicators` 自行负责提示（各父组件已在 catch 块中调用 `message.error` 并 rethrow），`KlineChart` 仅 catch 以避免未处理的 rejection，不额外弹提示。

关键点：**不在 `onMounted` 同步调用**，而是等父组件异步数据返回后再触发，避免与初始加载冲突。

---

## 数据流时序

```text
父组件 (WatchlistTable / CryptoSymbolsPanel / ...)
    │
    │  打开 K 线图
    ▼
加载初始数据: getKlines(...) / getKlineChart(...)
    │
    │  数据返回
    ▼
klineData.value = result      ──▶  props.data 从 [] ▶ [bar, ...]
    │                                     │
    │                                     ▼
    │                         KlineChart watch(props.data)
    │                                     │
    │                                     ▼
    │                         prefs.params.KDJ 自定义?
    │                                     │
    │                          否 ──────▶ 结束（默认参数，数据已对）
    │                          │
    │                          是
    │                          ▼
    │              recalcIndicators(prefs.value.params)
    │                          │
    │              ┌───────────┴───────────┐
    │              ▼                       ▼
    │           成功                      失败
    │              │                       │
    │              ▼                       ▼
    │    klineData.value = result    父组件已弹 toast
    │    图表渲染正确                  （recalcIndicators 内部处理）
    │                                  保留自定义参数
```

---

## 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `apps/web/src/components/kline/KlineChart.vue` | 修改 | 新增独立 watch 监听 `props.data` 长度；数据就绪后自动 recalc |
| `apps/web/src/composables/kline/subplotConfig.ts` | 修改（如需要） | 若 `isDefaultKdjParams` 尚未导出，则新增并导出；否则仅验证导入路径 |

---

## 详细设计

### 1. 修改 `KlineChart.vue`

新增导入：

```ts
import { isDefaultKdjParams } from '../../composables/kline/subplotConfig'
```

保持已有的 `props.data` watch 不变（继续负责 `renderChart`）：

```ts
watch(
  () => [props.data, props.currentTs, props.sliderStart, echartsTheme.value, subplots.value] as const,
  () => { void renderChart() },
  { immediate: true, deep: true },
)
```

新增一个独立的 `watch`，专门监听 `props.data` 长度变化，用于触发自动 recalc：

```ts
watch(
  () => props.data.length,
  async (nextLen, prevLen) => {
    if (!props.recalcIndicators) return
    if (prevLen !== undefined && prevLen > 0) return
    if (nextLen === 0) return

    const kdjParams = prefs.value.params?.KDJ
    if (!kdjParams || isDefaultKdjParams(kdjParams)) return

    try {
      await props.recalcIndicators(prefs.value.params)
    } catch (err) {
      // 父组件的 recalcIndicators 已在内部调用 message.error 并 rethrow。
      // 这里 catch 只是为了避免未处理的 rejection；不再额外弹提示。
      console.error('[KlineChart] auto recalc failed:', err)
    }
  },
  { immediate: true },
)
```

设计理由：

- 独立的 `watch` 不开启 `deep`，只观察 `props.data.length` 这个 number，避免父组件原地修改数组元素时 `oldData` / `newData` 指向同一引用导致的误判。
- `immediate: true` 确保组件挂载时若 `props.data` 已非空也能立即检查（虽然实际场景下挂载时 data 通常为 `[]`）。
- `prevLen !== undefined && prevLen > 0` 保证只在"从空到非空"时触发；若 data 从有到更有，不触发。

### 2. 父组件无需修改

所有已接入 `recalc-indicators` 的 9 个父组件都已在各自的 `recalcKdjIndicators` catch 块中调用 `message.error(...)` 并 `throw err`。因此：

- 自动 recalc 失败时，用户会收到错误提示（由父组件负责）。
- 自定义参数不会被重置（`KlineChart` 不会调用 `update({ params: ... })` 回滚）。
- 不需要新增 provide/inject 或修改顶层布局。

---

## 边界情况

| 场景 | 预期行为 |
|---|---|
| 默认参数 9/3/3 | `isDefaultKdjParams` 返回 true，不触发自动 recalc |
| 自定义参数但初始数据为空 | 等待数据到达；数据未到达前不发起请求 |
| 父组件初始数据加载失败 | `props.data` 保持为空，不触发自动 recalc |
| 自动 recalc 接口失败 | 父组件 `recalcKdjIndicators` 内部已弹 toast；`KlineChart` 仅 catch 避免未处理 rejection；自定义参数保留；图表显示默认数据 |
| 切换标的 | data 先空后非空，自动 recalc 再次触发 |
| keep-alive 组件复用 | 只有 data 再次从空变非空时才触发，避免重复请求 |
| 用户手动改参数 | 仍走现有 `watch(prefs.value.params)` 逻辑；本逻辑不重复触发 |

**关于切换标的的约束：**

自动 recalc 在"data 长度从 0 变为 >0"时触发。因此当同一 `KlineChart` 实例被复用、且需要为新标的自动重算时，父组件必须先把 `klineData.value` 置为空数组，再赋新值。当前所有父组件（如 `CryptoSymbolsPanel.openChart`）均遵循此模式：先清空、再异步加载、再赋值。若未来新增入口直接覆盖非空数组，则切换标的后不会触发自动 recalc。

---

## 错误处理

`KlineChart` 不直接调用 UI toast。

自动 recalc 调用的 `props.recalcIndicators` 由各父组件实现。当前所有父组件的实现模式为：

```ts
catch (err: unknown) {
  message.error(err instanceof Error ? err.message : String(err))
  throw err
}
```

因此：

- 自动 recalc 失败时，错误提示已由父组件弹出。
- `KlineChart` 在自己的 `try/catch` 中捕获该错误并打印 `console.error`，仅为了避免未处理的 Promise rejection。
- 自定义参数不会被重置，保持用户设置不变。

---

## 测试策略

### 单元测试

在 `apps/web/src/components/kline/__tests__/KlineChart.spec.ts`（如存在）或新建测试文件中覆盖：

1. **默认参数不触发 recalc**
   - `props.data` 从空变非空，默认 KDJ 参数
   - 断言 `recalcIndicators` 未被调用

2. **自定义参数触发 recalc**
   - `props.data` 从空变非空，`prefs.params.KDJ = { n: 6, m1: 2, m2: 2 }`
   - 断言 `recalcIndicators` 被调用一次，参数为 `{ KDJ: { n: 6, m1: 2, m2: 2 } }`

3. **recalc 失败不重置参数、不抛未处理 rejection**
   - mock `recalcIndicators` 返回 rejected Promise
   - 断言 `console.error` 被调用
   - 断言自定义参数未被重置

4. **长度不变时不重复触发**
   - `props.data` 已非空后再次 push 一根 bar（长度不变）
   - 以及直接把 `[bar1]` 替换为 `[bar2]`（长度不变）
   - 断言 `recalcIndicators` 只被调用一次

### e2e 回归

复现 e2e 测试中发现的 Crypto 场景：

1. 进入 标的工作台 → 加密标的 → 打开 `0GUSDT` K 线图。
2. 把 KDJ 参数改为 `6/2/2`，点击确定，关闭图表。
3. 重新打开同一图表。
4. 验证：
   - 设置面板显示 `KDJ(6,2,2)`。
   - 图表最新一根 K 线的 K/D/J 值与按 `6/2/2` 手动计算结果一致，与 `9/3/3` 不一致。

---

## 兼容性

- 本次改动仅影响 `KlineChart.vue`，新增一个独立的 `watch`。
- 所有已接入 `recalc-indicators` 的 9 个父组件无需修改，自动受益。
- 不修改 `useKlineChartPrefs`、`subplotConfig` 的公开 API（仅导入 `isDefaultKdjParams`）。
- 不需要新增 provide/inject 或修改顶层布局。

---

## 验收标准

- [ ] `KlineChart.vue` 新增独立 `watch(() => props.data.length, ...)`，在 data 从空变非空时，对自定义 KDJ 参数自动调用 `recalcIndicators`。
- [ ] 默认参数下无额外 recalc 请求。
- [ ] 自动 recalc 失败时不重置自定义参数，且不产生未处理 rejection。
- [ ] 确认各父组件 `recalcIndicators` 均在 catch 中调用 `message.error` 并 rethrow（保证错误提示仍由父组件负责）。
- [ ] 单元测试覆盖默认参数、自定义参数触发、失败处理、以及长度不变时不重复触发四种场景。
- [ ] e2e 复测 Crypto 入口，确认刚打开时数据与参数一致。
