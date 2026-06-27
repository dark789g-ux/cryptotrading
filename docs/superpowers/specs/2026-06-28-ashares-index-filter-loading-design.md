# A 股指数成分股跳转 Loading 修复（Design）

> 一句话目标：指数筛选相关操作（跨 tab 跳转、清除指数 tag）在数据加载完成前展示 loading + 空表，不再闪现旧默认列表（如「平安银行」）。

## 1. 背景与问题

用户在 **A 股数据 → A 股指数 → 申万指数** 点击某行（如「数字芯片设计」）的「成分股」，跳转到 **股票** 子 tab 时，会先看到默认全市场列表（按 `tsCode` 排序，`000001.SZ` 平安银行排第一），随后才切换为成分股列表。

**根因**：`ASharesTabsContainer.handleSwitchToStocks` 先同步切换 `subTab = 'stocks'`（面板立刻可见），再在 `nextTick` 中调用 `applyIndexFilter`。此时 `ASharesPanel` 仍持有上次 `onMounted → reload()` 的默认 rows，且 `loading = false`。Naive UI `n-data-table` 的 `:loading` 是在旧数据上方叠 spinner，**不会隐藏底层 rows**。

```text
当前时序（有 flash）：

  点击「成分股」
       │
       ▼
  subTab = 'stocks'          ← 面板立刻可见
       │                        rows = [平安银行, ...]  ← 旧默认列表
       │                        loading = false
       ▼
  nextTick → applyIndexFilter
       │
       ▼
  loadData() → loading = true → API → 成分股列表
```

## 2. 范围（已与用户确认：C）

| 场景 | 是否修复 |
|------|----------|
| 申万 / 同花顺指数 tab → 点击「成分股」→ 跳转股票 tab | ✅ |
| 股票 tab 内关闭「所属指数」tag（`clearIndexFilter`） | ✅ |
| 股票 tab 内再次应用另一指数筛选（`applyIndexFilter`） | ✅ |
| 翻页、排序、市场/行业等普遍筛选 | ❌ 保持现有行为 |
| `resetFilters` 全量重置 | ❌ 不在范围 |

## 3. 方案（已采纳：方案 A）

**指数筛选入口同步清空 rows + 调整 tab 切换顺序**，不引入新抽象层（无 `queryEpoch`、无 `loadData({ clearRows })` 参数）。

### 3.1 目标时序

```text
修复后：

  点击「成分股」
       │
       ▼
  applyIndexFilter（同步）
    ├─ indexFilter = { tsCode, name }
    ├─ rows = []
    ├─ loading = true
    ├─ page = 1
    └─ void loadData()
       │
       ▼
  subTab = 'stocks'          ← 面板可见时已是 loading + 空表
       │
       ▼
  API 返回 → rows = 成分股 → loading = false
```

### 3.2 UI 预期

```text
┌─────────────────────────────────────────┐
│ 筛选区  [所属指数: 数字芯片设计 ×]       │
├─────────────────────────────────────────┤
│                                         │
│            ⟳ 加载中…                     │  ← rows=[] + loading=true
│         （无旧数据行）                    │
│                                         │
└─────────────────────────────────────────┘
```

指数 tag 在 `applyIndexFilter` 同步赋值后立即显示；表格为空 + spinner，直到 API 返回。

## 4. 实现改动

### 4.1 `useASharesQuery.ts`

在 `applyIndexFilter` 与 `clearIndexFilter` 开头，于 `loadData()` 之前同步执行：

```ts
rows.value = []
loading.value = true
```

随后保持现有逻辑（更新 `indexFilter` / 置 null、`page = 1`、`void loadData()`）。

`loadData()` 内部已有 `loading.value = true`（`:124`），重复赋值无害。

**不在** `loadData()` 本身加通用清空逻辑——避免翻页/排序时表格闪空。

### 4.2 `ASharesTabsContainer.vue`

```ts
function handleSwitchToStocks(payload: { tsCode: string; name: string }) {
  stocksPanelRef.value?.applyIndexFilter(payload.tsCode, payload.name)
  subTab.value = 'stocks'
}
```

- 移除 `nextTick`：`display-directive="show:lazy"` 且默认 tab 为 `stocks`，`ASharesPanel` 在用户能点击指数成分股前已挂载，`stocksPanelRef` 非 null。
- 防御性写法（可选）：`if (!stocksPanelRef.value) return`，避免未来改默认 tab 或 mount 策略时静默失效。
- 先 filter 后切 tab，确保面板可见时状态已是 loading + 空表。

### 4.3 `ASharesPanel.vue`

无 API 变更；`defineExpose` 仍只暴露 `applyIndexFilter`。行为变化由 composable 承担。

## 5. 数据流（修复后）

```text
[申万/同花顺指数] 点击「成分股」
     │
     ▼ ASharesIndexSwPanel / ASharesIndexThsPanel
emit('jump-to-members') → ASharesIndexPanel → emit('switch-to-stocks')
     │
     ▼ ASharesTabsContainer.handleSwitchToStocks
applyIndexFilter(tsCode, name)     ← 同步：rows=[], loading=true, indexFilter 更新
subTab = 'stocks'
     │
     ▼ useASharesQuery.loadData()
POST /api/a-shares/query { indexTsCode }
     │
     ▼
rows = 成分股列表, loading = false
```

关闭指数 tag 路径：

```text
ASharesFilters @close → clearIndexFilter
  → rows=[], loading=true → loadData()（无 indexTsCode）→ 全市场列表
```

## 6. 错误处理

- `loadData()` 已有 `try/catch/finally`：`finally` 中 `loading = false`；失败时 `message.error`，rows 保持 `[]`（可接受，用户可点刷新）。
- 快速连续点击不同指数「成分股」：后一次 `applyIndexFilter` 会再次清空 rows；`loadData` 无 abort，存在竞态可能返回旧请求结果——**本次不修复**（原有问题，超出范围）。

## 7. 验证标准

| # | 操作 | 期望 |
|---|------|------|
| 1 | 申万指数 → 「数字芯片设计」→ 成分股 | 股票 tab 无「平安银行」闪现；先 spinner 空表，再显示成分股 |
| 2 | 同花顺指数 → 任意 .TI/.SI 指数 → 成分股 | 同上 |
| 3 | 股票 tab 有指数 tag → 关闭 tag | 不短暂显示旧成分股；loading 后显示全市场列表 |
| 4 | 已有指数 A → 回指数 tab → 点指数 B 成分股 | 不显示指数 A 的成分股 |
| 5 | 指数筛选生效后翻页 | 翻页时仍显示上一页数据 + loading 叠加（行为不变） |

### 可选单测

对 `useASharesQuery`（vitest + mock `aSharesApi.query`）断言：`applyIndexFilter` / `clearIndexFilter` 调用后、API resolve 前，`rows` 为空且 `loading === true`。

## 8. 不在范围

- 成分股按钮与行点击同时触发 K 线 modal（`ASharesIndexSwPanel` rowProps 未 stopPropagation）——独立 bug。
- `loadData` 请求竞态 / abortController。
- 后端 SQL / API 变更。
