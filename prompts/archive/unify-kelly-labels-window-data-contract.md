# 统一 kelly 与 labels/signal-stats 的出场模拟历史窗口数据契约

> 本文自包含，可整段贴给全新会话接手。**偏架构债，建议先 brainstorm 评估 ROI 再实施，非 cheap fix。**

## 一句话目标
统一三方出场模拟的"buy_date 前历史 K 线窗口"数据契约，消除"kelly(ForwardPath) 不带 T+1 前历史、labels/signal-stats 带"的分歧——它是未来加**窗口型**出场规则（需回看建仓前 N 根 K 线）的隐雷。

## 现状摸底（file:line 为证）
三方出场模拟各有数据层、左扩口径不同：
- **kelly**：`apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/paths.py` `load_forward_paths()`——`ForwardPath.bars`（`types.py:86` 起）从 buy_date **之后**起、**不含 T+1 前历史**，buy_bar=T+1。2026-06-13 D7 为 phase_lock 补了 `ForwardPath.recent_lows_window`（types.py）+ 加载参数 `recent_lows_window:int`（paths.py，左扩 `(W-1)+SUSPEND_BUFFER`）+ parquet JSON 列 + cache 版本 v3→v4——但这是**专为 phase_lock 打的补丁**。
- **labels**：`apps/quant-pipeline/src/quant_pipeline/labels/runner.py` 用 `head_rows_per_code` 左扩每股 start 前在场行（供 MA5/recent_lows，phase_lock 取 `max(MA_WINDOW, lookback)`）。
- **signal-stats**：`apps/server/src/strategy-conditions/signal-stats/signal-stats.simulator.db.ts` `attachMa5` + 左扩 `max(5, lookback)` + `collectRecentLows`。

后果：D4 初版 phase_lock 在 kelly 里 `lookback` **失效**（recent_lows 恒单元素），靠 D7 单独补 `recent_lows_window` 才修。**若再来一个需要"T+1 前 K 线"的窗口型出场规则，kelly 又会默认拿不到、又得单独打补丁**。详见 memory `project_phase_lock_exit`（kelly ForwardPath 盲点段）。

## 已定方向（需先 brainstorm 敲定）
- 让 `ForwardPath`（或其加载契约）默认携带**可配的"buy_date 前 N 根非停牌历史"**（low/OHLC/ma5），由出场规则**声明**所需回看窗口（如 `required_lookback`），path loader 据各族并集**左扩一次**——三方共用同一"窗口声明 → 左扩"契约。

### 开放问题
1. 收敛到什么抽象？（出场规则统一声明 `required_lookback`？三方如何共享该声明？）
2. **是否现在做（YAGNI）**：目前只 phase_lock 需要；第 2 个窗口型规则出现时再做可能更划算——先评估 ROI。
3. 改 `ForwardPath` 结构会动 parquet 缓存 schema（paths.py 序列化）：须 bump cache 版本 + 纳入 cache_key（参 D7 v3→v4 做法）。

## 硬约束 / 项目规范
- 改 ForwardPath/缓存 schema **必须 bump cache 语义版本 + 纳入 cache_key**（参 D7：`_make_cache_key` + schema 版本双失效）；
- **不得破坏现有 band_lock/fixed_n/tp_sl/trailing/atr_stop 零回归**（默认窗口=现状，即 W=1/不带前历史时逐字不变）；
- 源文件 UTF-8，文件 I/O 显式 encoding；改后重启 server/worker。

## 验证标准
1. 任一窗口型出场规则在三方（kelly/labels/signal-stats）行为一致（同输入同结果）；
2. 既有全部出场族零回归（`tests/unit/test_kelly_*`、`test_*band_lock*`、`test_phase_lock_*`、signal-stats jest 全绿）；
3. 缓存新旧 schema 正确失效、无串味。

## 前序进度 / 待续
全新任务，未动手。2026-06-13 phase_lock D4→D7 修复 kelly lookback 退化时暴露此分歧（D7 是 phase_lock 专属补丁，本任务是把它一般化）。**先 brainstorm 评估是否值得现在做。**
