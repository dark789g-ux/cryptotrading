# 任务切分与验证

> 入口见 [index.md](./index.md)。本文档给出 A1/A2 文件域不相交证明、并行派发切分、
> 分支命名与全量验证命令。

## 文件域不相交证明（并行安全前提）

```text
A1 拥有                                  A2 拥有
─────────────────────────────────       ─────────────────────────────────────
training/forward_returns.py     (新)     labels/dir3_scheme.py            (新)
training/lstm_walk_forward.py            labels/direction_3class.py
training/lstm_metrics.py                 labels/runner.py
tests/unit/test_forward_returns.py (新)  worker/train_e2e_runner.py
tests/unit/test_lstm_metrics*.py         web/.../TrainE2EFields.vue
tests/unit/test_lstm_walk_forward_*.py   web/.../buildParams.ts
                                         tests/unit/test_dir3_scheme.py  (新)
                                         tests/unit/test_direction_3class_labels.py
                                         web/.../__tests__/buildParamsLstm.spec.ts

只读共享（不修改）：
  A1 → import labels/_common.apply_hfq           （只读复用 hfq，不改 _common）
  A1 → 可能 import labels/runner._compute_end_padded 思路（不改 runner；如需则自实现尾缓冲）

交集：∅（无任一文件被双方修改）
```

> **关键**：A1 对 `_common.py` 与 `runner.py` 仅**只读 import**，不修改。若实现中发现
> 必须改 `_common.py`（如 `apply_hfq` 不满足需求），**先回到本 spec 重新协调**，不要擅自
> 让 A1 改入 A2 的 `runner.py` 邻域文件——会破坏并行安全。

## 并行派发切分（dispatching-parallel-agents）

两个独立 agent，各自分支，无共享状态、无顺序依赖：

```text
Agent-A1  →  分支 claude/lstm-real-ic-<id>
             实现 01-a1-real-ic-rankic.md 全部内容 + 自测

Agent-A2  →  分支 claude/dir3-eps-<id>
             实现 02-a2-dir3-eps-configurable.md 全部内容 + 自测
```

- **派发时禁用 worktree 隔离**（brainstorming skill 硬性规定）：直接在主工作目录改文件，
  文件域不相交从源头避免互相覆盖。
- 各 agent 完成后按 `verification-before-completion` 贴真实命令输出再下结论。
- 当前 brainstorming 会话已在分支 `claude/prompts-brainstorming-XpeGU`（存放本 spec）；
  实现分支由各 agent 另起，不混入 spec 分支。

## 通用约束（两 agent 必守）

- 先读仓库根 `CLAUDE.md`：禁静默吞错、外部空数据双路径 warn、时间列 timestamptz、UTF-8、
  单文件 ≤500 行、A 股 `trade_date` 是 YYYYMMDD 字符串禁直接 `new Date`。
- 新分支开发，禁推 main。
- Python 测试用仓库内 venv：`apps/quant-pipeline/.venv/bin/python -m pytest ...`
  （已装 numpy/pandas/torch/pytest）。
- 取数若需连真实 DB，单测一律用 monkeypatch / 桩，不依赖在线 DB。

## A1 验证

```bash
cd apps/quant-pipeline
./.venv/bin/python -m pytest tests/unit/test_forward_returns.py \
    tests/unit/test_lstm_metrics*.py \
    tests/unit/test_lstm_walk_forward_embargo.py -q
./.venv/bin/python -m pytest tests/unit/ -q   # 不破坏既有
```

> **既有基线失败**：tests/unit 已有约 19 个与本任务无关的既有失败（factor golden 漂移 /
> `test_predict_one_day` session=None / 连不上真实 DB）。对比改动**前后**失败集合，
> 确认没有**新增**失败即可，不要把既有失败算到本任务头上。

A1 新增单测至少覆盖：真实收益正确 join、NaN 样本剔除 + warn、IC/RankIC 数值与已知输入吻合、
`_run_folds` 行序对齐。

## A2 验证

```bash
cd apps/quant-pipeline
./.venv/bin/python -m pytest tests/unit/test_dir3_scheme.py \
    tests/unit/test_direction_3class_labels.py \
    tests/unit/test_features_builder.py -q   # 含 feature_set_id 回归
./.venv/bin/python -m pytest tests/unit/ -q   # 既有 19 个无关失败同上说明
```

前端（A2 动了前端）：

```bash
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web lint:quant-lines
pnpm --filter @cryptotrading/web test
```

A2 单测覆盖：编解码器往返 + legacy 别名 `canonical(0.005)=='dir3_band'` + off-grid 量化、
feature_set_id 随 ε 变化而变且 legacy hash 不漂移、各 ε 边界分桶正确、`_validate_params`
ε 校验、前端 buildParams 含 eps。

## 完成标准（Definition of Done）

| 项 | A1 | A2 |
|----|----|----|
| 新增单测全绿 | ✓ | ✓ |
| `pytest tests/unit/` 无**新增**失败 | ✓ | ✓ |
| 前端 type-check + lint + test | — | ✓ |
| 退化代理注释已删/改写 | ✓ | — |
| legacy feature_set_id 回归断言 | — | ✓ |
| 真实命令输出已贴（verification-before-completion） | ✓ | ✓ |
| 单文件 ≤500 行 | ✓ | ✓ |
