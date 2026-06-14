# 02 · 迷你回测核心架构（两段接线）

[← 返回总入口](./index.md)

## 2.1 数据流总览（圈码全 spec 统一口径）

signal_test「运行」升级后是「信号质量层（现有，先提交）+ 资金账户层（新增，独立错误边界）」两层。资金账户层**复用** portfolio-sim 的 loader + 引擎，按 `run_id` 读回刚落库的逐笔交易。

```text
signal_test「运行」(升级后 doExecute):

  ┌─ 信号质量层（现有，零改，先落库并保留）─────────────────────┐
  │ ① 枚举买入信号(含 listSseTradingDays)  enumerator           │
  │ ② 逐笔出场模拟 → outcomes              simulator 纯函数核(4模式)│
  │ ③ 落 signal_test_trade(提交)          insertTradesBatched    │
  │ ④ calcSignalStats → 写 signal_test_run 聚合列(胜率/凯利…)    │
  └────────────────────────────────────────────────────────────┘
                  │ signal_test_trade 已提交(以 run_id 为键)
                  ▼
  ┌─ 资金账户层（新增，独立 try/catch，仅 backtest_config != null）┐
  │ ⑤ 构造单源 PortfolioSimConfig(sources[0].runId = 本 run.id)   │
  │    → PortfolioSimLoader.load(config) → EngineInput            │  ← 复用 loader:按 run_id 读 trades+因子+quotes+calendar
  │ ⑥ runPortfolioSim(input) → EngineResult                      │  ← in-process 纯函数,不落 portfolio_sim_* 表
  │ ⑦ 落 signal_test_equity(逐日) + UPDATE run 回测列(summary)    │
  └────────────────────────────────────────────────────────────┘
                  ▼
  ⑧ status='completed' + completed_at（质量层成功即置；回测层失败不影响）
```

> **圈码约定**：①~④ = 现有信号质量层、⑤⑥⑦ = 新增资金账户层、⑧ = 终态。本 spec 全文档统一引用此编号。
> `backtest_config == null` ⇒ 跳过 ⑤⑥⑦，回测列留 null，行为同今日（**零漂移**）。

## 2.2 单源映射：signal_test ↔ PortfolioSimConfig

迷你回测＝「对当前这一个 signal_test 跑单源 portfolio-sim」。`backtest_config`（扁平单源，[03 §3.2](./03-minibacktest-data-model.md)）在 ⑤ 组装成引擎要的 `PortfolioSimConfig`（字段名以 `portfolio-sim.types.ts` 为准）：

```text
PortfolioSimConfig
  sources: [ {                ← 单元素(本 test 即唯一源)
     runId:  本次 signal_test_run.id   ← loader 用它读 signal_test_trade
     label:  方案名(或 'self')
     positionRatio / maxPositions / exposureCap / rankSpec / sizing  ← backtest_config 同名字段
  } ]
  initialCapital / cost / anchorMode / circuitBreaker               ← backtest_config 同名字段
```

## 2.3 复用 PortfolioSimLoader（不另造适配层）

`PortfolioSimLoader`（`portfolio-sim.loader.ts`，`@Injectable`）已有现成能力：`load(config)` 内部按 `sources[].runId` 调 `loadSourceTrades`（`FROM signal_test_trade t WHERE t.run_id=$1`，LEFT JOIN 因子表得 `EngineTrade[]` 含 `factorValues`，并对 `ml.scores_daily` 做 `DISTINCT ON` 去重）+ `fetchQfqQuotes` + `fetchSseCalendar`（含 tail 扩展），整体产出 `EngineInput{config, trades, quotes, calendar}`。

**因此迷你回测在 ⑤ 直接复用 loader**，不再「绕过 loader / 另抽因子 SQL / 从内存 outcomes 重建」：

```text
// signal-stats runner 内，③ 提交 trade 之后
const engineInput = await portfolioSimLoader.load(singleSourceConfig)  // 复用:trades(含因子)+quotes+calendar
const result = runPortfolioSim(engineInput, onProgress)                 // import 自 portfolio-sim.engine
// result.summary  → signal_test_run 回测列
// result.dailyRows → signal_test_equity
// result.fills     → 本期不落库
```

> **模块接线**：portfolio-sim module 须 `exports: [PortfolioSimLoader]`，signal-stats module `imports` 它后注入。**方法签名以 `portfolio-sim.loader.ts` 真源为准，实现前核**（本节签名源自摸底，属二手）。
> 复用收益：`scores_daily` 跨 model_version 去重、calendar tail 扩展、qfq 行情取数、因子 LEFT JOIN 全是现成、已踩过坑的代码，不重复造。

## 2.4 时序与默认排序键

- **跨日时序**：loader 产出 + 引擎按 `calendar` 升序逐日推进（出场→开仓→盯市→记录），先后正确，无需在 runner 侧再排序。
- **同日多信号优先级**：引擎每日每源跑 `rankAndScore`。`rankSpec.factors=[]`（默认）⇒ 缺省按 **ts_code 升序**（`portfolio-sim.ranking.ts` 缺省键）；非空 ⇒ 单/多因子加权排序决定抢 `maxPositions` 槽位的优先级。此口径在全 spec 仅此一处定义。

## 2.5 对拍恒等（正确性门禁）

复用 portfolio-sim 的 anchor 校验思路（`portfolio-sim.runner.ts:280` `runAnchorCheck`）做代数恒等：

```text
anchorMode=true 单源 ⇒ 约束全停 + 费率全0(engine.ts 旁路) ⇒ 每笔 taken 的 realizedRetNet ≡ trade.ret
  ⇒ 取 fills 中 taken 的 realizedRetNet 序列喂 calcSignalStats(引擎已 import signal-stats.metrics)，
     其 win_rate/kelly_f/sample_count 必与 signal_test_run 既有聚合列(同一批 ret)逐位相等
```

M5 用此恒等做「引擎接线无漂移」硬门禁（[07 §7.3](./07-phasing-verification.md)）。非 anchorMode（真实约束+费率）无闭式恒等，靠不变量（`cash+Σmv≈nav`、`nav(d)=nav(d-1)×(1+dailyRet(d))`）校验。

## 2.6 进度与状态复用

signal_test_run 已有 `phase`（`scanning|simulating|writing`）+ `progress_scanned/progress_total` + runner 三阶段进度上报。回测层在 `simulating` 后插入 `replaying` 阶段（引擎 `onProgress` 驱动），`writing` 顺带写 equity。`phase` varchar(16) 无 CHECK，加 `'replaying'` 无需 migration（[03 §3.1](./03-minibacktest-data-model.md)）。status 枚举是 `running|completed|failed`（**与 ml.jobs 的 pending/draft 不同源，勿混**）。
