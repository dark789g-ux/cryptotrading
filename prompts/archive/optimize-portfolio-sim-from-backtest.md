# 参考「策略回测(backtest)」模块，优化「组合模拟(portfolio-sim)」模块

> 交接提示词（handoff）。可整段贴给全新会话直接接手，不依赖上一会话上下文。
> 项目：cryptotrading（量化回测）。工作目录 `C:\codes\cryptotrading`，Windows + PowerShell（禁 `&&`，用 `;` 或分步）。中文思考与回答。
> 现状摸底里的 file:line / DB 事实截至 2026-06-14 已核；接手若隔时较久，硬断言前请按「数据完整性」规范复核。

## 一句话目标

把「策略回测 backtest」引擎里 portfolio-sim **没有**的三项能力——**多因子信号质量排序、动态仓位、回撤熔断**——按需移植到「组合模拟 portfolio-sim」，**首要解决同日海量候选「盲挑」的痛点**：当容量约束逼你从每天上百个信号里只能挑几十个时，目前只能按市值/价格位置/字母序挑，完全不看信号质量。

## 为什么做这个（背景，先读）

上一会话（2026-06-14）用 portfolio-sim 对一个真实有 gross edge 的 A 股策略（0AMV-Q2 的 V10：入场 `kdj_j<-5 且 ma5>ma60`）做组合级真实回测，结论很扎心，**直接暴露了 portfolio-sim 的结构性短板**：

- 逐笔前向 gross kelly **+0.13**（5 年无深亏），但真组合回测（20~50 仓 + A 股真成本）**年化 E7 ≈ −1.1% ~ −5.5%、fixed_n=1 ≈ −11% ~ −16%**，全亏。
- 两个杀手：① **容量碾压**——Q2 平均每天 ~147 个信号，组合只吃得下 **1.3%~3.3%**，96.7%~98.7% 被 skip 丢弃；② **成本吞噬**（高换手策略尤甚）。
- **最致命的是：被丢弃 97% 后「挑哪 3%」由排序字段决定，而 portfolio-sim 只有 `pos_120 / circ_mv / none` 三档，没有任何「信号质量」维度**——等于闭眼按市值/破位/字母挑。实测 `pos_120 升序`（最破位优先）比字母序还差（E7 −5.5% vs −1.1%），印证盲挑会逆向选股。

**留下的关键未答问题**：*若能在容量内「按信号质量择优」挑那 3%，V10 的正 edge 能不能被救回来？* —— 现有工具答不了，因为没有质量排序维度。**本任务就是补上这个维度**（并顺带可选地引入 backtest 的动态仓位 / 熔断）。

完整背景与数据见 [doc/研究/0amv-regime-strategy/results.md](../doc/研究/0amv-regime-strategy/results.md) 的「组合级真实回测」节。现成可当测试床的 portfolio-sim 输入源 run：**V10×E7 = `14ecdbdf-a27a-4db0-a041-9842aced760c`**、**V10×fixed1 = `75766fb8-8cbc-4ef5-a515-ec533dbd5860`**（都是 signal_test_run，逐笔已落库，直接喂 portfolio-sim）。

## 现状摸底（file:line 为证）

### A. backtest 里三项可借鉴的设计（在 `apps/server/src/backtest/`）

backtest 是一套**加密货币 K 线**回测引擎（自读 `kline` 表），与 portfolio-sim（A 股、消费 signal-stats 逐笔）完全独立、面向不同市场。但它的**引擎设计**有三样东西值得移植：

1. **多因子复合信号排序（★最该借鉴，直击本任务痛点）**
   - `SortFactor` 定义：`backtest/engine/models.ts:16-22`；5 个因子实现：`backtest/engine/signal-scanner.ts:71-78`（`risk_reward` / `momentum=(close-MA)/ATR` / `freshness=KDJ-J连续超卖根数倒数` / `liquidity=近N根均额` / `volatility=close/ATR`）。
   - 排序模式 `single | composite`：`backtest/engine/models.ts:197`；**复合加权排名算法** `sortByRankingScore`：`backtest/engine/signal-scanner.ts:87-119`（每因子独立排名→`score=n-rank`→乘 weight→累加→综合分降序）。
   - 对比缺口：portfolio-sim 的 `rankField: 'pos_120'|'circ_mv'|'none'` 是硬编码单字段单向，无加权、无质量维度。

2. **动态仓位（凯利三段式）**
   - 仓位计算：`backtest/engine/steps/engine.pending-execution.ts:66-89`（`kellyRaw=(b*p-q)/b` → `kellyAdjusted=max(0,kellyRaw*kellyFraction)` → `min(kellyAdjusted, kellyMaxPositionRatio, positionRatio)` → `positionSize=lastNav*positionRatio`）。
   - 时变估计：滚动窗口更新 p/b `backtest/engine/engine.ts:166-198`；模拟期/探针 `engine.ts:206-229`；配置 `models.ts:198-207`。
   - 对比缺口：portfolio-sim 是纯固定比例 `alloc = positionRatio × NAV_ref`（见 B 节）。

3. **账户级冷却熔断**
   - 纯函数状态机 `backtest/engine/cooldown.ts`（连亏 N 次触发账户级禁开仓，亏损延长/盈利缩短）；配置 `models.ts:183-195`。
   - 对比缺口：portfolio-sim **完全没有**任何回撤熔断 / 冷却。

> 注意：backtest 的因子（momentum/risk_reward 等）是它**自己的 scanner 从 K 线现算**的；portfolio-sim 消费的是**既有 signal_test_trade 逐笔**，不重算 K 线扫描。所以移植「质量排序」到 portfolio-sim ≠ 照搬 scanner，而是 **把可在 signal_date JOIN 到的质量因子做成 rankValue**（见 C 节数据源）。

### B. portfolio-sim 现状与扩展点（在 `apps/server/src/strategy-conditions/portfolio-sim/`）

- 配置契约 `PortfolioSimSource / PortfolioSimCostRates / PortfolioSimConfig`：`portfolio-sim.types.ts:17-61`；`rankField` 联合类型在 **`types.ts:29`**。
- 纯逻辑引擎核 `portfolio-sim.engine.ts`：
  - 排序 `sortCandidates`：`engine.ts:74-94`（**基于 `rankValue: number|null`，与字段名无关**；有值排前、按 rankDir、平局 ts_code 升序；`none`=全 null=纯 ts_code 序）。
  - 仓位 `alloc = source.positionRatio * navRef`：`engine.ts:186`；`navRef = 上一交易日收盘 NAV`（首日=initialCapital）：`engine.ts:154`。
  - 跳过约束 `checkSkip`（already_held→slots_full→exposure_cap→cash_short）：`engine.ts:312+`。
- DB 装载 `portfolio-sim.loader.ts`：`loadSourceTrades()` 取逐笔+rankValue `loader.ts:138-213`；`pos_120` JOIN `signal_rolling_indicator` `loader.ts:144-156`，`circ_mv` JOIN `raw.daily_basic` `loader.ts:157-169`，`none` 跳过 JOIN `loader.ts:170-182`。
- 校验 `validateCreateDto`：`portfolio-sim.service.ts:211-304`；rankField 白名单 **`VALID_RANK_FIELDS = new Set(['pos_120','circ_mv','none'])` 在 `service.ts:42`**。
- 前端：页面 `apps/web/src/views/strategy/PortfolioSimView.vue`；源配置行（含 rankField 下拉）`apps/web/src/components/portfolio-sim/PortfolioSimSourceRow.vue:147-156`；选项常量 `apps/web/src/components/portfolio-sim/portfolioSimPresets.ts:118-122`（`RANK_FIELD_OPTIONS`）；前端类型镜像 `apps/web/src/api/modules/strategy/portfolioSim.ts:14`（`PortfolioRankField`）。

**新增一个「单字段」rankField 要动的所有点（最小改动路径）**：
1. `portfolio-sim.types.ts:29` — 联合类型加新值
2. `portfolio-sim.service.ts:42` — `VALID_RANK_FIELDS` Set 加新值
3. `portfolio-sim.loader.ts:141`（方法签名联合类型）+ `:144` 起加 `else if` 分支写 JOIN SQL
4. `apps/web/src/api/modules/strategy/portfolioSim.ts:14` — 前端类型加新值
5. `apps/web/src/components/portfolio-sim/portfolioSimPresets.ts:118-122` — `RANK_FIELD_OPTIONS` 加选项
   - **`engine.ts` 的 sortCandidates / checkSkip 不用改**（字段无关）。
   - 若走 **composite 多因子**：sortCandidates 要改成消费「多个 rankValue 的加权合成分」，engine + types + loader（取多列）改动更大——这是设计岔路（见开放问题）。

### C. 数据可用性（真 DB 核验，2026-06-14）—— 决定哪些质量因子能落地

| 数据源 | 列 | 历史覆盖 | 能否用于历史回测排序 |
|---|---|---|---|
| `signal_rolling_indicator`（public） | `pos_120`(已用), **`pos_60`、`close_ma60_ratio`、`vol_ratio_60`、`vol_ratio_120`**(未用) | 有历史回填（pos_120 在 V10 回测里能跑出差异即证） | ✅ 可 |
| `raw.daily_indicator` | `risk_reward_ratio`、`atr_14`、`ma5/30/60/120/240`、`macd`、`kdj_j`、`stop_loss_pct` 等 | 全历史 | ✅ 可（可现算 backtest 式 `momentum=(close-MA)/ATR`、直接用 `risk_reward_ratio`） |
| `raw.daily_basic` | `circ_mv`(已用) | 全历史 | ✅（市值，非质量） |
| **`ml.scores_daily`（ml）** | `score`(double)、`rank_in_day`(int)、`model_version`(text) | **⚠️ 真实只覆盖 2026-05 的 2 天**（每日推理 prod，无历史回填） | **❌ 历史回测不可用，仅前向/上线意义** |

> **关键诚实点**：`ml.scores_daily` 是最理想的「信号质量分」（P(涨)−P(跌)），但**它没有历史数据**——拿它给 V10（2022~2026）排序会几乎全 null、退化成 ts_code 序。所以：**历史可验证的质量排序，Phase 1 只能用 `signal_rolling_indicator` / `raw.daily_indicator` 的因子**；`ml_score` 排序作为「上线/前向」单独选项，明确标注不可历史回测。

## 已定方向 + 待 brainstorming 敲定的开放问题（附推荐）

**推荐分三期（按 ROI / 风险排序）**：

- **Phase 1（核心，必做）——给 portfolio-sim 加「信号质量」排序维度**。数据用历史可得因子（`risk_reward_ratio`、`momentum`、`pos_60`、距 MA、缩量…）。先把「最小改动单字段」路径打通（上面 5 点），验证「质量择优能否救回 V10」。**这一步直接回答上一会话留下的关键问题。**
- **Phase 2（可选）——动态仓位**：参考 backtest 凯利三段式，给 `PortfolioSimSource` 加 `sizingMode`，engine `alloc` 处分支。注意：**并发下注下 per-trade kelly 不能直接照搬**（上一会话已点破：一天上百并发信号，每个押 13% = 几百倍杠杆），组合级 sizing 需重新定义（如按 source 历史绩效分配、或按信号强度线性加权后 clamp 到 positionRatio）。
- **Phase 3（可选）——回撤熔断**：移植 `cooldown.ts` 纯状态机到 portfolio-sim 逐日循环，A 股连亏熔断。

**开放问题（接手先与用户敲定）**：
1. **范围**：只做 Phase 1，还是 1+2(+3)？（推荐先 Phase 1 验证 edge，再决定是否上 2/3。）
2. **排序设计**：单字段（改动小，engine 不动）还是 backtest 式 **composite 多因子加权**（engine.sortCandidates 要重写、更强但更重）？推荐：先单字段把因子逐个验出哪个有效，再决定要不要 composite 合成。
3. **质量因子选哪些**：`risk_reward_ratio` / `momentum=(close-MA60)/ATR` / `pos_60` / `close_ma60_ratio` / 缩量 `vol_ratio_*`？方向（asc/desc）？（建议先各跑一遍看哪个在 V10 上能把 take 的 3% 质量拉高。）
4. **ml_score 是否纳入本期**：作为「前向/上线」选项加上但禁历史回测，还是本期完全不碰？（推荐：加但显式标注、且在前端/校验提示历史覆盖不足。）
5. **是否扫容量曲线**：除了排序，maxPositions/positionRatio 的容量曲线也该扫（多大组合才不被容量绞杀）——是否纳入本任务？

## 硬约束 / 项目规范（务必遵守）

- **数据完整性（[.claude/rules/data-integrity.md](../.claude/rules/data-integrity.md)）**：任何表名/列名进 SQL/JOIN 前**落真 DB 核一条**，禁采信本文件或子代理转述。本文件 C 节的列名已核（2026-06-14），但**新用的列（如 `risk_reward_ratio` 的真实列名、`raw.daily_indicator` 字段）务必再 `grep` 实体 + 查真 DB**。**`ml.scores_daily` 历史仅 2 天——别假设可回测。**
- **动态 SQL 禁拼前端字段名**（[.claude/rules/database-sql.md](../.claude/rules/database-sql.md)）：新 rankField → 列名映射必须走白名单/分支翻译，未命中 warn+跳过。
- **改后端必须重启 server/worker**（CLAUDE.md：`dev` 是 `nest start` 无 watch）；前端 vite 有 HMR。端到端验证前先确认后端跑的是最新代码。
- **前后端类型镜像同步**：`portfolio-sim.types.ts` ↔ `apps/web/src/api/modules/strategy/portfolioSim.ts`。
- **engine.sortCandidates 现基于 `rankValue:number|null` 字段无关**——单字段方案 engine 不用改；composite 方案才改 engine（别无谓改动）。
- 新增 DB 列/表 → 走 `migrations/*.sql` + 同名 `.ps1`（docker exec），并先 stamp/对齐；新增 TypeORM 实体须**双注册**（module forFeature + app.module 根 entities）。
- 源文件一律 **UTF-8**；Vue 单文件 ≤500 行（`lint:quant-lines`）；PowerShell 禁 `&&`。
- `anchorMode` 的代数恒等（realizedRetNet ≡ ret、每笔必 taken）是对账基石，改动不得破坏。

## 验证标准

1. **单测**：loader 新因子 JOIN（rankValue 取值正确、缺失置 null）；service 校验新 rankField（白名单、非法 400）；若改 composite，engine.sortCandidates 合成分排序单测。
2. **真机 e2e（核心）**：在 V10 测试床（源 run `14ecdbdf` / `75766fb8`）上建 portfolio-sim，用**新质量排序** vs `none` / `pos_120` 同容量对比，看：① 被 taken 的那批信号质量是否更高；② **年化是否从 ≈−1% 转正**（这是本任务的成败判据）；③ 信号数/skip 逐位可解释。
3. **锚点对账**：anchorMode 下 realizedRetNet ≡ ret 不变。
4. **诚实标注边界**：若质量排序仍救不回正，**如实报告**「Q2-V10 在容量+成本下确实不可部署」，不粉饰；若救回，给出最优排序因子 + 容量 + 净年化/回撤。
5. **门禁**：`pnpm --filter @cryptotrading/server build`、相关 jest、`pnpm --filter @cryptotrading/web type-check`、`lint:quant-lines` 全绿。

## 前序进度 / 待续

- ✅ 上一会话已定位 portfolio-sim 排序为 Q2 研究瓶颈，并实测 V10 在现有 `pos_120 / none` 排序下年化 −1.1% ~ −16%（详见 results.md「组合级真实回测」节）。
- ✅ 两模块摸底 + 真 DB 数据可用性已核（本文件 A/B/C 节）。
- ⏭ **接手第一步**：与用户敲定开放问题 1-5（尤其范围 & 排序设计），再动手 Phase 1。
- ⏭ Phase 1 打通后，**第一件事就是在 V10 测试床上验证「质量择优能否把年化转正」**——这是整件事的意义所在。

相关记忆：`project_0amv_regime_strategy`（Q2/V10 研究全史）、`project_portfolio_simulator`（组合模拟器 SDD + Q3 容量崩塌前例）、`project_kelly_sweep_harness`、`project_signal_forward_stats`（signal-stats 逐笔来源）。
