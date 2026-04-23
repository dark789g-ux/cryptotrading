---
name: vue-composable-side-effect
description: >
  在 Vue 3 + TypeScript 项目中，检查、修复和预防 Composable 副作用触发器被调用方漏接的问题。
  当用户编写或审查涉及 composable 封装弹窗懒加载、手动触发数据加载、popover/modal 数据获取的代码时触发。
  适用于 usePopoverData、useImportStrategies 等需要外部响应式状态与内部副作用绑定的场景。
---

# Vue Composable 副作用触发器检查

## 核心问题

Composable 封装了数据加载逻辑，但将"何时触发加载"的回调暴露给调用方。调用方解构时漏接该回调，导致弹窗/面板打开后数据永远不被加载。

### 典型症状

- Popover / Modal / Drawer 打开后列表为空
- 没有网络请求发出
- 无报错，仅表现为"无数据"

## 快速检查清单

编写或审查涉及 composable 的弹窗/面板代码时，逐条确认：

1. **Composable 是否暴露了触发器？** 检查返回值中是否有 `handleXxxShow`、`loadXxx`、`onXxxOpen` 等函数。
2. **调用方是否完整解构？** 检查组件中是否漏接了上述函数。
3. **调用方是否接入了生命周期？** 检查触发器是否被绑定到 `watch(showXxx)`、`@update:show` 或 `onMounted`。
4. **是否存在更优方案？** 优先让 composable 内部自行 `watch` 状态，减少对外暴露手动触发 API。

## 修复模板

### 方案 A：补接外部回调（最小改动）

```ts
// composable
export function useImportStrategies(propsRef: { strategy?: unknown }) {
  const showImportPopover = ref(false)
  const handlePopoverShow = (show: boolean) => {
    if (show) loadData()
  }
  // ...
  return { showImportPopover, handlePopoverShow, /* ... */ }
}

// 组件
const {
  showImportPopover,
  handlePopoverShow, // 1. 补回解构
} = useImportStrategies({ ... })

watch(showImportPopover, (v) => { // 2. 接入生命周期
  if (v) handlePopoverShow(true)
})
```

### 方案 B：内部自行 watch（推荐）

```ts
// composable
export function useImportStrategies(propsRef: { strategy?: unknown }) {
  const showImportPopover = ref(false)

  watch(showImportPopover, (v) => { // 内部绑定
    if (v) loadData()
  })

  // ...
  return { showImportPopover /* 不再暴露 handlePopoverShow */ }
}

// 组件
const { showImportPopover } = useImportStrategies({ ... })
// 无需手动连接，降低遗漏风险
```

## 判断标准

| 场景 | 推荐方案 |
|---|---|
| 多处复用，触发逻辑一致 | 方案 B（内部 watch） |
| 调用方需要自定义触发时机 | 方案 A，但必须在注释或文档中标注"必须接入手柄" |
