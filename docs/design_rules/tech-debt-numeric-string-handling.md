# 技术债：PostgreSQL numeric 列的 string 返回与渐进迁移记录

## 背景

PostgreSQL `numeric` 类型经 node-postgres 默认返回 JS `string`（防精度丢失，因为 JS `number` 是 IEEE 754 双精度，无法精确表示任意精度小数）。

这导致一个普遍陷阱：前端用 `Number.isFinite(val)` guard 时，对 string 入参永远返回 `false`（ECMAScript 规范：`Number.isFinite` 不强制转换类型），从而 fallback 到空显示。

## 已修复（2026-07-17）

### regime-backtest 系列（4 entity）

| Entity | numeric 列数 | 修复方式 |
|---|---|---|
| `regime-backtest-run.entity.ts` | 9（finalNav/totalRet/annualRet/maxDrawdown/sharpe/calmar/dailyWinRate/dailyKelly/totalCosts） | `NumericTransformer` + 字段类型 `string \| null` → `number \| null` |
| `regime-backtest-daily.entity.ts` | 4（nav/cash/dailyRet/exposure） | 同上 |
| `regime-backtest-trade.entity.ts` | 5（ret/alloc/costsPaid/realizedRetNet/rankValue） | 同上 |
| `regime-backtest-daily-log.entity.ts` | 2（nav/cash） | 同上 |

配套改动：
- `apps/server/src/entities/common/numeric.transformer.ts`（新建通用 transformer）
- `apps/server/src/strategies/regime-engine/backtest/regime-backtest.runner.ts`（清理冗余 numStr/String 包裹）
- `apps/server/src/strategies/regime-engine/backtest/regime-backtest-audit.helpers.ts`（清理冗余 String/Number/num 包裹）
- `apps/web/src/utils/format.ts`（新建前端统一 fmtPct/fmtNum 工具，防御性兼容 number/string/null 入参）
- 4 个 regime-backtest 前端组件迁移到 `@/utils/format`

## 剩余技术债（24 entity，未迁移）

以下 entity 仍有 `type: 'numeric'` 列但 TS 声明为 `string`（或 `string | null`），消费方依赖 string 行为。**不强制迁移**——按需在新增功能或重构时渐进推进。

### 一类：消费方故意按 string 设计（不建议改）

这些模块的前端 formatters 签名就是 `string | null`（如 `aSharesFormatters.ts`），改 entity 类型会破坏消费方。

| Entity 文件 | numeric 列数 | 主要消费方 |
|---|---|---|
| `entities/raw/daily-quote.entity.ts` | 16 | `aSharesFormatters.ts`（函数签名 `string \| null`） |
| `entities/raw/daily-basic.entity.ts` | 7 | 同上 |
| `entities/money-flow/money-flow-stock.entity.ts` | 10 | `shared-types/money-flow.ts`（`MoneyFlowStockRow` 等声明 `string \| null`） |
| `entities/money-flow/money-flow-industry.entity.ts` | 7 | 同上 |
| `entities/money-flow/money-flow-etf.entity.ts` | 7 | 同上 |
| `entities/money-flow/money-flow-index.entity.ts` | 4 | 同上 |
| `entities/money-flow/money-flow-market.entity.ts` | 4 | 同上 |
| `entities/money-flow/money-flow-sector.entity.ts` | 4 | 同上 |
| `entities/money-flow/money-flow-ths-industry.entity.ts` | 4 | 同上 |
| `entities/raw/etf-pcf.entity.ts` | 5 | a-shares 模块 |
| `entities/raw/stk-limit.entity.ts` | 3 | a-shares 模块 |
| `entities/index-daily/index-daily-quote.entity.ts` | 2 | index 模块 |
| `entities/ths-index-daily/ths-index-daily-quote.entity.ts` | 2 | ths 模块 |
| `entities/raw/adj-factor.entity.ts` | 1 | 同步模块内部使用 |
| `entities/symbol/kline.entity.ts` | 8 | crypto 模块 |
| `entities/raw/us-adj-factor.entity.ts` | 1 | 同步模块内部使用 |

### 二类：消费方声明 number 但实际拿到 string（潜在 bug，建议优先迁移）

这些模块的前端类型声明是 `number`，但后端实际返回 string，目前靠 `Number.isFinite(string)` 巧合 coerce 或 ECharts 隐式 parseFloat 绕过。

| Entity 文件 | numeric 列数 | 前端消费方 | 风险 |
|---|---|---|---|
| `entities/raw/us-daily-quote.entity.ts` | 13 | `AShareKlineBar` / `KlineChartBar` | 中：靠 ECharts 隐式 parseFloat 绕过 |
| `entities/raw/us-index-daily-quote.entity.ts` | 5 | us-index 前端 | 中 |
| `entities/raw/fund-daily.entity.ts` | 17 | 基金 K 线 | 中 |

> 注：`custom-index` 系列 entity（`custom-index-definition.entity.ts`、`custom-index-member.entity.ts` 等）虽有 `type: 'numeric'` 列，但经实际检查列数极少且消费场景较窄，归入一类处理。

## 迁移决策树

新增 numeric entity 或修改现有 entity 时，按以下规则决策：

```
该 entity 的消费方（前端 formatters / TS 类型）是否声明为 string？
├─ 是（如 aSharesFormatters）→ 保持现状，不改 entity，消费方自行 Number()
└─ 否（声明为 number，或新模块）→ 加 NumericTransformer，字段类型 number | null
    └─ 前端用 @/utils/format 兜底（防御性兼容 string 入参）
```

## 全局方案（不推荐）

理论上可以一行代码全局解决：在 `apps/server/src/main.ts` 顶部加：
```ts
import pg from 'pg';
pg.types.setTypeParser(pg.types.builtins.NUMERIC, parseFloat);
```

但这会让所有 numeric 列全局返回 number，**会立即破坏**：
- `KlineEntity.open: string` 等大量 entity 的 TS 类型
- `aSharesFormatters.ts` 的 `string | null` 签名函数
- 所有依赖 string numeric 行为的隐式 coerce 代码

**不采用**。维持 entity 级 transformer 的精准外科手术方式。

## 参考实现

- `apps/server/src/entities/common/numeric.transformer.ts` —— 通用 transformer
- `apps/server/src/entities/common/numeric.transformer.spec.ts` —— 单测
- `apps/web/src/utils/format.ts` —— 前端防御性 fmt 工具
- `apps/web/src/utils/__tests__/format.spec.ts` —— 单测

## 相关文档

- [regime-backtest/01-workflow.md](./regime-backtest/01-workflow.md) §3.1 regime-backtest 接口字段类型契约
- [regime-backtest/03-engine-internals.md](./regime-backtest/03-engine-internals.md) 引擎内部机制
