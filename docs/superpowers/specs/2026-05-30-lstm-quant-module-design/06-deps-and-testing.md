# 06 · 依赖与测试

[← 返回 index](./index.md)

本文定义 torch 依赖引入、本会话安装验证、单测矩阵与行数合规。

## 1. PyTorch 依赖

`apps/quant-pipeline/pyproject.toml` 的 `dependencies` 追加：

```toml
# ---- LSTM（次日方向三分类，序列模型）----
"torch>=2.2",
```

约束与注意：

```text
· CPU 版即可（无需 CUDA）；CI / 本环境装 CPU wheel。
· torch CPU wheel 体积较大（~200MB）；安装慢属正常，非失败。
· requires-python = ">=3.11"，torch>=2.2 支持 3.11，兼容。
· 延迟 import：lstm_model / sequence_builder / lstm_predictor 内部 import torch，
  不在 worker 包顶层 import（与现有 lightgbm「延迟 import 避免 worker 启动强依赖」
  同模式，见 inference/runner.py L178-179 注释）。
```

## 2. 本会话安装验证（用户决策）

用户选择"加依赖并尝试本会话安装验证"。落地时执行：

```text
1. 在 apps/quant-pipeline 安装 torch（pip/uv install torch，或 pip install -e .）
2. 跑新增单测（见 §3）+ LSTM 冒烟训练（合成小数据，1-2 epoch）
3. 若环境网络策略不允许装 torch / 装不上：
   → 立即如实告知用户（不假装跑通），代码与依赖声明照常提交，
     训练验证留待用户本地（有 GPU/完整环境）执行。
   → 禁止伪造"测试通过"（CLAUDE.md / verification-before-completion）
```

## 3. 单测矩阵

新增 `apps/quant-pipeline/tests/unit/`：

```text
test_direction_3class_labels.py
  · dir3_band：r>ε→2 / |r|≤ε→1 / r<−ε→0 边界值精确
  · dir3_tercile：每日截面三分位切分、并列稳定、类近似均衡
  · 次日收益用后复权口径；每票末行（无 t+1）被丢弃
  · 区间过滤后空 → warning + 0（不 raise）；区间内无报价 → RuntimeError

test_sequence_builder.py
  · 完整 L 窗才出样本；不足 L → 丢弃
  · 绝不跨 ts_code 串窗（构造两票交错日期，断言窗口纯净）
  · 连续性按交易日序号（停牌不算断裂）
  · NaN 样本丢弃 + warn 计数
  · feature_cols 顺序稳定

test_lstm_walk_forward_embargo.py
  · embargo_eff = max(embargo_days, lookback+1)
  · 构造边界：验证样本输入窗 + 标签绝不与训练区 trade_date 重叠

test_lstm_model_smoke.py
  · 合成 (B,L,N) + 三类标签，train_one_fold 跑 2 epoch，
    断言 loss 有限、输出 logits 形状 (B,3)、可保存/加载 state_dict
  · 类别权重逆频率计算正确

test_train_e2e_validate_lstm.py
  · _validate_params 放行 model='lstm' + scheme='dir3_band'/'dir3_tercile'
  · 仍拒绝未知 model / 未知 scheme

test_lstm_predictor.py（可 mock DB）
  · meta.algorithm=='lstm' 分派到 lstm_predictor；老模型无该字段→走 lgb
  · score = P(涨)−P(跌) 计算正确
  · 窗口不足的票 → score=NaN + missing warn
```

前端单测（vitest，`apps/web`）：

```text
buildParams.spec.ts（扩展现有）
  · model='lstm' 时 hyperparams 仅含用户填写项（null 跳过）
  · model 非 lstm 时不带 hyperparams
  · dir3_* label_scheme 正确透传
pickDefined.spec.ts
  · null/undefined 过滤、保留 0 与 false（0 是合法超参值，勿误删）
```

## 4. 行数合规

```text
后端 Python：无单文件行数 CI，但遵循 CLAUDE.md「单文件 ≤500 行」：
  lstm_walk_forward.py 预估最重 → 若 > 500，把"逐 fold 循环 + oos 聚合"
  抽到 lstm_metrics.py（分类指标计算）独立文件。
前端：pnpm --filter @cryptotrading/web lint:quant-lines（CI 强制 ≤500）
  新增/改动文件预估见 05 §6，均 < 500。
```

## 5. 落地验证命令清单

```text
# Python
cd apps/quant-pipeline
pip install -e .            # 装 torch 等依赖
pytest tests/unit/ -ra      # 新增单测 + 回归

# 前端
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web test
pnpm --filter @cryptotrading/web lint:quant-lines

# 后端（确认未破坏构建）
pnpm --filter @cryptotrading/server build
```

> 验证纪律（CLAUDE.md verification-before-completion）：任何"测试通过 / 跑通"
> 结论必须**先运行命令、贴出输出**再下；torch 装不上则如实说明，不伪造结论。

## 6. 数据覆盖注意

LSTM 上线初期，样本区间起始段历史不足 L 天的票偏多 → 推理 missing（NaN score）
计数偏高（见 [03-inference.md#行数校验兼容](./03-inference.md#5-行数校验兼容)）。这是数据覆盖问题，
非 bug；监控/验收阈值需知悉，建议训练/推理区间起点至少留 L 个交易日缓冲。

下一篇：[07-tasks-parallelization.md](./07-tasks-parallelization.md)
