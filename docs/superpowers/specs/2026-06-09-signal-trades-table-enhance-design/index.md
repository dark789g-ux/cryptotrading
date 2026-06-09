# 信号逐笔明细表增强 — 设计 spec（入口）

> 日期：2026-06-09 ｜ 主题：signal-trades-table-enhance ｜ 状态：待评审

## 背景与目标

在 `apps/web/src/views/strategy/SignalStatsResult.vue` 的「逐笔明细」表格（NaiveUI `n-data-table`，当前 `remote` 服务端分页）上补齐交互能力，并支持单笔交易回看 K 线：

1. **表头排序**：可排序列 `ret / holdDays / signalDate / buyDate / exitDate / tsCode / buyPrice / exitPrice`。
2. **筛选栏**：标的代码搜索、出场原因、收益率区间（百分比输入）、持仓天数区间。
3. **分页器**：保留服务端分页 + 新增每页条数切换（`showSizePicker`）。
4. **新增列**：`标的名称`（展示用，不参与排序）。
5. **操作列「详情」**：点击弹 Modal 展示该笔交易标的的 K 线，图上标注买入/出场点（`B`/`S`）。

### 关键约束（已落源头核对）

- 单个 run 的 `signal_test_trade` 最大约 **44 万行**（`signal-stats.metrics.spec.ts:224`），`pageSize` 上限 500 → **排序/筛选必须服务端全量生效**，前端永远只持有当前页。
- A 股日 K 接口 `getKlines`（`a-shares.service.ts:175`）当前 **只支持「最近 N 根」，不支持日期区间** → 详情 K 线需后端补日期窗口参数。
- K 线组件 `components/kline/KlineChart.vue` **已内建成交标记**：给落在窗口内的 bar 注入 `trades: TradeOnBar[]`（`type:'entry'|'exit'`）即画 `B`/`S`，`currentTs` 那根高亮放大（`klineChartTooltip.ts:78` `buildMarkPoints`）。
- 表/列权威值：trades 表 `signal_test_trade`（`signal-test-trade.entity.ts`）；A 股名称表 `a_share_symbols`（`a-share-symbol.entity.ts`，PK `tsCode`、名称列 `name`）；A 股日 K 源 `raw.daily_quote.trade_date`（Tushare `YYYYMMDD`）。

### 已定的默认决策（评审时可推翻）

| # | 决策 | 取值 |
|---|------|------|
| ① | 详情 K 线窗口 padding | 信号日 −30 自然日 / 出场日 +20 自然日（≈前 20 / 后 14 交易日），固定常量 |
| ② | trades 排序索引 | 仅补 `(run_id, ret)` 一条复合索引；冷门排序回落内存排序 |
| ③ | 详情容器 | 嵌套 `AppModal`（非 Drawer） |
| ④ | 收益率筛选输入 | 百分比（用户填 3 = 3%），前端换算小数传后端 |
| ⑤ | 标的名称列 | 响应期注入（非 join），展示用、不可排序 |
| ⑥ | K 线取数复权 | `priceMode='qfq'`，与 trades 的 buyPrice/exitPrice（qfq 直算）对齐 |

## 子文档清单与阅读顺序

按实现依赖顺序阅读：

1. [01-backend-a-shares-kline-window.md](./01-backend-a-shares-kline-window.md) — 后端 B1：A 股日 K 加日期窗口。
2. [02-backend-trades-sort-filter.md](./02-backend-trades-sort-filter.md) — 后端 B2：trades 服务端排序/筛选 + 名称注入 + 索引 migration。
3. [03-frontend-api-store-contracts.md](./03-frontend-api-store-contracts.md) — 前端 F3：API/store 契约（F1/F2 共同依赖，**先行**）。
4. [04-frontend-trades-panel.md](./04-frontend-trades-panel.md) — 前端 F2：trades 面板（筛选栏 + 可排序表 + 操作列 + 分页），改 `SignalStatsResult.vue`。
5. [05-frontend-kline-detail-modal.md](./05-frontend-kline-detail-modal.md) — 前端 F1：详情 K 线 Modal。
6. [06-implementation-sequence.md](./06-implementation-sequence.md) — 实现顺序、文件归属、并行任务切分、整体验证。

## 模块切分总图

```text
┌─ 后端 B1: A股日K加日期窗口 ────────────────┐  ┌─ 后端 B2: trades 排序/筛选 + 名称注入 ──────┐
│ a-shares.controller.ts  +startDate/endDate  │  │ signal-stats.controller.ts  +query 参数      │
│ a-shares.service.ts     +WHERE 区间         │  │ signal-stats.service.ts     动态 where/order  │
│ (+ jest 单测)                               │  │ dto/list-trades-query.dto.ts (新)            │
│                                             │  │ signal-stats.module.ts  +AShareSymbolEntity   │
│                                             │  │ migration: (run_id, ret) 索引 + .ps1          │
└─────────────────────────────────────────────┘  └────────────────────────────────────────────────┘
┌─ 前端 F3: API/store 契约（先行）───────────┐  ┌─ 前端 F1: 详情 K线 Modal（依赖 B1+F3）─────┐
│ api/modules/market/aShares.ts   getKlines   │  │ components/strategy/SignalTradeKlineModal.vue │
│ api/modules/strategy/signalStats.ts listTr. │  │ (AppModal + KlineChart + 注入 B/S 标记)        │
│ stores/signalStats.ts           fetchTrades │  └────────────────────────────────────────────────┘
└─────────────────────────────────────────────┘  ┌─ 前端 F2: trades 面板（依赖 B2+F3）────────┐
                                                  │ components/strategy/SignalTradesPanel.vue（新）│
                                                  │ components/strategy/signalTradeColumns.ts（新）│
                                                  │ 改 views/strategy/SignalStatsResult.vue       │
                                                  └────────────────────────────────────────────────┘
```

## 跨文档引用约定

- 一律相对路径 + 锚点，例：[排序白名单](./02-backend-trades-sort-filter.md#排序白名单)。
- 现状事实一律带 `file:line`；写进硬断言/SQL/migration 的列名/表名/接口名均已在本入口「关键约束」处落源头核对。

## 验证总纲（细则见各子文档）

- 后端：`pnpm --filter @cryptotrading/server build` + 对应 jest 单测 + `docker exec crypto-postgres psql ...` 真 DB 抽样。
- 前端：`pnpm --filter @cryptotrading/web type-check` **且** `pnpm --filter @cryptotrading/web build`（vite，type-check 查不出 SFC 编译错）+ 真机点开页面。
- migration：`docker exec` 执行 `.sql`/`.ps1`，`\d signal_test_trade` 确认索引落库。
- 端到端：后端 `nest start` 无 `--watch`，改后端代码后**必须重启进程**再验证。
