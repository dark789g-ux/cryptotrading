# A 股指数面板净流入列正负着色 + 单位口径修正

> 日期：2026-06-29
> 范围：前端单文件改动（`apps/web/src/components/symbols/a-shares-index/aSharesIndexColumns.ts`）+ 单测扩展
> 状态：已批准，待实现

## 背景与目标

A 股指数面板（申万区 `ASharesIndexSwPanel`、同花顺区 `ASharesIndexThsPanel`）的 `n-data-table` 中，7 个「净流入」相关列当前是**纯文本、无颜色**，且数值格式化口径有 bug。本次：

1. **主目标**：7 个净流入列按数值正负着色——**正数绿、负数红**（与项目既有「绿涨红跌」约定一致，非中国传统红涨绿跌）。
2. **顺带修复**：把这 7 列的格式化函数从 `formatAmount`（千元口径）改为 `formatMoneyFlow`（万元口径），修正净流入字段单位换算 bug。

### 顺带修复的依据（确凿 bug，已落源头核实）

- `aSharesFormatters.ts:35` 的 `formatMoneyFlow` 函数注释明确其设计用途即为净流入：**「net_amount 单位为万元，禁用千元口径的 formatAmount」**——即万元口径字段本应走 `formatMoneyFlow`。
- 但 `aSharesIndexColumns.ts` 这 7 列当前未使用它，用的是千元口径的 `formatAmount`，导致单位换算错误。
- 数值后果：`formatAmount` 进「亿」阈值是 `100000`（为千元口径设计），而净流入是万元口径。当某净流入真实值 ≥ 10 亿元（字段值 ≥ 100000 万元）时，`formatAmount` 显示成 **1/10**（真实 10 亿 → 显示「1.00 亿」）。申万整个行业板块净流入易破 10 亿，bug 实际会触发。
- 隔壁个股列表 `aSharesColumns.ts` 用的正是正确的 `formatMoneyFlow`，本次令两者对齐。

## 影响面

```text
                aSharesIndexColumns.ts
              createASharesIndexColumnDefs()
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
  ASharesIndexSwPanel.vue     ASharesIndexThsPanel.vue
     (申万区, showValuation=true)  (同花顺区)
```

该列工厂被**两个面板复用**，故着色 + 单位修正**同时生效于两者**（一致性，预期内）。`*.vue` 面板本身**不改**——它们只消费列工厂产物。

## 现状（改动前）

7 列当前 render 形如（`aSharesIndexColumns.ts:133-188`）：

```ts
{
  title: '净流入',
  key: 'net_amount',
  width: 120,
  sorter: true,
  defaultVisible: false,
  render: (row) => formatAmount(toStr(row.netAmount)),   // ← 无色 + 错误口径
},
// ...其余 6 列同构
```

同文件已具备的可复用件：

```ts
// aSharesIndexColumns.ts:32-37  —— 通用「按正负取涨跌色」，涨跌幅列已在用
function pctColor(value: number | null): string | undefined {
  if (value == null) return undefined
  if (value > 0) return colors.success.DEFAULT   // 绿 #0ECB81
  if (value < 0) return colors.error.DEFAULT     // 红 #F6465D
  return undefined                               // 0 / null 无色
}

// aSharesIndexColumns.ts:28-30  —— number|null → string|null（适配 formatter 签名）
function toStr(value: number | null): string | null {
  return value == null ? null : String(value)
}
```

字段类型（`types.ts`）：7 个字段均为 `number | null`，单位**万元**。

## 设计方案

采用「抽本地 helper」方案（DRY，一次改 7 列收益明显）：

### 1. 新增本地 helper

在 `aSharesIndexColumns.ts` 内（紧邻 `pctColor`）新增：

```ts
/** 资金净流入单元格：正绿负红着色 + 万元口径格式化（pctColor 为通用正负着色，名字沿用历史） */
function renderMoneyFlowCell(value: number | null) {
  const color = pctColor(value)
  return h('span', { style: color ? { color } : undefined }, formatMoneyFlow(toStr(value)))
}
```

### 2. import 调整

```ts
// 新增 formatMoneyFlow；formatAmount 仍保留（成交额 amount 列继续用，单位是千元，不动）
import {
  formatAmount,
  formatMoneyFlow,   // ← 新增
  formatMarketCap,
  formatNumber,
  formatPercent,
  formatTradeDate,
  trendClass,
} from '../a-shares/aSharesFormatters'
```

### 3. 7 列 render 改写

```text
net_amount     → render: (row) => renderMoneyFlowCell(row.netAmount)
net_amount_5d  → render: (row) => renderMoneyFlowCell(row.netAmount5d)
net_amount_10d → render: (row) => renderMoneyFlowCell(row.netAmount10d)
net_amount_20d → render: (row) => renderMoneyFlowCell(row.netAmount20d)
buy_lg_amount  → render: (row) => renderMoneyFlowCell(row.buyLgAmount)
buy_md_amount  → render: (row) => renderMoneyFlowCell(row.buyMdAmount)
buy_sm_amount  → render: (row) => renderMoneyFlowCell(row.buySmAmount)
```

其余列（含 `amount` 成交额仍用 `formatAmount`）一律不动。

## 着色规则与边界

```text
┌─────────────┬───────────────────────────┬──────────────────────────┐
│  值          │  颜色                      │  formatMoneyFlow 文本      │
├─────────────┼───────────────────────────┼──────────────────────────┤
│  value > 0  │  绿 #0ECB81 (success)      │  "5.00 亿" / "320.00 万"  │
│  value < 0  │  红 #F6465D (error)        │  "-3.00 亿"               │
│  value == 0 │  无色（默认文本色）         │  "0.00 万"                │
│  null/NaN   │  无色                      │  "—"（em dash）           │
└─────────────┴───────────────────────────┴──────────────────────────┘
```

数据流：

```text
row.netAmount (number|null, 万元)
        │
        ├──▶ pctColor(value) ──────────▶ color: string | undefined
        │
        └──▶ formatMoneyFlow(toStr(v)) ─▶ text: "x.xx 亿/万" | "—"
                        │
                        ▼
            h('span', { style: color?{color}:undefined }, text)
```

### 需点明的行为变化

- **空值占位符从 `-` 变为 `—`（em dash）**：这是 `formatMoneyFlow` 既有行为（`formatAmount` 返回 `-`），与隔壁个股列表统一，属可接受的视觉一致化。
- **0 值不着色**：沿用 `pctColor` 既有语义（`> 0` 绿 / `< 0` 红 / `== 0` 无色），与涨跌幅列一致。

## 测试策略

扩展现有 `aSharesIndexColumns.spec.ts`（沿用其 `renderText(node)` 取文本 + `vnode.props.style` 取色的风格），新增一个 `describe('净流入列着色与口径', ...)`，覆盖：

| 用例 | 输入（netAmount） | 断言文本 | 断言颜色 |
|------|------------------|----------|----------|
| 正值进亿 | `50000`（万元=5亿） | 含 `亿`（验证用 formatMoneyFlow 而非 formatAmount） | `colors.success.DEFAULT` |
| 正值万级 | `320` | `"320.00 万"` | `colors.success.DEFAULT` |
| 负值 | `-30000` | 含 `亿` | `colors.error.DEFAULT` |
| 0 值 | `0` | `"0.00 万"` | `style` 无 color |
| null | `null` | `"—"` | `style` 无 color |

代表列取 `net_amount`，并抽查 1 个分单列（如 `buy_lg_amount`）确认改写一致。颜色断言读 `(vnode as any).props?.style?.color`。

> 关键回归点：用 `50000` 这个值同时验证「着色」与「口径修正」——旧 `formatAmount(50000)` 输出 `"50000.00 万"`，新 `formatMoneyFlow(50000)` 输出 `"5.00 亿"`，断言含「亿」即可锁死口径已修正。

真机红绿观感可选派 `browser-tester` 验证（非必须）。

## 验证命令

```text
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web test
```

改动仅 `.ts`（非 `.vue`），无 SFC 编译风险，无需 `vite build`。

## 非目标（YAGNI）

- 不改任何 `.vue` 面板文件。
- 不调整 `amount` 成交额列（千元口径，`formatAmount` 正确）。
- 不重命名 `pctColor`（沿用，避免扩大改动面）。
- 不新增列、不改列宽 / 排序 / 默认可见性。
- 不引入主题切换、不做红涨绿跌可配置化。
