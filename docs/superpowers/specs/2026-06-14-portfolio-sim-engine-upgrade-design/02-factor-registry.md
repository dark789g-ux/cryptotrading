# 02 · 因子注册表(白名单)

新文件 `apps/server/src/strategy-conditions/portfolio-sim/portfolio-sim.factor-registry.ts`。

## 为什么要注册表(数据完整性落点)

[.claude/rules/database-sql.md](../../../../.claude/rules/database-sql.md):**动态 SQL 构建禁止直接拼接前端字段名**。
前端只发因子 **KEY**(如 `'momentum_60'`),后端用注册表把 KEY 翻译成「来源表 + 列 / 现算表达式」,
**绝不把前端字符串拼进 SQL**。注册表同时是:① loader 的 JOIN/列来源单一真相;② service 白名单
(`VALID_RANK_FACTOR_KEYS` 从注册表 keys **自动派生**,不再手维护);③ 前端选项与提示来源。

## 9 因子注册表

| RankFactorKey | 来源(表.列 / 现算) | 历史可回测 | 默认dir | 语义 |
|---|---|---|---|---|
| `pos_120` | `signal_rolling_indicator.pos_120` | ✅ 88% | asc | 120日价格位置,越低越超跌 |
| `pos_60` | `signal_rolling_indicator.pos_60` | ✅ 94% | asc | 60日价格位置 |
| `close_ma60_ratio` | `signal_rolling_indicator.close_ma60_ratio` | ✅ 94% | asc | close/ma60,越低越回踩 |
| `vol_ratio_60` | `signal_rolling_indicator.vol_ratio_60` | ✅ 94% | asc | 量比60,缩量优先 |
| `vol_ratio_120` | `signal_rolling_indicator.vol_ratio_120` | ✅ 88% | asc | 量比120 |
| `risk_reward` | `raw.daily_indicator.risk_reward_ratio` | ✅ 100% | desc | 盈亏比,越高越优 |
| `momentum_60` | `(qfq_close−ma60)/atr_14` 现算 | ✅ ~94% | desc | 动量(ATR标准化) |
| `circ_mv` | `raw.daily_basic.circ_mv` | ✅ 100% | asc | 流通市值(非质量,小市值优先) |
| `ml_score` | `ml.scores_daily.score` | ❌ 仅2天 | desc | P(涨)−P(跌),前向专用 |

> **默认 dir 仅是 UI 初值与 legacy 兜底**,运行时由 `RankFactor.dir` 覆盖。`close_ma60_ratio` 的方向
> 是研究问题(回踩 asc vs 强势 desc),默认 asc,实测再调。

## 注册表条目结构

```text
RankFactorRegistryEntry {
  key: RankFactorKey
  label: string                 // 前端展示名
  histAvailable: boolean        // false → 前端灰提示「禁历史回测」、校验放行但 warn
  defaultDir: 'asc' | 'desc'
  kind: 'column' | 'computed'
  // kind='column':
  source?: { table: string; schema?: string; column: string }   // 注册表内白名单常量,非前端串
  // kind='computed'(momentum_60):
  needs?: Array<{ table: string; schema?: string; column: string; alias: string }>
  compute?: (vals: Record<string, number | null>) => number | null
}
```

- 所有 `table`/`column`/`schema` 是**注册表里写死的常量字符串**(代码字面量),不接受任何外部输入。
- loader 拿到一组因子 KEY → 用注册表求出「需 JOIN 的表集合 + 需 SELECT 的列」,构建参数化 SQL。

## momentum_60 现算(三表)

`close` 不在 `daily_indicator`,在 `raw.daily_quote`(已核 2026-06-14)。用 **qfq_close**(前复权,
与 loader 行情口径一致),分母 ma60/atr_14 取自 `raw.daily_indicator`:

```text
momentum_60 = (daily_quote.qfq_close − daily_indicator.ma60) / daily_indicator.atr_14
needs = [
  { table:'daily_quote',     schema:'raw', column:'qfq_close', alias:'mom_close' },
  { table:'daily_indicator', schema:'raw', column:'ma60',      alias:'mom_ma60'  },
  { table:'daily_indicator', schema:'raw', column:'atr_14',    alias:'mom_atr'   },
]
compute(v): (v.mom_close==null || v.mom_ma60==null || !v.mom_atr) ? null
                                                                  : (v.mom_close - v.mom_ma60)/v.mom_atr
```

- **用 ma60 不用 ma240**(ma240 在 2022 全年 NULL,会丢整年);ma60 覆盖 ~94%,2022-04 起有值。
- `atr_14` 为 0 或 null → 该因子值置 `null`(不抛、不 ÷0),交给 null 处置。

## ml_score:前向专用 + pin 单模型去重(已核 DB)

`ml.scores_daily(trade_date, ts_code, model_version, score, rank_in_day)`,真 DB 核实 2026-06-14:

- **历史仅 `20260515`/`20260528` 两天** → `histAvailable:false`。前端选项标灰提示、service 校验放行
  但 `logger.warn`(历史回测会几乎全 null、退化 ts_code 序)。
- **2 个 model_version**:`lgb-lambdarank-v1-20260521-seed42`(两天全有)、`...20260607-seed42`(仅 20260515)。
  `20260515` 两模型并存(2×5495=10990 行)→ (trade_date,ts_code) 在跨模型下重复;但**单模型内
  (trade_date,ts_code) 唯一**(已查 dup=0)。
- → JOIN **必须先 pin 单模型再去重**:`DISTINCT ON (trade_date, ts_code) ORDER BY trade_date, ts_code,
  model_version DESC, rank_in_day ASC`——`model_version DESC` 取每键**最新模型**(20260515 取 0607、
  20260528 取 0521),单模型内唯一故确定;**绝不用 rank_in_day 跨模型混挑**(两模型 rank/score 不可比)。
  详见 [06-loader-multifactor.md](./06-loader-multifactor.md#ml_score-去重-join已核-db)。
- 局限(诚实标注):跨日可能取自不同模型(0515→0607、0528→0521);因 ml_score 本就前向专用、历史几乎全
  null,可接受。若上线要严格单模型,把 `model_version` 提为 source 级显式配置(后续增强,本期不做)。

## null 处置(贯穿排序)

因子缺值(LEFT JOIN 未命中 / 列 NULL / momentum 分母 0)一律 `null`。**排序里 null 记该因子并列最差名次**
(不用 backtest 的 `?? 0`,否则 2022 早期 pos_120=null 会被当 0 误当成「最超跌」抢配)。具体:

- **单因子**(rankSpec 长度 1):有值排前、按 dir 排序、null 殿后(等价现 `sortCandidates` 行为)。
- **composite**:某因子缺值的候选,在**该因子的独立排名**里**并列**排到末尾(同一最低档分,不按数组位置给相异分)。
  详见 [03-engine-ranking.md](./03-engine-ranking.md#null-与平名次处置并列同分)。

## VALID 集派生

`portfolio-sim.service.ts` 不再手写 `VALID_RANK_FIELDS`:

```text
VALID_RANK_FACTOR_KEYS = new Set(Object.keys(RANK_FACTOR_REGISTRY))   // 单一真相
// legacy 单字段校验白名单 = VALID_RANK_FACTOR_KEYS ∪ {'none'},见 07-service-and-frontend.md
```
