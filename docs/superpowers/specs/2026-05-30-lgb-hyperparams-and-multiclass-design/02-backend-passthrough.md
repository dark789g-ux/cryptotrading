# 02 · 后端（factor API、校验、特征/标签透传、feature_set_id 哈希）

> 上级：[index.md](./index.md)。前端见 [01](./01-frontend.md)，lgb-multiclass 见 [03](./03-lgb-multiclass.md)。

## factor-versions API

新增只读接口，供前端 `factor_version` 下拉枚举。

- 路由：`GET /api/quant/factor-versions`
- 位置：`apps/server/src/modules/quant/` 现有 controller + service（沿用模块，勿新建 module 防 Guard 依赖问题）
- 实现：查询 `factors.factor_definitions`

```sql
-- 经 service 执行（参数化，无拼接）
SELECT DISTINCT factor_version
FROM factors.factor_definitions
WHERE enabled = true
ORDER BY factor_version;
```

- 返回：`{ versions: string[] }`（当前 `['v1']`）。
- 空结果不报错，返回 `{ versions: [] }`，前端回退手输。
- Controller 上**禁止**再加 `@UseGuards(AuthGuard)`（全局 Guard 已注册，见 CLAUDE.md）。

> POST `/api/quant/jobs` 不改：`create-job.dto.ts` 的 `params` 为任意 jsonb 透传，`validateCreateJob` 仅校验 params 是对象（`create-job.dto.ts:67-72`）。所有新参数随 params 透传，校验落 Python。

## ValidatedParams 扩展

`apps/quant-pipeline/src/quant_pipeline/worker/train_e2e_runner.py`，`ValidatedParams`（现 `:57-68`）。

> ⚠️ 现状校正：`neutralize_cols` / `robust_z` **字段已存在**（现 `:67-68`，D-17 hook，`_validate_params` 返回处恒写 None、`_step_features` 未透传）。本次是**补齐这两个已有字段的校验赋值 + 透传**，并**新增其余 5 个字段**。

```python
@dataclass(frozen=True)
class ValidatedParams:
    # ... 既有字段 ...
    neutralize_cols: tuple[str, ...] | None = None   # 已存在(hook)：补校验+透传
    robust_z: bool | None = None                     # 已存在(hook)：补校验+透传
    hyperparams: dict[str, Any] | None = None        # 新增（lstm 已有等价用法）
    factor_clip_sigma: float | None = None           # 新增
    label_winsorize: tuple[float, float] | None = None  # 新增
    fwd_horizon_days: int | None = None              # 新增，仅 fwd_5d_ret
    max_hold_days: int | None = None                 # 新增，仅 strategy-aware
```

## 严格校验（_validate_params）

`_validate_params`（现 `:93-175`）对每个新参数严格校验，**越界即 `raise ValueError`，不静默夹取**（CLAUDE.md：禁止静默吞错 / 伪装成功）。错误信息须含字段名 + 实际值 + 合法范围。

```text
hyperparams        : 若存在须为 dict；逐键按白名单 + 范围校验（见下表）
neutralize_cols    : 若存在须为 list，且去重排序后 ∈ {[], ['industry_l1'], ['industry_l1','mv']}
                     三种规范组合之一；出现 ['mv'] 单独、未知元素等非规范组合 → raise ValueError
                     （后端不放开任意子集，与前端三档一一对应，杜绝前端无法产生的语义）
robust_z           : 若存在须为 bool
factor_clip_sigma  : 若存在须为 float，∈ [1.5, 5.0]
label_winsorize    : 若存在须为 [lo, hi]，lo<0<hi 且 lo∈[-1,0)、hi∈(0,1]
fwd_horizon_days   : 若存在须为 int，∈ {3,5,10}；且仅当 label_scheme=='fwd_5d_ret' 才接受，否则 warn+忽略
max_hold_days      : 若存在须为 int，∈ [10,30]；且仅当 label_scheme=='strategy-aware' 才接受，否则 warn+忽略
```

lgb hyperparams 键白名单与范围（与前端 [01](./01-frontend.md#lgbhyperfields) 表一致；未知键 `logger.warn` + 跳过，不静默接受）：

```text
num_leaves ∈[15,127] · min_data_in_leaf ∈[50,500] · feature_fraction ∈[0.5,1.0]
learning_rate ∈[0.01,0.2] · num_boost_round ∈[50,2000] · early_stopping_rounds ∈[10,200]
bagging_fraction ∈[0.5,1.0] · lambda_l1 ≥0 · lambda_l2 ≥0
```

> 注：hyperparams 白名单按"模型族"区分——lstm 用 lstm 键、lgb 系用上表键。校验时按 `model` 选对应白名单。

> 静默失效护栏（CLAUDE.md 禁止静默吞错）：lgb-lambdarank 普通 train 的 single_fold 路径硬编码 `early_stopping_rounds=None`。当 `walk_forward=false` 且 hyperparams 含 `early_stopping_rounds` 时，校验通过但该值不生效——此时必须 `logger.warn`「single_fold 模式下 early_stopping_rounds 不生效，已忽略」，不可静默丢弃。前端虽已 disabled 该字段（[01](./01-frontend.md#lgbhyperfields)），后端仍须独立防御（绕过前端直调 API 的情形）。

## 特征参数透传（_step_features）

`_step_features`（现 `:282-322`）→ `build_feature_matrix(...)`。三层链路（行号已核实）：

```text
train_e2e_runner._step_features
  → features/runner.py:build_feature_matrix(...)       # 现签名 :303-311，无这些参数 → 需加 4 参
        neutralize_cols / robust_z / factor_clip_sigma / label_winsorize
      ├→ build_feature_set_id(...)                      # 调用点 features/runner.py:412
      │     现已含 neutralize_cols/robust_z(builder.py:84-91)；factor_clip_sigma/
      │     label_winsorize 按「哈希」节方案 A 决定是否入哈希
      └→ features/builder.py:build_feature_matrix_from_frames(...)  # builder.py:472-486
            已接收 neutralize_cols/robust_z/factor_clip_sigma/label_winsorize（无需改 builder 签名）
```

要点：缺口在**中间层 `features/runner.py:build_feature_matrix`（:303-311）**——它当前根本没有这 4 个形参，对下游 `build_feature_matrix_from_frames`(builder.py:472，**已支持**) 用的是默认。改动集中在 `features/runner.py`：① `build_feature_matrix` 签名加 4 参；② 透传给 `build_feature_matrix_from_frames`；③ 同步传给 `build_feature_set_id`（:412）。builder.py 本身不改。

`label_winsorize` 的应用点（**只截一次，避免双重 winsorize**）：标签截尾在**标签生成阶段**（`strategy_aware.py` 的 `WINSORIZE_LO/HI`）执行；`builder.py` 的 `label_winsorize` 参数只是把同一份值**传入用于一致性/记录**，不得对已截尾的 label 列再截一次。实现时确认 builder 侧是否真的二次截尾——若是，则 builder 侧改为「仅当 labels 阶段未截时才截」或彻底由 labels 阶段负责，builder 不重复。两处用**同一个** `[lo,hi]` 值（同源透传）。

## 标签参数透传（_step_labels）

`_step_labels`（现 `:～205`）→ `labels/runner.py:compute_labels(...)`（现 `:251-258`）。

```text
compute_labels 签名加可选参：fwd_horizon_days / max_hold_days / label_winsorize
  → fwd_5d_ret 路径 labels/fallback.py:compute_fwd_5d_ret
        FWD_HORIZON_DAYS 常量（现:47）改为函数入参，默认 5
  → strategy-aware 路径 labels/strategy_aware.py
        MAX_HOLD_DAYS（从 exit_rules.py 导入）改为可覆盖入参，默认 20
        WINSORIZE_LO/HI（现:111-112）改为入参，默认 (-0.5, 0.5)
```

改动原则：常量保留作默认值，签名加同名可选参；调用方按 ValidatedParams 透传。其它 scheme（dir3_*）不受这些参数影响。

## feature-set-id 哈希

**硬性**：凡影响特征矩阵 / 标签数值的新参数，必须纳入 `feature_set_id` 哈希输入，否则不同配置碰撞同一 id → 静默复用错误缓存（CLAUDE.md 数据完整性）。

```text
现状  feature_set_id = hash(factor_version, label_scheme, 已纳入参数...)
新增纳入哈希输入：
   neutralize_cols, robust_z, factor_clip_sigma, label_winsorize,
   fwd_horizon_days(仅 fwd_5d_ret), max_hold_days(仅 strategy-aware)
```

实现机制（**方案 A：仅显式非默认参数入哈希**，明确采用，消除"既纳入又不变"的矛盾）：

把哈希输入分两层拼接：
1. **基础层**（现状不变）：`factor_version`、`label_scheme` 及现有已纳入项 —— 原样保留。
2. **覆盖层**（新增）：仅当用户**显式传入且值 != 该参数默认值**时，才把该参数追加进哈希串；等于默认值或未传 → **不追加**。

由此数学保证：

```text
旧任务 / 用户全用默认  → 覆盖层为空 → 哈希串 == 改动前 → feature_set_id 不变（历史缓存可命中）
用户改了某参数(非默认) → 覆盖层非空 → 不同 id → 不会误命中旧缓存
```

实现要点：
- 定位 `feature_set_id` 计算函数（在 `features/` 下，registry / builder 附近，依 `factor_version + label_scheme` 计算）。实现前先用 SubAgent 精确定位该函数与现有哈希输入构成。
- 覆盖层用**规范化**形式：按 key 排序、float 统一 round 到固定小数、bool/list 转固定字面；`neutralize_cols` 去重 + 排序后比对默认 `['industry_l1','mv']`。
- "默认值"以 Python 端单一真理源为准（builder / labels 模块的现有常量），与覆盖层比对的基准必须取自同一常量，避免两处默认漂移。
- 仅把"对当前 label_scheme 实际生效"的参数纳入（如 dir3 不纳入 `max_hold_days` / `label_winsorize`；非 fwd_5d_ret 不纳入 `fwd_horizon_days`）。
- **回归红线**：pytest 必须断言"全默认配置算出的 id == 改动前 id"（见 [04](./04-testing-and-rollout.md#python-pytest)），否则历史 feature_set 全失效需重算。

## 透传链路图

```text
前端 params(jsonb)
  └─ POST /api/quant/jobs（NestJS 透传，不校验字段）
       └─ train_e2e_runner._validate_params → ValidatedParams（严格校验/越界报错）
            ├─ feature_set_id = hash(... + 新特征参数)         ← 哈希纳入
            ├─ _step_labels  → compute_labels(fwd/max_hold/winsorize)
            ├─ _step_features→ build_feature_matrix(neutralize/robust_z/clip/winsorize)
            └─ train_model(hyperparams=...)  → 见 03（lgb / lgb-multiclass / 既有 lstm）
```
