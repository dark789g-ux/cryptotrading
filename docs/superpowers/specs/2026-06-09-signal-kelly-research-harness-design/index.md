# 信号前向统计 · 凯利上界研究 harness（设计入口）

> 状态：设计已与用户逐节确认，待 spec 自审 + 用户终审。
> 日期：2026-06-09　|　主题：「少信号 / 高凯利」方案的研究型扫描引擎

## 1. 背景与目标

现有「信号前向统计」模块（A 股买入条件触发后的前向胜率 / 盈亏比 / 凯利）已落地三张表
（`signal_test` / `signal_test_run` / `signal_test_trade`，逐笔明细已 105 万行）。但实测数据暴露一个天花板：

- 当前**唯一**凯利 > 0.15 的路径是「严筛 `KDJ_J<-10` + 持有 1 日」，全市场 2023–2026 凯利 ≈ **0.171**（n≈80276，胜率 54.5%，盈亏比 b≈1.21）。
- 凯利 `f* = p − (1−p)/b` 几乎完全由胜率 p 驱动；盈亏比 **b 被「持 1 日 + 无止盈止损」结构性锁死在 1.1~1.25**。
- 系统**没有价格型止盈止损 / 移动止损 / ATR 止损**——撬动 b 的杠杆完全空白。
- 单纯叠加 AND 趋势过滤（`close>ma60 AND ma30>ma60`）实测**无效**：信号没减、凯利没升（甚至 h=5 时降到 0.06）。

**目标**：构建一个**研究型扫描引擎**，在「入场条件变体 × 出场参数」网格上批量计算 p / b / Kelly，
**画出「信号数 ↔ 凯利」帕累托前沿**，回答"信号能压到多少、凯利能推到多高"，并产出 top-K 候选 (入场, 出场) 组合。

**定位**：纯研究、探索凯利上界——**不扣费率滑点、允许小样本、接受过拟合风险**，但用「样本外验证 + 样本下限 + bootstrap CI」护栏把"上界"约束成可信值，而非拟合假象。

## 2. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 用途定位 | 纯研究探索凯利上界（不扣费、允许小样本） |
| 引入杠杆 | 全开：价格 TP/SL、移动止损/ATR 止损、新入场特征、入场×出场网格搜索 |
| 架构 | 方案 C 混合：**Phase 1 Python harness（交付重心）** + Phase 2 可选回迁 NestJS |
| 同日双触发 | **止损优先（保守）**——见 [03](./03-exit-structures.md#5-同日双触发止损优先保守) |
| RS 特征 | 纳入；基准**运行时可配**（沪深300/中证500/行业指数，默认沪深300），变体窗口夹到 ≥2024-01-02 |
| 切分 / 下限 | **运行时可配**；默认训练 2023-01~2024-12 / 验证 2025-01~2026-06、验证集 n≥300 |

## 3. 子文档清单

| 文档 | 内容 |
|---|---|
| [01-architecture-dataflow.md](./01-architecture-dataflow.md) | Phase 1 pipeline 六段数据流、数据源、模块落点、与现有 simulator 的口径对齐 |
| [02-entry-features.md](./02-entry-features.md) | 新入场特征库（定义 / 公式 / 数据列 / 阈值变体 / RS 基准与窗口） |
| [03-exit-structures.md](./03-exit-structures.md) | 出场结构库、盘中触发硬口径、止损优先、跳空、exit_price 语义 |
| [04-grid-sweep-guardrails.md](./04-grid-sweep-guardrails.md) | 网格扫描、指标口径、训练/验证切分、样本下限、bootstrap CI、帕累托前沿、输出 |
| [05-validation-phase2.md](./05-validation-phase2.md) | 自校验锚点、一致性检查、Phase 2 赢家回迁与交叉验证 |
| [06-seed-hypotheses.md](./06-seed-hypotheses.md) | 种子假设 H0–H3（给搜索一个有金融逻辑的起点，非穷举） |

## 4. 建议阅读顺序

`01（总览/数据流）` → `02（入场）` → `03（出场）` → `04（扫描与护栏）` → `05（验证与回迁）` → `06（种子）`。

实现者只需读 01–04 即可动手 Phase 1；05 在跑出结果后读；06 用于第一次 sanity check。

## 5. 跨文档引用约定

统一用**相对路径 + 锚点**，例如 `./03-exit-structures.md#5-同日双触发止损优先`。锚点取子文档的二级/三级标题（GitHub 规则：小写、空格转 `-`、去标点）。

## 6. 已核对的事实锚点（实现时直接信任，禁止再凭二手转述改写）

> 以下均已落源头核对（实体定义 file:line / 真 DB 一条样本）。符合本仓库 `.claude/rules/data-integrity.md`：进硬断言的事实必须落源头。

| 事实 | 证据 |
|---|---|
| 凯利公式 `f* = p − (1−p)/b`，`b = avgWin/\|avgLoss\|`，p=胜率(ret>0) | `apps/server/src/strategy-conditions/signal-stats/signal-stats.metrics.ts:79-83` |
| 前向收益 `ret = qfq_close(exit) / qfq_open(buy_date=T+1) − 1` | `…/signal-stats.simulator.ts:174` |
| 现有出场仅两种：`fixed_n`(持 N 可交易日, 出场用 qfq_close) / `strategy`(条件命中+maxHold) | `…/signal-stats.simulator.ts:104-106` |
| 停牌日跳过：不占 holdDays / horizon 额度 | `…/signal-stats.simulator.ts:239` |
| 基线锚点：`KDJ_J<-10` + `fixed_n(1)` + 全市场 2023-01~2026-05 → Kelly **0.171** / n **80276** / 胜率 **0.5453** / b **1.214** | DB `signal_test_run`（本会话查得） |
| `raw.daily_quote` 含 `qfq_open / qfq_high / qfq_low / qfq_close / qfq_pre_close / qfq_pct_chg`（共 20 列） | DB `information_schema`（本会话查得） |
| 买入可选字段 36 个、仅 AND、支持 compareField | `…/strategy-conditions/strategy-conditions.types.ts:4-47` |
| THS 指数日线 `public.ths_index_daily_quotes`：997 码，覆盖 **2024-01-02 ~ 2026-06-08** | DB（本会话查得） |
| 宽基代理（type N）：`883300.TI 沪深300样本股`、`883304.TI 中证500成份股`、`883301.TI 上证50`… | DB `public.ths_index_catalog` |
| 行业指数（type I）594 个；个股→指数映射 `public.ths_member_stocks`(`con_code`=股, `ts_code`=指数)，5518 股 / 984 指数 | DB（本会话查得） |

## 7. 实现前需落源头确认的项（不得凭推断写死）

1. **`raw.daily_indicator` 的 `ma5/ma30/ma60` 与 `atr_14` 是基于复权价还是原始价？** `dev_ma`（超跌幅度）= `qfq_close/ma − 1` 与 `vol_regime`（`atr_14/close`）的口径必须与指标计算口径一致——查指标计算实现或真 DB 一条样本核对，否则 dev/波动率会系统性偏移。
2. **`raw.daily_quote.vol` 的单位与是否前复权**：`vol_contract`（缩量比）用 `vol / mean(vol,5)`，比值对复权不敏感，但若 vol 有除权跳变需确认。
3. **次新股 / 一字涨停 / 退市 的过滤口径**：Phase 1 必须与现有 `enumerator` + `simulator` 完全一致（见 [01 §4](./01-architecture-dataflow.md#4-与现有-simulator-的口径对齐硬要求)）；实现时逐条 grep 现有实现核对，不照本文转述写死。
