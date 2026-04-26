# 凯利公式计算器 设计文档

**日期：** 2026-04-26  
**状态：** 已确认，待实现

---

## 1. 需求概述

在侧边栏新增"工具"菜单，点击进入工具页面，页面内包含凯利公式计算器，供用户输入交易参数后计算最优仓位比例。

---

## 2. 页面与路由

| 项目 | 值 |
|------|----|
| 路由路径 | `/tools` |
| 路由名称 | `tools` |
| 页面标题 | `工具 - CryptoTrading` |
| 侧边栏位置 | 在"系统设置"上方 |
| 侧边栏图标 | `CalculatorOutline`（@vicons/ionicons5）|
| 侧边栏标签 | `工具` |

---

## 3. 文件结构

```
apps/web/src/
├── views/
│   └── ToolsView.vue              # 工具页容器（未来可挂载多个工具）
├── components/
│   └── tools/
│       └── KellyCalculator.vue    # 凯利公式计算器组件
└── router/index.ts                # 新增 /tools 路由
```

侧边栏修改：`apps/web/src/components/layout/Sidebar.vue`

---

## 4. UI 设计

### 4.1 整体布局

- 紧凑卡片式（方案 A）：输入区与结果区在同一卡片内，上下排布
- 卡片最大宽度 640px，居左对齐（与页面其他内容一致）
- 页面标题：`凯利公式计算器` + 副标题 `Kelly Criterion — 计算最优仓位比例`

### 4.2 输入区（Tab 切换）

使用 Naive UI `n-tabs`，两个 Tab：

**Tab A：胜率 + 盈亏比**

| 字段 | 类型 | 说明 |
|------|------|------|
| 胜率 W (%) | number input | 范围 1–99，整数或小数 |
| 盈亏比 R | number input | 平均盈利 / 平均亏损，> 0 |
| 账户资金 ($) | number input | 可选，用于计算建议金额 |
| 自定义凯利分数 | number input | 范围 0–1，默认 0.5 |

公式：`f* = W − (1−W) / R`（W 为小数）

**Tab B：胜率 + 盈亏金额**

| 字段 | 类型 | 说明 |
|------|------|------|
| 胜率 W (%) | number input | 范围 1–99 |
| 平均每笔盈利 ($) | number input | > 0 |
| 平均每笔亏损 ($) | number input | > 0 |
| 账户资金 ($) | number input | 可选 |
| 自定义凯利分数 | number input | 范围 0–1，默认 0.5 |

公式：`f* = (W × avgWin − (1−W) × avgLoss) / avgWin`

### 4.3 结果区

结果**实时计算**（computed，无需点按钮）。

**3列主结果卡片：**

| 列 | 内容 |
|----|------|
| 完整凯利 | `f*` 百分比，绿色高亮；若有账户资金显示金额 |
| 半凯利 | `f* × 0.5`，黄色高亮；金额 |
| 四分之一凯利 | `f* × 0.25`，灰色；金额 |

**2列次要结果：**

| 列 | 内容 |
|----|------|
| 自定义仓位 | `f* × 自定义凯利分数`，显示百分比和金额 |
| 期望对数增长率 | `E = W·ln(1+f*·R) + (1−W)·ln(1−f*)` / 笔 |

### 4.4 负凯利警告

当 `f* ≤ 0` 时：
- 结果区数值不显示（或显示 `—`）
- 卡片下方显示红色警告：`⚠ 凯利值为负（当前参数无正期望），建议不入场。`
- 正常时警告隐藏

---

## 5. 计算逻辑

```ts
// Tab A
function calcKellyA(winRate: number, ratio: number): number {
  const w = winRate / 100
  return w - (1 - w) / ratio
}

// Tab B
function calcKellyB(winRate: number, avgWin: number, avgLoss: number): number {
  const w = winRate / 100
  return (w * avgWin - (1 - w) * avgLoss) / avgWin
}

// 期望对数增长率
function expectedGrowth(w: number, f: number, r: number): number {
  return w * Math.log(1 + f * r) + (1 - w) * Math.log(1 - f)
}
```

所有计算在 `computed` 中完成，输入变化时自动更新。

---

## 6. 组件边界

- `ToolsView.vue`：页面容器，仅负责标题和布局，引入 `KellyCalculator`
- `KellyCalculator.vue`：自包含，无 props/emits，无后端请求，纯前端计算
- 不涉及后端改动

---

## 7. 不在范围内

- 历史记录保存
- 多个计算器并列（预留 ToolsView 扩展位）
- 导出 CSV
