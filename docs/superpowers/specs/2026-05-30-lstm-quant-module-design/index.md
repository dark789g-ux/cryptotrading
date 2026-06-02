# LSTM 算法接入量化模块 · 设计 Spec（入口）

> 日期：2026-05-30　分支：`claude/lstm-quantization-module-cnkoZ`
> 状态：设计已与用户确认，待 spec 审阅

## 背景与目标

量化模块（`modules/quant` + `apps/quant-pipeline`）当前唯一生产级算法是
LightGBM LambdaRank（截面排序）。架构是**算法无关**的：`run_type='train'`，
具体算法由 `params.model` 字符串路由。本 spec 设计在此基础上**新增一个真·时序
的序列窗口 LSTM 算法**，做**次日方向三分类（涨 / 横盘 / 跌）**，覆盖
前端 → NestJS → Python 训练 → walk-forward 评估 → 推理写 scores_daily →
前端结果展示的**全链路 E2E**。

### 已确认的设计决策（与用户逐项敲定）

| 决策点 | 选择 |
|--------|------|
| 建模范式 | 序列窗口 LSTM（真·时序），每只股票过去 L 天因子序列 |
| 数据来源 | **建在现有 `factors.feature_matrix` 之上**，不重建特征管线 |
| 预测目标 | **次日方向三分类** {跌=0, 横盘=1, 涨=2}，CrossEntropy |
| 「横盘」划定 | 两种可配（label_scheme 切换）：`dir3_band`（固定阈值带 ε）/ `dir3_tercile`（截面三分位） |
| 排序兼容 | 下游 score = P(涨) − P(跌)，写 scores_daily，保选股/IC 语义 |
| ML 框架 | **PyTorch（CPU）**，本会话尝试安装并验证 |
| 交付范围 | **全链路 E2E**（训练 + walk-forward + 推理 + 前端） |
| SHAP | 首版跳过（`shap_uri` 留空，前端已优雅处理 null） |

### 核心洞察（决定工作量的关键）

现有 `factors.feature_matrix` 已是 `(trade_date, ts_code, 各因子列, label)` 宽表，
且**已做行业中性化 + 按日 z-score**（恰是 NN 训练想要的归一化输入）。LSTM 序列
**直接在该宽表上"按 ts_code 沿时间堆叠"**构造，无需重做特征工程。下游
`model_runs` / `scores_daily` / 评估指标 / 前端展示因此**几乎零改动**——
LSTM 只产出"每只股票每天一个排序分"，与 LambdaRank 对齐。

## 全局架构

```text
前端 QuantTrainTriggerModal（mode=e2e）
  model=lstm + label_scheme=dir3_band/tercile + LSTM 超参
        │ POST /api/quant/jobs  run_type=train_e2e
        ▼
NestJS create-job.dto 校验（仅 run_type 白名单；params.model/scheme 不校验，无需改）
        │  → INSERT ml.jobs(pending) → Python worker 拾取
        ▼
worker.train_e2e_runner.run_train_e2e（校验白名单放开）
  ├─ step labels   : compute_dir3_labels → factors.labels.value=类别(0/1/2)
  ├─ step features : build_feature_matrix（label 承载类别）→ feature_set_id
  └─ step train    : train_model(model='lstm')
                        └─ runner.py 分派 → lstm_walk_forward
                              ├─ sequence_builder：宽表→(L×N)序列
                              ├─ lstm_model：nn.LSTM→Linear(3)→CrossEntropy
                              └─ 逐 fold OOS → oos_metrics(分类+排序)
                        产物 model.pt + meta.json → ml.model_runs
        │  infer job（或同链路后续）
        ▼
inference.runner（lstm 分支）：加载 .pt 重建序列前向 → score=P涨−P跌 → ml.scores_daily
        │
        ▼
前端 Run 详情：ClassMetricsPanel（混淆矩阵+accuracy/F1）/ Overview/Scores 复用排序分
```

## 子文档清单与阅读顺序

按以下顺序阅读：

1. [01-data-and-labels.md](./01-data-and-labels.md) — 三分类标签方案、`factors.labels` 落地、`feature_set_id` 决定性、序列构造契约
2. [02-python-training.md](./02-python-training.md) — `lstm_model.py` / `sequence_builder.py` / `lstm_walk_forward.py` / `runner.py` 分派、产物、oos_metrics、泄漏防护
3. [03-inference.md](./03-inference.md) — 推理 lstm 分支、score 定义、写 scores_daily
4. [04-backend-validation.md](./04-backend-validation.md) — 三处白名单同步（NestJS DTO / e2e validate / labels runner）
5. [05-frontend.md](./05-frontend.md) — 前端下拉、LSTM 超参子表单、buildParams、分类指标展示组件、≤500 行守则
6. [06-deps-and-testing.md](./06-deps-and-testing.md) — torch 依赖、本会话安装验证、单测矩阵、行数合规
7. [07-tasks-parallelization.md](./07-tasks-parallelization.md) — 按互不相交文件域切分的并行任务清单

## 跨文档引用约定

统一用相对路径 + 锚点，例如 `./01-data-and-labels.md#feature_set_id-决定性`。
所有"白名单三处同步"散落点在 [04-backend-validation.md](./04-backend-validation.md) 集中收口，其它文档引用之。
