# 01 · 概述与决策记录

## 模板信号详解（`template/analysis_code.py`）

`comprehensive_bottom_analysis` 逐根 K 线判定"底部放天量涨停"：

```text
price_change_pct = close.pct_change()*100          # 日涨幅（原始价）
is_limit_up      = price_change_pct >= up_limit     # 板块阈值：688/.SH→19.5；300/301/.SZ→19.5；else 9.5

# 底部（三选一 OR）
is_bottom_120 = (close - low_120) / (high_120-low_120 + 1e-10) < 0.25   # low/high_120 = rolling(120,min120).min/max
is_bottom_60  = (close - low_60)  / (high_60 -low_60  + 1e-10) < 0.20
is_below_ma   = close < ma_60 * 0.90                                    # ma_60 = rolling(60,min60).mean
is_bottom     = is_bottom_120 OR is_bottom_60 OR is_below_ma

# 天量（二选一 OR）
is_heavy_vol  = volume/(avg_vol_60+1) > 2.0  OR  volume/(avg_vol_120+1) > 2.0   # avg_vol_N = rolling(N,minN).mean

signal = is_bottom AND is_heavy_vol AND is_limit_up
```

`calculate_next_day_performance`：信号日 T 的次日 T+1 **开盘买、当日收盘卖**，
`profit_pct = (close-open)/open`。整段还有 `if len(df) < 130: return None` 的整股门控。

## 核心矛盾

| 模板要的 | 现有条件系统 | 结论 |
|---|---|---|
| 前向收益（T+1开盘买/持有N日收盘卖） | `simulator` 正是此口径，`fixed_n=1` 等价模板 | ✅ 白送 |
| OR 组合（底部三选一、天量二选一） | DSL 硬编码 `AND`（`strategy-conditions/strategy-conditions.query-builder.ts:223`） | ✗ |
| 120/60 日滚动区间最高最低、量/N日均量 | 库里只有 `ma*` 均线、Tushare `volume_ratio`（口径不同） | ✗ |
| 板块自适应涨停阈值 | 单条件只能填一个固定数 | ✗ |

→ 收益统计是白送的，**难点全在"怎么把这个复合信号喂进去"**。

## 5 轮决策记录（brainstorming 结论）

| # | 问题 | 用户选择 | 含义 |
|---|------|---------|------|
| 1 | 做到哪个程度 | **忠实复刻这一个就好** | 专用、最小、不通用化 DSL |
| 2 | 底部窗口用哪种价 | **前复权 qfq** | 滚动 high/low/ma 用 qfq；涨停仍用原始 `pct_chg`、量用原始 `vol` |
| 3 | 前端入口形态 | **拆解为若干指标** | 不要黑箱按钮，要可见可复用的指标 |
| 4 | 拆解粒度 / 指标住哪 | **不用考虑 OR，我新建几个 test 就行** | 拆成原子指标；OR/板块由用户多建 test 覆盖 |
| 5 | 指标怎么算出来 | **预计算落库成列** | 新建派生表 + 回填 + 增量维护（接受 qfq 脏维护成本） |

## 选定方案

把模板拆出来的、现有字段拼不出的部分，做成 **5 个预计算原子指标字段**，落进新派生表
`signal_rolling_indicator`，注册进 `ASHARE_FIELD_COL_MAP` 与前端字段下拉。用户在现有创建表单里
用这些字段 + 已有 `pct_chg`，**自建若干纯 AND 的 test**，用"多建几个 test + 选标的池/阈值"覆盖
模板的 OR 与板块差异。

```text
raw.daily_quote(qfq列) ─窗口SQL─▶ signal_rolling_indicator
                                       │ LEFT JOIN (别名 d)
                                       ▼
            enumerator / 实时扫描器  ─DSL(已有,AND)─▶  用户的几个 AND test
                                       ▼
            simulateSignalsBatched → 胜率/盈亏比/直方图/逐笔   (整条不变)
```

5 个新字段（详细公式见 `./02-data-model-and-sql.md`）：
`pos_120`、`pos_60`、`close_ma60_ratio`、`vol_ratio_60`、`vol_ratio_120`。
涨停由已有 `pct_chg` 字段承担（用户填 9.5 / 19.5）。

## 交付物边界（再次明确）

- **交付**：表 + 回填 + 增量维护（含 qfq 脏重算）+ 后端字段映射 + 两处 FROM join + 前端字段下拉 + 测试。
- **不交付**：test 方案行、OR 组合实现、板块 CASE 逻辑、新 builtin 信号类型、`signal_test` 表结构变更。

## 忠实度偏差（必须知情，三条）

1. **样本会比模板少**：模板次日无脑按开盘价买入；信号前向统计的 `simulator` 会剔除"次日一字涨停买不进"
   （`strategy-conditions/signal-stats/signal-stats.simulator.ts:138-145`，reason=`limit_up`）。涨停信号次日高开很常见，这个差异最实，但更贴实盘。
2. **`len<130` 整股门控 → 逐项 min_periods 近似**：我们按每个滚动字段自己的窗口长度（60/120）逐行门控
   （不满则 NULL）。差异仅在个股上市 60~130 bar 的窗口，影响极小。
3. **板块/ST/北交所**：本设计**不内置**板块阈值；由用户建 test 时选 `pct_chg` 阈值 + 标的池处理。
   （模板自身也误判 ST 5% / 北交所 30%，落进 9.5/19.5 分支。）

此外（口径差异，非偏差）：底部窗口用 **qfq**（用户选定），与模板的原始价在"窗口内有除权除息"的个股上有细微出入；
但更合理、且与收益口径（qfq）一致。`fixed_n=1` 的单日收益 `qfq_close/qfq_open-1` 与模板 `(close-open)/open`
在同一交易日内**完全相等**（日内无除权），故收益口径与模板一致。

---
*硬事实核对（2026-06-09，路径相对 `apps/server/src/`）：
`strategy-conditions/strategy-conditions.query-builder.ts:223` AND 拼接、
`strategy-conditions/signal-stats/signal-stats.simulator.ts:138-145` 一字涨停过滤、
模板逻辑 `template/analysis_code.py:10-79`。*
