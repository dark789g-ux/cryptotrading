# 02 · 详情弹窗（统计卡 + 直方图 + 逐笔明细）

[← 返回 index](./index.md) · [← 01 布局](./01-layout-and-list.md)

详情弹窗 = 可最大化的 `AppModal`，body 复用并改造 `SignalStatsResult.vue`。
对应**唯一一次 run**（`test.latestRun`），不再有历史运行表 / run 选择器。

```text
┌─ AppModal（maximizable，title=方案名）──────────────────────────────────┐
│ 配置摘要条: 固定5日 · 全市场 · 2025-01-01~2025-06-30 · 买入2条/卖出0条   │
│ ┌──────┬──────┬──────┬──────┐   ← n-grid 4 列网格，共 10 卡（末行 2 卡） │
│ │ 样本 │ 胜率 │ PF   │ 凯利 │                                          │
│ ├──────┼──────┼──────┼──────┤                                          │
│ │赔率b │均持仓│ 均盈 │ 均亏 │                                          │
│ ├──────┼──────┼──────┴──────┘                                          │
│ │最差  │最佳  │                ← 新增「最佳单笔」与「最差单笔」并排      │
│ └──────┴──────┘                                                        │
│ ┌─[ 收益率分布 ]─[ 逐笔明细 ]─────────────────────────────────────────┐ │
│ │  (n-tab-pane: 收益率分布)                                           │ │
│ │     <RetHistogram :run-id="latestRun.id" />                         │ │
│ │  (n-tab-pane: 逐笔明细)                                             │ │
│ │     <n-data-table 远程分页 50/页 标准样式>                          │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│ (status=running → 顶部 n-progress 进度条；status=failed → n-alert error) │
└──────────────────────────────────────────────────────────────────────────┘
```

## 1. 统计卡区（10 个）

沿用 `SignalStatsResult.vue:30-108` 的 `n-grid` + `n-statistic` 卡片结构，在「最差单笔」旁
**新增「最佳单笔」**。数据源全部来自 `test.latestRun`（完整 run 字段）：

| 显示标签 | 字段 | 格式 | tooltip |
|---|---|---|---|
| 样本数 | `sampleCount` | 整数 | — |
| 胜率 | `winRate` | 百分比 | 盈利笔数/总样本 |
| 赔率 b | `payoffRatio` | `.toFixed(3)`/`—` | 均盈/\|均亏\|；无亏损样本 null |
| 盈亏比 PF | `profitFactor` | `.toFixed(3)`/`—` | 总盈利/\|总亏损\| |
| 凯利 f* | `kellyF` | `.toFixed(3)`/`—` | Kelly 最优仓位 |
| 均持仓天数 | `avgHoldDays` | `.toFixed(2)` | — |
| 均盈 | `avgWin` | 百分比 | — |
| 均亏 | `avgLoss` | 百分比 | — |
| 最差单笔收益 | `worstTradeRet` | 百分比，负值红 | 历史最差单笔（min ret） |
| **最佳单笔收益**（新） | **`bestTradeRet`** | 百分比，正值绿 | 历史最佳单笔（max ret） |

> `bestTradeRet` 后端新增见 [03 文档](./03-backend-changes.md)「改动 A：新增最佳单笔」。前端
> `numeric` 列以 string 返回，展示前 `Number(x)`，null→`—`。

## 2. 进度 / 失败态（保留）

详情可能在 run 进行中或失败后被打开，保留 `SignalStatsResult.vue:5-26` 的两段：

- `status==='running'`：顶部 `n-progress`，标签 `扫描中 progressScanned/progressTotal`。
  此时统计卡与 tabs 不渲染（或显占位）。
- `status==='failed'`：`n-alert` error，显 `errorMessage`，兜底「未知错误」。
- `status==='completed'`：渲染统计卡 + tabs。

## 3. n-tabs：收益率分布 / 逐笔明细

用 `n-tabs`（`type="line"` 或 `segment`，与项目其它 tabs 一致），两个 `n-tab-pane`。

**懒加载机制钉死**：`n-tabs` 默认 `display-directive="show"`（≈ v-show，弹窗一打开就 mount 全部
pane，直方图会提前请求）。本设计用 **`display-directive="show:lazy"`**——pane 仅在**首次激活**时
mount、之后保活。`RetHistogram` / 明细表各自在自身 `onMounted` 取数（runId 经 prop 传入），即
「首次切到该 tab 才请求」。两个 pane 的取数时机由此统一，不再有「挂载 or 激活」两可。

### 3.1 Tab 1 — 收益率分布（直方图）

`<RetHistogram :run-id="latestRun.id" />`（新组件，见
[04 文档](./04-frontend-changes.md)「§4 RetHistogram.vue」）。

- 该 pane 首次激活 → `RetHistogram` mount → `onMounted` 调 `store.fetchRetHistogram(runId)`
  取分档数据（机制见上方「懒加载机制钉死」）。
- 用 ECharts 柱状图渲染，X 轴 = 分档区间标签（如 `[-4%,-2%)`），Y 轴 = count（频数，≥0）。
- **盈绿/亏红**：`itemStyle.color` 按档 `bin.sign`（`'win'`→绿 `#18a058`，`'loss'`→红
  `#d03050`），0 为分档边界，无跨色档（见 03 分档算法）。
- 边界：`bins` 为空（无完成 run / 0 样本）→ 显「暂无数据」占位（仿 `ShapBarChart.vue:5`）。

> **直方图 Y 轴是频数恒非负；X 轴 ret 含负半轴（亏损档）是正常且必要的**——看亏损侧形状正是
> 直方图价值。全胜 run 则只有绿档、无红档，正常渲染。

### 3.2 Tab 2 — 逐笔明细（标准表，注意②③）

按项目标准 `n-data-table` 规范开发，对齐「策略条件」表风格：
`<n-data-table :columns :data :loading :bordered="false" remote :pagination>`，远程分页
`pageSize=50`，数据走 `store.fetchTrades(runId, page, pageSize)`（沿用 `signalStats.ts`
现有接口 `GET /signal-tests/runs/:runId/trades`）。

列（沿用 `SignalStatsResult.vue:362-411` 的 `tradeColumns`，统一为标准 render 风格）：

| 列标题 | key | 渲染 |
|---|---|---|
| 标的 | `tsCode` | width=110 |
| 信号日 | `signalDate` | `formatTradeDate`（YYYYMMDD→YYYY-MM-DD） |
| 买入日 | `buyDate` | `formatTradeDate` |
| 出场日 | `exitDate` | `formatTradeDate` |
| 买入价 | `buyPrice` | `Number(x).toFixed(3)` |
| 出场价 | `exitPrice` | `Number(x).toFixed(3)` |
| 收益率 | `ret` | 百分比，正绿负红 |
| 持仓天数 | `holdDays` | 整数 |
| 出场原因 | `exitReason` | `max_hold`→强平 / `signal`→信号 / `delist`→退市，NTag |

> 「标准表格样式」指与策略条件/项目其它列表一致的 `n-data-table` 规范（`:bordered="false"` +
> render 列 + Naive 标准分页器）。若实现时发现项目已有共享表格封装组件，优先复用之。

## 4. 数据源与懒加载

- 统计卡 / 配置摘要：直接读 `test.latestRun`（list 接口已带回，无需额外请求）。
- 直方图：tab「收益率分布」首次激活时 `fetchRetHistogram(latestRun.id)`（懒加载）。
- 逐笔明细：tab「逐笔明细」首次激活时 `fetchTrades(latestRun.id, 1, 50)`（懒加载，沿用现状）。
- 关闭弹窗不清缓存（store 的 `tradesMap` 按 runId 索引，可复用）。

下一篇：[03 · 后端改动](./03-backend-changes.md)
