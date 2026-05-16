# A 股详情 K 线资金流副图 & "主力净流入"误称清理 设计

- **日期**：2026-05-17
- **作者**：renmaoyuan（with Claude）
- **状态**：待评审
- **前置 spec**：[`2026-05-16-kline-moneyflow-subchart-design.md`](./2026-05-16-kline-moneyflow-subchart-design.md)（T1-T3 已完成，但显式排除了 A 股 Drawer）

## 1. 背景与目标

T3 已把行业 / 板块趋势 Tab 切到通用 `KlineChart` 并启用 `moneyFlow` 副图，T2 把"资金流副图"做成可选 prop。前置 spec § 7.2 显式标注「A 股详情 (AShareDetailDrawer) 是否加副图是另一产品决策」为本期非目标，留待后续。

本期回到这个决策点：

1. **主目标**：A 股详情 Drawer（`AShareDetailDrawer.vue`）的 K 线下方默认展示资金流副图，与行业/板块完全同语义。
2. **附加目标**：扫描修正代码库里把 Tushare `net_amount`（官方语义"资金净流入"）误称为"主力净流入"的误称——并连带把 daily-review 模块里 LLM 工具协议字段 `mainNetIn`（实际取 `net_amount`）重命名为 `netIn`，让命名与数据语义对齐。
3. **附加目标**：确认 SyncView Card 3「资金流向」对个股维度的同步入口可用，端到端跑通"同步 → 查询 → 副图展示"链路。

### 1.1 Tushare 字段语义（来自官方文档查证）

| 接口 | 字段 | 官方描述 | 单位 |
|---|---|---|---|
| `moneyflow_ths` | `net_amount` | 资金净流入 | **万元** |
| `moneyflow_ths` | `net_d5_amount` | 5 日主力净额 | 万元 |
| `moneyflow_ths` | `buy_lg_amount` | 今日大单净流入额 | 万元 |
| `moneyflow_ind_ths` | `net_amount` | 净额（流入 − 流出） | **亿元** |
| `moneyflow_ind_ths` | `net_buy_amount` | 流入资金 | 亿元 |

关键事实：**单日 `net_amount` 在两个接口里官方释义都是"资金净流入 / 净额"，不是"主力净流入"**。"主力"二字在 Tushare 文档中只出现在 `net_d5_amount`（5 日主力净额）。因此：

- 现行前端 Y 轴标签 `'资金净流入(亿)'` 与 Tooltip `'资金净流入'` **本就正确**，不动。
- 代码里把 `net_amount` 标注成"主力净流入"的位置全部属于误称，本 spec 清理。
- `last5dNetIn` / `last20dNetIn` 等"近 N 日累计"语境保留"主力"字样（与 Tushare `net_d5_amount` 文档原文对齐）。

## 2. 非目标

- 不修改后端 `money-flow.service.ts` / `money-flow.controller.ts` 任何接口契约或排序逻辑。
- 不修改 `KlineChart.vue` / `klineChartOptions.ts` / `klineChartLayout.ts`（T2 已完成）。
- 不修改 `money_flow_stocks` 表 schema 或同步逻辑。
- 不改 SyncView Card 3 的 UI（同步入口已存在）。
- 不回改历史 plan/spec 文档（`docs/superpowers/plans/2026-05-12-daily-review.md`、`docs/superpowers/specs/2026-05-12-daily-review-design.md`）—— 这些是已发布快照。
- 不改字段语义考据未完结的 `last5dNetIn` / `last20dNetIn` 数据来源（保留为 TODO，由后续 spec 处理）。

## 3. 架构

```
[ AShareDetailDrawer.vue ]
        |
        | watch(row) -> fetchAShareDetail
        | watch(priceMode) -> fetchAShareKlineOnly
        v
[ aShareDetailFetcher.ts ]  (NEW)
   |              |
   | Promise.all  |
   v              v
[ aSharesApi   [ moneyFlowApi
   .getKlines]    .queryStocks ]
   GET /a-shares  GET /money-flow
   /:c/klines      /stocks
        \           /
         v         v
  { kline: AShareKlineBar[],
    moneyFlow: MoneyFlowBar[] }
        |
        v
  <KlineChart :data="klineRows"
              :money-flow="moneyFlowRows"
              :slider-start="35" />
```

后端零改动。前端在 `AShareDetailDrawer.vue` 与新建的 `aShareDetailFetcher.ts` 之间增加一层薄聚合，参照 T3 的 `trendFetchers.ts` 范式。

## 4. 详细设计

### 4.1 新建文件：`apps/web/src/components/symbols/a-shares/aShareDetailFetcher.ts`

```ts
import { aSharesApi, type AShareKlineBar } from '@/api/modules/market/aShares'
import { moneyFlowApi, type MoneyFlowStockRow } from '@/api/modules/market/moneyFlow'
import type { MoneyFlowBar } from '@/api/modules/market/symbols'

export interface AShareDetailFetchResult {
  kline: AShareKlineBar[]
  moneyFlow: MoneyFlowBar[]
}

/** Drawer 首次加载 / 切换 row 时调用：并行拉 K 线 + 资金流 */
export async function fetchAShareDetail(
  tsCode: string,
  limit: number,
  priceMode: 'qfq' | 'raw',
): Promise<AShareDetailFetchResult> {
  const [kline, flowRows] = await Promise.all([
    aSharesApi.getKlines(tsCode, limit, priceMode),
    moneyFlowApi.queryStocks({ ts_code: tsCode, limit }),
  ])
  return { kline, moneyFlow: mapMoneyFlowBars(flowRows) }
}

/** priceMode 切换时调用：只重拉 K 线，资金流由调用方缓存复用 */
export async function fetchAShareKlineOnly(
  tsCode: string,
  limit: number,
  priceMode: 'qfq' | 'raw',
): Promise<AShareKlineBar[]> {
  return aSharesApi.getKlines(tsCode, limit, priceMode)
}

/**
 * 把后端 MoneyFlowStockRow 映射为 KlineChart 副图所需的 MoneyFlowBar。
 * - 后端 service 在传 limit 时按 trade_date DESC 返回，K 线主图是 ASC 显示，需要 reverse。
 * - netAmount 已由后端 toYi() 转为亿元（万元 ÷ 10000），前端不再换算。
 * - null/NaN 回退为 0，与 trendFetchers.fetchIndustryTrend 一致。
 */
function mapMoneyFlowBars(rows: MoneyFlowStockRow[]): MoneyFlowBar[] {
  return rows
    .slice()
    .reverse()
    .map(r => ({
      trade_date: r.tradeDate,
      net_amount: Number(r.netAmount) || 0,
    }))
}
```

### 4.2 改动文件：`apps/web/src/components/symbols/a-shares/AShareDetailDrawer.vue`

**保留现有 UX**：`loading` 自旋、`try/catch + message.error` 错误提示、`show=false` 清空数据。

**watch 范式调整**：现有单 watch `[show, tsCode, priceMode]` 无法区分"row 变 vs priceMode 变"，要兑现 § 11 "priceMode 不重拉资金流" 硬约束，**拆成两个 watch**：

```ts
import {
  fetchAShareDetail,
  fetchAShareKlineOnly,
} from './aShareDetailFetcher'
import type { MoneyFlowBar } from '@/api/modules/market/symbols'

const loading = ref(false)
const klineRows = ref<AShareKlineBar[]>([])
const moneyFlowRows = ref<MoneyFlowBar[]>([])

/** Drawer 打开 / row 切换：并行拉 K 线 + 资金流 */
async function loadDetail() {
  const tsCode = props.row?.tsCode
  if (!tsCode) return
  loading.value = true
  klineRows.value = []
  moneyFlowRows.value = []
  try {
    const result = await fetchAShareDetail(tsCode, 360, props.priceMode)
    klineRows.value = result.kline
    moneyFlowRows.value = result.moneyFlow
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

/** priceMode 切换：只重拉 K 线，资金流保留 */
async function reloadKlineOnly() {
  const tsCode = props.row?.tsCode
  if (!tsCode) return
  loading.value = true
  try {
    klineRows.value = await fetchAShareKlineOnly(tsCode, 360, props.priceMode)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.show, props.row?.tsCode] as const,
  ([show, tsCode]) => {
    if (!show) {
      klineRows.value = []
      moneyFlowRows.value = []
      return
    }
    if (!tsCode) return
    void loadDetail()
  },
)

watch(
  () => props.priceMode,
  () => {
    if (!props.show || !props.row?.tsCode) return
    void reloadKlineOnly()
  },
)
```

替换说明：
- 删除原 `loadKlines()` 函数，由 `loadDetail()` 接管，并新增 `reloadKlineOnly()`。
- `klineRows` / `moneyFlowRows` 在 `show=false` 与 `loadDetail` 开头**双重清空**——避免上一只股票的资金流柱漏到新股票视图里。
- `priceMode` 切换路径不清空 `moneyFlowRows`，从用户视角"副图保持显示，主图复权方式平滑切换"。

模板：

```vue
<kline-chart
  v-else
  :data="klineRows"
  :money-flow="moneyFlowRows"
  height="100%"
  :slider-start="35"
/>
```

### 4.3 边界情况

| 场景 | 行为 |
|---|---|
| 资金流 API 返回 0 行（北交所新股 / 停牌 / 未同步） | `moneyFlowRows = []`，`<KlineChart :money-flow="[]">` 不渲染副图 grid（`apps/web/src/composables/kline/klineChartOptions.ts:267-291` 既有保护）。Drawer 正常显示主图，不报错不提示。 |
| K 线 360 但资金流仅返回 200 行（部分日期未发布） | 按 trade_date 对齐，缺失日期 bar 留空（既有逻辑）。 |
| 任一 API 失败（reject） | 沿用现有 Drawer try/catch，整体加载失败提示与现状一致；**不**退化为"K 线显示但副图静默空白"——避免与"合法 0 行"产生混淆。 |
| priceMode 切换时正在加载 | watch 顺序触发，最后一次写入获胜；不引入 race-cancel 机制（YAGNI）。 |

## 5. `mainNetIn → netIn` 重命名

### 5.1 改名理由

字段名 `mainNetIn` 暗示"主力净流入"，但所有取值点都来自 `money_flow_stocks.net_amount` 或 `money_flow_market.net_amount`（即 Tushare `moneyflow_ths.net_amount`，官方语义"资金净流入"）。重命名为 `netIn` 让命名与数据来源对齐，**不动数据查询**。

### 5.2 完整改动清单

#### 5.2.1 接口/类型定义（5 处）

| 文件 | 行号 | 当前 | 改后 |
|---|---|---|---|
| `apps/server/src/daily-review/types/daily-review.types.ts` | 5 | `mainNetIn?: number` | `netIn?: number` |
| `apps/server/src/daily-review/types/daily-review.types.ts` | 32 | `market: { mainNetIn: number }` | `market: { netIn: number }` |
| `apps/server/src/daily-review/investigation/tools/tool-types.ts` | 71 | `mainNetIn: number \| null` | `netIn: number \| null` |
| `apps/web/src/components/daily-review/ReviewMoneyFlowChart.vue` | 10 | `topIn: { name: string; mainNetIn: number }[]` | `topIn: { name: string; netIn: number }[]` |
| `apps/web/src/components/daily-review/ReviewMoneyFlowChart.vue` | 11 | `topOut: { name: string; mainNetIn: number }[]` | `topOut: { name: string; netIn: number }[]` |

#### 5.2.2 SQL 别名 + handler 赋值（5 处）

| 文件 | 行号 | 当前 | 改后 |
|---|---|---|---|
| `apps/server/src/daily-review/snapshot/snapshot-builder.service.ts` | 89 / 94 / 100 | SQL `SELECT ... AS main_net_in` | `SELECT ... AS net_in` |
| `apps/server/src/daily-review/snapshot/snapshot-builder.service.ts` | 109 | `mainNetIn: +r.main_net_in * 10000` | `netIn: +r.net_in * 10000` |
| `apps/server/src/daily-review/snapshot/snapshot-builder.service.ts` | 111 | `market: { mainNetIn: +(market?.main_net_in ?? 0) * 10000 }` | `market: { netIn: +(market?.net_in ?? 0) * 10000 }` |
| `apps/server/src/daily-review/investigation/tools/handlers/lookup-concept.handler.ts` | 146 | `mainNetIn: this.safeNumber(r.net_amount)` | `netIn: this.safeNumber(r.net_amount)` |

`r.net_amount` 是数据库列名映射，**不动**。

#### 5.2.3 前端 handler 读取（2 处）

| 文件 | 行号 | 当前 | 改后 |
|---|---|---|---|
| `apps/web/src/components/daily-review/ReviewMoneyFlowChart.vue` | 32 | `inItems.map(i => ({ value: toHundredMillion(i.mainNetIn), ... }))` | `i.netIn` |
| `apps/web/src/components/daily-review/ReviewMoneyFlowChart.vue` | 33 | 同上 outItems | 同上改 `i.netIn` |

#### 5.2.4 测试用例（9 处生产测试）

| 文件 | 行号 | 当前 | 改后 |
|---|---|---|---|
| `apps/server/src/daily-review/snapshot/snapshot-builder.service.spec.ts` | 70-72 | Mock 字段 `main_net_in: '...'` × 3 行 | `net_in: '...'` |
| 同上 | 75 | `expect(r.market.mainNetIn).toBe(...)` | `r.market.netIn` |
| 同上 | 76 | `expect(r.stocksTopIn[0].mainNetIn).toBe(...)` | `r.stocksTopIn[0].netIn` |
| 同上 | 77 | `expect(r.stocksTopOut[0].mainNetIn).toBe(...)` | `r.stocksTopOut[0].netIn` |
| 同上 | 116 | Mock 返回 `{ market: { mainNetIn: 0 }, ... }` | `{ market: { netIn: 0 }, ... }` |
| `apps/server/src/daily-review/investigation/tools/handlers/lookup-concept.handler.spec.ts` | 63 | `mainNetIn: 99999` | `netIn: 99999` |

#### 5.2.5 注释 / prompt 字面值（3 处）

| 文件 | 行号 | 当前 | 改后 |
|---|---|---|---|
| `apps/server/src/daily-review/investigation/tools/handlers/lookup-concept.handler.ts` | 19 | 注释 `constituents: [{tsCode, name, pctChg, mainNetIn, isLeader}]` | 改 `netIn` |
| 同上 | 25 | 注释 `isLeader = 当天该概念内 mainNetIn 排名第 1` | 改 `netIn` |
| `apps/server/src/daily-review/investigation/tools/tool-types.ts` | 72 | 注释 `该板块当日 mainNetIn 排名第 1 视为龙头` | 改 `netIn` |

#### 5.2.6 显式不改（HISTORICAL 快照）

下列文件 `mainNetIn` 字面值**保留**，作为历史 plan/spec 的快照存在：

- `docs/superpowers/plans/2026-05-12-daily-review.md`（5 处：l.317, 326, 763-765, 792-794, 946）
- `docs/superpowers/specs/2026-05-12-daily-review-design.md`（3 处：l.107-109）

### 5.3 执行顺序

为不破坏 daily-review 工作流，重命名必须在同一次提交内完成下面 7 步：

1. 改 `tool-types.ts` 与 `daily-review.types.ts` 接口字段定义
2. 改 `snapshot-builder.service.ts`（SQL 别名 + handler 赋值）
3. 改 `lookup-concept.handler.ts`（赋值 + 注释 + JSDoc）
4. 改 `ReviewMoneyFlowChart.vue`（props 类型 + 模板/逻辑读取点）
5. 改所有相关 `*.spec.ts` 的 mock 与断言
6. `pnpm --filter @cryptotrading/server build` 验证 TypeScript 编译 0 错
7. `rg "mainNetIn" apps/` 命中数必须 = 0；`rg "main_net_in" apps/` 命中数必须 = 0

## 6. "主力净流入" 文案清理（A 类）

### 6.1 必改清单（NEED-CHANGE）

| 文件 | 行号 | 当前 | 改后 |
|---|---|---|---|
| `apps/web/src/components/money-flow/MarketFlowPanel.vue` | 45 | `label: '主力净流入'` | `label: '资金净流入'` |
| `apps/web/src/components/money-flow/money-flow.types.ts` | 19 | 注释 `主力净流入柱状副图数据` | `资金净流入柱状副图数据` |
| `apps/server/src/daily-review/investigation/tools/handlers/lookup-stock.handler.ts` | 125 | 注释 `"主力净流入"排名` | `"资金净流入"排名` |
| `apps/server/src/daily-review/daily-review.service.spec.ts` | 147 | `summary: '主力净流入 12 亿'` | `summary: '资金净流入 12 亿'` |
| `apps/server/src/daily-review/investigation/investigator.service.spec.ts` | 31 | 同上 | 同上 |

（Spec 自审时已 spot-check：`money-flow-stock.entity.ts` 与 `money-flow-sync.service.ts` 当前**不含**"主力净流入"字样，无需修改。）

### 6.2 显式不改（KEEP）

| 文件 | 行号 | 原文 | 不改理由 |
|---|---|---|---|
| `apps/server/src/daily-review/investigation/tools/tool-types.ts` | 44 | 注释 `近 5 个交易日（按 trade_date DESC）主力净流入合计，单位元` | `last5dNetIn` 字段语义对应 Tushare `net_d5_amount`（官方原文"5 日主力净额"），保留"主力"二字与文档一致 |
| 同上 | 46 | 注释 `近 20 个交易日 主力净流入合计，单位元` | 同上，20 日累计沿用 5 日"主力"语义 |
| 历史 plan/spec markdown | — | 各处出现的"主力净流入"字样 | 已发布快照不回改 |

⚠️ **TODO（不在本期）**：`last5dNetIn` / `last20dNetIn` 实际取值是 `SUM(net_amount)` 还是 `SUM(net_d5_amount)` / 等价语义，需要单独 spec 验证；本期仅以"注释保留主力字样、待后续核实数据语义"了结。

### 6.3 验收 grep

```bash
rg "主力净流入" apps/
```

预期命中：**仅 `tool-types.ts:44, 46` 两处**（5/20 日累计语境保留）。其它命中必须 0。

## 7. 同步入口验证（Task γ）

SyncView Card 3「资金流向」已暴露个股维度同步入口（`POST /money-flow/sync/run` → `syncStocks(...)`，在 `money-flow-sync.service.ts:295-300` 的四维循环中）。本任务**零代码**，仅做端到端可达性验证：

1. 打开 SyncView → Card 3「资金流向」→ 选最近一个交易日的 start/end → 触发同步
2. 等待 SSE 流结束，确认日志**无** `daily_empty` / `moneyflow_ths_empty` warn
3. 执行 SQL：
   ```bash
   docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
     "SELECT COUNT(*) FROM money_flow_stocks WHERE trade_date = '<YYYYMMDD>';"
   ```
   期望 `> 4000`
4. 打开 A 股详情 Drawer，挑一只主板大票（如 `000001.SZ`），副图最右一根应是当日 `net_amount` 柱形
5. 挑一只北交所新股或停牌票（可选），副图允许稀疏甚至空白——合法行为，不算 bug

产出物：一段验收记录贴入 PR 描述，无代码改动。

## 8. 测试策略

### 8.1 Task α（A 股副图主线）

- **单元** `aShareDetailFetcher.spec.ts`（新建）：
  - Promise.all 并发触发两次 API 调用
  - `mapMoneyFlowBars` 正确 reverse + 数值透传 + null 回退 0
  - 资金流 0 行时 `moneyFlow: []`
  - `fetchAShareKlineOnly` 不触发 `moneyFlowApi.queryStocks`
- **组件回归**：T2 已建立的 KlineChart snapshot 覆盖 `moneyFlow=[]` 不渲染副图分支，不新建。
- **手测**：3 类股票 × priceMode 切换：
  - 主板大票（数据完整）
  - 北交所新股（资金流稀疏 / 空）
  - 停牌票（最近 N 日空）
  - 切换 qfq/raw，观察 network 面板只重发 `/klines`、不重发 `/money-flow/stocks`

### 8.2 Task β（重命名 + 文案清理）

- **编译**：`pnpm --filter @cryptotrading/server build` 0 错。
- **单测**：`pnpm --filter @cryptotrading/server test` daily-review / investigation 相关 spec 全绿。
- **前端类型**：`pnpm --filter @cryptotrading/web vue-tsc --noEmit` 0 错。
- **grep 反查**：
  - `rg "\bmainNetIn\b" apps/` = 0
  - `rg "main_net_in" apps/` = 0
  - `rg "主力净流入" apps/` 命中仅 `tool-types.ts:44,46` 两处
- **LLM 输出抽测**：手动触发一次 daily-review，确认生成报告中不再出现 `mainNetIn` 字面值（中文标签是否带"主力"由 prompt 决定，本期不强约束）。

### 8.3 Task γ（同步入口验证）

见 § 7，无自动化测试。

## 9. 任务切分（对齐 dispatching-parallel-agents）

按"文件域不相交"切分，三个 Task 可并行派发：

| Task | 范围 | 涉及目录 | 预估改动 |
|---|---|---|---|
| **α — A 股副图主线** | 新建 fetcher + 改 Drawer + 单测 | `apps/web/src/components/symbols/a-shares/*`（含新建） | 1 新文件 + 1 改文件 + 1 spec ≈ 200 行 |
| **β — 重命名 & 文案清理** | `mainNetIn → netIn` + "主力净流入" → "资金净流入"（NEED-CHANGE 项） | `apps/server/src/daily-review/**` + `apps/web/src/components/daily-review/ReviewMoneyFlowChart.vue` + `apps/web/src/components/money-flow/{MarketFlowPanel.vue, money-flow.types.ts}` + 相关 spec | 13 处接口/handler/SQL 别名 + 9 处测试 + 5 处文案 ≈ 50 行散点改动 |
| **γ — 同步入口验证** | 手动执行 SyncView 同步 + 跑 SQL 确认 | 无代码 | 0 行（产出验收记录） |

**文件域非冲突边界**：
- α 只动 `components/symbols/a-shares/*`
- β 只动 `daily-review/**` + `components/money-flow/{MarketFlowPanel.vue, money-flow.types.ts}` + `components/daily-review/*` + 散点注释
- γ 不动代码
- α 和 β 的测试文件不相交

如发生交集（`money-flow.types.ts` 既被 α 间接 import 又是 β 的注释清理点），统一交给 **β** 处理；α 只 import 不改它。

## 10. 风险与回避

| 风险 | 回避 |
|---|---|
| `mainNetIn` 出现在 LLM 历史对话或已生成报告 markdown 中 | 历史 markdown 不回改（HISTORICAL）；LLM tool protocol 每次都从工具定义重拼上下文，无向前/向后兼容包袱 |
| SQL 别名 `main_net_in` 与代码字段联动遗漏 | § 5.3 步骤 7 的 grep 反查兜底，必须 0 命中 |
| `last5dNetIn` / `last20dNetIn` 数据语义实际是"资金净流入累计"而非"主力净额累计" | 本期不动；以"注释保留主力字样 + TODO 备注"了结，由后续 spec 验证字段来源 |
| priceMode 切换路径上资金流缓存与 K 线日期失同步 | 同一只股票 365 天内 trade_date 集合不因复权方式变化，仅价格变。资金流按 trade_date 对齐，与 K 线 reverse 后顺序一致 |
| Drawer 打开瞬间 `props.row` 频繁切换导致竞态 | 采用 watch 顺序"最后一次写入获胜"，不引入 race-cancel；现状即如此 |

## 11. 验收清单（写代码前公示）

1. ✅ A 股 Drawer 默认展示 K 线 + 资金流副图，无开关，无需用户操作
2. ✅ 副图数据来源是 `GET /money-flow/stocks?ts_code=*&limit=360`，与 K 线对齐
3. ✅ priceMode 切换只发 1 个 `/klines` 请求，**不重发** `/money-flow/stocks`
4. ✅ 资金流 0 行时副图静默隐藏，Drawer 不报错
5. ✅ `rg "\bmainNetIn\b" apps/` = 0
6. ✅ `rg "main_net_in" apps/` = 0
7. ✅ `rg "主力净流入" apps/` 命中仅 `tool-types.ts:44,46` 两处
8. ✅ `pnpm --filter @cryptotrading/server build` 通过
9. ✅ `pnpm --filter @cryptotrading/server test` daily-review 相关 spec 全绿
10. ✅ `pnpm --filter @cryptotrading/web vue-tsc --noEmit` 0 错
11. ✅ SyncView Card 3 触发一次同步 → `money_flow_stocks` 当日行数 > 4000
12. ✅ Drawer 手测覆盖：主板大票 / 北交所新股 / 停牌票 三档行为符合 § 4.3 边界表
