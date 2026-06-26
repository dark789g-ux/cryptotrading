# A股股票列表 — 资金流向净流入列设计

> 在「A股数据 - 股票」页面的列设置中，新增四个个股资金流向列：**净流入、5日净流入、10日净流入、20日净流入**。

## 1. 背景与目标

A股股票表格（`ASharesPanel.vue` → `POST /a-shares/query`）当前已展示行情/估值/均线/KDJ-MACD/动量/风控/活跃市值/砖块图等列，但**没有任何资金流向列**。本次新增四个个股主力净流入列，可在列设置抽屉「资金流」分组开关、点表头服务端排序。

数据来自个股资金流表 `money_flow_stocks`（Tushare `moneyflow_ths` 同花顺个股资金流向）。

## 2. 已敲定决策（brainstorming 结论）

| 维度 | 决策 |
|------|------|
| **口径** | 净流入 = 基准日 `net_amount`；5/10/20日 = 截至基准日（含）往前、`money_flow_stocks` 中**最近 N 条记录**的 `net_amount` 累计 SUM。停牌/无记录日不补零、自动跳过——故「N 条记录」≈「最近 N 个有资金流数据的交易日」，与严格日历交易日在停牌时略有差异。5日也自算，三档口径一致（**不**用 Tushare 现成 `net_d5_amount`，其语义≠简单 N 日累计） |
| **能力** | 表格展示 + 服务端排序（点表头）。**不**作筛选条件（不进 condition 映射） |
| **实现** | 方案 A：实时 LATERAL 预聚合子查询，**零迁移 / 零回填 / 零同步改造** |
| **对齐（基准日）** | 每只票以**自身**在 `daily_quote` 的最新交易日为基准（latest CTE 是 `GROUP BY ts_code` 的**逐票** `MAX(trade_date)`，**非全局统一日**；停牌/退市票用其最后有行情日）。该基准日与本行 close/MA/KDJ 等列**同源**，保证整行同一交易日。基准日当天若无资金流记录 → 净流入显示 `—`，N日累计仍按截至基准日往前取 |
| **列归属** | **A股专属列**，不进共享 `INDICATOR_DESCRIPTORS`（否则污染自选股/回测表→全空），新增「资金流」列分组 |

## 3. 数据源现状（亲验 DB + 实体）

- 表 `money_flow_stocks`：70.2 万行，5218 只票，日期范围 **20251201 ~ 20260626**（约 7 个月），单日约 5186 行。
- 字段（实体 `entities/money-flow/money-flow-stock.entity.ts`）：`net_amount`（当日净流入，**单位万元**）、`net_d5_amount`（Tushare「5日主力净额」，本次不用）。**无** `net_d10/d20`。
- 索引：`UNIQUE (ts_code, trade_date)` —— 完美支撑 LATERAL「按 ts_code 取最近 N 条」走索引。
- 7 个月数据对「近 20 交易日累计」绰绰有余。

## 4. 后端设计

**唯一改动文件**：`apps/server/src/market-data/a-shares/data-access/a-shares-query.sql.ts`
（外加同目录 `a-shares-query.sql.spec.ts` 补单测。）

### 4.1 LATERAL 子查询（在所有 LEFT JOIN（含 `${scoreJoin}`）之后、`WHERE s.list_status = 'L'` 之前）

`s` = `a_share_symbols`，`l` = latest CTE（已存在，**逐票** `MAX(trade_date)`）。别名 `mf` 与现有 `q/m/i/sa/sw1-3/sd` 不冲突。

```sql
LEFT JOIN LATERAL (
  SELECT
    SUM(t.net_amount) FILTER (WHERE t.trade_date = l.trade_date) AS net_inflow,      -- 当日;缺则NULL→显示—
    SUM(t.net_amount) FILTER (WHERE t.rn <= 5)  AS net_inflow_5d,
    SUM(t.net_amount) FILTER (WHERE t.rn <= 10) AS net_inflow_10d,
    SUM(t.net_amount)                            AS net_inflow_20d                    -- 内层 LIMIT 20 即全部
  FROM (
    SELECT net_amount, trade_date,
           ROW_NUMBER() OVER (ORDER BY trade_date DESC) AS rn
    FROM money_flow_stocks
    WHERE ts_code = s.ts_code AND trade_date <= l.trade_date   -- 严格对齐:不晚于行交易日
    ORDER BY trade_date DESC
    LIMIT 20
  ) t
) mf ON true
```

口径要点：
- `l.trade_date` 是**逐票**的最新交易日（每只票各异，与本行其它列同源），**非全局统一日**。
- 「净流入」用 `FILTER (WHERE t.trade_date = l.trade_date)`：仅当基准日当天有资金流记录才有值，否则 `SUM(empty)=NULL`（符合「基准日缺则 —」）。
- 「N日累计」= 截至 `l.trade_date`（含）往前 **N 条 `money_flow_stocks` 记录**的 `net_amount` 之和。停牌/无记录日不补零、自动跳过（即 ROW_NUMBER 按记录序而非日历交易日，详见 §2 口径与 §7.5）。
- 原值（万元）透传，**后端不换算**，格式化在前端。

### 4.2 SELECT 别名（加到主 SELECT 列表）

```sql
mf.net_inflow      AS "netInflow",
mf.net_inflow_5d   AS "netInflow5d",
mf.net_inflow_10d  AS "netInflow10d",
mf.net_inflow_20d  AS "netInflow20d",
```

### 4.3 排序映射（`RAW_SORT_COL_MAP` 与 `QFQ_SORT_COL_MAP` 各加 4 项）

```ts
netInflow:     'mf.net_inflow',
netInflow5d:   'mf.net_inflow_5d',
netInflow10d:  'mf.net_inflow_10d',
netInflow20d:  'mf.net_inflow_20d',
```

`appendASharesSort` 在 SQL 末尾拼 `ORDER BY <col> <dir> NULLS LAST`，可直接引用 LATERAL 输出列 `mf.net_inflow*`（PostgreSQL ORDER BY 在 SELECT 后求值，能引用 FROM/JOIN 列）。NULLS LAST 已有 → 缺数据票排末尾。

**不改** `RAW_CONDITION_COL_MAP` / `QFQ_CONDITION_COL_MAP`（按决策不作筛选条件）。

### 4.4 count 路径与性能（风险点，需真机验证）

`a-shares.service.ts:123` 的 count 走 `SELECT COUNT(*) FROM (${baseQuery.sql}) sub` —— **包裹整个含 LATERAL 的 base SQL**。`COUNT(*)` 不引用 `mf` 列且 `LEFT JOIN ... ON true` 不改变行数，规划器**可能**做 join 消除，但不保证。

- 性能预估：data 查询排序时对全市场 ~5200 票各跑一次 LATERAL（每票走唯一索引扫 ≤20 行），约 10 万行级，预计亚秒~1秒。
- **必须真机 `EXPLAIN ANALYZE` 验证** count + data 两条路径耗时；若 count 路径 LATERAL 未被消除导致明显变慢，再考虑给 count 用不含 LATERAL 的精简 SQL（本设计先不预优化，遵循 YAGNI）。

## 5. 前端设计（4 个文件，均 A股专属，不碰共享 `INDICATOR_DESCRIPTORS`）

### 5.1 行类型 — `apps/web/src/api/modules/market/aShares.ts`

`AShareRow` 接口追加：

```ts
netInflow: string | null
netInflow5d: string | null
netInflow10d: string | null
netInflow20d: string | null
```

### 5.2 格式化 + 列定义

**格式化（单位坑，务必正确）** — `a-shares/aSharesFormatters.ts` 新增 `formatMoneyFlow`：

`net_amount` 单位是**万元**。**禁止**用 `formatAmount`（千元口径，会差 10 倍）。复用 `formatMarketCap` 的万元换算逻辑，但单独命名以区分语义（资金流有正负）：

```ts
/** 资金净流入（万元口径 → 亿/万）。net_amount 单位为万元，禁用千元口径的 formatAmount。 */
export function formatMoneyFlow(value: string | null): string {
  if (value == null) return '—'
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  if (Math.abs(num) >= 1_0000) return `${(num / 1_0000).toFixed(2)} 亿`
  return `${num.toFixed(2)} 万`
}
```

**列定义** — `a-shares/aSharesColumns.ts` 手写 4 列（A股专属，**不**走 `buildIndicatorColumns`），插在 `...buildIndicatorColumns(...)` 之后：

- `key`: `netInflow / netInflow5d / netInflow10d / netInflow20d`
- `title`: `净流入 / 5日净流入 / 10日净流入 / 20日净流入`
- `sorter: true`（remote 排序）、`defaultVisible: false`（与其它指标列一致，不撑默认表宽）
- `descKey`: `net_inflow / net_inflow_5d / net_inflow_10d / net_inflow_20d`
- `render`: `formatMoneyFlow(row.netInflowXxx)`，外裹 `h('span', { style: color })`，颜色复用现有 `getPctChangeColor`（>0 红 success / <0 绿 error / 0 无色），与涨跌幅、K线资金流副图配色一致。

### 5.3 列分组 — `columnGroupMeta.ts`

- `COLUMN_GROUPS` 追加 `{ key: 'moneyFlow', label: '资金流' }`（建议置于 `amv` 之后，衍生量类相邻）。`as const` 数组，`ColumnGroupKey` 类型自动纳入。
- `COLUMN_KEY_GROUP` 追加 4 项 key → `'moneyFlow'`。

### 5.4 字段说明 — `components/common/fieldDescriptions.ts`

追加 4 条到 `FIELD_DESCRIPTIONS`（或该文件等价的描述映射对象；实现时核对实际导出名/结构）。key 用 snake_case 对齐现有 `turnover_rate/pe_ttm` 风格，与 §5.2 列定义的 `descKey` 一一对应：

```
net_inflow:     基准日主力资金净流入，单位万元（来自同花顺个股资金流）
net_inflow_5d:  近 5 日主力净流入累计（最近 5 条记录），单位万元
net_inflow_10d: 近 10 日主力净流入累计（最近 10 条记录），单位万元
net_inflow_20d: 近 20 日主力净流入累计（最近 20 条记录），单位万元
```

## 6. 数据流与列设置位置

```
A股页 列设置抽屉                       POST /a-shares/query
┌──────────────────┐  勾选「资金流」   ┌──────────────────────────────┐
│ 基础/行情/估值    │  分组 4 列  ───▶ │ a-shares-query.sql.ts        │
│ 均线/动量/KDJ...  │                  │  +LEFT JOIN LATERAL          │
│ 活跃市值          │                  │   money_flow_stocks          │
│ ▼ 资金流 (新)     │                  │   (按ts_code取≤20条/截至l日) │
│   ☐ 净流入        │                  │  net_inflow/_5d/_10d/_20d    │
│   ☐ 5日净流入     │  ◀── 4 列数值 ── │  (万元,原值透传)             │
│   ☐ 10日净流入    │                  └──────────────────────────────┘
│   ☐ 20日净流入    │  表头点击 → SORT_COL_MAP → 服务端 ORDER BY
└──────────────────┘  formatMoneyFlow(万元→亿/万) + 正红负绿
```

## 7. 边界与风险

1. **单位**：`net_amount` 万元口径；前端必须用 `formatMoneyFlow`（万元），**严禁** `formatAmount`（千元，差 10 倍）。— 已在 §5.2 钉死。
2. **共享 descriptor 污染**：4 列必须 A股专属，**不得**加进 `INDICATOR_DESCRIPTORS`（自选股/回测表后端不返回这些字段，会全 `—`）。— 已在 §5.2 钉死。
3. **基准日缺数据 → `—`**：基准日（逐票最新行情日）当天资金流未同步（该票 `money_flow` 最新日 < `daily_quote` 最新日）→ 净流入列显示 `—`，N日累计正常（截至基准日往前取记录）。这是预期行为，非 bug。
4. **count 路径 LATERAL**：见 §4.4，需 EXPLAIN 验证，必要时再优化。
5. **「N 日」= 最近 N 条记录**：用 `money_flow_stocks` 自身记录的 ROW_NUMBER 取最近 N 条，停牌/缺数据日无记录、自动跳过不补零——与严格日历交易日在停牌时略有差异。口径已与用户确认为「最近 N 条记录累计」，起点锚定逐票基准日（§2）。

## 8. 测试策略

- **后端单测** `a-shares-query.sql.spec.ts`：断言生成 SQL 含 `JOIN LATERAL`、`net_inflow_5d` 等片段；断言按 `netInflow5d` 排序时 `ORDER BY` 命中 `mf.net_inflow_5d`。（注：mock/字符串级单测**验不出数值正确性** —— data-integrity 规则。）
- **真机 e2e（必须，browser-tester）**：
  1. 开 A股页 → 列设置出现「资金流」分组含 4 列 → 勾选 → 表格显示数值。
  2. **DB 对拍**：取一只票，`docker exec psql` 手算其截至最新交易日近 5/10/20 日 `SUM(net_amount)`，与页面数值逐一对拍一致。
  3. 当日资金流缺数据的票 → 净流入显示 `—`。
  4. 点四列表头 → 服务端排序生效（流入最多/流出最多排到顶）。
  5. 单位显示正确（量级合理，未差 10 倍）。
- **重启后端**：dev 无 `--watch`，新 SQL 不重启不生效（CLAUDE.md）。

## 9. 任务拆分（subagent 派发，主线程集成）

| 任务 | subagent | 文件域 | 内容 |
|------|----------|--------|------|
| **T1 后端** | general-purpose | `a-shares/data-access/*` | 改 `a-shares-query.sql.ts`（LATERAL + 4 SELECT 别名 + 2×4 排序映射）；`a-shares-query.sql.spec.ts` 补用例 |
| **T2 前端** | general-purpose | `web/.../symbols/a-shares/*`、`columnGroupMeta.ts`、`api/.../aShares.ts`、`fieldDescriptions.ts` | `AShareRow` 加 4 字段；`aSharesFormatters.ts` 加 `formatMoneyFlow`；`aSharesColumns.ts` 加 4 列；`columnGroupMeta.ts` 加分组；`fieldDescriptions.ts` 加说明 |

T1、T2 **文件域不相交（后端 vs 前端），可并行**。

**主线程集成验证**：
1. `pnpm --filter @cryptotrading/server build`
2. `pnpm --filter @cryptotrading/server exec jest a-shares-query`
3. `pnpm --filter @cryptotrading/web type-check`
4. 重启后端 → browser-tester 真机 e2e（§8 全部剧本）+ EXPLAIN 性能验证（§4.4）

## 10. 验证标准（完成定义）

- [ ] server build 绿、`jest a-shares-query` 绿、web type-check 绿
- [ ] A股页列设置出现「资金流」分组含 4 列，可勾选/拖拽/排序
- [ ] 一只票近 5/10/20 日 `SUM(net_amount)` 页面值与 DB 手算**逐一对拍一致**
- [ ] 当日缺资金流的票净流入显示 `—`；点表头排序生效；单位量级正确
- [ ] EXPLAIN 确认 count + data 路径耗时可接受（无 LATERAL 引发的明显劣化）
