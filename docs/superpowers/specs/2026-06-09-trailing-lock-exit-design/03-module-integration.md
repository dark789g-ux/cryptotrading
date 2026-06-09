# 03 · 三模块集成

> 规则见 [01](./01-rule-semantics.md)，核接口见 [02](./02-shared-core-and-contracts.md)。本文给三模块**具体改动点**。
> 任务按**互不相交的文件域**切分，便于并行实现（[04 §分批提交](./04-testing-and-rollout.md#四分批提交建议)）。

## 一、signal-stats（NestJS）

### 1.1 数据层（已亲验 `raw.daily_quote` / `raw.stk_limit` 列，2026-06-09）

`apps/server/src/strategy-conditions/signal-stats/signal-stats.simulator.db.ts`：

- `fetchQuotes`（现 `:207` 仅取 `qfq_open, qfq_close, open`）→ **增取** `qfq_high, qfq_low, high, low, close`。
  （daily_quote 同行已有 raw `open/high/low/close` 与 `qfq_open/qfq_high/qfq_low/qfq_close`，无需多查。）
- `fetchLimits`（现 `:226` 仅取 `up_limit`）→ **增取** `down_limit`。
- **窗口左扩 ≥4 个交易日**：现 `unionWindow = sseCalendar.slice(minBuyIdx)`（`:131`）从 buy_date 起；
  MA5 需 T-3..T+1，且 `signal_high = qfq_high(T)` 需信号日 T 的行 → 预取窗口须含 `signalDate` 及其前 3 交易日。
  方案：另取一段 `[T-3, buy_date)` 的 quote 用于 MA5 预热 + signal_high，**不影响**现有 buy_date 起的持有窗口语义。
- MA5：用 qfq_close 在预取序列上滚动现算（与 exit_rules `_ensure_ma` 同思路：shift 累加，窗口无关）。

### 1.2 纯函数层 `signal-stats.simulator.ts`

- `HoldingDaySnapshot`（`:60`）**扩字段**：`qfqHigh/qfqLow/rawHigh/downLimit/ma5: number|null`；
  并在 `SimulationInput` 增 `signalHigh: number`（= qfq_high(T)）。
- 新增纯函数 `decideBandLock(...)`（同构 [01](./01-rule-semantics.md) 算法）；`buildHoldingDays`（`:317`）补填新字段。
- `ExitConfig`（`:104`）扩为三态：`| { mode:'trailing_lock'; maxHold?: number }`。
- `simulateTradeCore`（`:157`）出场分派加 `trailing_lock` 分支；**入场过滤（停牌/一字涨停/次新）保持不变**复用。
- `SimulatedTrade.exitReason`（`:33`）联合类型扩 `'stop' | 'ma5_exit'`（现 `'max_hold'|'signal'|'delist'`）。
  出场价：`stop`→止损成交价、`ma5_exit`→adj_close、`max_hold`→adj_close（注意现有 `simulateTradeCore:168`
  固定取 `qfqClose` 作 exitPrice，trailing_lock 分支需改为用 decision 给出的 `exitPrice`）。

### 1.3 落库与配置

- `SignalTestEntity`（`exit_mode/horizon_n/exit_conditions/max_hold`）：`exit_mode` 增枚举值 `'trailing_lock'`；
  无新参数（maxHold 可复用现有 `max_hold` 列，默认空=不封顶）。**需 migration** 仅当 `exit_mode` 有 DB CHECK 约束
  （实现前 `\d signal_test` 核对；无约束则免迁移）。
- `signal_test_trade.exit_reason` 为 varchar，容纳 `stop/ma5_exit` 无需改列。

### 1.4 前端

`apps/web/src/views/strategy/SignalTestForm.vue`：出场模式 `n-radio-group`（现 `fixed_n / strategy` 两项）
**增第 3 项** `波段跟踪止损`；选中后无额外必填项（可选"最长持有天数"复用 maxHold 输入框）。
`api/modules/strategy/signalStats.ts` 同步类型。**遵守 Vue 单文件 ≤500 行**（`lint:quant-lines`）。

## 二、exit_rules.py（Python）

`apps/quant-pipeline/src/quant_pipeline/strategy/`：

### 2.1 接入共享核 + 激活跌停顺延

- 新建 `band_lock_exit.py`（[02 §1](./02-shared-core-and-contracts.md#一python-共享核-band_lock_exitpy)）。
- `exit_rules.py` 已有 `is_limit_down` 顺延骨架（`:607-611` 触发即顺延、`:671-677` `_first_sellable_idx`）但**休眠**：
  其数据层未 join stk_limit，`is_limit_down` 经 `_normalize_prices`（`:435/456-458`）默认 False。
  → **数据层须 join `raw.stk_limit` 激活**：`labels/runner.py` 取价 SQL（约 `:105-113`，二手，**实现前核实**）
  增 `LEFT JOIN raw.stk_limit` 取 `up_limit/down_limit`，并按 [01 §五](./01-rule-semantics.md#五限停板流动性)
  口径派生：`一字涨停 = raw_open≥up_limit`、`封死跌停 = raw_high≤down_limit`。
- **注意**：band_lock 自带限停板顺延（在共享核内），与 exit_rules 既有 `is_limit_down` 顺延**择一**，
  不要双重顺延。band_lock scheme 走共享核口径。

### 2.2 注册为独立 scheme

- 买入价改 **T+1 开盘**：现 `strategy_aware.py` 用 `close_adj`（约 `:509-515`，二手）作 entry；band_lock scheme
  需以 `T+1 open_adj` 喂核（仅本 scheme 改，不动其它 exit_rules）。`signal_high = high_adj(T)`。
- 通过 `dir3_scheme.py::base_scheme_codec()`（约 `:159`）生成 scheme 串；band_lock 作为一种新的 base_type
  或新策略定义（`factors.strategy_definitions`）落配置。**实现前确认**接入点：是新 `exit_rules` type，还是
  新 base scheme（band_lock 是整套有状态方案，**不是** `_RULE_BUILDERS` 里的单条 first-match 规则 →
  倾向独立 scheme 入口，绕开 `build_exit_rules`）。
- `force_close_date` / 数据末尾兜底沿用 `simulate_exit` 既有口径（`exit_rules.py:476/639-643`），
  即核返回 `no_exit` 时由 wrapper 按 `_last_valid_close` 强平、`exit_reason='force_close'`。

## 三、kelly_sweep（Python，行号二手 → 实现前核实）

`apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/`：

- `types.py`（Bar 约 `:37-58`、ForwardPath 约 `:61-90`）：
  - `Bar` 增 `ma5: float`（及限停板所需 `raw_open/raw_high/up_limit/down_limit`）。
  - `ForwardPath` 增 `signal_bar_high: float`（= 信号日 qfq_high）。
- `paths.py`（`load_forward_paths`）：构建 path 时**补查**信号日 qfq_high + 每根持有 bar 的 MA5
  （qfq_close 滚动现算，需左扩预热）+ `raw.stk_limit` 的 up/down limit + raw open/high。
- `exits.py`：新增 `simulate_band_lock_exit(path, ...)`，内部把 `path.bars` 适配成 `BandLockBar` 调共享核。
- `sweep.py`：`DEFAULT_EXIT_GRID`（约 `:99-115`）注册 `band_lock` 出场族（可带 `max_hold` 候选如 {10,20} 或不带）；
  `_exit_id()` / `_run_exit()`（约 `:277-300`）各加分支。
- 入场端"一字涨停买不进"：kelly_sweep 现以 `qfq_open(T+1)` 作 buy_price，**须补**入场 `raw_open≥up_limit` 过滤
  （该 path 不产生交易/不计入凯利样本）。实现前确认现有是否已有该过滤。

## 四、共享数据派生口径（三模块一致）

```text
一字涨停(买不进) = raw_open ≥ up_limit        # 仅入场端
封死跌停(卖不出) = raw_high ≤ down_limit       # 仅出场端
limit 缺失       = 该端约束不生效（不误杀）
MA5             = 5个"非停牌交易日"的 qfq/hfq close 滚动均值（停牌日不进窗口），左扩≥4交易日预热，不足为 None
signal_high     = 信号日(T) 的 qfq/hfq high   # 与持仓期 low 同复权基准
cost            = 持仓首日(T+1) 的 qfq/hfq open
次新过滤         = 不进 band_lock 核；由各模块上游处理（见下）
```

**次新（new_listing）过滤归属**（核函数不做，避免三模块口径分裂时背锅）：
- signal-stats：沿用现有 `simulateTradeCore`（`signal-stats.simulator.ts:146-152`，T+1 距 list_date <60 个 SSE 交易日剔除），在 `decideBandLock` **之前**完成，已亲验。
- exit_rules / kelly_sweep：沿用各自**上游 candidate / 信号生成**既有的次新口径；band_lock scheme **不额外**做次新过滤。实现前确认上游是否已含次新剔除，若三模块要求口径一致则在 candidate 层对齐（不在核内）。

> 任一进 fail-fast 断言 / SQL join 键 / 硬编码的列名、后缀、表名，落地前按
> [.claude/rules/data-integrity.md](../../../../.claude/rules/data-integrity.md) **亲查实体 / 真 DB 一条**再写，
> 不采信本文及子代理转述（kelly_sweep / runner.py 行号均二手）。
