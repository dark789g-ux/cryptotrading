# LSTM 量化模块 A 类技术债设计 · 入口

> 本目录是 `prompts/` 下 A1、A2 两项技术债经 brainstorming 后的成型设计 spec。
> 实现前请按「阅读顺序」通读，再按各子文档的「文件域 / 验证」开工。

## 背景与目标摘要

`cryptotrading` 量化模块已在 PR #3 合入 LSTM 次日方向三分类（涨/横盘/跌）全链路。
本 spec 处理两项相互独立的 A 类技术债：

- **A1 · 真实 IC/RankIC**：当前 `oos_metrics.ic / rank_ic` 用类别序数 `{0,1,2}` 当收益的
  **退化代理**（`lstm_walk_forward.py:200-202`），不反映真实收益相关性。目标：改用
  **真实次日后复权收益** `r = close_adj(t+1)/close_adj(t)-1`（与 dir3 标签同源口径），
  仅修排序兼容指标，**不动**分类主指标（accuracy/macro_f1/混淆矩阵）。

- **A2 · `dir3_band` 横盘阈值 ε 可配**：当前 ε 固定常量 `DIR3_BAND_EPS=0.005`。目标：
  让用户**训练前在前端配置 ε**，且**不破坏 `feature_set_id` 决定性哈希**。采用
  「**方案①+ 动态编码**」：ε 规范化后编进 `label_scheme` 字符串（照旧作为现有哈希输入），
  **零改动** `build_feature_set_id` 签名。

两任务**文件域完全不相交**，可用 `dispatching-parallel-agents` 并行实现。

## 决策记录（brainstorming 已拍板）

| 决策点 | 选定 | 理由 |
|--------|------|------|
| 范围 | A1 + A2 都做 | 两者独立、可并行 |
| A1 方案 | 方案1 最小侵入 | 新增 `load_forward_returns` helper，仅供 oos 指标，不动 schema/哈希 |
| A2 方案 | 方案①+ 动态编码 | 前端数字输入框 + 后端 ε→scheme 串编码，决定性天然成立、零哈希签名改动 |
| A2 ε 档位 | 设计时再议 → 改为**连续网格** | 方案①+ 不再需要枚举档位；ε 落 0.1% 网格、范围 `0<ε≤0.1` |
| NestJS DTO | **无需改** | `params` 为不透明 `Record<string,unknown>` 透传，校验在 Python + 前端 |

## 子文档清单

| 文档 | 内容 | 主要文件域 |
|------|------|-----------|
| [01-a1-real-ic-rankic.md](./01-a1-real-ic-rankic.md) | A1 真实次日收益设计：数据流 / helper 契约 / NaN 处理 / 测试 | `training/forward_returns.py`(新)、`lstm_walk_forward.py`、`lstm_metrics.py` |
| [02-a2-dir3-eps-configurable.md](./02-a2-dir3-eps-configurable.md) | A2 ε 编解码器 / 白名单家族化 / 前端 / 回归约束 | `labels/dir3_scheme.py`(新)、`direction_3class.py`、`labels/runner.py`、`train_e2e_runner.py`、前端 |
| [03-partition-and-validation.md](./03-partition-and-validation.md) | 文件域不相交证明 / 并行派发切分 / 分支命名 / 全量验证命令 | 跨任务协调 |

## 建议阅读顺序

1. 本 `index.md`（背景 + 决策）
2. `01-a1-real-ic-rankic.md`（理解 A1 数据流改动）
3. `02-a2-dir3-eps-configurable.md`（理解 A2 编解码与回归约束）
4. `03-partition-and-validation.md`（开工前确认文件域切分与验证命令）

## 跨文档引用约定

- 文档间引用统一用相对路径 + 锚点，例如 [`./02-a2-dir3-eps-configurable.md#回归约束`](./02-a2-dir3-eps-configurable.md#回归约束)。
- 代码位置统一写 `相对仓库根路径:行号`，行号以**实现时实际文件**为准（本 spec 行号为撰写时快照，可能随改动漂移）。
- 所有源文件 UTF-8；单文件 ≤500 行；禁静默吞错；外部空数据双路径 `logger.warn`（CLAUDE.md 硬约束）。
