# 04 · Part A 后端引擎接线

[← 返回总入口](./index.md)

## 4.1 改动落点总览

```text
signal-stats.runner.ts   doExecute 在 ④ 之后、⑧ 之前插入资金账户层 ⑤⑥⑦(独立 try/catch)
signal-stats.service.ts  create/update/triggerRun 透传并校验 backtest_config
dto/*                    CreateSignalTestDto 增 backtestConfig?(可选,缺省=不跑回测)
signal-stats.module.ts   imports PortfolioSimModule(注入 PortfolioSimLoader)
portfolio-sim.module.ts  exports PortfolioSimLoader
portfolio-sim.engine.ts  import { runPortfolioSim }（不改）
新增只读 endpoint         GET /signal-tests/:id/runs/:runId/equity
```

> 复用 `PortfolioSimLoader` 后**无需新建 mini-backtest 适配模块 / 新因子 SQL / 新 quotes 取数**（见 [02 §2.3](./02-minibacktest-architecture.md)）。新代码集中在「config 组装 + 落库 + endpoint + DTO」。

## 4.2 runner 接线点（圈码同 [02 §2.1](./02-minibacktest-architecture.md)）

`signal-stats.runner.ts` `doExecute` 现有 ①~④ 不动，在其后插入 ⑤⑥⑦：

```text
① 枚举买入信号(含 listSseTradingDays)        现有
② 逐笔出场模拟 → outcomes                     现有
③ insertTradesBatched 落 signal_test_trade(提交)  现有
④ calcSignalStats → 写 signal_test_run 聚合列   现有(信号质量层,已落库保留)
─── 以下仅当 test.backtestConfig != null,且包在【独立 try/catch】──
⑤ cfg = 构造单源 PortfolioSimConfig(sources[0].runId = runId)
   phase='replaying'; input = await portfolioSimLoader.load(cfg)
⑥ result = runPortfolioSim(input, onProgress→progress 上报)
⑦ phase='writing':
     DELETE signal_test_equity WHERE run_id=runId   (幂等重跑)
     批量 insert result.dailyRows → signal_test_equity
     UPDATE signal_test_run SET final_nav/total_ret/.../total_costs = result.summary.*
─────────────────────────────────────────────────────
⑧ status='completed' + completed_at
```

`backtestConfig == null` ⇒ 跳过 ⑤⑥⑦，回测列留 null，直接 ⑧。

## 4.3 失败回滚边界（正确性硬约束）

现有 `executeRun` 的 catch（`signal-stats.runner.ts` 顶层）在 `doExecute` 抛任何错时执行 `tradeRepo.delete({runId})` 清空全部 trade + `status='failed'`。**若回测层 ⑤⑥⑦ 抛错冒泡到该 catch，会连信号质量层已落库的 trade 一并删掉**。

**约束**：⑤⑥⑦ 必须包在**独立 try/catch**，失败时：

```text
catch(回测层) {
  logger.error(...)
  UPDATE signal_test_run SET final_nav=...=null,            // 回测列保持 null
                            error_message = '回测层失败: ' + msg   // 仅作提示,不污染质量指标
  // 不 rethrow → 不触发顶层 trade 删除
}
// 之后照常 ⑧ status='completed'（信号质量层成功,run 仍可看胜率/凯利,只是无回测视图）
```

即：**信号质量层失败 → 顶层 catch 删 trade + failed（不变）；回测层失败 → 质量层数据保留、run='completed'、回测列 null + error_message 提示**。两层错误边界分离。

## 4.4 单源 config 组装 + 排序因子

⑤ 把 `backtest_config`（扁平）组装成引擎 `PortfolioSimConfig`：单元素 `sources[0]`，其 `runId = 本 signal_test_run.id`、`positionRatio/maxPositions/exposureCap/rankSpec/sizing` 取自 backtest_config 同名字段；账户级 `initialCapital/cost/anchorMode/circuitBreaker` 同理。

排序因子由 loader 一并装载（`loadSourceTrades` 的 LEFT JOIN），**无需在 signal-stats 侧另写因子 SQL**。`RankFactorKey` 9 值（`pos_120/pos_60/close_ma60_ratio/vol_ratio_60/vol_ratio_120/risk_reward/momentum_60/circ_mv/ml_score`）须与 `portfolio-sim.factor-registry.ts` 注册表逐一对齐——**进硬断言前核注册表真源**（注意 `ml_score` 前向专用 histAvailable=false、`risk_reward` 实列名 `risk_reward_ratio`、`momentum_60` 为 computed，不能按 KEY 字面拼列）。

## 4.5 quotes / calendar

亦由 `loader.load(config)` 内部产出（`fetchQfqQuotes` 返回 `Map<tsCode, Map<date,{open,close}>>`，`fetchSseCalendar` 取 `raw.trade_cal` SSE 升序并 tail 扩展），覆盖回放窗口、停牌日缺 key=不更新盯市（引擎已处理）。**无需在 signal-stats 侧复制取数**（避免暴露 simulator 的 private `fetchQuotes`）。

## 4.6 config 校验（DTO 层）

`CreateSignalTestDto` 增 `backtestConfig?`（可选）。校验复用 portfolio-sim 的 `create-portfolio-sim.dto.ts` 语义，落到扁平形：

```text
initialCapital   > 0
positionRatio    (0,1]
maxPositions     null | 正整数
exposureCap      null | (0,1]
sizing.mode      'fixed'|'signal_weighted'|'source_kelly'；signal_weighted 要 capMult>=floorMult>0
rankSpec.factors 每项 factor∈9白名单、weight>0、dir∈{asc,desc}
circuitBreaker   null | 双触发字段齐全且 resumePct<=haltPct、阈值非负
anchorMode=true  ⇒ 强制 maxPositions/exposureCap=null、cost 归零、circuitBreaker 旁路(与 portfolio-sim 同语义)
```

校验失败抛中文 400（透传前端 message，与 signal-stats 现风格一致）。

## 4.7 不变量（M5 校验）

- 每日 `cash + Σmv ≈ nav`（浮点容差）；`nav(d) = nav(d-1) × (1 + dailyRet(d))`。
- anchorMode 单源：`Σ taken realizedRetNet` 喂 calcSignalStats 与既有聚合列逐位相等（[02 §2.5](./02-minibacktest-architecture.md)）。
- 引擎 `EngineSummary` 11 字段（finalNav/totalRet/annualRet/maxDrawdown/sharpe/calmar/dailyWinRate/dailyKelly/nTaken/nSkipped/totalCosts，`portfolio-sim.types.ts` EngineSummary）逐一落 run 回测列（[03 §3.3](./03-minibacktest-data-model.md)）。

## 4.8 量化舍入一致性

拼接处**不引入新舍入层**：trade.ret 由 loader 原样供给引擎，引擎按自身既有口径算 realizedRetNet；signal-stats 出场核的 `floor2`（0.01 截断，与 Python `math.floor` 同构）只在 ② 内部生效。避免 banker's rounding 分叉（memory 教训）。
