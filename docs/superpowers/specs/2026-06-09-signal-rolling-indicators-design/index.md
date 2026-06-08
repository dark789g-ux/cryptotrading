# 信号前向统计：复刻"底部放天量涨停" — 设计总入口

> 状态：设计已与用户敲定（5 轮 brainstorming 决策见 `01`），待 spec 审阅 → 实现。
> 日期：2026-06-09　域：`strategy-conditions/signal-stats` + `market-data` 派生指标

## 背景与目标（摘要）

用户提供了一个外部指标脚本 `template/analysis_code.py`（"底部放天量涨停 → 次日开盘买、当日收盘卖"），
希望在既有的**信号前向统计**模块里复刻它，跑出前向胜率 / 盈亏比。

模板信号是三块**与**起来，其中两块内部是**或**：

```text
signal = 涨停 AND 底部 AND 天量
  涨停 = 涨幅 ≥ 板块阈值（主板9.5% / 创业·科创19.5%）
  底部 = 120日区间底部25%  OR  60日区间底部20%  OR  收盘<MA60×0.9
  天量 = 量/60日均量>2     OR  量/120日均量>2
```

**核心矛盾**：前向收益管线（T+1 开盘买、持有 N 日收盘卖）完全够用，模板的"次日开盘买当日收盘卖"
正好是 `fixed_n=1`；但**买入信号那一半现有条件 DSL 表达不了**——DSL 只有 AND 没有 OR、无滚动窗口字段、
单条件只能填一个固定阈值。

**选定方案（用户拍板）**：不动 DSL、不搞 OR、不做黑箱。把模板拆成 **5 个预计算原子指标字段**落库，
注册进条件系统；**OR 与板块由用户"多建几个纯 AND 的 test"覆盖**。详见 `01`。

**交付物边界**：
- 本设计交付：5 个指标字段 + 落库表 `signal_rolling_indicator` + 全量回填 + 增量维护（含 qfq 脏重算）+
  注册进后端字段映射与前端字段下拉。
- **不**交付：具体的 test 方案、OR 组合、板块判断逻辑——这些由用户在现有创建表单里自建。

## 子文档清单

| 文档 | 内容 |
|------|------|
| [01-overview-and-decisions.md](./01-overview-and-decisions.md) | 模板信号详解、核心矛盾、5 轮决策记录、交付边界、忠实度偏差 |
| [02-data-model-and-sql.md](./02-data-model-and-sql.md) | 表 schema、5 指标窗口公式与 min_periods 门控、全量回填 SQL |
| [03-maintenance-and-integration.md](./03-maintenance-and-integration.md) | 增量维护挂载点、qfq 脏对齐、4 处集成编辑点（file:line）、migration+ps1 |
| [04-usage-and-testing.md](./04-usage-and-testing.md) | 用户建 test 指南（6 个 AND 分支）、真机平价测试、单测、rollout 顺序 |

## 建议阅读顺序

`index` → `01`（为什么这么做）→ `02`（算什么、怎么落库）→ `03`（怎么接进系统、怎么维护）→ `04`（怎么用、怎么验）。

## 引用约定

跨文档引用统一用相对路径 + 锚点，例如 `./02-data-model-and-sql.md#回填-sql`。
所有"硬事实"（表名 / 列名 / file:line）均已落源头核对（2026-06-09，见各文档脚注）。
