# 04 · 前端操作台

## 路由与文件

- 路由：`/portfolio-sim`（name `portfolio-sim`），Sidebar 策略组追加入口（RegimePicks 旁）。
- 文件（每文件 ≤500 行；views/strategy 不在 lint:quant-lines 强制范围但仓规一致）：

```text
apps/web/src/
├─ api/modules/strategy/portfolioSim.ts        API 封装（含 409 中文原文透传）
├─ views/strategy/PortfolioSimView.vue          页面骨架：列表 + 详情展开
└─ components/portfolio-sim/
   ├─ PortfolioSimCreateModal.vue               新建弹窗（三节表单）
   ├─ PortfolioSimDetail.vue                    详情：指标卡 + 锚点徽章 + 弃单分布
   ├─ PortfolioSimNavChart.vue                  净值曲线（仿 OosTrendChart）
   └─ PortfolioSimFillsTable.vue                逐信号明细（服务端分页）
```

## 页面布局

```text
┌─ 组合模拟 ───────────────────────────────────────────┐
│ [新建模拟]                                            │
│ ┌─ run 列表 ─────────────────────────────────────┐   │
│ │ 名称 | 状态(n-steps 三阶段/进度) | 年化 | 回撤  │   │
│ │      | 日kelly | 操作(运行/删除)               │   │
│ └────────────────────────────────────────────────┘   │
│ ┌─ 详情（选中行展开）──────────────────────────────┐ │
│ │ [锚点徽章：与官方 run 对账 ✓/✗ + 数字对照]        │ │
│ │ 指标卡×6：总收益/年化/最大回撤/Sharpe/日kelly/成本 │ │
│ │ ┌────────────────────────┐ ┌────────────────────┐ │ │
│ │ │ 净值曲线 ECharts        │ │ 弃单原因分布        │ │ │
│ │ │ (portfolio_sim_daily)   │ │ held/slots/cap/cash│ │ │
│ │ └────────────────────────┘ └────────────────────┘ │ │
│ │ 逐信号明细表（taken/skipped、源策略、日期段筛选）   │ │
│ └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

## 新建弹窗（三节）

```text
① 源策略（1~N，可增删行）
   每行：方案选择器（GET /api/signal-tests，解析最新 success run）
         或 [高级] 直接粘 run id
         + positionRatio（n-slider+输入框，% 后缀，仿 StrategyCapitalSection）
         + maxPositions（n-input-number，可空=不限）
         + exposureCap（n-slider，可空=不限；选中 0AMV 方案时缺省带出
           regime config v1 的 kellyFraction：Q3=0.33 / Q1=0.15）
         + 排序字段（n-select：pos_120 升序 / circ_mv 升序 / 无）
② 资金与成本
   initialCapital（n-input-number，缺省 1,000,000）
   成本档 radio：乐观 / 现实 / 保守 / 零成本 / 自定义（展开各费率输入）
   档位旁灰字注明解析后的合计双边费率
③ 锚点模式（n-switch + Tooltip）
   开 = 无约束+零成本，跑完详情页显示对账徽章；
   开启时 ①② 中被覆盖的项置灰并注明"锚点模式下强制"
```

## 运行态（照搬 signal-stats 既有模式）

- 全局单轮询器 2s 轮询所有 running 行的 `/progress`；页面挂载时 `resumeAllPolling`
  （刷新后恢复，不依赖内存 runningId）。
- 状态列 n-steps 三阶段（loading→replaying→writing）+ 进度数字。
- 触发 409 → 后端中文原文透传到 n-message。
- 无前端超时（曾因 10min 超时误杀长任务，已删，本模块不再引入）。

## 锚点徽章

详情页顶部，仅 anchorMode run 显示：`anchor_check.pass` 为 true → 绿色
"锚点对账通过：kelly 0.7245 = 0.7245 / win … / n 14364 = 14364"；false → 红色徽章
+ 两列数字对照表。把硬门禁做成界面可见的一等公民。

## 交互细节

- 列表分页用 `defaultPageSize`（受控 prop 陷阱已知，对齐 RegimePicksView 修法）。
- 明细表列：状态/源/ts_code/信号日/买入日/出场日/rank 值/权重/税后收益/弃单原因；
  服务端排序白名单透传。
- 删除需 n-popconfirm；running 中删除按钮置灰（后端也有 409 兜底）。
