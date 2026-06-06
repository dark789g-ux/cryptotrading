# 重算治理：窗口无关化修复后生产存量标签的口径对齐重算

> 设计文档（runbook spec）· 2026-06-06 · 分支 `feat/quant-strategy-management`
> 形态：目录 + index 入口（原 spec 超 300 行，按子主题拆分）

## 背景与目标（摘要）

窗口依赖修复（commit `6779c79` + `172e5f4`）改变了 `factors.labels` 的计算口径。现有生产标签（strategy-aware 4.28M 行 / fwd_ret_h1 2.53M 行）是**旧码**算的、与**新码不一致**。

本任务**不改代码**（代码已对、已验证 210001 行 INCR==FULL），是一次 **数据治理 / 口径对齐** 运维操作：

1. **先量化差异** —— 别盲算 ~680 万行（可能大半 0 差异）；
2. 到 **决策门** 把真实差异规模摆给用户、逐 scheme 决定是否重算；
3. 批准后用 **月度分块、内存安全** 的方式 DELETE + 整段等价重算 labels；
4. 级联重建 `feature_matrix`、评估是否重训依赖模型；
5. 验证。

## 已确定的关键约束（本次会话拍板）

| 维度 | 决定 |
|---|---|
| 范围/深度 | **单 spec 含决策门**：一份 runbook 覆盖全链路，执行时先探查、到门口停下由用户拍板，不强制一次跑完 |
| 目标环境 | **仅本地 `crypto-postgres`**（既是 dev 也是当前工作库，alembic 已 head，无独立 prod 需同步）|
| 安全姿态 | **直接原地 DELETE + 重算，不备份**；临时 scheme 量化探查是唯一安全网 |
| 重算路径 | 方案 C **月度增量 + 实测校准 chunk**；两 scheme 串行；跑前腾内存；重算期不并发 prepare/train |
| 内存硬约束 | 本机 16G、仅剩 ~3.3G 空闲 → 排除单次整段(B)/逐年(A)，必须细粒度分块 |

## 子文档清单（建议阅读顺序）

1. [01-context-and-state.md](./01-context-and-state.md) — 任务背景、口径变更 bug1-4、真 DB 现状、代码契约、模型注册表、硬约束
2. [02-pipeline-and-gate.md](./02-pipeline-and-gate.md) — 总体流水线、决策门判据、两条硬不变量
3. [03-measure-and-calibrate.md](./03-measure-and-calibrate.md) — 阶段1 量化探查 + chunk RSS 校准（安全网核心）
4. [04-recompute-and-cascade.md](./04-recompute-and-cascade.md) — 阶段2/3/4 labels 重算 + feature_matrix 重建 + 模型评估
5. [05-validation-and-rollback.md](./05-validation-and-rollback.md) — 阶段0 前置条件、阶段5 验证标准、错误处理/回滚

## 跨文档引用约定

- 统一相对路径 + 锚点，例：`./04-recompute-and-cascade.md#阶段2labels-重算`。
- bug 编号（bug1-4）全局一致，定义见 [01#口径变更bug1-4](./01-context-and-state.md#口径变更bug1-4)。
- 阶段编号（阶段0-5）全局一致，总览见 [02#总体流水线](./02-pipeline-and-gate.md#总体流水线)。

## 前序与关联

- 前序任务 `prompts/fix-labels-incremental-window-invariance.md`（已完成）：修 bug1-4，commit `6779c79` / `172e5f4`。
- 本任务源自 `prompts/recompute-production-labels-after-window-fix.md`。
- 关联记忆：`project_labels_features_incremental_prepare`。
- 正确性比对脚本：`apps/quant-pipeline/tests/integration/verify_incremental_correctness.py`（diff 逻辑复用源）。
