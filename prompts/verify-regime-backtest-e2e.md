# 真机 e2e 验证：regime-engine 多策略回测引擎

> 整段可贴给全新会话直接接手。**只做真机端到端验证，不改实现**（除非验出 bug）。

## 一句话目标

在**跑起来的应用 + 真 DB** 上，把已合入 main 的「regime 驱动多策略回测引擎」跑通一次完整回测，确认 **regime 路由 → 开仓 → 出场 → 熔断 → sizing → 净值记录** 全链路在真实数据上正确——这是该功能唯一未做的一步（后端 build + 1488 jest、前端 type-check + 592 vitest 已全绿；3 张数据表已建好）。

## 背景（已完成的实现，全部在本地 main，未推 origin）

2026-07 经 brainstorming→spec→subagent-driven-development 全流程实现，10 commit：`0afd7f7`(迁移 buildEnumerateQuery) → `0083af5`(core/types) → `f837311`(cost/cooldown/metrics/exit-simulator) → `f60b18a`(引擎主循环+sizing/summary) → `b6756bc`(数据表+实体) → `1189914`(数据加载层) → `f0328bd`(编排层+service+controller) → `b297b58`(前端页面) → `92c0e86`(后端弃用 signal-stats+portfolio-sim) → `5d8309e`(前端弃用)。

**引擎核心设计**（验收时对照）：
- **主循环**（`regime-backtest.engine.ts`，纯函数）：逐交易日 → ①出场（按 exitDate 收口 + 卖费 + registerExit）→ ②classifyRegime→entry 取本日信号 → ③熔断闸门（cooldown + drawdown_halt）→ ④开仓（simulateTradeCore 预算 exitDate+ret → sizing 分配 → 约束检查 already_held/slots_full/cash_short/sized_out → 成交）→ ⑤盯市（daysByDate + close 更新 mv）→ ⑥记录 NAV。
- **regime 路由**：市场 regime → 四象限 `RegimeConfigMap = Record<'Q1'|'Q2'|'Q3'|'Q4', RegimeConfigEntry>`。`action:'trade'` 象限有 `entryConditions`（条件系统 JSON）+ `exitMode`；`action:'flat'` 象限空仓（落空仓理由）。
- **exitMode**：`trailing_lock`（跟踪止损）/ `fixed_n`（固定持有 N 日）/ `strategy`（条件出场）。exitParams：fixed_n→`{N}`、strategy→`{exitConditions,maxHold}`、trailing_lock→`{maxHold|null}`。
- **熔断**：`cooldown`（连续亏损后冷却）、`drawdown_halt`（回撤超限停机）。
- **sizing**：`computeAlloc` 按基础参数分配资金（去 source 化，非 portfolio-sim 的 rank spec）。
- **quality 硬编码 0.5**：回测暂不接入信号质量评分，`signal_weighted` 退化为 (floor+cap)/2。
- **run.config 冻结快照**：创建回测时把 `{config: RegimeConfigMap, capital: RegimeBacktestCapital}` 冻结存入 `regime_backtest_run.config`，回测用创建时的配置（后续改 regime 配置不影响已跑的回测）。
- **信号是动态枚举**（非查预存表）：`buildEnumerateQuery`（`strategy-conditions.enumerator.ts`）根据 entryConditions 条件 JSON 实时查 `raw.daily_indicator`/`raw.daily_quote`/`raw.daily_basic` 枚举当日信号。

---

## 阶段 0：前置数据检查（最易翻车，回测跑空多半是因为这步）

**0.1 regime 配置**（回测的输入，没配好等于空跑）：
```
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT id, version, status, note, jsonb_pretty(config) FROM regime_strategy_config ORDER BY version DESC LIMIT 3;"
```
确认：至少有 1 行 `status='active'`；`config` 的 Q1~Q4 四象限里至少 1 个是 `action:'trade'` 且带 `entryConditions`（否则没有信号、全空仓）；`exitMode`/`exitParams` 配置合理。**记下 active 配置的 `id`，创建回测时作为 `regimeConfigId` 传。** 若无 active 配置 → 先去 `/regime-config` 页面配好（非本次验收范围，阻塞则上报）。

**0.2 行情/指标/基本面覆盖回测区间**（信号枚举 + 持有窗口都靠它）：
```
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT min(trade_date),max(trade_date),count(DISTINCT trade_date) FROM raw.daily_quote;"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT min(trade_date),max(trade_date),count(*) FROM oamv_daily;"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT min(cal_date),max(cal_date),count(*) FROM raw.trade_cal WHERE exchange='SSE' AND is_open=1;"
```
确认覆盖范围包含你打算回测的 `[dateStart, dateEnd]`。**首次跑选一个数据齐全、且有趋势/有震荡的小区间**（如近 3~6 个月），好让 regime 切换 + 不同 exitMode 路径都被触发。

**0.3 表已建好**（已确认，仅供复核）：
```
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'regime_backtest%' ORDER BY table_name;"
```
应见 `regime_backtest_daily` / `regime_backtest_run` / `regime_backtest_trade` 三张。

---

## 阶段 1：建表（已完成）

`apps/server/src/migration/20260704_create_regime_backtest_tables.ps1` 已跑过，3 张表已存在。**跳过此步。**

---

## 阶段 2：启动服务

`pnpm dev`（DB + server :3000 + web :5173）。

⚠️ **后端 `dev` 是 `nest start` 无 watch（不热加载）**：本次提交后若旧后端进程还在跑，**必须先重启后端进程**再验，否则撞 404/旧行为假象（前端 vite 有 HMR 不受限）。端到端验证前先确认后端跑的是最新代码。

---

## 阶段 3：建 + 跑（前端 `/regime-backtest` 或直调 API）

**前端路径**（推荐，复用登录态）：浏览器打开 `http://localhost:5173/regime-backtest`（路由 `apps/web/src/router/index.ts:73`，组件 `views/strategy/RegimeBacktestView.vue`）。

**注意**：`create` 和 `triggerRun` 都带 `@AdminOnly`（`regime-backtest.controller.ts:19,30`）——需管理员账号登录。

新建回测（`CreateRegimeBacktestDto` 字段，`dto/create-regime-backtest.dto.ts`）：
- `regimeConfigId`：阶段 0.1 记下的 active 配置 id
- `name` / `note?`
- `capital`：`{ initialCapital, cost:Record<string,number>, positionRatio, maxPositions:number|null, sizing?, circuitBreaker?, anchorMode? }`
- `dateStart` / `dateEnd`：阶段 0.2 确认覆盖的区间

触发运行后，引擎异步三阶段（loading → replaying → writing）。**轮询进度**（非 SSE）：`GET /api/regime-engine/backtests/:id/progress`。前端应自动轮询；直调 API 则手动查直到终态。

直调 API 备选（PowerShell，需先拿到管理员会话 cookie / token）：
```
# 列出（确认创建成功）
curl.exe http://localhost:3000/api/regime-engine/backtests
# 触发运行
curl.exe -X POST http://localhost:3000/api/regime-engine/backtests/<id>/run
# 轮询进度
curl.exe http://localhost:3000/api/regime-engine/backtests/<id>/progress
```

**若 run 失败**：查 `regime_backtest_run.status`/`error` 字段，对照 data-loader/engine 排查（常见：信号枚举为空→entryConditions 配错或区间无命中；oamv/行情缺日→区间越界）。

---

## 阶段 4：结果合理性（核心）

**4.1 净值曲线**（`GET /:id/daily` 或前端 NavChart）：
- 曲线连续、无 NaN/断点；起始 NAV ≈ `initialCapital`；每日 NAV = cash + Σ持仓 mv。
- DB 抽查：
  ```
  docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT trade_date,nav,cash,positions_value,n_positions,n_held FROM regime_backtest_daily WHERE run_id='<id>' ORDER BY trade_date LIMIT 20;"
  ```
  确认列非空、n_positions 随开/平仓增减合理。

**4.2 trades**（`GET /:id/trades` 或前端 TradesTable）：
- 有开仓记录（entryDate + entryPrice）+ 平仓记录（exitDate + exitPrice + ret）。
- 抽 2~3 笔对照真 DB 手算：买入价 = 信号次日开盘（按引擎口径）；exitDate 是否符合 exitMode（fixed_n=信号后 N 个可交易日；trailing_lock=止损/MA5/锁定触发；strategy=条件命中或 maxHold）。
  ```
  docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT ts_code,entry_date,entry_price,exit_date,exit_price,ret,exit_reason,regime_key FROM regime_backtest_trade WHERE run_id='<id>' ORDER BY entry_date LIMIT 20;"
  ```
- 不同 `regime_key`（Q1~Q4）的 trade 应符合对应象限配置：trade 象限有开仓、flat 象限无开仓。

**4.3 熔断 & 约束**：
- `skip_reason` 分布合理：`already_held`（同标的已在仓）/ `slots_full`（仓位满）/ `cash_short`（现金不足）/ `sized_out`（分配额过小）/ `cooldown` / `drawdown_halt`。DB 查 summary 里的 `nTaken`/`nSkipped` 字段。
- 若区间内有连续亏损，应见 `cooldown` 触发；有大幅回撤应见 `drawdown_halt`。区间太平没触发则标注"靠单测覆盖、真机未触发"。

**4.4 summary**（前端 SummaryCards 或 `GET /:id`）：
- totalReturn / maxDrawdown / nTrades / winRate 数值合理（非全 0/全 NaN/极端值）。

---

## 关键文件（grep 可核）

- 引擎主循环（纯函数）：`apps/server/src/strategies/regime-engine/backtest/regime-backtest.engine.ts`（224 行，9 spec）
- 数据加载层：`apps/server/src/strategies/regime-engine/backtest/regime-backtest.data-loader.ts`（352 行，27 spec）——查 `oamv_daily`/`raw.trade_cal`/`raw.daily_quote`/`raw.stk_limit`/`raw.daily_indicator`/`raw.daily_basic`/`a_share_symbols`
- 编排层（loading→replaying→writing）：`regime-backtest.runner.ts`
- service（CRUD + triggerRun 互斥）：`regime-backtest.service.ts`
- controller（8 路由）：`regime-backtest.controller.ts` @ `regime-engine/backtests`
- 共享纯函数内核：`regime-engine/core/`（types/cost/cooldown/metrics/sizing/summary/exit-simulator）
- 信号枚举：`strategy-conditions/strategy-conditions.enumerator.ts`（`buildEnumerateQuery`，从 signal-stats 迁入）
- regime 配置实体：`entities/strategy/regime-strategy-config.entity.ts`（`RegimeConfigMap`/`RegimeConfigEntry`/`RegimeExitMode`）
- 回测实体：`entities/strategy/regime-backtest-{run,daily,trade}.entity.ts`
- 前端：`views/strategy/RegimeBacktestView.vue` + `components/strategy/regime-backtest/`（CreateForm/NavChart/TradesTable/SummaryCards）

---

## 验收标准

- [ ] 阶段 0：regime active 配置存在且四象限合理；行情/oamv/日历覆盖回测区间。
- [ ] 阶段 3：能新建回测 + 触发 run + 轮询到终态成功（无 500/异常）。
- [ ] 4.1：净值曲线连续无 NaN，起始≈initialCapital，NAV=cash+持仓mv 对得上。
- [ ] 4.2：trades 有开/平仓，≥2 笔 exitDate/exitPrice 对照 exitMode 手算对得上；flat 象限无开仓。
- [ ] 4.3：skip_reason 分布合理（至少看到 already_held/slots_full 之一；趋势/回撤区间见 cooldown/drawdown_halt 更佳）。
- [ ] 4.4：summary 指标数值合理（非全 0/NaN/极端）。
- [ ] 全程无 500/异常/前端崩；发现 bug 则**落源头交接或修**（systematic-debugging）。

---

## 硬约束 / 规范

- 改后端代码必**重启后端进程**（dev 无 watch）再验，否则撞旧码假象。
- 所有源文件 UTF-8；查 DB/写脚本对象键名英文（PowerShell GBK 坑）。
- 终端 PowerShell，禁 `&&` 连接，用 `;` 或多行。
- 查 DB 用 `docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "..."`。
- 进硬断言/硬编码/SQL 事实**落源头亲验**，不采信本文转述。
- `create`/`triggerRun`/`remove` 带 `@AdminOnly`——需管理员账号。

---

## 待续 / 已知边界

- **quality 硬编码 0.5**：回测暂不接入信号质量评分，`signal_weighted` 退化为 (floor+cap)/2（by-design，非 bug）。
- **phase_lock 出场**：引擎已支持但 `RegimeExitMode` 类型仅 `trailing_lock|fixed_n|strategy`（phase_lock 未进类型定义）——验收不覆盖。
- **加密 backtest 引擎未重构**：本次只建 regime-engine 回测层，旧的加密逐 bar 引擎不动。
- 本次 e2e 全过 → 本任务完成，**移入 `prompts/archive/`**。
- 验出 bug：按 systematic-debugging 定位，小修直接改 + 补单测；大改回 spec 评估。
