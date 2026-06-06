# 02 · 增量物化算法（正确性红线）

本文是整套设计的正确性核心。所有改动必须满足原 prompt 的硬约束：增量结果与"全范围整段重算"**逐行逐值一致**（约束 1）、缺口边界 label 不算错（约束 2）、不绕过 PIT（约束 3）、完整物化口径不取"有一行就算物化"的最弱标准（约束 4）、不破坏 773 单测基线（约束 5）。

## 共用基础：覆盖区间 / 缺口查询

判定路线 = 决策 2（A 实时查结果表，不建登记表）。两类物化共用同一套"查已物化 → 算缺口子区间"逻辑，落在新模块 `quant_pipeline/labels_features_incremental.py`（或各 runner 内复用函数）。

```text
输入: 表+键 (labels:scheme / feature_matrix:feature_set_id), date_range=[start,end], trade_cal
步骤:
  1. trading_days = trade_cal 中 [start,end] 内 is_open=1 的交易日(升序)
  2. materialized  = SELECT DISTINCT trade_date
                     FROM <表> WHERE <键>=:k AND trade_date BETWEEN :start AND :end
                     (走索引 ix_..._scheme_date / ix_..._set_date)
  3. gap_days      = trading_days − materialized          (有序集合差)
  4. gap_subranges = 把 gap_days 按"交易日相邻"切成连续子区间 [(g0,g1), ...]
                     相邻判定: 在 trading_days 序列里位置连续即同一段
输出: gap_subranges
```

**覆盖区间 `R_F`（供训练校验/前端 disable）** 用同一查询的另一种聚合：对 `feature_matrix[fs]` 取 `DISTINCT trade_date`，按相邻交易日切成连续段列表 `[(s1,e1),(s2,e2),...]`。空洞 = 段与段之间的间隙。

> 注：`materialized` 用 `DISTINCT trade_date`，基数 = 交易日数（几年也就几百上千），即便每天数千标的也只回几百行，配现成索引足够快——这是决策 2 选 A 而非登记表的依据。

## labels 增量缺口算法

```text
compute_labels(scheme, date_range, ..., force_recompute=False):
  ma_win   = strategy_aware exit 规则里 ma_break 的 period (fwd_ret / 无 ma_break → None)
  head_pad = (ma_win - 1) 交易日 if ma_win else 0       # MA 滚动窗口需要的头部
  if force_recompute:
      subranges = [(start, end)]           # 退回现有"整段重算覆盖"行为
  else:
      subranges = gap_subranges(labels, scheme, [start,end])
  skipped = trading_days − ∪subranges      # 已物化、跳过的
  for (g0, g1) in subranges:
      g0_load    = max(start, g0 之前第 head_pad 个交易日)  # 头部 padding, 不早于 start
      end_padded = g1 之后第 30 个交易日                     # 尾部 padding(_compute_end_padded)
      quotes  = _load_daily_quotes(g0_load, end_padded)
      entries = quotes ∩ [g0,g1]                            # 入场信号仍只取缺口内
      rows    = compute_*_labels(quotes, entries, end=g1, ...)
      _upsert_labels(rows ∩ [g0,g1])                        # 头尾 padding 区都不写
  log: skipped_dates=len(skipped), computed_subranges=subranges  # 禁止静默截断
  return 写入行数
```

### padding 判定：尾部=持有窗口，头部=MA 窗口（源码坐实，非假设）

> ⚠️ 修订记录：早期草稿误判 labels "无头部 padding"，依据是误读 `simulate_exit` 为"先切 buy_date 再算 MA"。真实顺序相反（见下），strategy_aware scheme **必须头部 padding**，否则缺口边界 `exit_reason/hold_days/value` 与整段算不一致 → 违反约束 1。由 spec self-review 独立审阅抓出、亲读源码裁决。

**尾部 padding（fwd_ret 与 strategy_aware 两类 scheme 都要）**：
`end_padded` = `g1` 后第 30 交易日 > `MAX_HOLD_DAYS(20)` + T+1 + 余量（`_compute_end_padded`），让 `g1` 附近入场日能看到未来价格判出场/算收益（约束 2）。

**头部 padding（仅 strategy_aware scheme 要）**：
`strategy/exit_rules.py` 的 `simulate_exit`（`:459`，带可配 `ma_window` 参数，默认 `MA_WINDOW=5`、由 `build_exit_rules` 回传）真实顺序是 **先对整个 prices_df 算滚动 MA（`_ensure_ma(prices, ma_window)`，`:501`；`_ensure_ma` 逐窗独立求和 `Σ close[t−j]/w`，等价 `min_periods=window` 的 NaN 边界、但窗口无关 bit-stable，见下表 bug4），再切 `sub = prices[trade_date >= buy_date]`（`:504`）**。故 MA(t) 在"prices_df 起点后 `ma_window−1` 个交易日内"为 NaN，`MABreakRule` 在 MA=NaN 时不触发出场（`:121`）。

→ 整段算（prices_df 从 `date_range.start` 加载）的语义是 **MA(t) 非 NaN ⟺ t ≥ start + (ma_window−1) 交易日**。增量要逐行复现，缺口加载起点必须：

```text
g0_load = max(date_range.start, g0 − (ma_window−1) 交易日)
```

- `ma_window` = 该 scheme `exit_rules` 里 `ma_break` 的 `period`（可配 [2,250]，`exit_rules.py:43-47,383-391`）；无 `ma_break` 规则则 MA 全 NaN、`head_pad=0`。
- **不早于 `start`**：否则 `g0=start` 时增量 MA 比整段更准、反而不一致（整段算在 start 附近本就 NaN）。
- 头部 padding 区 `[g0_load, g0−1]` 只供算 MA，不产生 entries、不写库。
- 其余出场规则（StopLoss/MaxHold/TakeProfit/TrailingStop）基于 entry_price / 持仓期峰值，**无头部 lookback**（`exit_rules.py:9-13` 规则清单）。

**fwd_ret scheme 无头部依赖**：不经 simulate_exit，`fwd_ret = groupby+shift(-horizon)`（`fallback.py:113-144`）纯未来 → `head_pad=0`。
**entries / buy_date 无头部依赖**：`entries`=quotes 切片（`labels/runner.py:328-331`）、`buy_date=next_day(signal_date)`（`strategy_aware.py:379`），都无跨日。

> 实施核实点：从 job 的 strategy_aware 配置（`base_params.exit_rules`）取 `ma_break.period` 作 `ma_window`；确认 `build_exit_rules` 返回的 `ma_window` 即该值（`exit_rules.py:383-391`）。

### PIT（约束 3）
`_load_listing_info`（`labels/runner.py:186-212`）按 `a_share_symbols` 的 `list_date/delist_date` 过滤，逐缺口子区间照常调用，不绕过。

## features 增量缺口算法

```text
build_feature_matrix(factor_version V, label_scheme S, date_range, ..., force_recompute=False):
  fs = resolve_feature_set_id(...)          # 哈希不含 date_range, 同配置同 fs
  if force_recompute:
      subranges = [(start, end)]
  else:
      subranges = gap_subranges(feature_matrix, fs, [start,end])
  # ★ 缺口 ⊆ labels 覆盖校验 (决策点)
  labels_cov = 覆盖段(labels, S, [start,end])
  for (g0,g1) in subranges:
      missing = [g0,g1] 内交易日 − labels_cov
      if missing 非空:
          logger.warn("features 缺口缺 labels, 跳过这些天", apiName="features_missing_labels",
                      scheme=S, dates=missing)        # 不静默
          这些天不计入本次物化
      算 [g0,g1]∩labels_cov:                          # 零 padding
          factors = _load_daily_factors(V, g0, g1)     # factors.daily_factors 读现成因子
          labels  = _load_labels(S, g0, g1)
          mat = build_feature_matrix_from_frames(factors ⋈ labels, 截面中性化/zscore/winsorize)
          _upsert_feature_matrix(mat)                  # PK (trade_date,ts_code,feature_set_id)
  log: skipped_dates, computed_subranges
  return fs
```

### 「零 padding」的论证（源码坐实）
- 因子从 `factors.daily_factors` **读现成**（`features/runner.py:71,95`），features 阶段不现算因子，无跨日。
- 中性化/z-score/winsorize 全是当日截面：`_grouped_zscore` `df.groupby(group_keys)`（`builder.py:228`），`group_keys` ∈ {`["trade_date","industry_l1"]`(`:334`)、`level="trade_date"`(`:298,321,355`)、`"trade_date"`(`:414,426`)}。**无 `groupby('ts_code')` 跨日时序**。
- `merge_with_labels` 按 `(trade_date,ts_code)` inner join（`builder.py:602`），无时序。

→ 缺口子区间头尾都不用 padding，直接算。

### features 缺口 ⊆ labels 的处理
正常流程下 prepare 串联**先备 labels 再备 features**，`R_F ⊆ R_labels` 天然成立，不触发跳过。仅当**单独**跑 `features` run_type 且 labels 没备到位时触发 warn 跳过——这正是 inner join 会丢行的天，标记跳过而非误判已物化（呼应约束 4）。

## force_recompute 语义
- `force_recompute=True`：跳过"查已物化/算缺口"，对整段 `[start,end]` 重算并覆盖写（= 现有行为，等价基线）。
- 用途：捕捉"某历史日标的集合事后变动（补 daily_quote / 新上市修正）"——这种情况下"行存在性"口径会误判已物化跳过，须显式 force。
- 入口：prepare/labels/features job 的 `params.force_recompute`（默认 `false`），前端备料 modal 给勾选框。

## 完整物化口径（正面回应约束 4）
- 判定"`trade_date t` 已物化" = `labels[scheme]` / `feature_matrix[fs]` 在 `t` 有 ≥1 行（`DISTINCT trade_date` 命中）。
- **显式声明边界**：这是"行存在性"口径，**不自动识别**当日标的集合事后变动；那种情况旧行仍在、会被判已物化跳过。**不假装能自动检测**（避开"残缺却判完整"陷阱），改由 `force_recompute` 显式兜底。
- 不取"至少一行非空"这类最弱约束做"整段完整"判断——本设计是**逐 trade_date** 判定缺口，不是"整段有任意一行就算整段完整"。

## 与现有行为的等价性（约束 1 验证锚点）
对任意 `trade_date t`：features 值只依赖当日截面（与加载起点无关）；labels 值依赖 `[t−(ma_window−1), t+尾部窗口]`（MA 回看 + 未来持有/收益）。缺口加载 `[g0_load, end_padded]`（`g0_load` 含头部 MA padding、且不早于 `start` 以复现整段算在 start 附近的 NaN 边界）覆盖了 `[g0,g1]` 每行所需窗口 → 增量结果 == 整段重算结果。验证方法见 [06-testing-verification.md](./06-testing-verification.md#正确性逐行比对约束-1)。

### ⚠️ 补漏：「窗口依赖」是等价性的第二类前提（早期证明遗漏，实测纠正）
> 上面的"加载窗口覆盖所需日期范围"只是**必要**条件，不充分。即便加载窗口覆盖了 `t` 所需的全部日期，只要某项计算的**结果依赖加载窗口的起点/长度本身**（而非仅依赖窗口内的值），增量 chunk（窗口 `[g0_load, end_padded]`）与整段重算（窗口 `[start, ...]`）就会分歧。真机逐行比对（`verify_incremental_correctness.py`）暴露了 4 处此类病，已全部窗口无关化修复：

| # | 窗口依赖项 | 机制 | 修法（窗口无关化） |
|---|-----------|------|------------------|
| **1** | `_compute_end_padded` / `_compute_g0_load` 查 `raw.trade_cal` | 漏 `exchange='SSE'` → 每日历日多交易所行被 `LIMIT n` 截走一半 → 头/尾 padding 减半 | 查询补 `exchange='SSE'`（A 股交易日历标准口径）|
| **2** | `_load_stk_limit(g0_load, g1)` 只到 `g1` | signal=`g1` 的 buy_date=next_day(`g1`)>`g1`；涨停过滤看 buy_date 当天 stk_limit，增量没加载到 → 漏剔涨停入场 | 改 `_load_stk_limit(g0_load, end_padded)`（与 quotes/suspend 同口径，覆盖所有 buy_date）|
| **3** | `filter_new_listing` 用加载窗口的局部交易日算"上市后第N交易日" | 次新股 list_date 早于 chunk 起点 → 不在局部日历 → `list_idx=NaN` → 漏剔（整段从更早起则正确剔）| 改用**全局 SSE 交易日历**（`_load_trade_calendar`）计数，注入 `LabelInputs.trade_calendar` / `FallbackInputs.trade_calendar`，与加载窗口无关；strategy_aware 与 fwd 两路径同治 |
| **4** | `_ensure_ma` 用 `rolling().mean()` | pandas rolling 均值滑动累加（running sum 加新减旧），MA(t) 浮点末位依赖序列**起点**到 t 的累加路径 → 同位置可差 1 ULP，close≈ma 时翻转 `MABreakRule` 严格 `close<ma` | 改逐窗独立求和 `Σ_{j=0}^{w-1} close[t−j] / w`（向量化 shift 错位相加，顺序固定、只依赖窗口内 w 个值、保留 `min_periods=window` 的 NaN 边界）|

**窗口无关原则（沉淀为硬约束）**：任何"逐 signal_date 的计算"都不得依赖加载窗口 `[g0_load, end_padded]` 的起点/长度，只能依赖窗口内的**值**。已知三类窗口依赖陷阱：①滚动统计的浮点累加路径（MA/任何 rolling）②按"日历位置"计数的逻辑（new_listing 上市后第N交易日 → 必须全局日历）③外部数据加载范围不足（stk_limit 须覆盖到 buy_date 的最大值 end_padded）。

> **生产标签语义变更提示**：bug3/bug4 修复使现有 `strategy-aware` 与 `fwd_ret` 历史标签更正确但与旧值不同（new_listing 更严格、close≈ma 边界点出场判定可能不同）。差异需 `force_recompute` 重算才纠正——属独立运维步骤，不在增量物化代码修复范围内。
