# 真机 e2e 验证：波段跟踪止损出场规则 trailing_lock / band_lock（三模块）

> 整段可贴给全新会话直接接手。**只做真机端到端验证，不改实现**（除非验出 bug）。

## 一句话目标

在**跑起来的应用 + 真 DB** 上，把已合入 main 的「波段跟踪止损出场规则 trailing_lock / band_lock」在三个模块各跑通一次，确认**止损 / 高点锁定 / MA5 收盘离场 / 限停板顺延**等路径被真实数据触发且数值正确——这是 spec §三 的完整完成判据，当前唯一未做的一步（自动化测试已全绿：Python 1347 / jest signal-stats 226 / 双 build / type-check / lint）。

## 背景（已完成的实现，全部在本地 main，未推 origin）

2026-06-09 经 brainstorming→spec→subagent-driven-development 全流程实现并 FF 合入 main，6 commit：`475d191`(共享核) → `52a081f`(exit_rules) → `63476e6`(kelly_sweep) → `684ff0a`(signal-stats 后端) → `9d3f01e`(前端) → `d511f40`(spec 备注)。

- **规范算法 spec**：`docs/superpowers/specs/2026-06-09-trailing-lock-exit-design/`（入口 `index.md`，规范算法 `01-rule-semantics.md`，对拍样例 S1~S13 `02-shared-core-and-contracts.md`，三模块集成 `03-module-integration.md`）。**验数值前先读 01 把规则吃透**。
- **共享纯函数核**：`apps/quant-pipeline/src/quant_pipeline/strategy/band_lock_exit.py::simulate_band_lock`（单一真值，21 单测对拍）。三模块都喂它。
- 规则要点（细节以 01 为准）：T+1 开盘买入；持仓首日 收盘>开盘=方案一(初始止损=开盘×0.999)/≤=方案二(初始止损=最低×0.999 + 成本×0.999 保本地板)；止损价每日收盘后设、次日生效（跌破前一日最低价×0.999 出场，成交价 min(止损,开盘)）；某日最低>信号K线最高价→冻结锁定 + 叠加 MA5 收盘离场(close<MA5 且 MA5<前一日 MA5)；一字涨停(raw_open≥up_limit)买不进、封死跌停(raw_high≤down_limit)卖不出顺延。价格基准各模块原生复权价（signal-stats/kelly_sweep=qfq，exit_rules=hfq）。

> 行号均为 main 当前值，**grep 可核**（CLAUDE.md 规范：进硬断言/硬编码前落源头亲验，别采信本文转述）。

---

## 模块 B：signal-stats（用户可视，浏览器 e2e）★ 最重要

面向用户的「信号前向统计」，前端可选第 3 个出场模式「波段跟踪止损」。

**起服务**：`pnpm dev`（DB + server :3000 + web :5173）。后端 `dev` 是 `nest start` **无 watch**——若期间改了 `apps/server` 代码须**重启后端进程**才生效（前端 vite 有 HMR 不受限）。

**浏览器操作**（用 `browser-driving` + `kimi-webbridge` skill，复用用户真实登录态）：
1. 打开 `http://localhost:5173/signal-stats`（路由见 `apps/web/src/router/index.ts:67`，组件 `views/strategy/SignalStatsView.vue`）。需登录则走邀请码/会话（用户态应已登录）。
2. 新建一个信号测试：出场模式选「**波段跟踪止损**」（`SignalTestForm.vue` 第 3 个 radio，value=`trailing_lock`）；
   - 该模式**无卖出条件编辑器、无 horizonN**，只有可选「最长持有天数」（留空=不封顶）。先**留空**跑一轮。
   - 买入条件挑一个能在所选区间产出**足量信号**的（如 `kdj_j<0` 之类）；
   - **区间/标的尽量选趋势行情**，好让"价格冲过信号K线最高价→锁定→MA5 拐头离场"的路径被真实触发（否则可能只看到跟踪止损 `stop`，看不到 `ma5_exit`）。建议先长区间全市场跑一轮拿大样本。
3. 触发 run，等 SSE 跑完（注意终态：runner 完成须 emit progress=100，否则前端卡 99——这是同类功能的已知坑）。
4. **核对结果**：
   - 出场原因分布里应出现 `stop`（止损，前端显示「止损」）；趋势样本里应能看到 `ma5_exit`（前端「MA5离场」）；可能有 `max_hold`/`delist`。**确认前端列表/详情/直方图正常渲染**，出场方式列显示「波段跟踪止损(不封顶/≤N)」而非误标「条件出场」。
   - 抽 2~3 笔逐笔明细，**对照真 DB 手算**验证：买入价=持仓首日 qfq_open、止损成交价=min(止损价,当日qfq_open)、scheme(1/2) 判定、MA5 离场条件。查 DB：
     ```
     docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT trade_date,qfq_open,qfq_high,qfq_low,qfq_close FROM raw.daily_quote WHERE ts_code='600519.SH' AND trade_date BETWEEN '20240101' AND '20240131' ORDER BY trade_date"
     docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT trade_date,up_limit,down_limit FROM raw.stk_limit WHERE ts_code='600519.SH' AND trade_date='20240108'"
     ```
5. 再跑一轮**设 maxHold=10**，确认有 trade 因 `max_hold` 在第 10 个可交易日出场（验可选封顶）。
6. （尽力）找一段含**一字跌停**的标的/区间，验封死跌停顺延（卖出顺延到下一可卖日开盘）；难构造则跳过，标注"未真机覆盖、靠单测 S6"。

**接线参考**（grep 可核）：`signal-stats.runner.ts` trailing_lock 分支构造 `{mode:'trailing_lock',maxHold:maxHold??undefined}`（约 :125-133，在 strategy else 之前）；`signal-stats.service.ts` validateDto trailing_lock 分支（约 :266）；数据层 `signal-stats.simulator.db.ts` `isBandLock` 左扩取数/MA5/downLimit（约 :141）；TS 核 `signal-stats.simulator.ts::decideBandLock`（约 :373）。

---

## 模块 D：exit_rules / 标签侧（labels job 触发，无专属 UI）

band_lock 是独立 stateful scheme（`labels/band_lock_labels.py::compute_band_lock_labels`），**只能由显式 `scheme='band_lock'` 的 labels 任务触发**（未接 prepare/train 的 base_type 编排）。

**触发途径二选一**（先 `--help` 确认确切选项，别照搬）：
- **CLI 直跑**：`apps/quant-pipeline` 下用项目环境（`.venv` / `uv run`）跑 `python -m quant_pipeline.cli labels build --scheme band_lock ...`（labels 子命令见 `cli.py:213` `labels_build`，确认它接受的日期/区间/标的参数）。max_hold 用 `band_lock__mh10` scheme 串或对应入参（runner 入参 `band_lock_max_hold` 见 `labels/runner.py:483/853`，scheme 正则 `_BAND_LOCK_RE` 见 `:72`，dispatch 见 `:687`）。
- **worker job**：`run_type='labels'` + `params={"scheme":"band_lock","date_range":...,"band_lock_max_hold":N?}`（看 `/quant/jobs` 是否能提交自定义 scheme；不能则走 CLI）。

**核对**：跑一个小区间后查 `factors.labels` 有 `scheme='band_lock'`（或 `band_lock__mh10`）的行、`value(gross)/exit_reason/hold_days` 非空：
```
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT scheme,exit_reason,count(*),round(avg(value)::numeric,4) FROM factors.labels WHERE scheme LIKE 'band_lock%' GROUP BY scheme,exit_reason ORDER BY 1,2"
```
抽 1~2 行对照真 DB 手算 gross（=exit_price/buy_price-1，buy_price=T+1 hfq open_adj=open×adj_factor）。确认 exit_reason 含 stop/ma5_exit/max_hold/force_close 合理分布、无异常。

---

## 模块 E：kelly_sweep（研究网格，CLI 触发）

band_lock 出场族（max_hold∈{None,10,20}）**默认不在扫描族里**，须显式选。

**触发**：kelly_sweep 有独立 CLI `apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/cli.py`——`--help` 看怎么传 `exit_families`/区间；族集合见 `sweep.py:129`（`fixed_n/tp_sl/trailing/atr_stop/band_lock`），`build_exit_grid(["band_lock"])` 见 `:133`，`_run_exit` band_lock 分支见 `:314`。或在调用处显式传 `exit_families=["band_lock"]`。

**核对**：跑一个小区间，确认输出里有 band_lock 各 max_hold 配置的凯利/胜率结果（`_exit_id` 形如 `band_lock(mh=None/10/20)`，见 `sweep.py:284`），数值合理（非全 0/全 NaN）、与同区间其它族量级可比。结果落 research 表的话查表抽验。

---

## 真 DB 抽查口径（写进任何结论前必做）

- 列已亲验存在：`raw.daily_quote(open,high,low,close,qfq_open,qfq_high,qfq_low,qfq_close,...)`、`raw.stk_limit(ts_code,trade_date,up_limit,down_limit)`、`raw.daily_indicator.ma5`（已验 qfq 基）、`factors.labels(trade_date,ts_code,scheme,value,exit_reason,hold_days)`、`signal_test/signal_test_run/signal_test_trade`。
- 查 DB 模板：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "..."`。
- **MA5 复权基差异(by-design)**：signal-stats/kelly_sweep 用 qfq、exit_rules 用 hfq，各模块内 close 与 ma5 同基比较自洽——别误判为 bug 去"对齐"（见 spec 03 §四备注）。

## 验收标准（spec §三）

- [ ] B：前端建 trailing_lock 方案→run→落库，UI 正常；exit_reason 出现 `stop`（趋势样本含 `ma5_exit`）；≥2 笔手算对得上；maxHold=10 能产 `max_hold` 出场。
- [ ] D：`factors.labels` 有 band_lock 行，gross/exit_reason/hold_days 合理，≥1 行手算对得上。
- [ ] E：band_lock 各 max_hold 配置产出凯利结果且数值合理。
- [ ] （尽力）限停板顺延/锁定路径在真实数据上被触发并核对；难构造则记录"靠单测覆盖、真机未触发"。
- [ ] 全程无 500/异常/前端崩；发现 bug 则**落源头交接或修**（systematic-debugging）。

## 硬约束 / 规范

- 改后端代码必**重启后端进程**（dev 无 watch）再验，否则撞旧码假象。
- 浏览器任务先读 `browser-driving` skill（含强制复盘协议）+ `kimi-webbridge`（工具机制）。
- 所有源文件 UTF-8；查 DB/写脚本对象键名英文（PowerShell GBK 坑）。
- 进硬断言/硬编码/SQL join 键的事实**落源头亲验**，不采信本文转述（CLAUDE.md / data-integrity 规范）。
- 终端 PowerShell，禁 `&&` 连接，用 `;` 或多行。

## 待续 / 已知边界

- 三处接入边界（非 bug，知悉即可）：exit_rules band_lock 仅 labels-job 可触发、未接 prepare/train；kelly band_lock 默认不在扫描族；详见记忆 `project_trailing_lock_exit`。
- 本次 e2e 若全过：在 `project_trailing_lock_exit` 记忆里把"真机 e2e 未做"更新为已验；本交接完成后**删除或移入 `prompts/archive/`**。
- 若验出 bug：按 systematic-debugging 定位，小修直接改 + 补单测；大改回 spec 评估。
