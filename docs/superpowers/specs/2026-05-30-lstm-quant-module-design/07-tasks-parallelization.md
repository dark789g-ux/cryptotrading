# 07 · 任务切分与并行化

[← 返回 index](./index.md)

本文按**互不相交的文件域**切分任务，供 `dispatching-parallel-agents` 派发，
从源头避免多 agent 相互覆盖（brainstorming 规范：冲突管理由 spec 负责，不依赖
worktree 物理隔离）。

## 1. 依赖关系

```text
        ┌─────────────────────────────────────────┐
        │ T0 依赖声明（pyproject.toml 加 torch）    │  先行，其它 Python 任务依赖其安装
        └───────────────────┬─────────────────────┘
                            │
   ┌────────────┬───────────┼───────────┬─────────────┐
   ▼            ▼           ▼           ▼             ▼
 ┌──────┐   ┌────────┐  ┌────────┐  ┌────────┐   ┌────────┐
 │ T1   │   │ T2     │  │ T3     │  │ T4     │   │ T5     │
 │ 标签 │   │ 序列+  │  │ 训练   │  │ 推理   │   │ 前端   │
 │ dir3 │   │ 模型   │  │ 编排   │  │ lstm   │   │ 全部   │
 └──┬───┘   └───┬────┘  └───┬────┘  └───┬────┘   └────────┘
    │           │           │           │
    └───────────┴─────┬─────┴───────────┘
                      ▼
              ┌───────────────┐
              │ T6 集成验证    │  装 torch + 全单测 + lint + e2e 冒烟
              └───────────────┘
```

T1/T2/T5 文件域完全独立，可并行。T3 依赖 T2（import lstm_model/sequence_builder），
T4 依赖 T2（复用 sequence_builder）。T5（前端）与所有 Python 任务无文件交集，可全程并行。

## 2. 任务清单（按文件域）

### T0 · 依赖（最先）
```
改 apps/quant-pipeline/pyproject.toml  +torch>=2.2
```

### T1 · 三分类标签（独立文件域）
```
新 labels/direction_3class.py          compute_dir3_labels + 两个 SCHEME 常量 + DIR3_BAND_EPS
改 labels/runner.py                    compute_labels 放行 dir3_* 分派（04 §2.2）
新 tests/unit/test_direction_3class_labels.py
依据：01 §1-2、04 §2.2、06 §3
```

### T2 · 序列构造 + LSTM 模型（独立文件域）
```
新 training/sequence_builder.py        build_sequences + SequenceBundle
新 training/lstm_model.py              DirectionLSTM + train_one_fold + DEFAULT_LSTM_HYPERPARAMS
新 tests/unit/test_sequence_builder.py
新 tests/unit/test_lstm_model_smoke.py
依据：01 §3、02 §3-4、06 §3
```

### T3 · 训练编排（依赖 T2）
```
新 training/lstm_walk_forward.py       train_lstm_model（walk-forward + oos + 产物）
（可选）training/lstm_metrics.py        若 lstm_walk_forward >500 行则抽分类指标
改 training/runner.py                  第261行分派 model=='lstm'（02 §2）
改 worker/train_e2e_runner.py          _ALLOWED_MODELS/_ALLOWED_SCHEMES（04 §2.1）
新 tests/unit/test_lstm_walk_forward_embargo.py
新 tests/unit/test_train_e2e_validate_lstm.py
依据：02 §2/5、04 §2.1、06 §3
```

### T4 · 推理（依赖 T2）
```
新 inference/lstm_predictor.py         predict_one_day_lstm
改 inference/runner.py                 meta.algorithm 分派（03 §2）
新 tests/unit/test_lstm_predictor.py
依据：03 全文、06 §3
```

### T5 · 前端（独立，与 Python 零交集，可全程并行）
```
改 components/quant/train-modal/TrainE2EFields.vue   下拉+类型+联动+lstm 子表单入口
新 components/quant/train-modal/LstmHyperFields.vue  LSTM 超参子表单
改 components/quant/train-modal/buildParams.ts       类型+hyperparams 装配+pickDefined
改 components/quant/QuantTrainTriggerModal.vue        trainModelOptions+LSTM
新 components/quant/run-detail/ClassMetricsPanel.vue  混淆矩阵+accuracy/F1
改 views/quant/QuantRunDetailView.vue                 按 task 分支渲染
改 components/quant/run-detail/FoldMetricsTable.vue   字段映射+accuracy/macro_f1
扩 tests：buildParams.spec.ts / pickDefined.spec.ts
依据：05 全文、06 §3
```

### T6 · 集成验证（全部完成后，最后）
```
装 torch（本会话尝试，06 §2）
pytest tests/unit/ -ra
pnpm --filter @cryptotrading/web type-check / test / lint:quant-lines
pnpm --filter @cryptotrading/server build
（条件允许）e2e 冒烟：合成小数据跑 train_e2e(model=lstm) 链路
依据：06 §5
```

## 3. 冲突边界确认

```text
T1 仅碰 labels/         T2 仅碰 training/{sequence_builder,lstm_model}
T3 碰 training/{runner,lstm_walk_forward} + worker/train_e2e_runner
T4 仅碰 inference/        T5 仅碰 apps/web/

唯一共享文件风险：T3 改 training/runner.py，T2 不碰 runner.py → 无交集。
training/__init__.py 若需导出新符号 → 由 T3 统一收口（T2 只加文件不改 __init__）。
labels/__init__.py 同理由 T1 收口。
```

## 4. 落地顺序建议

```text
并行波次 1：T0 → 完成后 T1 / T2 / T5 三路并行
并行波次 2：T2 完成后 T3 / T4 并行
收尾：T6 集成验证（串行，需全部就绪）
```

[← 返回 index](./index.md)
