# Agent 交接提示词 · LSTM 量化模块 A 类技术债

本目录存放给**新会话 agent**接手的自包含提示词。每个文件可直接整段贴给一个新 agent，
无需本会话上下文。

## 背景（所有提示词共享）

`cryptotrading` 量化模块已在 PR #3 合入 main：新增了 PyTorch 序列 LSTM 算法，
做**次日方向三分类（涨/横盘/跌）**，全链路 E2E（前端 → NestJS → Python 训练 →
walk-forward → 推理写 scores_daily → 前端展示）。

设计 spec（务必先读）：`docs/superpowers/specs/2026-05-30-lstm-quant-module-design/`
（入口 `index.md`，8 个子文档）。

LSTM 相关核心文件：
```
apps/quant-pipeline/src/quant_pipeline/
├─ labels/direction_3class.py        三分类标签 dir3_band/dir3_tercile
├─ labels/runner.py                  compute_labels 放行 dir3_*
├─ training/sequence_builder.py      feature_matrix 宽表→(L×N)序列
├─ training/lstm_model.py            DirectionLSTM + train_one_fold
├─ training/lstm_walk_forward.py     walk-forward 编排 + 产物 + oos_metrics
├─ training/lstm_metrics.py          分类指标 + 排序兼容指标(IC/RankIC)
├─ training/runner.py                model=='lstm' 分派
├─ inference/lstm_predictor.py       推理：读 L 天窗口前向 → score=P涨−P跌
└─ worker/train_e2e_runner.py        白名单 _ALLOWED_MODELS/_ALLOWED_SCHEMES
apps/web/src/components/quant/        前端下拉/超参/分类指标展示
```

## 本目录提示词清单

| 文件 | 任务 | 工作量 | 价值 |
|------|------|--------|------|
| [A1-real-ic-rankic.md](./A1-real-ic-rankic.md) | 真实 IC/RankIC（消除类别序数退化代理） | 中 | 高 |
| [A2-dir3-band-eps-configurable.md](./A2-dir3-band-eps-configurable.md) | `dir3_band` 横盘阈值 ε 可配 | 小 | 中 |

建议先做 A1（真实债，影响指标可信度），再做 A2。两者文件域基本独立，也可并行。

## 通用约束（所有 agent 必读）

- 先读仓库根 `CLAUDE.md`（核心规范 + 硬约束），尤其：禁静默吞错、外部空数据双路径 warn、
  时间列 timestamptz、UTF-8、单文件 ≤500 行、A 股 trade_date 是 YYYYMMDD 字符串禁直接 `new Date`。
- **新建分支开发**，禁止直接推 main。分支命名如 `claude/lstm-real-ic-xxxx` / `claude/dir3-eps-xxxx`。
- 涉及创意性改动（改数据流/契约）先走 `brainstorming` skill 出设计再实现。
- Python 测试用仓库内 venv：`apps/quant-pipeline/.venv/bin/python -m pytest tests/unit/ -q`
  （已装 numpy/pandas/torch/pytest）。改完必跑相关单测 + 不破坏既有。
- 完成后按 `verification-before-completion`：贴真实命令输出再下"通过"结论。
