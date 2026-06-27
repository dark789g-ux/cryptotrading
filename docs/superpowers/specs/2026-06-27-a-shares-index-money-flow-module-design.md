# A 股指数列设置「资金流字段模块」设计

- 日期：2026-06-27
- 分支：`feat/table-column-prefs-generalization`
- 状态：已批准，待实现
- 一句话目标：在 Symbols ▸ A 股数据 ▸ A 股指数（同花顺面板 + 申万面板）的列设置抽屉里，把资金流相关列归成一个独立「资金流」分组模块，并对齐股票模块补上 5/10/20 日净流入多周期列（覆盖全部 5 类指数）。

---

## 1. 背景与现状（file:line 为证，已落源头核实）

参考样板是「股票-列设置」里的资金流模块：`columnGroupMeta.ts:81-85` 把 `netInflow / netInflow5d / netInflow10d / netInflow20d` 映射到 `moneyFlow` 分组（`COLUMN_GROUPS` 中 `{ key:'moneyFlow', label:'资金流' }`，`columnGroupMeta.ts:10`）。

A 股指数侧的现状（与子代理转述有出入的点已亲查源文件 / 真 DB 纠正）：

1. **资金流列已存在**：`aSharesIndexColumns.ts:130-161` 已定义 4 列——净流入 `net_amount`、大单净流入 `buy_lg_amount`、中单净流入 `buy_md_amount`、小单净流入 `buy_sm_amount`，均 `sorter:true` + `defaultVisible:false`。
2. **渲染口径**：这 4 列用 `formatAmount(toStr(row.xxx))`、**无颜色**（`:136/144/152/160`）。**不是** `formatMoneyFlow`、**没有**红绿涨跌色。新列必须沿用同款渲染才一致。
3. **后端数据已返回**：`index-daily.service.ts:193-214` 的 `getLatest()` 已按 `CASE q.category` 从 5 张资金流表取当日值并 JOIN（`:219-223`）。
4. **后端 sort 白名单已含这 4 列**：`IndexLatestSortField`（`dto/latest.dto.ts:11-23`，前端镜像 `a-shares-index/types.ts:60-72`）= `pct_change|vol|amount|total_mv_wan|tradeDate|pe|pb|count|net_amount|buy_lg_amount|buy_md_amount|buy_sm_amount`。
   ⚠️ 但 `aSharesIndexColumns.ts:41-44` 的注释**陈旧**，只列了前 7 个、漏了 `count/net_amount/buy_*`——本次顺带订正注释。
5. **列设置已接入 per-table 偏好**：同花顺面板 tableId=`aSharesIndex`，申万面板 tableId=`aSharesIndexSw`，都走 `useTableColumnPreferences`。
6. **缺的唯一一环**：上述 4 个 key 都**没在** `COLUMN_KEY_GROUP`（`columnGroupMeta.ts:19-99`）里注册，`resolveColumnGroup` fallback 到 `meta`（其它）。所以它们散落在「其它」而非「资金流」分组——这正是「添加资金流字段模块」要补的。

真 DB 核实（`docker exec crypto-postgres psql`）：`money_flow_industries` 80345 行、日期 `20251201~20260626`、`ts_code` 后缀 `.SI`（申万 68195 行）与 `.TI`（同花顺 12150 行）并存；`buy_lg_amount/buy_md_amount/buy_sm_amount` 三列已落库（在制 migration `20260626000001` 已应用）。

---

## 2. 需求范围（已与用户敲定）

- **归组**：现有 4 列 + 新增 3 列共 7 列，全部归入 `moneyFlow` 分组。
- **多周期**：给指数补 5/10/20 日净流入，**覆盖全部 5 类**（申万 `.SI` / 同花顺行业 `.TI` / 概念 / 大盘 / 宽基），两面板无「—」空缺、模块一致。
- 列顺序（用户已确认）：净流入族在前，再大/中/小单。

---

## 3. 后端实现选型

| 方案 | 做法 | 结论 |
|------|------|------|
| **A. 外层 5×LATERAL 滚动求和 + CASE 路由** | 在 `getLatest()` **外层**（作用于已 `DISTINCT ON` 收敛的 `latest` 行）给 5 张表各加一个 LATERAL（`ROW_NUMBER()+FILTER` 镜像股票写法），再 `CASE latest.category` 选对应表的 5d/10d/20d | **采用**。与现有 `netAmount` 的 CASE 同构、查询期计算、零 schema/migration/回填 |
| B. 预聚合多周期列入库 | 5 张表各加 `net_5d/10d/20d` 列，聚合服务算好写库 | 否决：改聚合+回填+存储，滚动窗本质是查询期产物，落库别扭 |
| C. 单 LATERAL 动态表名 | 一个子查询覆盖 5 表 | 否决：纯 SQL 无法参数化表名，需 UNION，比 A 更绕 |

**性能关键（必须遵守）**：滚动 LATERAL **放外层 `SELECT * FROM (innerDistinctOn) latest` 之上**，而非内层 `DISTINCT ON` 子查询里。内层 FROM 的是 `index_daily_quotes` **全历史**，LATERAL 放内层会对每条历史行跑一次（爆炸）；放外层则每 `tsCode` 仅一次（≤ 该面板指数数，与股票 query 同量级）。

---

## 4. 最终「资金流」分组列清单

```text
列设置抽屉 ▸ 「资金流」分组（可折叠，同花顺面板 + 申万面板共用）
┌──────────────────────────────────────────────────────────────┐
│ 顺序  标题          列 key(=sort字段)    渲染                默认 │
│  1   净流入        net_amount          formatAmount(toStr)  隐藏 │ 已存在
│  2   5日净流入     net_amount_5d       formatAmount(toStr)  隐藏 │ 新增
│  3   10日净流入    net_amount_10d      formatAmount(toStr)  隐藏 │ 新增
│  4   20日净流入    net_amount_20d      formatAmount(toStr)  隐藏 │ 新增
│  5   大单净流入    buy_lg_amount       formatAmount(toStr)  隐藏 │ 已存在
│  6   中单净流入    buy_md_amount       formatAmount(toStr)  隐藏 │ 已存在
│  7   小单净流入    buy_sm_amount       formatAmount(toStr)  隐藏 │ 已存在
└──────────────────────────────────────────────────────────────┘
全部 sorter:true、defaultVisible:false、无颜色（与现有 4 列一致）
```

新列插入位置：`aSharesIndexColumns.ts` 现有「净流入」(`:130-137`) 之后、「大单净流入」(`:138`) 之前。

---

## 5. 数据契约（spec 钉死，前后端并行据此实现）

- **响应行字段（camelCase）**：`netAmount5d`、`netAmount10d`、`netAmount20d`，类型 `number | null`，单位**万元**（与 `netAmount` 同）。
- **sort 白名单字段（snake）**：`net_amount_5d`、`net_amount_10d`、`net_amount_20d`。
- **列 key**：`net_amount_5d`、`net_amount_10d`、`net_amount_20d`（= sort 字段，铁律不变）。
- **分组**：上述 3 个 + 现有 4 个（`net_amount/buy_lg_amount/buy_md_amount/buy_sm_amount`）→ `moneyFlow`。

---

## 6. 后端改动（apps/server/）

文件域：`market-data/index-daily/` 内 3 文件，与前端不相交。

1. `dto/latest.dto.ts` — `IndexLatestSortField` 联合追加 `'net_amount_5d' | 'net_amount_10d' | 'net_amount_20d'`。
2. `index-daily.types.ts` — `IndexLatestRow` 追加 3 字段（带「净流入（万元，N 日累计）」注释）。
3. `index-daily.service.ts`：
   - `SORT_COL_MAP`（文件顶部）追加 `net_amount_5d: '"netAmount5d"'` 等 3 项（映射到外层 SELECT 别名，外层 `ORDER BY ${orderExpr}` 即可排序）。
   - `getLatest()` SQL：**外层**改 `SELECT *` → `SELECT latest.*, <3 个 CASE 表达式 AS "netAmount5d/10d/20d">`，并在 `(...) latest` 之后追加 5 个 `LEFT JOIN LATERAL`，每个对应一张表：

   ```sql
   -- 外层结构（示意；CASE 分支严格镜像现有 netAmount 的 5 分支）
   SELECT latest.*,
     CASE latest.category
       WHEN 'sw'       THEN ind_roll.n5
       WHEN 'industry' THEN ths_roll.n5
       WHEN 'concept'  THEN sec_roll.n5
       WHEN 'market'   THEN mkt_roll.n5
       ELSE COALESCE(ind_roll.n5, sec_roll.n5, ths_roll.n5, mkt_roll.n5, idx_roll.n5)
     END AS "netAmount5d",
     -- 同理 "netAmount10d"(n10) / "netAmount20d"(n20)
   FROM ( <现有内层 DISTINCT ON 子查询，完全不动> ) latest
   LEFT JOIN LATERAL (
     SELECT SUM(net_amount) FILTER (WHERE rn <= 5)  AS n5,
            SUM(net_amount) FILTER (WHERE rn <= 10) AS n10,
            SUM(net_amount)                          AS n20
     FROM (
       SELECT net_amount, ROW_NUMBER() OVER (ORDER BY trade_date DESC) AS rn
       FROM money_flow_industries
       WHERE ts_code = latest."tsCode" AND trade_date <= latest."tradeDate"
       ORDER BY trade_date DESC LIMIT 20
     ) t
   ) ind_roll ON latest.category = 'sw'
   LEFT JOIN LATERAL ( ... money_flow_ths_industries ... ) ths_roll ON latest.category = 'industry'
   LEFT JOIN LATERAL ( ... money_flow_sectors ...        ) sec_roll ON latest.category = 'concept'
   LEFT JOIN LATERAL ( ... money_flow_market（无 ts_code 过滤，仅 trade_date<=latest."tradeDate"）... ) mkt_roll ON latest.category = 'market'
   LEFT JOIN LATERAL ( ... money_flow_index ...          ) idx_roll ON TRUE   -- 供 ELSE/宽基兜底
   ORDER BY ${orderExpr}
   LIMIT $3 OFFSET $4
   ```

   - `LatestRawRow`（raw 行类型）追加 `netAmount5d/10d/20d`；`mapped` 映射追加 `netAmount5d: nullableNum(r.netAmount5d)` 等 3 行。
   - **不动**内层 `DISTINCT ON` 子查询、不动现有 `netAmount/buyXxAmount` 的等值 JOIN。

> 进硬编码（列名、表名、CASE 分支）前，后端 Task 须自查实体 / 真 DB 一条样本核对，不采信本 spec 的二手转述（数据完整性规则）。`mkt_roll` 用 `money_flow_market`（无 `ts_code`）；其余按 `ts_code` 过滤。

---

## 7. 前端改动（apps/web/）

文件域：`components/symbols/` 内 3 文件 + `a-shares-index/types.ts`，与后端不相交。

1. `components/symbols/a-shares-index/types.ts` — `IndexLatestRow` 追加 `netAmount5d/10d/20d`（`number|null`，注释「净流入（万元，N 日累计）」）；`IndexLatestSortField` 联合追加 3 个 snake 值。
2. `components/symbols/a-shares-index/aSharesIndexColumns.ts`：
   - 在「净流入」列后插入 3 个列定义，**逐字段镜像「净流入」列**（`width:120, sorter:true, defaultVisible:false, render:(row)=>formatAmount(toStr(row.netAmount5d))`），仅 title/key/字段名不同。
   - 订正 `:41-44` sort 白名单注释，补齐 `count/net_amount/buy_lg_amount/buy_md_amount/buy_sm_amount/net_amount_5d/10d/20d`。
3. `components/symbols/columnGroupMeta.ts` — `COLUMN_KEY_GROUP` 在「资金流」段补 7 项：`net_amount, net_amount_5d, net_amount_10d, net_amount_20d, buy_lg_amount, buy_md_amount, buy_sm_amount` → `'moneyFlow'`（现有 `netInflow*` 股票 key 保留，新旧并存无冲突，因 key 不重名）。

> 两面板共用 `createASharesIndexColumnDefs`，故归组与新列对两面板同时生效，无需分别改面板组件。

---

## 8. 数据现实与边界（暴露权衡，非本次回归）

- `money_flow_industries` 真 DB 仅约 7 个月（`20251201~`）；窗口不足时 5d/10d/20d 用现有交易日累计（不补零、不报错），20 日窗口数据充足。
- **同花顺面板的「大单/中单/小单（当日）」本就无数据**（Tushare `moneyflow_ind_ths` 不含大中小单拆分，`getLatest` 对 `industry/concept` 的 `buyXx` 走 `mf_idx` 兜底多为 NULL）。归组后这 3 列在同花顺面板仍显「—」——**既有现象**，本次不修。多周期**净流入**不受影响（净流入各类均有数据）。
- 现有 4 列用 `formatAmount` 显示万元值的单位口径问题（`amount` 注释为千元、`netAmount` 为万元却共用 `formatAmount`）属**既有项**，本次保持一致、不在范围内修改（避免 drift）。
- 外层 5 LATERAL 对非匹配 category 靠 `ON latest.category=...` 短路或唯一索引秒回；单面板 ≤ 336 行（申万三级），性能可接受。
- 无 schema 变更 → **无 migration**；聚合服务（在制 buy 列工作）是前置依赖、已落 DB，本次**不碰**。

---

## 9. 测试与验证

- 后端：`pnpm --filter @cryptotrading/server build`；真 DB 抽一条申万一级（如 `801010.SI`）核对 `getLatest` 返回的 `netAmount5d/10d/20d` = 手算最近 5/10/20 交易日 `net_amount` 之和。
- 前端：`pnpm --filter @cryptotrading/web type-check` + `pnpm --filter @cryptotrading/web build`（type-check 查不出 SFC 编译错，必跑 vite build）。
- e2e（`browser-tester`，扩展在制 `.browser-driving/flows/sw-money-flow-columns.py`）：① 列设置抽屉出现「资金流」分组、含 7 列；② 多周期 3 列勾选后表格有数值；③ 点表头按 `net_amount_5d` 排序生效；④ 同花顺面板同样有「资金流」分组。**后端无热加载，e2e 前必须重启后端进程**（验证跑的是最新代码）。

---

## 10. 实现编排（subagent 派发；文件域不相交，契约钉死后可并行）

| Task | subagent | 文件域 | 依赖 |
|------|----------|--------|------|
| T1 后端 | `general-purpose` | `apps/server/.../index-daily/{dto/latest.dto.ts, index-daily.types.ts, index-daily.service.ts}` | 按 §5 契约；与 T2 并行 |
| T2 前端 | `general-purpose` | `apps/web/.../symbols/{a-shares-index/types.ts, a-shares-index/aSharesIndexColumns.ts, columnGroupMeta.ts}` | 按 §5 契约；与 T1 并行 |
| T3 验证 | `browser-tester` | `.browser-driving/flows/sw-money-flow-columns.py`（只读后端/前端） | T1+T2 集成后；重启后端→build/type-check→e2e |

主线程负责：①§5 契约对 T1/T2 钉死后并行派发；② 集成后跑后端 build + 前端 type-check/build 门禁；③ 重启后端；④ 派 T3 e2e；⑤ 按子系统分层提交（后端一笔、前端一笔、e2e/flow 一笔，遵循分层 commit 偏好）。

## 11. 验收标准

1. 同花顺面板与申万面板的列设置抽屉均有「资金流」分组，含 净流入 / 5日 / 10日 / 20日净流入 / 大单 / 中单 / 小单 共 7 列。
2. 多周期 3 列在申万面板有真实数值，且 = 真 DB 手算滚动和。
3. 7 列均可按各自 key 远程排序。
4. 后端 build、前端 type-check + vite build 全绿。
5. 无 migration、无聚合服务改动、无 schema 变更。
