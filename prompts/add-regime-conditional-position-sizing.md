# 实现「不同市场 regime 下采取不同仓位设置」— 交接

> 自包含交接：可整段贴给全新会话接手。**起点是 brainstorming**（本文档只摸底 + 列开放问题，不预先拍设计）。

## 一句话目标

给**组合模拟器**（`portfolio-sim`）加「按当日大盘 regime 切换仓位设置」的能力：不同 regime 下用不同的 `maxPositions` + `positionRatio`。因迷你回测（`signal_test.backtestConfig`）与组合模拟**共用同一套引擎**，一处实现两处受益。

## 用户的 canonical 验收例子（务必照此对齐语义）

| regime | 条件（大盘 0AMV MACD） | maxPositions | 每仓 positionRatio |
|---|---|---|---|
| A | `0AMV 柱(HIST) > 0` AND `0AMV DIF > 0` | 2 | 0.45 |
| B | `0AMV 柱(HIST) < 0` AND `0AMV DIF > 0` | 5 | 0.20 |

> 注意：A 的总敞口 2×45%=90%，B 的 5×20%=100%。即**每个 regime 同时定 maxPositions 和 positionRatio**，是一组 `{条件 → {maxPositions, positionRatio}}` 映射。

## 现状摸底（file:line 为证，禁凭模块名猜）

### 仓位决策的单点入口
- **`computeAlloc`**（`apps/server/src/strategy-conditions/portfolio-sim/portfolio-sim.sizing.ts:47`）是**唯一**决定每笔下注金额的纯函数：`alloc = positionRatio × mult × navRef`。入参 `(trade, source, navRef, ctx)`——**ctx 里没有任何大盘/regime/日期态**，这是要加 regime 钩子的核心位置。
- 三种 sizing（`source.sizing.mode`）：`fixed`(mult=1) / `signal_weighted`(按**信号自身因子质量分位**) / `source_kelly`(按**源历史凯利**，装载期算一次)。**全都与大盘 regime 无关**——`signal_weighted` 的「不同仓位」是按信号质量、不是市场状态。
- **`maxPositions` 的执行点**在 `checkSkip`（`portfolio-sim.engine.ts` 约 414-459，`slots_full` 分支），**按源**卡（`source.maxPositions`，当前是静态字段）。regime 要改 maxPositions，得让 checkSkip 拿到「当日 regime 解析出的 maxPositions」。
- 引擎主循环逐日推进（`portfolio-sim.engine.ts:212-354`：出场→开仓→盯市→记录）；开仓在每个 `buy_date==d` 这天发生，**这里是"按当日 d 解析 regime"的天然位置**。

### 大盘 0AMV MACD 数据 + 字段（硬事实）
- 表 `oamv_daily`（全市场活跃市值指数，每交易日一行）。0AMV MACD 三列（`strategy-conditions.types.ts:58-62`，`ASHARE_MARKET_AMV_COL_MAP`）：
  - **`oamv_macd` → 列 `oamv_daily.amv_macd` = MACD 柱(HIST)**（与个股 `macd_hist→i.macd` 同构，"柱"存在名为 `macd`/`amv_macd` 的列）。**用户写的 `0AMV.MACD.HIST` 就是这个**。
  - `oamv_dif` → 列 `amv_dif` = DIF。`oamv_dea` → 列 `amv_dea` = DEA。
  - **禁止**按字面 `0AMV.MACD.HIST` 去拼 `amv_hist` 之类不存在的列名。
- 现有用法：0AMV 是作为**入场条件**字段暴露的（query builder EXISTS 走 `oamv_daily`，`strategy-conditions.query-builder.ts:59-68`），且 **fail-closed**：该日 `oamv_daily` 无行或 MACD 为 NULL → 当天信号全排除。**regime 解析也要沿用 fail-closed 口径**（缺数据时的兜底见开放问题③）。

### 引擎吃什么 + config 存哪
- 引擎输入 `EngineInput{config, trades, quotes, calendar}`（`portfolio-sim.types.ts:214`）——**当前没有大盘 0AMV 日序列**。regime 需要把 `oamv_daily` 的 (trade_date → {amv_macd, amv_dif, amv_dea}) 装进 EngineInput（loader 加一段取数，`portfolio-sim.loader.ts`）。
- `PortfolioSimSource`（`types.ts:107`）：`positionRatio/maxPositions/exposureCap/rankSpec/sizing`。`PortfolioSimConfig`（`types.ts:146`）：`sources[]/initialCapital/cost/anchorMode/circuitBreaker`。
- config 落 **jsonb**（`portfolio_sim_run.config` / `signal_test.backtest_config`），所以**加 `regimes` 字段无需 migration**。

### ⚠️ 已有 regime 概念，必须先评估复用
- 侧栏已有 **「Regime 选股 / Regime 配置」**（`regime-engine`，0AMV 四象限分阶段策略，见 memory `project_0amv_regime_strategy`）。它已有一套基于 0AMV 的市场 regime 定义。
- **开放问题①（最关键）**：本需求的 regime 是**复用 regime-engine 的四象限定义**，还是在组合 config 里**内联一套轻量 regime 规格**（一组 `{0AMV MACD 条件 → 仓位}`）？两条路工作量/耦合差很多，brainstorming 必须先定。

## 已经比较确定的方向（待 brainstorming 确认，非硬拍）

- regime 解析发生在引擎**逐日开仓**前（按 `buy_date==d` 当天的 `oamv_daily` 算出当前 regime）。
- 解析结果喂给 `computeAlloc`（覆盖 base positionRatio）和 `checkSkip`（覆盖 maxPositions）。
- regime 配置进 `PortfolioSimConfig` 的新 jsonb 字段（无 migration）。
- 沿用 0AMV 入场 gating 的 **fail-closed** 数据口径。

## 待 brainstorming 敲定的开放问题

1. **复用 regime-engine 四象限 vs 内联轻量 regime 规格**（见上，最关键）。
2. **作用层：源级 vs 账户级**。`positionRatio/maxPositions` 现在是**源级**；而「大盘 regime」是**账户级**（同日所有源同 regime）。例子里「2 仓 / 5 仓」是单源 maxPositions 还是组合总仓？多源时怎么分配？（单源迷你回测无歧义，多源组合要定清。）若要"账户级总 maxPositions"，引擎现在只按源卡 slots，需新增账户级约束。
3. **regime 条件语言 + 互斥/兜底**：条件复用现有 `StrategyConditionItem`（能直接接 query-builder 的 0AMV 字段）还是专门的 MACD 谓词？regime 列表是否互斥、按顺序首个命中？**没有 regime 命中当天**（如例子没覆盖 HIST<0 AND DIF<0）怎么办——回退源静态 positionRatio/maxPositions？还是当天不开仓？**oamv_daily 缺数据当天**怎么办（fail-closed=不开仓？还是回退静态？）。
4. **与现有 sizing 模式的组合**：regime 定的 positionRatio 是**替换** base，还是与 `signal_weighted/source_kelly` 的 mult **相乘**？（即 regime 只改 base + maxPositions，sizing mult 仍叠加？还是 regime 接管一切？）
5. **与 anchorMode 共存**：anchorMode 强制 fixed + 约束全停（对拍恒等）。regime 在 anchorMode 下必须**全旁路**（与其它约束一致），否则破坏 `realizedRetNet ≡ ret` 恒等。
6. **与熔断共存**：熔断（连亏/回撤）冻结开仓。regime 调仓 + 熔断冻结的优先级/叠加顺序。
7. **前端落点**：组合模拟「新建方案」+ 迷你回测「风控与回测」tab 都要能配 regime（共用引擎）？还是先只做组合模拟？UI 怎么编辑 regime 列表（条件构建器 + 每 regime 的 maxPositions/positionRatio）。

## 硬约束 / 项目规范（务必遵守）

- **零漂移**：config 不含 `regimes`（或为空）时，行为与今日**逐字一致**——存量 run/方案、anchorMode 对拍恒等全不受影响。这是合并门槛。
- **对拍恒等仍立**：anchorMode 单源 `realizedRetNet ≡ ret`（`portfolio-sim.runner.ts` runAnchorCheck 思路），regime 必须在 anchorMode 下旁路。
- **引擎是纯函数**：`computeAlloc`/`runPortfolioSim` 不依赖 DB/NestJS；regime 数据由 loader 装入 EngineInput，引擎只消费内存数据。
- **字段列名落源头**：0AMV 柱=`amv_macd`、DIF=`amv_dif`、DEA=`amv_dea`（`oamv_daily`），进 SQL/硬断言前再核 `ASHARE_MARKET_AMV_COL_MAP`（`strategy-conditions.types.ts:58`），禁二手转述。
- **fail-closed**：oamv_daily 覆盖回测窗口必须先核齐；缺数据按择时闸门口径处理（别让缺数据伪装成某 regime）。
- 单文件 ≤500 行；源文件 UTF-8；schema 变更走 migration（本功能 config jsonb 应无需 migration，若新增列才要）；后端改 `apps/server` 须重启进程再验证（`nest start` 无 watch）；改 `.vue` 合并前跑 `vite build`。
- **共用引擎双向影响**：动 `computeAlloc/checkSkip/engine/loader/types` 会同时影响组合模拟和 signal_test 迷你回测，两边的单测（portfolio-sim 232 / signal-stats 424）都要保持绿，且对拍恒等不破。

## 验证标准

- **单测**：regime 解析（给定某日 0AMV → 命中哪个 regime / 无命中 / 缺数据）、`computeAlloc` 在各 regime 下 positionRatio 正确、`checkSkip` 用 regime maxPositions 卡 slots；纯函数零 DB。
- **零漂移测**：无 regimes 配置 → 引擎输出与改造前逐位一致（可用现有锚点 run 对拍）。
- **anchorMode 恒等**：带 regimes 但 anchorMode=true → regime 旁路、`realizedRetNet ≡ ret`。
- **真机 e2e**：建一个带例子里 A/B 两 regime 的方案（单源即可，走迷你回测 7-tab 或组合模拟），跑一段 0AMV 数据齐全的区间，查 `*_fill` / equity：HIST>0&DIF>0 的日子最多 2 仓、每仓≈45%×NAV；HIST<0&DIF>0 的日子最多 5 仓、每仓≈20%。oamv_daily 缺数据的日子按兜底口径。

## 前序进度 / 待续

- 2026-06-15：本交接由「signal_test 迷你回测升级 + ml.jobs 草稿态」(已合入本地 main `ed85c9e`，见 memory `project_signaltest_minibacktest`)的收尾对话派生。迷你回测/组合模拟共用引擎是本需求"一处实现两处受益"的基础。
- **下一步**：新会话先跑 **brainstorming**，重点敲开放问题①（复用 regime-engine vs 内联）②（源/账户级）③（兜底/缺数据），出 spec 再 SDD 实现。
