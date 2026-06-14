# 05 · Part A 前端：7-tab 表单 + 净值曲线 + 移除内联新建源

[← 返回总入口](./index.md)

## 5.1 SignalTestForm 重构为 n-tabs 分区表单

现 `SignalTestForm.vue`（`views/strategy/SignalTestForm.vue`，491 行，5 区单文件）→ 改为 `n-tabs` 分区（仿 `StrategyModal.vue` 形态：`n-tabs` + 各区子组件）。**控件复用来源是 portfolio-sim，不是 strategy section**（理由见 §5.3）。

```text
┌ SignalTestForm (n-tabs，7 区，对齐新建策略) ─────────────────────────────────┐
│ [基础信息][基础配置][入场信号][入场排序][资金与仓位][止损与出场][风控与回测] │
└──────────────────────────────────────────────────────────────────────────────┘
 tab          内容                                    控件来源
 ──────────────────────────────────────────────────────────────────────────────
 基础信息      方案名称 / 标的池(all|list) / 统计区间       现有 signal-stats 控件
 基础配置      窗口/回看参数:lookback(phase_lock 初始止损回看)  从出场参数上浮(拆既有字段)
              + 预留 recentLow 类窗口位
 入场信号      买入条件 ConditionRows                      现有,复用(已与策略共用)
 入场排序      rankSpec 单/多因子(+weight+dir)              仿 portfolio-sim 排序;新建小组件
 资金与仓位    initialCapital/positionRatio/               仿 portfolio-sim 源行+成本档
              maxPositions/exposureCap/sizing模式
 止损与出场    4模式 fixed_n(horizonN)/strategy(exitConditions  现有 signal-stats 出场配置
              +maxHold)/trailing_lock(stopRatio/floorRatio/   (原样搬入,仅止损因子,不含 lookback)
              floorEnabled/ma5RequireDown)/phase_lock(initFactor/lockFactor)
 风控与回测    成本档(5费率) + 双触发熔断 + anchorMode        复用 CircuitBreakerPanel + portfolioSimPresets 成本档
```

> **7 区对齐新建策略**（决策④）。仿策略「窗口归基础配置、止损因子归止损与出场」的拆法：把 phase_lock 的 `lookback`（初始止损回看窗口）从出场参数**上浮**到「基础配置」tab，其余 phase_lock 止损因子（initFactor/lockFactor）仍在「止损与出场」。这是**拆分既有字段、不新增后端字段**。
> 注：`lookback` 仅 phase_lock 模式有效；非 phase_lock 模式「基础配置」tab 显示「当前出场模式无窗口参数」占位，待未来扩展（如 recentLow 窗口）。后端 `backtest_config` 不含 lookback——lookback 仍属 `phase_lock_params`（[03 §3.2](./03-minibacktest-data-model.md)），「基础配置」tab 只是它的 UI 归属，提交时仍写回 phase_lock_params。

## 5.2 拆分以满足 ≤500 行

重构后按子组件拆（每文件 < 500 行）：

```text
SignalTestForm.vue                外壳:n-tabs + 提交校验 + DTO 组装(瘦)
SignalTestBasicSection.vue        基础信息(名称/标的池/区间)
SignalTestBaseConfigSection.vue   基础配置(lookback 窗口;phase_lock 时显示,否则占位)
  (入场信号直接用现有 ConditionRows,无需新组件)
SignalTestRankSection.vue         入场排序(rankSpec)
SignalTestCapitalSection.vue      资金与仓位
SignalTestExitSection.vue         止损与出场(从现 SignalTestForm 出场配置块抽出,4模式;lookback 上浮到基础配置)
SignalTestRiskSection.vue         风控与回测(成本档 + CircuitBreakerPanel + anchorMode)
```

新建 composable `useSignalTestForm.ts`（仿 `useStrategyForm` 的默认值/重置/日期归一模式，但独立类型）：管理 `form` 默认值、`backtestConfig` 默认值、编辑回填、提交时组装 `CreateSignalTestDto`（含可选 `backtestConfig`）。

## 5.3 为什么不复用 strategy 的 section 控件

已核实（feParams 探查）：`StrategyCapitalSection / StrategyConfigSection / EntrySortSection / StrategyStopExitSection / CooldownParamsSection` 全部 `v-model:params` 吃 `StrategyParams`（49 字段、crypto K 线回测专属）。三处根本性不兼容：

1. **类型不兼容**：signal_test 无 `StrategyParams`（无 kdjN/maConditions/timeframe 等）。直接传会类型+逻辑双错。
2. **出场体系不可调和**：strategy 的 `stopLossMode/stopLossFactor/enableLadderStopLoss/...` 是 K 线引擎动态止损；signal_test 4 模式（fixed_n/strategy/trailing_lock/phase_lock，对应 `band_lock_params/phase_lock_params`）字段集合完全不重叠。故 `StrategyStopExitSection` **不可复用**——「止损与出场」tab 直接搬现有 SignalTestForm 的出场配置块。
3. **portfolio-sim 控件才是对的源**：资金/仓位/排序/熔断这几 tab 对接的是 `runPortfolioSim` 参数，与 `PortfolioSimCreateModal` 用的 `CircuitBreakerPanel`、`portfolioSimPresets`（成本档）、源行字段（positionRatio/maxPositions/exposureCap/rankSpec/sizing）**同一套语义**。复用这些（或照其形态新建瘦组件）。

## 5.4 详情页净值曲线

`SignalStatsResult.vue`（详情弹窗）增「回测」视图：当 run 有回测层（`final_nav != null`）时，展示：

- 回测指标卡：total_ret / annual_ret / max_drawdown / sharpe / calmar / daily_win_rate / n_taken / total_costs。
- 净值曲线 ECharts：拉 `GET /api/signal-tests/:id/runs/:runId/equity`（新只读 endpoint，返回 `signal_test_equity` 升序），x=trade_date、y=nav，叠加回撤带。
- 信号质量层（现有胜率/凯利/盈亏比/直方图）继续展示——两层并列（D2 叠加）。

`backtest_config == null` 的旧 run 不显示回测视图（条件渲染），零回归。

## 5.5 移除内联新建源

```text
删除  components/portfolio-sim/PortfolioSimNewSourceModal.vue
改    components/portfolio-sim/PortfolioSimSourceRunPicker.vue
        - 去掉来源方式 'new' 单选(模板 :14) + <template v-else> 块(:68-91)
        - 去掉 <PortfolioSimNewSourceModal>(:93-96) + import(:115)
        - 删路径B轮询态:showNewModal/newRunState/newPollError/onNewSourceCreated/newRunPct
        - SourceMethod 联合收成 'scheme' | 'manual'
        - 'scheme' 空态文案(:44-46)「无可用 completed run，请新建信号源或换方案」
            改为 →「无可用 completed run，去『信号统计』新建并运行方案」+ 跳转链接(router 到信号统计页路由)
改    composables/usePortfolioSimSourceRuns.ts
        - 裁剪仅 startPolling 路径B用到、现已无人调用的部分(保留 loadRuns/latestCompleted)
```

> 链路成立性已验证：组合源「选已有方案 + 历史 run」（`PortfolioSimSourceRunPicker` scheme 路径，`loadRuns(schemeId)` 取 signal_test run，仅 completed 可选）就是「选历史 run」。用户在信号统计页建+跑，跑完即在此被选用。

## 5.6 类型 / API 前端改动

- `api/modules/strategy/signalStats.ts`：`SignalTest` / `CreateSignalTestDto` 增 `backtestConfig?: SignalTestBacktestConfig | null`；`SignalTestRun` 增回测指标字段（final_nav 等）；新增 `getEquity(testId, runId)` 调 `GET /signal-tests/:id/runs/:runId/equity`。
- Naive UI 自定义 `<n-select :options>` 选项类型须 `extends SelectOption`（vue3 规范）。
- 改 import 块后回读文件头验证顺序；合并前跑 `vite build`（type-check 查不出 SFC 编译错）。
