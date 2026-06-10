# 0AMV 分阶段最优策略研究 + 自动化 · 设计总入口

> 日期：2026-06-10 ｜ 状态：spec（两阶段，一份 spec）
> 前序交接：`prompts/explore-best-strategy-per-0amv-regime.md`（本 spec 吸收其全部内容后归档）

## 背景与目标摘要

搬砖系列全周期单参数已到天花板（04L2 无择时 kelly +0.007 打平；05C 柱>0 择时 0.1095
但强 regime 依赖）。本项目把大盘 0AMV 指数按 MACD 四象限切成阶段（regime），
**逐象限开放搜索各自的最优 A 股入场/出场策略**（含空仓结论），并在研究收口后
落地**每日 regime 识别 + 自动选股清单**的产品功能。

关键预验（已完成，见 01 文档）：四象限 × 按年分解显示 Q3（反弹筑底）是唯一跨年
稳健的象限（5 年 4 正、唯一亏年仅 -0.031）；Q1 的全期 +0.085 几乎全靠 2025 一年；
Q2/Q4 无 edge。分阶段的价值已被数据证明，同时过拟合风险也被数据点名——因此
研究协议以"双保险"验证纪律为骨架。

两阶段结构：

```text
Phase 1 研究（宽锚点真机 run × 离线 SQL 切片 × 双保险验证）
  ──产出──▶ regime_strategy_config v1（机器可读的象限→策略配置 + 证据链）
Phase 2 自动化（每日识别象限 → 按 active 配置扫描 → 候选股清单展示）
```

自动化部分采用**配置驱动**设计：schema 现在定死，研究产出填值，spec 内无 TBD。

## 子文档清单

| 文档 | 内容 |
|---|---|
| [01-background-and-findings.md](./01-background-and-findings.md) | 背景演进、四象限×按年实测数据、基础设施现状、已锁定的六项决策 |
| [02-research-protocol.md](./02-research-protocol.md) | Phase 1：入场族锚点设计、出场配置、离线搜索协议、双保险验证、真机收口对账、SQL 模板 |
| [03-automation-design.md](./03-automation-design.md) | Phase 2：regime_strategy_config schema、每日流水线、API、前端、数据模型与 migration |
| [04-verification-and-risks.md](./04-verification-and-risks.md) | 测试矩阵、实现前必查核查点、硬约束承袭、交付物达标线、实施顺序建议 |

## 建议阅读顺序

1. `01` 先看数据与已锁定决策（理解"为什么是这个设计"）；
2. `02` 研究协议（Phase 1 主体，实施量最大）；
3. `03` 自动化设计（Phase 2，依赖 02 的产出契约）；
4. `04` 验证、风险与实施顺序（开工前最后一遍清单）。

## 跨文档引用约定

统一使用相对路径 + 锚点，例如 `./02-research-protocol.md#双保险验证协议`。
代码引用使用 `file:line` 格式（行号以 2026-06-10 本地 main 为准，实施时复核）。
