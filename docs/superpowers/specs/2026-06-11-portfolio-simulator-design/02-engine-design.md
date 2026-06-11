# 02 · 引擎设计（逐日回放）

模块位置：`apps/server/src/strategy-conditions/portfolio-sim/`（与 signal-stats 平级，
因为它消费 signal-stats 的产物）。引擎核是**不碰 DB 的纯函数**（输入=内存 trades+行情
序列+配置，输出=每日净值+逐信号判定），DB 装载与落库由外层 runner/service 负责——
拆分方式照搬 signal-stats 的 simulator / simulator.db 先例。

## 配置结构

```text
PortfolioSimConfig
├─ sources: PortfolioSimSource[]        （1~5 个；官方场景 = Q3-winner + Q1-winner）
│   ├─ runId: string                     源 signal_test_run.id（解析后冻结进快照）
│   ├─ label: string                     展示名，如 'Q3-winner'
│   ├─ positionRatio: number             单票权重，占 NAV_ref，(0,1]
│   ├─ maxPositions: number | null       该策略最大同时持仓数；null=不限
│   ├─ exposureCap: number | null        该策略总敞口上限（占 NAV_ref）；null=不限
│   │                                    前端缺省从 regime config v1 带出（Q3=0.33/Q1=0.15）
│   ├─ rankField: 'pos_120'|'circ_mv'|'none'   同日排序字段（Q3 缺省 pos_120、Q1 缺省 circ_mv）
│   └─ rankDir: 'asc'|'desc'             缺省 asc（低位优先/小市值优先）
├─ initialCapital: number                缺省 1,000,000（对齐 backtest）
├─ cost: PortfolioSimCostModel           解析后的费率数字（见下文成本模型）
└─ anchorMode: boolean                   true → 强制无约束+零成本（见锚点模式）
```

校验：sources 非空且 runId 各不相同；positionRatio∈(0,1]；maxPositions≥1 或 null；
exposureCap∈(0,1] 或 null；initialCapital>0。runId 在**触发时**再核一次存在且
status='completed'（fail-fast；signal_test_run 的成功态实测为 'completed' 而非
'success'——2026-06-11 真 DB 核验，portfolio_sim_run 自身才用 'success'）。

**exposureCap 缺省值的量纲说明**：regime config v1 的 `kellyFraction`（Q3=0.33/Q1=0.15）
语义即"该策略建议**总仓位**占比"（holdout kelly × 0.5，见终态报告"建议仓位(半凯利)"列），
与总敞口上限同量纲，作为缺省是直用而非代理。注意与 backtest 模块的同名字段
`kellyFraction`（单票仓位的凯利缩放系数）是**不同概念**，实现与评审时勿混。

## 日历与窗口

交易日历取 `raw.trade_cal`（exchange='SSE'，is_open='1'；列名实现时 `\d` 核实）。
回放窗口 = 全部源 trades 的 `min(buy_date)` ~ `max(exit_date)`。trade_cal 若滞后于
trades 最大日期（已知运维现象），缺失尾部交易日以 trades 中实际出现的 buy/exit 日期
并集补齐并 `logger.warn`（不静默吞）。

## 逐日循环

```text
NAV_ref(d) = 上一交易日收盘 NAV（首日 = initialCapital）

对每个交易日 d（升序）：
  ① 出场  exit_date==d 的在仓持仓逐笔收口（A股卖出资金当日可用 → 先出场后开仓）：
  │        毛回款 = alloc × (1 + ret)                      ← ret 用表里记录值，精确
  │        卖费   = 毛回款 × (commission + transfer + stamp(d) + slippage)
  │        cash  += 毛回款 - 卖费
  │        realized_ret_net = (毛回款 - 卖费 - alloc - 买费) / (alloc + 买费)
  ② 开仓  buy_date==d 的信号，按 source 在 config 中的顺序逐策略处理；
  │        策略内按 rankField 排序，平局按 ts_code 升序；rank 缺失项整体置于
  │        有 rank 项之后、缺失项内部按 ts_code 升序（全程确定性）。
  │        逐个候选按固定顺序检查，首个不满足者记为 skip_reason：
  │          already_held  该策略已持有同 ts_code（对齐 backtest heldSymbols 行为）
  │          slots_full    该策略在仓数 ≥ maxPositions
  │          exposure_cap  (该策略持仓市值合计 + alloc) / NAV_ref(d) > exposureCap
  │                        （严格大于才 skip；成交后敞口恰好等于 cap 的那笔放行）
  │          cash_short    cash < alloc + 买费（不部分成交，整笔跳过）
  │        通过则开仓：alloc = positionRatio × NAV_ref(d)；
  │        买费 = alloc × (commission + transfer + slippage)；cash -= alloc + 买费；
  │        持仓初始市值 = alloc。
  ③ 盯市  每个在仓持仓（不含当日已出场者）：
  │        当日有行情 → mv *= qfq_close(d) / 上一盯市价（入场首日 = qfq_close/qfq_open）
  │        停牌（无行情行）→ mv 不变（沿用上一盯市值）
  ④ 记录  NAV(d) = cash + Σmv；daily_ret = NAV(d)/NAV(d-1) - 1；
           落每日行（含各策略敞口 jsonb）
```

**同 buy_date 单源前提**：buy_date = signal_date 的严格次一 SSE 交易日
（`signal-stats.simulator.db.ts` 日历下标+1，停牌不改 buy_date），不同 signal_date
不可能映射到同一 buy_date；因此"同一 buy_date 只来自单一策略"成立**当且仅当**
"同一 signal_date 不同时出现在两个源 run"——这是 regime 象限互斥提供的**外部前置
假设**而非引擎保证，05 有守护断言（双源 signal_date 无交集）。引擎本身仍按 source
顺序确定性处理同日竞争，以覆盖该假设被打破或未来非 regime 源的一般情形。

## 盯市与出场收口

- **比率推进，对复权基准重整免疫**：盯市只用 qfq 价格的**比率**（close/close、
  close/open），即使今日重算的 qfq 序列与 run 时点的绝对值不同（每股同乘常数），
  比率不变。qfq 价取 `raw.daily_quote × raw.adj_factor` 现算（与 signal-stats 同口径）。
- **出场日强制收口**：出场不用盯市路径的终点，而是直接以 `alloc × (1+ret)` 实现——
  该笔总收益**逐位等于**官方记录，路径只决定中间回撤形状。持有期内发生除权/数据修订
  时路径与真实有微小偏差，但不影响任何收益类指标的精确性（边界声明见 01）。
- **行情预取**：按 tsCode 分组、批量取各持有窗口的 qfq open/close，有界并发——
  照搬 `signal-stats.simulator.db.ts` 模式。

## 成本模型

| 项目 | 现实档（用户校准） | 说明 |
|---|---|---|
| 佣金 | 0.025%/边（万 2.5） | 双边收取 |
| 过户费 | 0.001%/边 | 双边，简化为两市同费率 |
| 印花税 | 卖出 0.1%（≤2023-08-27）/ 0.05%（≥2023-08-28） | **按卖出日时变**，仅卖出 |
| 滑点 | 三档：乐观 0 / 现实 0.05%/边 / 保守 0.10%/边 | 常数参数 |

三档预设 = 佣金/过户费/印花税同上、滑点档不同；另有 `zero`（锚点用）与 `custom`
（前端展开自定义各费率）。**config 快照存解析后的费率数字而非档位名**——run 可复现性
不依赖代码预设未来不变。

## 锚点模式（自校验硬门禁）

`anchorMode=true` 时引擎强制：**资金无限语义**——全部约束关闭（maxPositions/
exposureCap=null、already_held 规则停用、**cash_short 同样旁路**，cash 允许变负）、
费率全 0。此时每笔信号都 taken，逐笔 `realized_ret_net ≡ ret`（由收口构造保证，
非浮点巧合）；锚点 run 的组合级指标（净值/回撤等）无意义，仅逐笔统计用于对账。
（2026-06-11 真机 e2e 教训：初版仅停用三项保留 cash_short，单日 1818 信号聚簇下
12,847 笔被现金弃单、对账失败——"每笔必 taken"必须连现金一起旁路才成立。）
**锚点模式强制单源**（DTO 校验 sources.length===1）——对账目标是单个官方 run，
anchor_check 平铺结构也以此为前提；多源组合验证不属于锚点门禁的职责。

跑完后把复放 rets+holdDays 喂给现有 `calcSignalStats`
（`signal-stats.metrics.ts`），其输出 `kellyF / winRate / sampleCount` 必须与官方
`signal_test_run` 表存储值**逐位一致**（在该表 numeric 存储精度内比较）。对账结果
（官方值/复算值/是否通过）写入 run 的 `anchor_check` jsonb，前端徽章直接展示。
首个验收对象：run `52d2a2c8-1d36-4a0a-a4f6-5ef6e7137971`。

## 排序值取数

开仓排序所需 rank 值不在 trade 表，按 `(ts_code, signal_date)` 批量回 JOIN：

- `pos_120` ← `signal_rolling_indicator`（`d.pos_120`，与 query-builder 映射同源，
  `strategy-conditions.types.ts` ASHARE_FIELD_COL_MAP）
- `circ_mv` ← `raw.daily_basic`（`m.circ_mv`）

一次性按源 run 全量取回（67k 行级，IN/JOIN 批量），存内存 Map。**查不到 rank 值的
信号不淘汰**：按 ②开仓 中定义的缺失项排序规则置后，fill 行 rank_value 记 NULL。

## 汇总指标（写回 run 表）

- `total_ret = final_nav/initialCapital - 1`；`annual_ret = (1+total_ret)^(244/交易日数) - 1`
  （final_nav≤0 的极端情形 annual_ret/calmar 置 NULL 并 warn，避免幂运算 NaN）
- `max_drawdown`：每日 NAV 的最大回撤（峰值回落比例，负数）
- `sharpe = mean(daily_ret)/std(daily_ret) × √244`（rf=0；std 为样本标准差，n-1）
- `calmar = annual_ret / |max_drawdown|`（回撤为 0 时置 NULL）
- **日收益口径 kelly**：把 daily_ret 序列直接喂 `calcSignalStats`（holdDays 填 1），
  取其 winRate/kellyF —— 与逐笔 kelly 0.72 形成量纲正面对照，是影子期复核的承诺口径
- `n_taken / n_skipped / total_costs`（买卖费用合计，绝对额）

## 运行阶段与进度

三阶段，对齐 signal-stats 运行态模式：`loading`（取 trades+行情预取+rank JOIN，
progress=分组完成数）→ `replaying`（progress=已回放交易日数/总交易日数）→
`writing`（落 daily+fills，progress=批次数）。每阶段重置 progress_total。

## 错误处理

- 源 run 不存在/非 completed/零 trades → 触发即失败，错误信息中文透出（409/400 语义见 03）。
- 行情预取某 tsCode 整窗缺失 → 该批 trades 以"全程沿用 alloc 盯市+出场正常收口"降级，
  `logger.warn` 带 tsCode+窗口；**禁止** `.catch(()=>[])` 静默吞错（data-integrity 规则）。
- 回放过程中任何异常 → run 置 failed + error_message，已写入的 daily/fills 由下次重跑
  事务清理（幂等语义见 03）。
