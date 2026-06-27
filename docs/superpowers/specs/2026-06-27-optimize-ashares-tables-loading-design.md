# 优化 A 股股票表格 / A 股指数表格加载速度（Design）

> 一句话目标：在**不引入缓存/物化、不改字段类型**的前提下，通过「后端 SQL 重写 + 前端去串行化」把股票表格、A 股指数表格的加载从数百 ms 级降到几十 ms 级（DB 索引经实测评估默认不做，见 §4-C）。

## 1. 范围与约束

**范围（已与用户确认）**：
- 股票表格 `ASharesPanel`（`POST /api/a-shares/query`）。
- A 股指数表格 `ASharesIndexThsPanel` / `ASharesIndexSwPanel`（`GET /api/indices/latest`）。
- 目标：整体提速（首屏、翻页/筛选/排序、切回 tab 全部覆盖）。

**明确不在范围**：
- `ActiveMarketValuePanel.vue`（用户最初 @ 的文件）——它是「活跃市值」tab 的 ECharts **K 线图**（`GET /api/oamv/data`，`oamv_daily` 单表 ≤250 行无 JOIN），**本身无性能问题**，不动。
- 缓存层 / 物化视图（用户排除）。
- 字段类型 `NUMERIC→DOUBLE`（用户排除，高风险需全量回填）。

**硬约束（项目规范）**：
- 所有源文件 UTF-8；文件 I/O 显式 `encoding='utf-8'`；对象键名英文。
- DB schema 变更须附 `migration/*.sql` + 同名 `.ps1`（内置 `docker exec`，用 `$PSScriptRoot` 引同目录 SQL）。
- 后端 `dev` 无 watch：改 `apps/server` 后必须重启后端进程再做端到端验证。
- PowerShell 禁用 `&&`，用 `;` 或多行。

## 2. 现状摸底（file:line + 实测为证）

### 2.1 数据规模（真实 COUNT，2026-06-27）

| 表 | 行数 |
|----|------|
| `a_share_symbols`（list_status='L'） | 5,538 |
| `raw.daily_quote` | 5,670,870 |
| `index_daily_quotes` | 1,162,297 |
| `money_flow_stocks` | 702,408 |
| `raw.index_member` | 5,847 |

### 2.2 股票表格链路

- `ASharesService.query()` `a-shares.service.ts:110-137`：每次请求跑两条 SQL —— COUNT pass（`:123-127` `SELECT COUNT(*) FROM (<base>) sub`）+ rows pass（`:128-135` base + ORDER BY + LIMIT/OFFSET）。
- base query `a-shares-query.sql.ts:119-305`，核心是 CTE `latest`（`:147-151`）：

```sql
WITH latest AS (
  SELECT ts_code, MAX(trade_date) AS trade_date
  FROM raw.daily_quote GROUP BY ts_code
)
```

- 前端 `useASharesQuery.loadData()` `useASharesQuery.ts:123-150`；首屏 `reload()` `:211-216` 用 `Promise.all` 已并发。

### 2.3 股票表格实测（EXPLAIN ANALYZE，默认 qfq 无筛选）

- **COUNT pass：~650ms**。根因 = CTE `latest` 对 `raw.daily_quote` **567 万行全表 `Parallel Seq Scan` + `GROUP BY ts_code`**。
  - 关键修正：优化器**已自动裁剪** base 里所有 LATERAL / watchlist 标量子查询（它们不影响行数）；COUNT 慢**不是** LATERAL，而是这条全表 GROUP BY。
- **rows pass：~89ms**（默认 `ts_code` 排序）：借 `a_share_symbols_pkey` 有序 + `Merge Left Join` + `LIMIT 10` 提前终止，CTE `latest` 只算了约 11 组。
  - 隐患：按**行情/资金流/评分等非默认字段排序**时无法提前终止 → CTE `latest` 被迫全量计算 → rows pass 退化到数百 ms。

### 2.4 指数表格链路（代码证据）

- `IndexDailyService.getLatest()` `index-daily.service.ts:117-343`：COUNT pass（`:165-172` `COUNT(DISTINCT q.ts_code)` over 116 万行）+ rows pass（`:179-318`）。
- rows pass 结构：内层 `DISTINCT ON (q.ts_code) ... ORDER BY q.ts_code, q.trade_date DESC`（对 116 万行取每指数最新行，`:214-253`）→ 外层 **5 个 `LEFT JOIN LATERAL`**（`:255-314`，ind/ths/sec/mkt/idx 资金流滚动）→ 最后 `ORDER BY + LIMIT $pageSize`（`:315-316`，默认 20、可达 200）。
- 浪费点：5 个 LATERAL 对**全部数千指数**都算，最终只展示 20 行；每行按 `category` 实际只用 1–2 个滚动值。
- `sw_member_count` CTE（`:180-190`）对 `raw.index_member` 做 `UNION ALL` 三遍扫 + `is_new='Y'` 过滤，`is_new` 无索引（现有索引仅 `ix_raw_index_member_l1`(l1_code)、`ix_raw_index_member_ts_code`(ts_code,in_date)、pkey）。

### 2.5 前端瀑布

- `ASharesPanel.vue` `onActivated` `:272-276`：3 阶段串行 `await fetchConditions → await fetchLastRunStatus → await loadHitLookup`。
- `loadHitLookup` `:187-203`：`for-of` 内 `await strategyConditionsApi.getRunResult(id)` 逐条串行；N 条 fresh 策略 = N×RTT。
- 指数 `ASharesIndexThsPanel` / `ASharesIndexSwPanel` 的 `onActivated` 无条件 `reload()` 全量重查；`ASharesIndexPanel.vue` 用 `display-directive="show:lazy"`（非 `v-if`）→ 首次进 tab Ths+Sw 都 onMounted，多发一次 `/indices/latest`。

## 3. 瓶颈定位图

```text
股票表格（每次翻页/筛选/排序/首屏都跑 COUNT+rows）
  COUNT pass ~650ms ── CTE latest 全表 GROUP BY(567万行)  ★最大固定开销
  rows  pass ~89ms  ── 默认排序快；非默认排序退化(同一CTE全量)

指数表格
  rows pass ── DISTINCT ON 扫116万行 + 5×LATERAL×全部指数
            （index_member 三遍扫仅 5847 行，可忽略，不加索引）

前端
  ASharesPanel.onActivated ── (3 + N条策略) × RTT 串行瀑布
  指数 onActivated ── 无条件全量重查 + Sw 面板重复请求
```

## 4. 方案设计

### A. 后端·股票表格

**A1（核心）把 CTE `latest` 从「按 ts_code 分组 MAX」改为「单行全局 MAX + CROSS JOIN」**
- 仅改 `a-shares-query.sql.ts:buildASharesBaseQuery` 的 CTE 与 `a_share_symbols` 的衔接，**其余所有 `l.trade_date` 引用保持不变**（避免删 CTE 导致 `mf` LATERAL 的 `:205 FILTER (WHERE t.trade_date = l.trade_date)` 与 `:213 trade_date <= l.trade_date` 变成未定义引用）：

```sql
WITH latest AS (                                  -- 单行：全市场最新交易日
  SELECT MAX(trade_date) AS trade_date FROM raw.daily_quote
)
... FROM a_share_symbols s
CROSS JOIN latest l                               -- 原为 LEFT JOIN latest l ON l.ts_code = s.ts_code
LEFT JOIN raw.daily_quote q ON q.ts_code = s.ts_code AND q.trade_date = l.trade_date
-- m/i/sa/mf LATERAL/indexTsCode 分支内的 l.trade_date 全部不动
```

- 收益：`MAX(trade_date)` 走 `idx_a_share_daily_quotes_trade_date` DESC 单行返回，**消除 567 万行 `Seq Scan + GROUP BY`**；无需新增 service 往返、无需参数重排。
- **语义变化（用户已确认接受）**：停牌股若自身最新日 < 全市场最新日，其行情/指标列（含 `tradeDate`）显示为空（而非旧数据），与 `getSummary`（`a-shares.service.ts:88-90` 同为全局 MAX）口径统一。

**A2 COUNT pass 提速（A1 的附带收益）**
- A1 后 `SELECT COUNT(*) FROM (<base>) sub`：单行 `latest` 不放大行数，优化器裁剪不影响行数的 LEFT JOIN；无行情类筛选 → 实际只数 `a_share_symbols`(5538 行)；有 `dto.conditions` → 按全局日索引点查。预期 650ms → 个位数~几十 ms。
- 「无 `conditions` 时另写精简 COUNT SQL」**本次不实现**（A1 后优化器裁剪已够快），仅在 §6 EXPLAIN 复核后确有需要再评估；**不计入 T1 验收**。

**验证**：A1/A2 前后对 base 跑 `EXPLAIN ANALYZE`（默认排序 + 按 pctChg 排序 + 按 netInflow5d 排序三种），COUNT/rows 均应无 `Seq Scan on daily_quote (rows≈567万)`。

### B. 后端·指数表格（`index-daily.service.ts`）

**B1 默认排序先收敛再算 LATERAL**
- 当 `sortField ∉ {net_amount_5d, net_amount_10d, net_amount_20d}`（即排序不依赖 LATERAL 产物）：用**两层嵌套**先取当页 ≤pageSize 行，再对这些行做 LATERAL——
  - 内层：`DISTINCT ON (q.ts_code) ... ORDER BY q.ts_code, q.trade_date DESC`（DISTINCT ON 要求 ORDER BY 以 `q.ts_code` 起头，不可直接换排序列）；
  - 中层：`SELECT * FROM (内层) page ORDER BY <sortCol> <dir> NULLS LAST LIMIT $pageSize OFFSET $offset`；
  - 外层：仅对中层 ≤pageSize 行 `LEFT JOIN LATERAL ...`，最后再 `ORDER BY <sortCol>` 保稳定序。
- 当按 `net_amount_5d/10d/20d` 排序：保留现有「全量算 LATERAL 再排序」分支（必须先算完才能排序）。

**B2 精简 LATERAL（按 category 触发）**
- 每行按 `category` 实际只取 1–2 个滚动值（`market→mkt`、`sw→ind`、`industry→ths`、`concept→sec`、兜底 COALESCE）。按 category 条件化或合并 LATERAL，减少无效滚动计算。
- 内层 5 个**单日** `mf_*` 普通 JOIN（`:247-251`）本次不强制精简：B1 的「先收敛再 JOIN」已把其成本从全量指数降到当页；范围限定为只精简外层 5 个 LATERAL。
- 风险：保持 `netAmount5d/10d/20d` 的 `CASE category` 取值结果与现状逐行一致（用同一组覆盖 market/sw/industry/concept 的指数对照验证）。

### C. DB 索引（重新评估：默认不做）

- **诚实反驳**：`raw.index_member` 实测仅 **5,847 行**，`sw_member_count` 三遍扫描 ≈ 1.7 万行读取，亚毫秒级——加索引收益可忽略。**默认不加**，把它从关键路径里去掉。这也印证「索引非本次瓶颈，SQL 重写才是主战场」。
- 仅当 §6 的 `EXPLAIN ANALYZE` 显示该 CTE 确为指数表瓶颈时才考虑，且需注意**归属**：`raw.index_member` 的表与索引由 quant-pipeline 的 Alembic 管理（`apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260517_0002_raw_python_sync_tables.py`），**不应**放进 `apps/server/src/migration`（否则两套迁移系统漂移）。届时在 Alembic 侧新增 migration，列组合初稿 `(l1_code, l2_code, l3_code, ts_code) WHERE is_new = 'Y'`，按 EXPLAIN 调优。
- 其余表 `(ts_code, trade_date)` / `(category, trade_date DESC)` 索引已足够，不新增。

### D. 前端

**D1 `ASharesPanel` 去串行化**（`ASharesPanel.vue`）
- `onActivated`：`await Promise.all([fetchConditions('a-share'), fetchLastRunStatus()])` 后再 `loadHitLookup()`。
- `loadHitLookup`（`:187-203`）：收集 fresh 条件后用 `Promise.all(conditions.map(c => getRunResult(c.id).catch(()=>null)))` 并发，再组装 `Map`；保留单条失败忽略语义。
- 保留「切回刷新策略命中」语义，不对这部分加节流。

**D2 指数表格 `onActivated` 节流（核心）+ 重复请求源待定位**
- `ASharesIndexThsPanel` / `ASharesIndexSwPanel`：`onActivated` 增加节流——记录 `lastLoadedAt`，距上次 <60s 且筛选条件未变则跳过 `reload()`。这条已能解决「Ths/Sw 都挂载后，回顶层 tab 时两者各 `reload` 一次」的主要重复。
- **待先验证**：`ASharesIndexPanel.vue` 当前 `display-directive="show:lazy"` 本身即懒挂（未激活的 sub-tab 首屏不挂载），先实测网络面板确认是否真有重复 `/indices/latest`，**再决定**是否动 `display-directive`。注意改 `v-if` 会在 sub-tab 来回切换时反复卸载/重挂 → 每次重挂触发 `onMounted→reload`，**可能增加请求**，故不作默认动作。

**自主决定项**（无产品语义影响）：节流阈值 60s；B1 分支判据 = 排序字段是否 ∈ `{net_amount_5d, net_amount_10d, net_amount_20d}`。

## 5. 任务拆分（供 subagent-driven-development，按互斥文件域）

| # | 任务 | 主要文件（互不相交） | 依赖 |
|---|------|----------------------|------|
| T1 | A 股 base CTE 改写（A1，含 COUNT 附带提速 A2） | `a-shares-query.sql.ts`、`a-shares.service.ts`、`a-shares.service.spec.ts` | 无 |
| T2 | 指数 rows 重写（B1/B2） | `index-daily.service.ts` | 无 |
| T4 | 前端去串行化（D1） | `ASharesPanel.vue`、`ASharesPanel.spec.ts` | 无 |
| T5 | 前端指数节流（D2 核心） | `ASharesIndexThsPanel.vue`、`ASharesIndexSwPanel.vue` | 无 |
| T3（条件） | 索引（C）——仅 §6 EXPLAIN 证实瓶颈才做，且归 quant-pipeline Alembic | `apps/quant-pipeline/.../migrations/versions/*.py` | 依赖 §6 EXPLAIN 结论 |

默认并行 T1/T2/T4/T5（文件域互斥）；T3 条件触发；D2 的 `display-directive` 改动待网络实测后另议（不在 T5 默认范围）。

## 6. 验证标准

- 后端 EXPLAIN：T1/T2 改动前后 `EXPLAIN ANALYZE` 对照，关键路径无全表 `Seq Scan on daily_quote/index_daily_quotes (rows≈百万)`。
- 后端结果一致性（**因 A1 故意改语义，T1 不能要求逐行全等**，按任务分口径）：
  - **T2 指数表（纯重构）**：同参数下行数、列值与改动前**逐行一致**（含默认/行情排序/资金流排序）。
  - **T1 股票表**：对**当日有成交的股票**及非行情结构列逐行一致；**停牌股**（自身最新日 < 全市场最新日）的行情/指标列**预期由旧值变空**，并因 `NULLS LAST` 改变其在行情列排序中的位次、影响行情类 `conditions` 过滤的 `total`——此为 A1 预期语义，不算回归。
- 后端单测：`pnpm --filter @cryptotrading/server exec jest a-shares.service` 通过；若 `index-daily` 有对应 spec 一并跑。
- 前端：`pnpm --filter @cryptotrading/web test`（ASharesPanel 相关）通过；`pnpm --filter @cryptotrading/web type-check` 通过。
- 端到端（重启后端后）：股票表格首屏 / 翻页 / 改排序 / 切回 tab，指数表格首屏 / 切回，主观加载明显变快，数据正确。
- e2e 若写入用户偏好（列偏好/筛选方案），验完恢复默认。

## 7. 风险与回滚

- **A1 语义变化**：停牌股行情列由「旧数据」变「空」。已确认接受；如需回退，把单行 `latest` CTE 改回「按 ts_code 分组 MAX + LEFT JOIN」即可（纯 SQL 改动，无 schema 依赖）。
- **B2 正确性**：`CASE category` 取值必须与现状逐行一致——以一组覆盖 market/sw/industry/concept 的指数做 before/after diff 把关。
- **C 索引（默认不做，仅 §6 证实才加）**：在 quant-pipeline Alembic 侧用 `CREATE INDEX CONCURRENTLY` 避免锁表；失败可直接 `DROP INDEX`。
- 所有改动均为查询/前端逻辑层，无数据写入、无不可逆操作。
