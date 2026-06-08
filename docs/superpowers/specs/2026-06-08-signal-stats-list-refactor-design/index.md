# 信号前向统计：内容区改全宽方案表 + 详情弹窗（含收益率直方图）设计

> 创建日期：2026-06-08
> 关联功能：信号前向统计（A 股买入条件触发后前向胜率/盈亏比）
> 关联前序 spec：`../2026-06-07-signal-forward-stats-design/`（功能本体设计）

## 背景与目标

「信号前向统计」当前页面（`apps/web/src/views/strategy/SignalStatsView.vue`）是
**左侧 220px 窄方案列表 + 右侧常驻详情面板** 的主从布局，右侧详情常驻渲染统计卡 +
历史运行表 + 逐笔明细表。

本次重构把内容区改造为**「策略条件」那样的全宽数据表格**：每行 = 一个方案
（test），直接在表格里展示该方案最新一次运行的关键指标；点击行 → 用一个**可最大化的
AppModal 详情弹窗**展示完整统计、收益率分布**直方图**、逐笔明细。

### 已确认的关键决策（brainstorming 结论）

1. **列表主体**：一行 = 一个方案（test）。去掉左窄列表，内容区改全宽 `n-data-table`。
2. **详情载体**：可最大化的 `AppModal` 弹窗（与编辑表单各一个 modal，互斥不叠加）。
3. **直方图**：只画**收益率（ret）分布**，盈绿/亏红、0 为分档边界；数据走**后端新增
   分档接口**（不在前端拉全量明细自己分档）。
4. **详情内 tabs**：**收益率分布**与**逐笔明细**用 `n-tabs` 切换，不纵向堆叠。
5. **去掉历史运行对比表**：test 是一次性的、不重复跑，详情只对应那唯一一次 run。
6. **新增「最佳单笔」**：与现有「最差单笔」对称，需后端新增 `best_trade_ret` 列。
7. **逐笔明细表**：按项目标准 `n-data-table` 规范开发（对齐「策略条件」表风格）。

### 非目标（本次不做）

- 多 horizon（+1d/+3d/+5d/+10d）叠加分布：现模型每次 run 只算一个 horizon，超范围。
- 持仓天数分布直方图：本次只做收益率分布。
- 按 symbol 维度聚合：现无后端接口，本次不引入。
- run 选择器 / 历史多次运行对比：test 一次性，去掉。

## 子文档清单与阅读顺序

按下列顺序阅读：

1. [01-layout-and-list.md](./01-layout-and-list.md) — 总体布局、全宽方案表、列设计（注意①）、交互与
   ASCII wireframe。
2. [02-detail-modal.md](./02-detail-modal.md) — 详情弹窗内容：配置摘要、10 个统计卡、
   `n-tabs`[收益率分布][逐笔明细]、直方图渲染、逐笔明细标准表（注意②③）。
3. [03-backend-changes.md](./03-backend-changes.md) — 后端三处改动：list 补 latestRun、
   新增 ret-histogram 接口与分档算法、`best_trade_ret` 列 + metrics + migration。
4. [04-frontend-changes.md](./04-frontend-changes.md) — 前端文件拆分、API 类型、store
   action、`RetHistogram.vue` 组件、数据流与轮询。
5. [05-testing-and-verification.md](./05-testing-and-verification.md) — 单测、构建、真机
   验证清单、边界与风险。

## 跨文档引用约定

- 子文档间用**相对路径文件级链接** + 正文括注章节名，例如
  `[03 文档](./03-backend-changes.md)（改动 C：ret-histogram 接口）`。**不**用 `#锚点`
  片段——本仓标题含中文/序号/反引号，GitHub 式 slug 生成结果不稳，锚点易失效。
- 代码位置一律 `file:line` 为证，禁凭模块名/变量名推断。
- 所有进 SQL 硬编码的表名/列名均已落实体定义核对（见 03 文档头部「已核对事实」）。

## 受影响文件总览

后端（`apps/server/src/`）：

| 文件 | 改动 |
|---|---|
| `strategy-conditions/signal-stats/signal-stats.controller.ts` | 加 `GET runs/:runId/ret-histogram` |
| `strategy-conditions/signal-stats/signal-stats.service.ts` | `findAll` 补 latestRun；加 `getRetHistogram` |
| `strategy-conditions/signal-stats/signal-stats.metrics.ts` | `calcSignalStats` 加 `bestTradeRet` |
| `strategy-conditions/signal-stats/signal-stats.runner.ts` | 落库 `update` 加 `bestTradeRet`（:157-171） |
| `entities/strategy/signal-test-run.entity.ts` | 加 `bestTradeRet` 列 |
| `migrations/20260608_*_signal_test_run_best_trade_ret.{sql,ps1}` | 新建：加列 + 回填存量 |

前端（`apps/web/src/`）：

| 文件 | 改动 |
|---|---|
| `views/strategy/SignalStatsView.vue` | 重写为全宽表格容器 + 详情/编辑两弹窗编排 |
| `views/strategy/SignalStatsTable.vue` | 新建：表格列定义 |
| `views/strategy/SignalStatsResult.vue` | 改造为详情弹窗主体：删历史表、加 tabs + 直方图 |
| `components/strategy/RetHistogram.vue` | 新建：ECharts 收益率直方图 |
| `api/modules/strategy/signalStats.ts` | `SignalTest.latestRun?`、`bestTradeRet`、`getRetHistogram` |
| `stores/signalStats.ts` | 加 `fetchRetHistogram`；run 完成后刷新 tests |
