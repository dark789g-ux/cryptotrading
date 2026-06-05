# labels/features 增量物化 + 备料/训练解耦 设计

> 状态：设计已与用户逐段对齐，待审阅。
> 日期：2026-06-06　主轴：把"生产料（备料）"与"消费料（训练）"彻底解耦，备料增量累积、训练只在已备料的交集里挑时段。

## 背景与目标

### 问题（已落源码/真 DB 核实）
`compute_labels` 与 `build_feature_matrix` 都是「按整段 `date_range` 算 → upsert 覆盖写」，**没有任何"哪些 trade_date 已物化、跳过它们"的逻辑**。扩日期范围时重叠区间被纯冗余重算（labels ~25min、features ~62min）。2026-06-05 端到端验证时，`20230101:20241231` 那次把已物化的 2024 整段重算覆盖了一遍。

### 用户诉求（比原 prompt 更高层）
不止"别重算"，而是一层**架构解耦**：
1. **备料阶段**：labels/features 变成可独立触发、增量累积的资产；增量物化（算缺口、跳过已物化）是这层的底座。
2. **训练阶段**：训练时段只能落在已物化的 `labels ∩ features` 交集里，训练**不再现算料**。

### 关键洞察（简化了"交集"语义）
`factors.feature_matrix` = features **inner join** labels（join 不上整行丢弃，`builder.py:602`/`merge_with_labels`）。所以 **某 feature_set 的 feature_matrix 覆盖区间天然 ⊆ labels 覆盖区间**；"labels∩features 交集"在实现层 = **`feature_matrix[feature_set_id]` 的覆盖区间 `R_F`** 这一个东西。训练只需认 `R_F`，labels 单独物化的意义是当 features 的上游输入。

## 已定决策（用户逐项拍板）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 范围 | labels + features 一起，全栈（python+server+web），真解耦，一份大 spec（目录形态） |
| 2 | 增量判定路线 | **A：实时查结果表** `DISTINCT trade_date` 算覆盖区间/缺口；**不建**物化登记表（B）。配 `force_recompute` 开关 |
| 3 | 训练超出覆盖区间 | **甲：前端 disable + 后端兜底**校验 `date_range ⊆ R_F` |
| 4 | 备料入口 | **prepare run_type 为主**（labels→features 增量串联）+ `labels`/`features` 单独 run_type 兜精细补救 |
| 5 | train_e2e 旧一条龙 | **废弃**，强制先 prepare 再 train |
| 6 | 空洞处理 | `R_F` 非连续时，前端 disable 空洞日期 + 后端兜底校验空洞报错（时序模型断档有害） |
| 7 | feature_sets 标识 | feature_sets **加列** `label_id/label_version`，训练列表显示命名标签名（非物化登记表，不违背决策 2） |
| 8 | 缺口 padding | labels 缺口**头部 MA padding**（`g0_load=max(start, g0−(ma_window−1)交易日)`，仅 strategy_aware，`ma_window`=ma_break period）**+ 尾部 padding**（末日后第 30 交易日）；features 缺口**零 padding** |

## 子文档清单与阅读顺序

建议按序阅读：

1. [01-architecture.md](./01-architecture.md) — 解耦架构总览、数据流全景、三层改动清单
2. [02-incremental-algorithm.md](./02-incremental-algorithm.md) — **正确性红线**：labels/features 缺口算法、padding 判定（含源码论证）、完整物化口径、force 语义
3. [03-backend-decoupling.md](./03-backend-decoupling.md) — prepare runner、训练 date_range 过滤、train_e2e 废弃、feature_sets 加列、server 校验/覆盖区间 API
4. [04-frontend.md](./04-frontend.md) — 备料 modal、训练 modal 翻转、is-date-disabled 机制、单独入口
5. [05-migration-rollout.md](./05-migration-rollout.md) — alembic 加列 migration、废弃清理、worker 重启与上线顺序
6. [06-testing-verification.md](./06-testing-verification.md) — 单测/集成/真机/回归，正确性逐行比对（约束 1 头号）

## 跨文档引用约定
- 文档间引用统一用相对路径 + 锚点（锚点遵循 GitHub 中文标题 slug：转小写、空格转 `-`、删标点、保留中文），例：`[缺口算法](./02-incremental-algorithm.md#labels-增量缺口算法)`。若所用渲染器不支持中文锚点，按链接文字指示的小节标题定位。
- 源码引用用 `path:line`（行号为 2026-06-06 时点，实施时以实际为准）。

## 关键已核实事实（带证据，禁止据二手转述进硬断言）

| 事实 | 值 | 证据 |
|------|----|----|
| labels 表 PK | `(trade_date, ts_code, scheme)`，按 trade_date 月分区 | 真 DB `\d+ factors.labels` |
| feature_matrix 表 PK | `(trade_date, ts_code, feature_set_id)`，按 trade_date 月分区 | 真 DB `\d+ factors.feature_matrix` |
| trade_date 列类型 | `character(8)`（YYYYMMDD 定宽） | 真 DB |
| upsert 冲突行为 | 两表均 `ON CONFLICT ... DO UPDATE`（覆盖写） | `labels/runner.py:235-248`、`features/runner.py:297-309` |
| feature_set_id 哈希字段 | factor_version/scheme/new_listing_min_days/factor_ids/neutralize_cols/robust_z（**不含 date_range**） | `features/builder.py:105-183` |
| 因子表名 | `factors.daily_factors`（复数 s） | `features/runner.py:71,95` |
| 训练加载无 date_range 过滤 | `WHERE feature_set_id=:fs ORDER BY trade_date, ts_code` | `training/runner.py:97-100` |
| train runner 直接吃 feature_set_id | params 读 `feature_set_id`，不推算 | `training/runner.py:460-495` |
| labels **有**头部依赖(MA) | `simulate_exit` 先对整窗口算 rolling MA 再切 buy_date → 缺口需头部 padding `ma_window−1` 交易日 | `strategy/exit_rules.py:459,501,504`；`_ensure_ma :401-415`；`build_exit_rules 回传 ma_window :383-391` |
| features 无跨日依赖 | 中性化/z-score 全 `groupby(['trade_date'...])` 截面 | `builder.py:228,298,334,414` |
| 训练类 runner 吃 feature_set_id | train/optuna/seed_avg 均直接读 `feature_set_id`，不读 labelRef | `training/runner.py:460`、`seed_averaging.py:408`、`search_spaces.py:62` |
| 单测基线 | 773 collected（prompt 称 772） | `pytest --collect-only` |
| migration 机制 | alembic（`src/quant_pipeline/db/migrations/versions/*.py`），**非** server 的 sql+ps1 | `alembic.ini` |

## run_type 参数契约（已查清，原为开放项）
三个训练类 runner 全部直接吃 `feature_set_id`、**不吃 labelRef**；但当前 `create-job.dto` 的 `TRAIN_RUN_TYPES`（`:23`）把它们归入"labelRef 必填"集合——属现状混乱，解耦时一并理顺（详见 [03 run_type 参数契约理顺](./03-backend-decoupling.md#run_type-参数契约理顺)）。最终三类契约：
- `labels`：labelRef(→scheme) + date_range + 备料参数 + force
- `features` / `prepare`：labelRef(→scheme) + factor_version + date_range + 备料参数 + force
- `train` / `optuna` / `seed_avg`：feature_set_id + date_range + 模型参数（**不要 labelRef**）

## 待实施时核实
- 从 strategy_aware `base_params.exit_rules` 取 `ma_break.period` 作头部 padding 的 `ma_window`（[02 padding 判定](./02-incremental-algorithm.md#padding-判定尾部持有窗口头部ma-窗口源码坐实非假设)）；确认 `build_exit_rules` 返回的 `ma_window` 即该值。
- 因子表名 `factors.daily_factors`、各 runner 行号以实施时实际为准（行号系 2026-06-06 时点）。
