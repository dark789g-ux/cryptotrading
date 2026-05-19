---
title: 量化子菜单视觉差异化设计
date: 2026-05-19
scope: apps/web/src/components/layout/Sidebar.vue
status: ready-for-review
---

# 量化子菜单视觉差异化（Quant Submenu Visual Hierarchy）

## 背景

侧边栏顶级菜单"量化"是当前唯一带 children 的菜单组，子项包括：总览 / 评分 / 训练 Run / 作业队列。当前实现下子菜单除了缺少图标外，字号、颜色、缩进与顶级项几乎一致，**层级感弱**，用户无法一眼分辨"这 4 项是量化模块的下属"。

此外现有实现还有一处语义瑕疵：父项"量化"的 `key` 与子项"总览"的 `key` 都是 `quant-overview`，父项被点击时直接跳到总览，"分组容器 + 跳转入口"两个角色被压在同一个 key 上。

## 目标

1. 弱化子菜单的视觉权重，让"4 个子项是量化模块的下属"在不读文字的情况下也可被感知。
2. 让父项"量化"的语义回归为纯粹的"展开/收起分组"，跳转动作交给子项"总览"。
3. 改动只涉及 `Sidebar.vue` 一处，不动路由、不动主题 token、不影响其他菜单项。

## 非目标

- 不引入新菜单图标库。
- 不重构菜单数据源（继续硬编码在 `Sidebar.vue` 的 `menuOptions` 中）。
- 不调整折叠侧边栏（窄态 64px）下的 popover 行为，沿用 naive-ui 默认。
- 不为父项添加未读小红点 / 模块徽标。

## 交互行为

### 父项与子项的职责拆分

| 角色 | key | 点击行为 |
|---|---|---|
| 父项"量化" | `quant`（新） | 仅切换展开 / 收起，**不**跳路由 |
| 子项"总览" | `quant-overview`（沿用） | 跳 `/quant/overview` |
| 子项"评分" | `quant-scores`（沿用） | 跳 `/quant/scores` |
| 子项"训练 Run" | `quant-runs`（沿用） | 跳 `/quant/runs` |
| 子项"作业队列" | `quant-jobs`（沿用） | 跳 `/quant/jobs` |

### 展开 / 收起

- **默认收起**：首次进入网站、未命中 `quant-*` 路由时，"量化"以收起态出现。
- **路由命中时自动展开**：当前路由 name 命中 `quant-overview` / `quant-scores` / `quant-runs` / `quant-jobs` 任一时，"量化"在挂载即自动展开，且子项命中态高亮。naive-ui `n-menu` 的 `:expanded-keys` 受控属性可承担这一逻辑。
- **手动切换不丢失**：用户点击"量化"展开/收起的状态不持久化到 localStorage（YAGNI），下次刷新仍按"路由命中即展开"逻辑还原。
- **窄态（collapsed=true）**：保留 naive-ui 默认 popover 弹出行为，子项以浮层形式出现，无需额外差异化。

### activeKey 计算

- 现有 `activeKey` 计算逻辑通过路由 name 前缀匹配决定（[Sidebar.vue:84-88](apps/web/src/components/layout/Sidebar.vue#L84)），子项 key 与路由 name 一一对应，无需改动。
- naive-ui `n-menu` 在子项被选中时会自动给父项加"路径态"（一般是颜色变深 / 加粗），无需手动维护父项高亮。

## 视觉差异化

整体方针：**弱化**（subtle）—— 通过缩进、字号、颜色三个维度让子项"退后一档"，再加一条 1px 浅灰竖线把 4 个子项串成一组。

### 布局示意

```text
┌─────────────────────────────────────┐
│ 📊 策略回测                         │
│ ≡  标的筛选                         │
│ 🔄 数据同步                         │
│ 🔖 自选列表                         │
│ 📈 策略条件                         │
│ ⇄  资金流向                         │
│ 📰 每日复盘                         │
│ 📊 量化                       ⌃    │  ← 父项保持顶级样式
│    │  总览                          │  ← 子项：缩进对齐到"文字起点"
│    │  评分                          │     左侧 1px 浅灰竖线串联
│    │ ▎训练 Run                      │  ← 选中：左 3px 色条 + 橙色淡底
│    │  作业队列                      │
│ 🔧 工具                             │
│ ⚙  系统设置                         │
└─────────────────────────────────────┘
```

注：上图中 `│` 是子菜单整组左侧的 1px 竖线，`▎` 是选中态的 3px 主色条。

### 样式参数

| 维度 | 顶级项 | 量化子项 | 备注 |
|---|---|---|---|
| 字号 | 14px（现状） | 13px | 小 1px 即可，差 2px 会破坏阅读节奏 |
| 行高 | 36px（现状） | 32px | 紧凑一档 |
| 文字颜色（默认） | `var(--color-text)` | `var(--color-text-muted)` | 淡一档传递从属 |
| 文字颜色（hover） | `var(--color-text)` | `var(--color-text)` | hover 回正常 |
| 文字颜色（选中） | `var(--color-primary)` | `var(--color-primary)` | 选中态与顶级一致 |
| 图标 | 18px @vicons | 无 | 子项不配图标 |
| 文字左起点 | ~44px（含 16px padding + 18px icon + 10px gap） | 44px（无图标，靠 padding-left 撑） | **关键**：子项文字左边缘与顶级项文字左边缘对齐 |
| 选中态背景 | 现状（橙色淡底） | 现状（橙色淡底） | 沿用 `n-menu-item-content--selected` |
| 选中态左色条 | 现状（3px primary） | 现状（3px primary） | 沿用现有覆写 |
| 整组左竖线 | — | 1px `var(--color-border)` α30% | 位于 padding-left ≈ 28px 处，纵贯 4 个子项 |

### 设计要点

1. **文字起点对齐**是层级感的核心：让子项的文字左边缘与顶级项的文字左边缘对齐（视觉上"图标位被让出"），用户立刻能感知子项在结构上"属于上一项"。
2. **颜色淡一档**用现有 token `--color-text-muted`，避免引入新颜色变量。hover 时回到正常色，保持可读性。
3. **左侧 1px 竖线**用 `var(--color-border)` 加 alpha 30% 实现，颜色噪音最低；通过 `:deep(.n-submenu-children)::before` 或单独 `<i>` 元素绘制，不破坏 n-menu 内部 DOM。
4. **不改选中态样式**：选中态沿用 `n-menu-item-content--selected` 现有覆写，避免引入子菜单专属的选中态视觉。

## 实现要点

### 1. `menuOptions` 修改

`apps/web/src/components/layout/Sidebar.vue` 的 `menuOptions` 中，将量化父项的 `key` 从 `quant-overview` 改为 `quant`：

```ts
{
  label: '量化',
  key: 'quant',                       // 改：原 'quant-overview'
  icon: renderIcon(StatsChartOutline),
  children: [
    { label: '总览',     key: 'quant-overview' },
    { label: '评分',     key: 'quant-scores' },
    { label: '训练 Run', key: 'quant-runs' },
    { label: '作业队列', key: 'quant-jobs' },
  ],
},
```

### 2. 展开态控制

引入 `expandedKeys` 受控属性：

```ts
const QUANT_CHILD_KEYS = ['quant-overview', 'quant-scores', 'quant-runs', 'quant-jobs'] as const

const expandedKeys = ref<string[]>([])

// 路由变化时，命中量化子项则展开
watch(
  () => route.name,
  (name) => {
    if (typeof name === 'string' && QUANT_CHILD_KEYS.includes(name as any)) {
      if (!expandedKeys.value.includes('quant')) {
        expandedKeys.value = [...expandedKeys.value, 'quant']
      }
    }
  },
  { immediate: true },  // 首次挂载也要响应（参见 CLAUDE.md Vue 3 watch 规范）
)

const handleExpandedKeysChange = (keys: string[]) => {
  expandedKeys.value = keys
}
```

模板：

```html
<n-menu
  :options="menuOptions"
  :value="activeKey"
  :expanded-keys="expandedKeys"
  @update:expanded-keys="handleExpandedKeysChange"
  ...
/>
```

### 3. 样式覆写

在 `<style scoped>` 末尾新增：

```scss
// 子菜单（量化组）弱化样式
:deep(.n-submenu-children) {
  position: relative;

  // 整组左侧 1px 竖线
  &::before {
    content: '';
    position: absolute;
    left: 28px;
    top: 4px;
    bottom: 4px;
    width: 1px;
    background-color: var(--color-border);
    opacity: 0.3;
    pointer-events: none;
  }

  .n-menu-item {
    height: 32px;
  }

  .n-menu-item-content {
    padding-left: 44px !important;  // 与顶级项文字起点对齐
    font-size: 13px;
    color: var(--color-text-muted);

    &:hover {
      color: var(--color-text);
    }

    &--selected,
    &--selected:hover {
      color: var(--color-primary);
    }
  }
}
```

注：`44px` 需根据实际渲染微调，开发时打开 DevTools 量一下顶级项文字左边缘像素，把 `padding-left` 对齐到同一像素。

## 改动范围

仅 [apps/web/src/components/layout/Sidebar.vue](apps/web/src/components/layout/Sidebar.vue) 一处文件：

- `menuOptions` computed：父项 key 改名为 `quant`。
- `<script setup>`：新增 `expandedKeys` ref、`watch(route.name)`、`handleExpandedKeysChange` 处理函数；引入 `QUANT_CHILD_KEYS` 常量。
- `<template>`：`<n-menu>` 增加 `:expanded-keys` 与 `@update:expanded-keys` 绑定。
- `<style scoped>`：新增 `:deep(.n-submenu-children)` 段落（约 30 行）。

**不动**：路由配置、其他菜单项、全局主题 token、`Layout.vue`、`AuthGuard`。

## 验证

- **手动验证**：
  1. 刷新进入 `/backtest` 等非量化页面，"量化"应收起。
  2. 直接访问 `/quant/overview`，"量化"自动展开，"总览"高亮。
  3. 在量化子页面间切换，展开态保持。
  4. 点击"量化"父项，仅切换展开/收起，URL 不变。
  5. 子项的字号、颜色、左侧竖线视觉上明显比顶级项"轻"。
  6. 折叠侧边栏（点击 logo 旁的折叠按钮），"量化"以 popover 形式弹出 4 个子项。

- **回归点**：
  - `activeKey` 计算不应受影响（子项 key 未变）。
  - 折叠态下 popover 样式不应被新增的 `:deep(.n-submenu-children)` 选择器误伤；如有误伤，将选择器收紧为 `:deep(.n-menu:not(.n-menu--collapsed) .n-submenu-children)`。

- **不需要自动化测试**：纯视觉 + 局部交互改动，没有可断言的业务逻辑。

## 风险与权衡

| 风险 | 缓解 |
|---|---|
| `:deep(.n-submenu-children)` 选择器若 naive-ui 升级改 class 名会失效 | 锁版本；升级时手动验证侧边栏 |
| `padding-left: 44px` 是经验值，主题改动可能需要重新对齐 | 注释中标注"需与顶级项文字左边缘对齐"，并在 PR 描述附 DevTools 截图 |
| `watch(route.name)` 加 `immediate: true` 必须严格遵守 CLAUDE.md 的 Vue 3 watch 规范，否则首次进入量化子页时不展开 | 已在实现示例中写明 |

## 未来可扩展

- 若后续其他顶级菜单（如"系统设置"）也需要 children，本方案的 `:deep(.n-submenu-children)` 选择器是**全局生效**的——这正是设计意图（保持视觉一致）。若届时希望某些组用不同视觉，再按组别加 key-scoped 覆写。
