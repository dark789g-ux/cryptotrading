# 06 · 任务切分 / 测试 / 风险 / 验证标准

← 返回 [index.md](./index.md)

## 1. 任务依赖与文件域切分

按"互不相交文件域"切分，便于并行；②是公共底座，④⑤⑥依赖它。

```text
[T1 后端 screener]  a-shares-query.sql.ts (+ a-shares.service.ts 仅核对)
       ──可与前端并行──
[T2 共享底座] indicatorColumnDefs.ts(新) + columnGroupMeta.ts(+2组+key)   ← 公共底座
       │
       ├─[T3 A股 consumer]  aShares.ts(AShareRow 扩字段) + a-shares/aSharesColumns.ts
       ├─[T4 自选股去重]    watchlistColumnDefs.ts(删内联18列→复用目录)
       └─[T5 回测表接入]    useCandleRunSymbolMetricsColumns.ts 重构
                            + useBacktestMetricsColumnPreferences.ts(新)
                            + CandleRunSymbolMetrics.vue(接线+post-map)
```

依赖：T3/T4/T5 **必须等 T2 合并**（引用 `INDICATOR_DESCRIPTORS`/`buildIndicatorColumns`）。T1 独立。

提交建议（用户偏好分层 commit）：
- `feat(a-shares): screener 行补技术指标 + 个股AMV 列与排序`（T1）
- `refactor(symbols): 抽共享指标列定义目录 + 活跃市值/砖块图分组`（T2）
- `feat(a-shares): 列设置接入技术指标列(默认隐藏)`（T3）
- `refactor(watchlist): 指标列复用共享目录去重(零漂移)`（T4）
- `feat(backtest): 逐K标的指标表接入列选择器`（T5）

## 2. 测试计划

### 后端（jest，`pnpm --filter @cryptotrading/server exec jest a-shares-query`）

- `buildASharesBaseQuery` SQL 串断言：含 `i.ma5 AS "ma5"`…全部新别名；含 `LEFT JOIN stock_amv_daily sa`；含 `sa.amv_dif AS "amvDif"`。
- `RAW_SORT_COL_MAP`/`QFQ_SORT_COL_MAP`：`ma5/kdjJ/atr14/amvDif`… 解析到正确列；未知字段回退 `s.ts_code`。
- COUNT 不放大：断言 AMV JOIN 为 LEFT 且 ON 唯一键（或集成层用真 DB 验 1 股 1 行）。
- ⚠ 纯 SQL 串断言**验不出字段水合**（见 database-sql 规范）→ 真机/集成兜底（§4 e2e）。

### 前端（vitest，`pnpm --filter @cryptotrading/web test`）

- `indicatorColumnDefs`：builder 产物列数/key/title/小数位正确；`stopLossPct` 带 `%`；null→`'-'`；`blankWhen` 命中→`'-'`；`defaultVisible` 函数/布尔两形态生效；**`brickXg`（kind='signal'）渲染 tag 真/假、null→`'-'`、不走 toFixed**。
- `columnGroupMeta`：`resolveColumnGroup('amvDif')==='amv'`、`'brick'==='brick'`；`COLUMN_GROUPS` 含两新组。
- **去重零漂移**：对同一组 descriptor，自选股渲染输出与改前 `formatFixed` 等价（抽样 ma5=4位/kdjJ=2位/stopLossPct=%/null=`-`）。
- 回测 post-map：`columns` 注入 `sortOrder` 跟随 `headerOrder(key)`。

### 编译（硬性）

- **`pnpm --filter @cryptotrading/web build`（vite）** —— SFC 编译，`vue-tsc` type-check 查不出模板/宏错（vue3-frontend 规范）。改了 `.vue`（CandleRunSymbolMetrics）必跑。
- `pnpm --filter @cryptotrading/web type-check`、`pnpm --filter @cryptotrading/server build`。
- `pnpm --filter @cryptotrading/web lint:quant-lines`（若动 quant 域文件；本 spec 主要在 symbols/backtest，确认无 >500 行新文件）。

## 3. 性能风险

- screener 的 `latest AS (SELECT ts_code, MAX(trade_date) FROM raw.daily_quote GROUP BY ts_code)` CTE 是**既有**主要耗时点（EXPLAIN 中因子/列 JOIN 仅 ~16ms 级，瓶颈在 latest CTE 全表扫）。
- 本功能只加列与一个 LEFT JOIN，不显著恶化，但**挂 25 列前应实测真实分页查询延迟**（带 LIMIT/默认日/过滤的生产形态，而非裸 EXPLAIN 全集）。若确认偏慢，作为**独立后续**优化 latest CTE（物化最新日 / 预算表），不阻塞本 spec。
- 前端：新增 ~25 列默认隐藏，首屏渲染列数不变 → 无渲染回归；用户勾选多列后表变宽属预期。

## 4. 真机 e2e 验证标准（后端先重启）

A股：
1. 列设置弹窗出现「活跃市值」「砖块图」组，及均线/KDJ·MACD/风控波动 下的新指标项；默认全未勾。
2. 勾选 MA5/KDJ.J/ATR14/AMV.DIF → 表格出现对应列且**有真实数值**（非全 `-`）。
3. 点 KDJ.J 表头 → 触发 remote 重查、按 KDJ.J 升序、NULL 末尾。
4. 刷新页面 → 勾选与列序持久化（server JSONB 回读）。

自选股：
5. 指标列显示与改前一致（ma5/ma30/kdjJ/RR 默认可见、数值/小数位不变）—— 去重零漂移。

回测「逐K 标的指标」：
6. 「列设置」按钮打开抽屉；勾掉 MA30、拖动列序、保存 → 表格随之变化。
7. 点 MA5 表头排序仍生效（受控 sortOrder 未被 prefs 破坏）；刷新后列偏好（localStorage）保留。

## 5. 关键约束清单（合并前自检）

- [ ] SELECT 别名 / `AShareRow` 字段 / descriptor key **三处字面一致**（canonical key）。
- [ ] `brickXg` 全链按 **boolean 信号**处理：`AShareRow.brickXg: boolean | null`、service 查询泛型容纳 boolean、descriptor `kind:'signal'` 渲染 tag。
- [ ] `stock_amv_daily` 表名/schema 已亲查（裸名 public，非 `raw.`）。
- [ ] `WatchlistQuoteRow` 指标字段名已 grep 核对 = canonical key。
- [ ] 自选股删内联 18 列后渲染零漂移（抽样比对）。
- [ ] 回测表受控排序 post-map 注入 sortOrder，未直接套 useSymbolColumnPreferences。
- [ ] 后端改 SQL 后重启；`.vue` 改动跑过 `vite build`。
- [ ] 文件 I/O 全显式 `utf-8`；对象键名英文（PowerShell GBK 防裸中文键）。
