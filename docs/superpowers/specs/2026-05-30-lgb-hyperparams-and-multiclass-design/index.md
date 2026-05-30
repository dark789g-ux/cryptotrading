# lgb 超参表单 + 特征参数暴露 + lgb-multiclass 设计 spec（index）

> 子目录入口。本 spec 内容较多，按子主题拆分为多份子文档，便于并行实现与独立审阅。

## 背景与目标（摘要）

当前量化模块创建训练任务时，超参暴露不均衡：**LSTM** 已有完整超参表单（7 项），而 **lgb-lambdarank / linear / gbdt** 几乎不暴露任何模型超参，只能靠后端默认值或 `optuna` 任务调参；特征/标签生成阶段的参数（中性化维度、稳健标准化、截尾阈值等）也全部硬编码、用户不可调；`factor_version` 还是手敲文本框。

本 spec 覆盖四件事（一次实现）：

1. **lgb 超参表单**：给 LightGBM 系模型暴露 9 个树参数旋钮，普通 `train` 与 `train_e2e` 两个入口都加。
2. **特征/标签参数暴露**：把 `neutralize_cols` / `robust_z` / `factor_clip_sigma` / `label_winsorize` / `fwd_horizon_days` / `max_hold_days` 暴露给前端（仅 E2E），并**纳入 feature_set_id 哈希**防缓存污染。
3. **factor_version 动态下拉**：新增 NestJS API 枚举可用版本，前端改 `n-select`。
4. **lgb-multiclass 新模型**：新增 LightGBM 三分类（跌/横盘/涨）模型，照 LSTM 范本独立训练/推理/评估，吃 dir3 标签。

### 范围边界（不做）

- 不改 `optuna` / `seed_avg` 现有调参链路。
- 不改 linear / gbdt 作为「评估基线、不落地」的现状。
- 不改 LSTM 既有行为。

## 关键设计决策（来自 brainstorming，已与用户确认）

| 决策点 | 结论 |
|--------|------|
| lgb 超参暴露范围 | 扩展全套 9 项（见 [01](./01-frontend.md#lgbhyperfields)） |
| 暴露入口 | lgb 超参：普通 train + E2E；特征/标签参数：仅 E2E |
| 特征/标签参数 | 全部暴露（含 winsorize） |
| feature_set_id 哈希 | 凡影响特征数值的新参数**必须**纳入哈希 |
| factor_version | 改为动态下拉（新增后端 API） |
| neutralize_cols UI | 三档单选（无 / 行业 / 行业+市值） |
| label_winsorize UI | `[lo, hi]` 双数字框 |
| lgb 三分类 | 本次纳入，新增独立模型类型 `lgb-multiclass` |
| UI 组织 | 折叠式「高级选项」（`n-collapse`），留空=用后端默认 |
| 校验位置 | NestJS 仅透传；严格范围校验在 Python `_validate_params`，越界报错不夹取 |

## 子文档清单与阅读顺序

| 顺序 | 文档 | 内容 |
|------|------|------|
| 1 | [01-frontend.md](./01-frontend.md) | 前端组件拆分、字段清单、折叠布局、buildParams、联动 |
| 2 | [02-backend-passthrough.md](./02-backend-passthrough.md) | factor-versions API、ValidatedParams、严格校验、特征/标签透传、feature_set_id 哈希 |
| 3 | [03-lgb-multiclass.md](./03-lgb-multiclass.md) | lgb-multiclass 训练/推理/评估路径（照 LSTM 范本） |
| 4 | [04-testing-and-rollout.md](./04-testing-and-rollout.md) | 单测、验证命令、文件改动清单、并行任务切分 |

## 跨文档引用约定

- 统一相对路径 + 锚点：`./02-backend-passthrough.md#feature-set-id-哈希`。
- 代码位置引用统一 `文件路径:行号`。
- 类型 / 接口名保持英文，避免 PowerShell GBK 裸键名问题。
- 所有源文件 UTF-8；示例 SQL 用 `docker exec` 格式。

## 现状关键事实（实现者须知）

- **最终上线模型只有一个**：walk_forward 路径里 linear / gbdt 仅为对照基线、训完即弃；真正落 artifact、用于推理的永远是用户 `model` 指定的那个（`walk_forward_runner.py:108-118,185`）。故 lgb 超参表单本质是**控制最终上线的 lambdarank booster**。
- **NestJS `params` 是任意 jsonb 透传**，`create-job.dto.ts` 无字段白名单（`validateCreateJob` 仅校验 params 为对象）。新参数无需改 NestJS DTO，校验落 Python。
- **LSTM 是三分类模型的现成范本**：独立 walk-forward 路径、吃 dir3 整数标签、`score=P(涨)−P(跌)`、分类指标（accuracy/macro_f1/per_class/confusion）+ ic/rank_ic。lgb-multiclass 全程对齐。
