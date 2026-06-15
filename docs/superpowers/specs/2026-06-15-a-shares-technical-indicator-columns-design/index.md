# A股技术指标列 + 共享指标列定义抽象 — 设计 spec

> 一句话目标：给 A股 数据表的「显示哪些列」补齐项目中**每股可得**的技术指标列，把指标列的定义抽成一份 A股/自选股共用的共享目录，并让回测「逐K 标的指标」表也接入同一套列选择器。

## 背景与目标

当前 A股 数据表（`ASharesPanel`）的列设置弹窗（`ColumnSettingsDrawer`）只暴露 基础/行情/估值/策略信号 几类列；技术指标（MA/MACD/KDJ/ATR…）虽已在 `raw.daily_indicator` 落库、且自选股表早已展示全套，但 **A股 列表接口的行数据里根本没带指标字段**，所以列设置里看不到它们。

本 spec 解决三件事（用户已逐项拍板，见 [01-scope-decisions.md](./01-scope-decisions.md)）：

1. **后端**：让 A股 screener（`POST /a-shares/query`）的每行带上 Tier-1 每股指标 + 个股 AMV，并支持排序。无 DB 迁移。
2. **抽象**：把指标列的定义（标题/小数位/分组/渲染）抽成一份共享「指标列定义目录」，A股 与自选股共用，消除自选股已有的重复声明。
3. **接入**：回测「逐K 标的指标」表（`CandleRunSymbolMetrics`，现无列选择器、表宽 1360）重构成 `SymbolColumnDef` + 接入共享 `ColumnSettingsDrawer`。

**明确推迟到 P2（不在本 spec）**：量化因子桥（`factors.daily_factors` 的 RSI/BOLL/动量/波动）、市场级 0AMV 列（实测每行同值）。理由见 [01-scope-decisions.md](./01-scope-decisions.md#推迟项理由)。

## 关键事实（已落源头核对，禁二手转述）

| 事实 | 证据 |
|------|------|
| Tier-1 指标列全在 `raw.daily_indicator`、最新日满覆盖 | 实体 `daily-indicator.entity.ts` + 真 DB `\d`：最新日 5508/5508，MA5 仅 2 个次新股 NULL |
| screener 已 JOIN `raw.daily_indicator i`、`RAW_CONDITION_COL_MAP` 已映射 i.* | `a-shares-query.sql.ts:144` JOIN、`:26-37` 映射 |
| `RAW_SORT_COL_MAP` 不含任何指标列（需扩） | `a-shares-query.sql.ts:50-67` |
| 市场级 0AMV 每行同值 | `oamv-daily.entity.ts` 唯一键仅 `tradeDate`、无 `ts_code` |
| 个股 AMV 真每股、满覆盖 | `stock-amv-daily.entity.ts` 唯一键 `(tsCode,tradeDate)`；真 DB 最新日 5507/5508、`amv_dif/dea/macd` 全非空 |
| 自选股已声明全套指标列、键为 canonical | `watchlistColumnDefs.ts:237-263`（`ma5/kdjJ/dif/atr14/riskRewardRatio`…） |
| `buildColumnsFromPreference` 产物不含 `sortOrder` | `useSymbolColumnPreferences.ts:83-91` |
| 回测表受控远程排序 + `dataStatus==='missing'` 留空守卫 | `CandleRunSymbolMetrics.vue:84-89,96-99`、`useCandleRunSymbolMetricsColumns.ts:81-131` |

## 子文档清单（建议按序阅读）

1. [01-scope-decisions.md](./01-scope-decisions.md) — 范围边界、用户拍板记录、指标清单分层、推迟项理由
2. [02-backend-screener.md](./02-backend-screener.md) — A股 screener SQL 改动：SELECT 补列 / 新增 AMV JOIN / 排序映射 / AShareRow
3. [03-shared-catalogue-grouping.md](./03-shared-catalogue-grouping.md) — 共享指标列定义目录 `indicatorColumnDefs.ts` + `columnGroupMeta` 分组 + 默认可见策略 + 持久化
4. [04-consumers-ashares-watchlist.md](./04-consumers-ashares-watchlist.md) — A股 与自选股两个 consumer 改造 + 去重 + canonical key 对齐硬约束
5. [05-backtest-table.md](./05-backtest-table.md) — 回测「逐K 标的指标」表接入：受控排序 / 留空守卫 / localStorage 持久化
6. [06-tasks-testing-risks.md](./06-tasks-testing-risks.md) — 任务依赖顺序 / 文件域切分 / 测试计划 / 性能风险 / e2e 验证标准

## 跨文档引用约定

统一用相对路径 + 锚点，例：`[排序映射](./02-backend-screener.md#3-排序映射-raw_sort_col_map)`。代码位置一律 `file:line`。

## 验证标准（总览，细则见 06）

- 后端 jest：SELECT 含新列、AMV JOIN 存在且不放大 COUNT、`RAW_SORT_COL_MAP` 解析新字段。
- 前端 vitest：catalogue builder 产物正确、`resolveColumnGroup` 命中新组、两 consumer 不发散。
- **必跑 `pnpm --filter @cryptotrading/web build`**（SFC 编译，type-check 查不出）。
- 真机 e2e：A股 列设置勾选指标列 → 渲染带数据 → 表头排序触发 remote → 刷新持久化；回测表列选择器可勾选/排序/持久化。
- **后端改 SQL 后必须重启**（`nest start` 无 watch）。
