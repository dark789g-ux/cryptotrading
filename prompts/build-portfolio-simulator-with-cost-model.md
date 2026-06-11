# 实现组合级模拟器 + 交易成本建模

> 交接提示词（handoff）。可整段贴给全新会话直接接手，不依赖上一会话上下文。
> 项目：cryptotrading（量化回测）。工作目录 `C:\codes\cryptotrading`，Windows + PowerShell（禁 `&&`）。中文思考与回答。
> 建议入口：`/brainstorming 探索 @prompts/build-portfolio-simulator-with-cost-model.md`（本仓惯例：spec → SDD → 收口）。

## 一句话目标

把"逐笔信号统计"升级为"组合级回测"：给定一组逐笔交易（或每日候选清单），在**资金约束、
分仓规则、交易成本**下模拟组合日收益/净值曲线，回答两个悬而未决的问题——
①同日多信号买几个、怎么分仓；②税后组合口径的真实表现。**这是 0AMV regime 研究
影子期复核（2026-08 初到期）的硬前置。**

## 为什么做（背景）

2026-06-11 完成的 0AMV 四象限分阶段研究（spec
`docs/superpowers/specs/2026-06-10-0amv-regime-strategy-design/`，结论档案
`doc/研究/0amv-regime-strategy/results.md` 终态映射表+边界声明）交付了已激活的
config v1，但全部 kelly 是**逐笔量纲**：Q3 反弹日数千信号聚簇、收益高度相关，
逐笔 kelly 0.72 ≠ 组合仓位 kelly。spec 承诺影子期"以组合日收益口径复核"——该口径
的工具链目前不存在。成本同样未建模（研究期靠手工敏感性折算拦截短持仓配置）。

## 现状摸底（file:line / 数据事实，2026-06-11 已核，接手时复核）

- **逐笔交易数据就绪，组合模拟可直接回放（关键设计输入）**：`signal_test_trade`
  表每行含 `ts_code / signal_date / buy_date / exit_date / buy_price / exit_price /
  ret / hold_days / exit_reason`（实体
  `apps/server/src/entities/strategy/signal-test-trade.entity.ts`；numeric 列
  TypeORM 水合为 string）。**价格为前复权**：买入=信号次日 qfq_open、出场多数为
  qfq_close（`apps/server/src/strategy-conditions/signal-stats/signal-stats.simulator.ts:65-67,180,208`），
  `ret = exitPrice/buyPrice - 1`，未扣任何费用。
- **主要输入 run（官方收口，对账已闭合）**：
  | 名称 | run id | trades | 逐笔 kelly |
  |---|---|---|---|
  | 0amv-regime-Q3-winner | `52d2a2c8-1d36-4a0a-a4f6-5ef6e7137971` | 14,364 | 0.7245 |
  | 0amv-regime-Q3-alt | `8988e4ec-d57b-42ac-b2ad-1514f8b18a69` | 25,123 | 0.5359 |
  | 0amv-regime-Q1-winner | `800c3732-38e1-4fd3-b778-3b14fb09de4d` | 28,032 | 0.3538 |
  另有 18 个宽锚点 run 可作回归素材（台账
  `doc/研究/0amv-regime-strategy/runs-manifest.md`，**run id 一律从台账复制**）。
- **指标口径参照**：`signal-stats.metrics.ts:50-52` 官方 `avgLoss` 取 `ret<0`
  （零收益不计亏）——曾因离线 SQL 用 `ret<=0` 产生 ≤0.004 kelly 微差，组合模拟器
  如复算逐笔指标须对齐官方口径。
- **影子期数据流**：`regime_daily_pick` 表（每日候选清单，含 flat/unknown 标记行，
  实体 `entities/strategy/regime-daily-pick.entity.ts`）+ `regime_strategy_config`
  v1 active（id `6c5e9323-7a52-40fc-93d2-faadf23609a2`，kellyFraction Q3=0.33/Q1=0.15）。
  picks 只有信号日快照**没有前向收益**——影子组合需 JOIN `raw.daily_quote` 的 qfq
  序列按出场规则复算（或复用 signal-stats 模拟器）。
- **可比引擎参照**：Python kelly_sweep harness（`apps/quant-pipeline/`）曾以
  真 DB 自校验复现 TS 锚点（Kelly 0.1755≈0.171）——"无约束极限下复现锚点数字"
  这一自校验模式值得照搬。
- **基准指数数据**：库里有 `ths_index_daily` / index-catalog 模块与 `oamv_daily`
  大盘 OHLC；沪深300/中证1000 日线是否齐全**未核**，接手后摸底。
- DB：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "..."`。
  研究临时表 `tmp_m23_*` / `tmp_ho_*`（UNLOGGED）仍在，可复用可弃。

## 已定方向（上一会话倾向，brainstorming 时可推翻但须给理由）

1. **回放优先**：组合模拟器的第一形态消费**既有 run 的 signal_test_trade**（回放
   + 约束 + 成本），不重新模拟出场——与官方 run 完全同源，零口径漂移。重模拟留给
   影子期 picks 场景（picks 无 ret）。
2. **自校验锚点**：资金无限 + 无成本 + 等权极限下，组合模拟器复算的逐笔统计必须
   与官方 run 的 `kelly_f / win_rate` 逐位一致（对齐 metrics 口径），作为门禁测试。

## 待 brainstorming 敲定的开放问题（附倾向）

1. **实现位置**：① NestJS TS（与 signal-stats 同栈，可直接进 web 操作台/影子看板）
   ② Python quant-pipeline（pandas 快、研究迭代快、kelly_sweep 先例）。倾向：
   **核心引擎进 TS**（影子期产品化需要它在线），Python 仅当扫参需要时复用 harness
   模式——但两栈同构成本是真实代价，值得辩论。
3. **分仓规则参数空间**（第一版建议收敛）：初始资金、单票仓位上限、最大同时持仓数、
   同日信号超额时的选择规则（候选：pos_120 升序 / 等权随机种子固定 / circ_mv 升序）、
   kellyFraction 的应用方式（总仓位上限 vs 单票权重）。
2. **成本模型**：参数化（佣金双边、印花税卖出、滑点 bp），预设档位建议
   保守 0.3% / 现实 0.2% / 乐观 0.13% 双边合计——**费率以用户实际券商为准，开工时问**。
   滑点是否与流动性挂钩（amount 分位）留二期。
4. **输出指标**：组合日收益序列、净值曲线、年化/最大回撤/Sharpe/Calmar、组合级
   kelly（日收益口径）、与基准对比；落库形态（research 表 vs 文件）。
5. **影子期对接形态**：CLI/脚本先行还是直接做进 regime-picks 看板？倾向：先
   研究口径跑通（脚本+落库），看板二期——但影子期 8 周窗口要留出看板时间。
6. **多策略并行**：Q1+Q3 两策略共用资金池怎么协调（按 regime 互斥天然不冲突？
   Q1/Q3 不同日，理论互斥——验证后可简化设计）。

## 硬约束 / 项目规范

- `.claude/rules/`（data-integrity / datetime / database-sql / vue3-frontend /
  code-organization）全部适用；**列名/run id/费率进硬断言前落源头核验**，禁采信
  本文档二手转述。
- 价格口径：signal_test_trade 价格是前复权，组合金额计算用 ret 推进（qfq 绝对价
  不可当真实成交额）；如需真实市值/手数约束须另取未复权价并显式声明口径。
- trade_date/signal_date 均 `YYYYMMDD` varchar，**禁 `new Date(tradeDate)` 直转**。
- 单文件 ≤500 行；后端改动后须重启进程才生效（nest 无 watch）。
- 若动 signal-stats：430+ 既有测试是回归底线（`pnpm --filter @cryptotrading/server exec jest`）。

## 验证标准

1. **自校验锚点**（硬门禁）：无约束极限下复现官方 run `52d2a2c8` 的 kelly_f/win_rate
   逐位一致。
2. 成本档位单调性：成本↑ → 组合收益单调↓；零成本=锚点。
3. 约束生效性：资金/持仓数约束收紧 → 成交笔数单调不增，且被弃信号符合选择规则。
4. 单测覆盖分仓规则与成本计算的边界（同日超额、资金耗尽、零命中日、跨年）。
5. 终态交付：三个官方 run 的组合口径报告（净值/回撤/税后 kelly，三档成本）+
   影子期复核所需的复算路径文档。

## 前序进度 / 待续

- ✅ 研究主线 M1-M4 全部完成，config v1 激活，影子期 2026-06-11 起算（操作手册见
  `doc/研究/0amv-regime-strategy/report-20260611-final.html` 第六节）。
- ⏭ 本任务从零开始：建议第一步摸底（指数日线覆盖、signal_test_trade 回放所需索引、
  Q1/Q3 互斥性验证 SQL），再 brainstorming 敲定开放问题 1-6。
- 相关记忆：[[project_0amv_regime_strategy]]（研究全史）、
  [[project_signal_forward_stats]]（signal-stats 模块）、
  [[project_kelly_sweep_harness]]（自校验锚点先例）。
