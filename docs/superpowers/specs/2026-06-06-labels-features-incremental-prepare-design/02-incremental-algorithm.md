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
  if force_recompute:
      subranges = [(start, end)]           # 退回现有"整段重算覆盖"行为
  else:
      subranges = gap_subranges(labels, scheme, [start,end])
  skipped = trading_days − ∪subranges      # 已物化、跳过的
  for (g0, g1) in subranges:
      end_padded = trade_cal 中 g1 之后第 30 个交易日   # 沿用 _compute_end_padded
      quotes = _load_daily_quotes(g0, end_padded)        # 头部从 g0, 不前扩
      rows   = compute_*_labels(quotes, end=g1, ...)     # 算到 g1
      _upsert_labels(rows ∩ [g0,g1])                     # 只写 [g0,g1], padding 区不写
  log: skipped_dates=len(skipped), computed_subranges=subranges  # 禁止静默截断
  return 写入行数
```

### 「只需尾部 padding、无头部 padding」的论证（源码坐实，非假设）

缺口子区间 `[g0,g1]` 从 `g0` 起加载行情即可，**起点不用往前扩**，因为 labels 计算对"`g0` 之前的历史"无依赖：

- **entries**：`entries = quotes.loc[(trade_date>=start)&(<=end), [ts_code,trade_date]]`（`labels/runner.py:328-331`）——纯行切片，无 rolling/shift/跨日。
- **buy_date**：`buy_date = next_day(signal_date)`（`strategy_aware.py:379`），只需窗口内交易日历顺序。
- **simulate_exit 的 MA5**：`sub = prices[prices["trade_date"] >= str(buy_date)]`（`exit_rules.py:321`）**先切到入场日**，`out["ma5"] = out["close"].rolling(5, min_periods=5).mean()`（`exit_rules.py:238`）在切片后才算。即 MA5 本就只用 `buy_date` 及之后价格、`buy_date` 后前 4 日 MA5=NaN 是**既定语义**，整段算与缺口算对同一 `buy_date` 逐值一致。
- **fwd_ret**：`g["close_adj"].shift(-horizon)`（`fallback.py:113-144`），纯未来。

→ 头部依赖不存在。**尾部** padding 仍必须（`end_padded` = `g1` 后第 30 交易日 > `MAX_HOLD_DAYS(20)` + T+1 + 余量），让 `g1` 附近入场日能看到未来价格判出场/算收益（约束 2）。

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
对任意 `trade_date t` 的 label/feature 行，其值只依赖 `[t, t+窗口]`（labels）或当日截面（features），与"加载区间的起点"无关。故缺口子区间 `[g0,g1]+尾部padding` 覆盖了 `[g0,g1]` 每行所需窗口 → 增量结果 == 整段重算结果。验证方法见 [06-testing-verification.md](./06-testing-verification.md#正确性逐行比对约束-1)。
