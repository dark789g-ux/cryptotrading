# labels 子系统 Code Review 修复 — 设计 spec

> 创建日期：2026-05-22
> 评审来源：`docs/review_results/03-labels.md`（16 条）
> 评审对象：`apps/quant-pipeline/src/quant_pipeline/labels/` + `strategy/exit_rules.py`

## 背景与目标

`docs/review_results/03-labels.md` 对 labels 标签子系统做了代码评审，列出 16 条问题
（4 条 🔴 严重、6 条 🟡 中等、6 条 🟢 建议）。本 spec 把全部 16 条转化为一份可执行
的修复设计。

经调研与用户拍板，对评审结论做了两处调整，**与评审原文不同，实现时以本 spec 为准**：

- **评审第 2 条降级**：Tushare `daily` 接口官方文档明确「停牌期间不提供数据」，故
  `raw.daily_quote` 对停牌日根本没有行，停牌日被 `simulate_exit` 自然跳过、`hold_days`
  只计交易日 —— 这恰好符合规范。评审所述「收益污染」不成立。本条**降级为文档级修复**。
- **评审第 3 条采纳「切真 T+1 入场」**：用户决定本次就把信号日/入场日分离，对齐
  doc/04 §4.2.3，而非仅加注释。

核心目标：

1. 消除标签收益率被分红/拆股污染的确凿正确性 bug（复权缺失）。
2. 把「信号日 = 入场日」的 M2 简化升级为真正的 T+1 入场。
3. 修掉 `simulate_exit` 的退市/数据缓冲/强平价边界缺陷。
4. 把「空数据 `return 0` 伪装成功」改为按 CLAUDE.md 硬约束抛错。
5. 性能向量化 + 清理死代码/魔数/重复，新建 `labels/_common.py`。

## 16 条处置总表

| # | 评审条目 | 严重度 | 处置 | 子文档 |
|---|---|---|---|---|
| 1 | 复权缺失 | 🔴 | `_load_daily_quotes` JOIN `raw.adj_factor`，`apply_hfq` 算 `close_adj/low_adj`，raw 与复权价并存 | [01](./01-common-and-adjustment.md) |
| 2 | 停牌 `suspend_dates` | 🔴→🟢 | **降级**：仅修文档（Tushare daily 停牌无行，挂起本就自然生效） | [03](./03-exit-rules-fixes.md#item-2) |
| 3 | 入场日错位 | 🔴 | **切真 T+1 入场**，`trade_date` 写信号日 | [02](./02-entry-t1-and-schemes.md) |
| 4 | fallback 成本口径 | 🔴 | **保留毛收益**，仅文档声明两 scheme 口径差异 | [02](./02-entry-t1-and-schemes.md#item-4) |
| 5 | `end_padded` 缓冲不足 | 🟡 | 改按交易日历取 `end` 后第 30 个交易日；截断时 `logger.warning` | [03](./03-exit-rules-fixes.md#item-5) |
| 6 | `derive_*`/fallback 主循环逐行 | 🟡 | 向量化 | [04](./04-data-integrity-perf-cleanup.md#item-6) |
| 7 | `filter_new_listing` `apply(axis=1)` | 🟡 | 向量化 | [04](./04-data-integrity-perf-cleanup.md#item-7) |
| 8 | 退市 force_close 双重判定 | 🟡 | 删 `strategy_aware.py:429` 兜底调用 + 删 `apply_delisting_force_close` 函数 | [03](./03-exit-rules-fixes.md#item-8) |
| 9 | force_close NaN close 兜底缺陷 | 🟡 | 新增 `_last_valid_close` 回溯最近有效 close | [03](./03-exit-rules-fixes.md#item-9) |
| 10 | 空数据静默 `return 0` | 🟡 | quotes/labels 空改 `raise`；`_load_stk_limit` 空补 `logger.warning` | [04](./04-data-integrity-perf-cleanup.md#item-10) |
| 11 | 日期字符串比较前提 | 🟢 | 加注释说明依赖 YYYYMMDD 定宽 | [04](./04-data-integrity-perf-cleanup.md#item-11) |
| 12 | 接口契约文档不符 | 🟢 | `exit_rules.py:22-23` 删除不存在的 `suspend_dates` | [03](./03-exit-rules-fixes.md#item-2) |
| 13 | 未使用 import | 🟢 | 删 `strategy_aware.py:42/44`、`exit_rules.py:29` | [04](./04-data-integrity-perf-cleanup.md#item-13) |
| 14 | `winsorize_label_value` 死代码 | 🟢 | ⚠️ 评审前提有误：该函数被 `features/builder.py` 使用，**非死代码**。保留函数，仅修正 docstring | [04](./04-data-integrity-perf-cleanup.md#item-14) |
| 15 | 进度回调魔数 | 🟢 | 集中到 `_common.py` 的 `PROGRESS_*` 常量 | [04](./04-data-integrity-perf-cleanup.md#item-15) |
| 16 | fallback/strategy_aware 重复 | 🟢 | 新建 `labels/_common.py` 收拢 `_empty()`/dedup/`derive_*` | [01](./01-common-and-adjustment.md#common-module) |

## 子文档清单与阅读顺序

按以下顺序阅读 / 实施（后者依赖前者建立的接口契约）：

1. [`01-common-and-adjustment.md`](./01-common-and-adjustment.md) — 新建 `labels/_common.py`
   与复权数据链路（评审第 1、16 条）。**基础层，必须先做** —— 它定义了 `daily_quotes`
   DataFrame 的新列契约（`close` + `close_adj` 并存）。
2. [`02-entry-t1-and-schemes.md`](./02-entry-t1-and-schemes.md) — T+1 入场改造与两 scheme
   口径文档（评审第 3、4 条）。
3. [`03-exit-rules-fixes.md`](./03-exit-rules-fixes.md) — `exit_rules.py` / `simulate_exit`
   的停牌文档、缓冲、退市、强平价修复（评审第 2、5、8、9、12 条）。
4. [`04-data-integrity-perf-cleanup.md`](./04-data-integrity-perf-cleanup.md) — 空数据硬
   约束、性能向量化、清理项（评审第 6、7、10、11、13、14、15 条）。

## 跨文档引用约定

- 文档间引用一律用相对路径 + 锚点，例：`./01-common-and-adjustment.md#apply_hfq`。
- 锚点用 GitHub 风格小写连字符；本 spec 给关键小节显式标 `<a id="...">` 以稳定锚点。
- 代码位置引用一律 `文件路径:行号`，行号以评审时快照为准，实现时以实际为准。

## 实施顺序（阶段化，非并行）

```text
阶段 A  labels/_common.py 新建        ── 定义 apply_hfq / empty_labels_frame /
        （01）                            dedup_labels / derive_* / PROGRESS_*
                  │
                  ▼
阶段 B  runner.py 改造                ── _load_daily_quotes JOIN adj_factor +
        （01/02/03/04）                   end_padded 交易日历 + 空数据 raise +
                                          import _common
                  │
                  ▼
阶段 C  strategy_aware.py 改造         ── T+1 入场 + 复权消费 + 向量化 +
        （01/02/04）                      删死代码 + import _common
                  │
                  ▼
阶段 D  fallback.py 改造               ── 复权消费 + 主循环向量化 + 口径文档 +
        （01/02/04）                      import _common
                  │
                  ▼
阶段 E  exit_rules.py 改造             ── _last_valid_close + 契约文档（与 C/D 无
        （03）                            文件冲突，可与 C/D 并行）
                  │
                  ▼
阶段 F  alembic migration              ── factors.labels COMMENT ON COLUMN
        （02）
```

> ⚠️ **本 spec 不适合多 agent 并行**：复权改动引入的 `daily_quotes` 列契约
> （`close` + `close_adj`）横穿 `runner.py` / `strategy_aware.py` / `fallback.py`，
> 多 agent 同时改这几个文件必然冲突。阶段 A→D 是依赖链，应顺序实施；仅阶段 E
> （`exit_rules.py`）文件域独立，可与 C/D 并行。

## 上线注意事项

- **存量标签必须全量重跑**：本次 strategy-aware 切 T+1 入场，口径变了。`factors.labels`
  中所有 `scheme='strategy-aware'` 的存量行是按 T 入场算的，新旧混用会错位一天。
  合并后须对所有历史区间重跑 `labels build --scheme strategy-aware`。
  `fwd_5d_ret` 算法不变但 `close` 改为复权价 —— 同样建议重跑。
- 复权改动后，跨除权日的标签收益率会变化（这是修复目标）；勿把这种变化误判为回归。

## 测试策略总览

- 沿用 `test-driven-development` skill：每个改造点先写断言测试再改实现。
- 复权（第 1 条）：用一只已知高送转的票，断言 `close_adj` 跨除权日连续、收益率不含除权缺口。
- T+1（第 3 条）：断言 `trade_date` = 信号日、`buy_date` = 下一交易日、过滤以 `buy_date` 为准。
- 向量化（第 6、7 条）：断言向量化版与原 `iterrows`/`apply` 版输出**完全一致**。
- 空数据（第 10 条）：断言 quotes/labels 空时 `compute_labels` 抛 `RuntimeError`。

## 验收标准

1. 全部 16 条按总表处置完成。
2. `pnpm`/pytest labels 相关单测全绿，含上述新增断言测试。
3. `strategy_aware.py` 行数退回 500 行红线以下。
4. 一次端到端 `labels build` 在含除权日的真实区间上跑通，抽查标签收益率合理。
