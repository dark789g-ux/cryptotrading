# PIT 窗口护门设计（PIT Window Guard）

**日期**：2026-05-23
**状态**：待实施
**作者**：renmaoyuan + Claude（brainstorming 协作）

---

## 背景

`factors.factor_definitions` 表里每个因子声明 `pit_window_days`（日历日窗口）+ `pit_anchor`。runner 据此预取数据喂给因子 `compute()`。

**现状问题**：

业务上因子按"交易日"定义（如 `ma_ratio_20d` 需 20 个交易日），但 `pit_window_days` 是日历日。注释里说经验值 `N 交易日 × 1.6`，但：

1. **没有强制约束**——用户可在 UI 把 `pit_window_days` 改成任意 1-400 范围内的值
2. **运行时只查"是否拿到任何数据"**（`runner.py:174-185` 检查 `sub.empty`），不查"窗口内实际交易日数"
3. **因子内部用 `if len(close) < N: return pd.Series(dtype=float)` 静默返空**，结果不写库
4. **缺失原因不可分辨**——DB 里"窗口不足致空"与"股票停牌致空"长得一模一样

**典型踩坑场景**：用户给 `ma_ratio_20d` 设 `pit_window_days=32`，遇春节后第一周（32 个日历日里只有 ~15 个交易日），该日所有股票的该因子值都没有写入 DB，**无任何前置提示、无明确告警**，训练数据出现"洞"。

## 目标

为 PIT 窗口建立**三层防护**，让"窗口不足"成为可见、可阻断、可追溯的错误：

1. **前置阻断**：修改 `pit_window_days` 时校验 `>= min_trade_days × 2.0`，前后端共同拦截
2. **启动校验**：worker 启动时检查所有因子声明合法性 + DB ↔ Python 子类一致性
3. **运行时护门**：取数后实测窗口内交易日数，不足则告警 + 动态扩窗 × 2 重试一次

## 非目标

- 不改造现有 16 个因子的 `compute()` 业务逻辑（只补声明）
- 不引入"按交易日取数"的新机制（仍按日历日取，仅运行时校验）
- 不重写 PIT 审计框架（在现有 `quality/pit_audit.py` 上增量）

## 关键决策记录

| 决策 | 取值 | 理由 |
|---|---|---|
| 兜底系数 | `2.0` | 覆盖春节/国庆 7 天连休 + 周末叠加 |
| 声明来源 | Python 子类 `@register(min_trade_days=N)` + DB 双向校验 | 让因子作者明明白白声明，DB 漂移 fail-fast |
| 运行时不足行为 | Warn + 扩窗 ×2 重试 | 用户更在意运行时数据完整性 |
| `min_trade_days` 可编辑性 | 不可改（契约） | UI 无编辑入口，改它必须通过子类 + migration |
| 系数同步策略 | 3 处人工同步（Python / NestJS / Vue） | 比建 shared 常量简单，注释里标注 |

## 子文档清单

按以下顺序阅读：

1. [01-architecture.md](./01-architecture.md) — 总体架构 + 三层防护的数据流
2. [02-data-model.md](./02-data-model.md) — DB schema 变更 + Factor 子类声明 + registry 双向校验 + 16 因子回填表
3. [03-runtime-guard.md](./03-runtime-guard.md) — trade_cal 工具函数 + runner 改造 + SSE 推送 + 启动期校验 + 常量
4. [04-frontend-backend.md](./04-frontend-backend.md) — NestJS service 校验 + Vue FactorEditModal 实时提示
5. [05-migration-and-tests.md](./05-migration-and-tests.md) — 一次性迁移脚本 + 测试矩阵 + 文件清单

## 引用约定

跨文档引用统一用相对路径 + 锚点，如 `./02-data-model.md#21-db-schema-变更`。

## 实施顺序建议

```text
┌─ Step 1: DB migration ────────────────┐
│  20260524_factor_definitions_         │
│      min_trade_days.sql + .ps1        │
│  落地后所有现有行有 min_trade_days     │
└────────────────┬──────────────────────┘
                 ▼
┌─ Step 2: Python 元数据契约 ────────────┐
│  base.py + registry.py + constants.py │
│  16 个子类 @register 加参数            │
│  registry 启动校验 DB ↔ 子类           │
└────────────────┬──────────────────────┘
                 ▼
┌─ Step 3: runner 运行时护门 ────────────┐
│  data_access.count_trade_days...      │
│  runner.py 动态扩窗逻辑                │
│  SSE warnings_summary                  │
└────────────────┬──────────────────────┘
                 ▼
┌─ Step 4: 后端 API 校验 ────────────────┐
│  factors.service.ts update 跨字段校验  │
│  GET 接口暴露 min_trade_days           │
└────────────────┬──────────────────────┘
                 ▼
┌─ Step 5: 前端 Modal 实时提示 ──────────┐
│  FactorEditModal 加 hint + 禁用保存    │
└────────────────┬──────────────────────┘
                 ▼
┌─ Step 6: 测试 + 文档 ─────────────────┐
│  单测 + 集成测试 + 回归                │
└───────────────────────────────────────┘
```

Step 1-3 强耦合（DB / Python / runner 同发同改），Step 4-5 在 Step 1 之后即可并行。
