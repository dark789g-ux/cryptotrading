# 信号前向统计 — 导入已有方案按钮

## 目标

在 SignalStatsView 的标题栏「新建方案」按钮左侧添加一个「导入方案」按钮，用户点击后通过 Select 下拉选择一个已有方案，系统自动将其配置填入新建表单，用户可修改后保存为新方案（克隆）。

## 涉及文件

| 文件 | 改动类型 |
|---|---|
| `apps/web/src/views/strategy/SignalStatsView.vue` | 模板 + 脚本 |
| `apps/web/src/views/strategy/SignalTestForm.vue` | 新增 `prefillData` prop + watch |

## 设计

### 1. SignalStatsView.vue

#### 模板改动

在 `<template #header-extra>` 内，现有「新建方案」按钮左侧添加导入按钮：

```text
┌─ n-card header-extra ──────────────────────────────────────────┐
│  <n-popover> [导入方案 ▼]    [新建方案]                         │
│   ┌──────────────────────────────────┐                         │
│   │  <n-select                        │                         │
│   │    placeholder="选择已有方案..."    │                         │
│   │    :options="importOptions"        │                         │
│   │    @update:value="onImportSelect"  │                         │
│   │  />                               │                         │
│   └──────────────────────────────────┘                         │
│  </n-popover>                                                   │
└─────────────────────────────────────────────────────────────────┘
```

按钮 `disabled` 条件：`store.tests.length === 0`（无已有方案时不可导入）。

#### 新增状态

```ts
const importSource = ref<SignalTest | null>(null)
const showImportPopover = ref(false)
```

#### importOptions 计算属性

```ts
const importOptions = computed(() =>
  store.tests.map((t) => ({
    label: `${t.name}（${exitModeLabel(t.exitMode)} / ${t.universe.type === 'all' ? '全市场' : '指定标的'}）`,
    value: t.id,
  }))
)
```

其中 `exitModeLabel` 复用 SignalStatsTable 中已有的映射逻辑（`fixed_n` → '固定天数', `strategy` → '策略条件', `trailing_lock` → '移动止损'）。

#### onImportSelect 处理函数

```ts
function onImportSelect(testId: string) {
  const test = store.tests.find((t) => t.id === testId)
  if (!test) return
  importSource.value = test
  editingTest.value = null       // 确保走 create 分支
  showImportPopover.value = false
  showForm.value = true
}
```

#### 模板绑定

```html
<SignalTestForm
  ref="formRef"
  :initial-data="editingTest ?? undefined"
  :prefill-data="importSource ?? undefined"
  @submit="handleFormSubmit"
/>
```

#### 清理

在 `handleFormSubmit` 成功后，重置 `importSource.value = null`（与 `editingTest` 一起清理）。

### 2. SignalTestForm.vue

#### Props 扩展

```ts
interface Props {
  initialData?: SignalTest
  prefillData?: SignalTest    // 新增：导入预填（保存时走 create）
}
```

#### Watch 逻辑

扩展现有的 `watch(() => props.initialData, ...)` 逻辑，新增对 `prefillData` 的监听：

```ts
watch(
  () => props.prefillData,
  (data) => {
    if (!data) return
    if (props.initialData) return  // 编辑模式优先，不被 prefill 覆盖
    // 与编辑回填相同的映射逻辑
    const baseName = data.name.replace(/\s*\(副本\)\s*$/, '')
    form.value.name = baseName + ' (副本)'
    form.value.buyConditions = JSON.parse(JSON.stringify(data.buyConditions))
    form.value.exitMode = data.exitMode
    form.value.horizonN = data.horizonN
    form.value.exitConditions = data.exitConditions
      ? JSON.parse(JSON.stringify(data.exitConditions))
      : []
    form.value.maxHold = data.maxHold
    form.value.dateRange = [
      dayjs(data.dateStart, 'YYYYMMDD').valueOf(),
      dayjs(data.dateEnd, 'YYYYMMDD').valueOf(),
    ]
    form.value.universeType = data.universe.type
    form.value.tsCodesText = data.universe.tsCodes?.join('\n') ?? ''
  },
  { immediate: true }
)
```

注意：回填逻辑与编辑回填完全一致（可考虑抽取为共享函数 `fillFormFromTest(form, data, nameSuffix?)`，但不强制）。

## 数据流全景

```text
┌─────────────────────────────────────────────────────────────────┐
│  SignalStatsView                                                │
│                                                                  │
│  store.tests ──┬──► importOptions (Select 选项)                  │
│                │                                                  │
│  onImportSelect(id) ──┬── importSource = test                   │
│                       ├── editingTest = null                    │
│                       ├── showImportPopover = false             │
│                       └── showForm = true                       │
│                │                                                  │
│  ┌─────────────┴──────────────────────────────────────────────┐  │
│  │  AppModal (title: "新建方案")                                │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  SignalTestForm                                      │  │  │
│  │  │  :initial-data="editingTest ?? undefined"  ← null    │  │  │
│  │  │  :prefill-data="importSource ?? undefined" ← test    │  │  │
│  │  │                                                      │  │  │
│  │  │  watch(prefillData) → 回填 form + name + ' (副本)'    │  │  │
│  │  │  emit('submit', dto) → handleFormSubmit              │  │  │
│  │  │    └─ editingTest===null → store.createTest(dto) ✓   │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 边界情况

| 场景 | 处理 |
|---|---|
| 已有方案列表为空 | 导入按钮 disabled |
| Popover 中选择后不选直接关闭 | 无副作用 |
| 选择后修改表单再重新导入 | 重新预填覆盖当前内容（不做确认弹窗，与编辑模式下切换 initialData 行为一致） |
| 导入后点表格编辑 | `editingTest` 非 null，走正常编辑流程 |

## 不改动的部分

- Store / API 层：无需新增接口，复用已有的 `store.tests` 数据
- SignalStatsTable：无改动
- AppModal：无改动
