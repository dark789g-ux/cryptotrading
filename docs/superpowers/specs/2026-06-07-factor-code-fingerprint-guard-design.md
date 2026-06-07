# 因子计算代码指纹护门设计（problem2 系统性修复）

> 2026-06-07。来自 followup「close_adj train/serve 特征错配 + lambdarank label_gain 崩溃」的 Phase 3。
> Phase 1（label→gain 分桶，已提交 df0915a）、Phase 2（新 fm 重训 shadow，进行中）见同名 followup。
> **本 spec 待用户过目确认后再 TDD 实现。**

## 1. 问题（已坐实）

`feature_set_id` 只绑 6 个输入（`features/builder.py:62 build_feature_set_id`）：
`factor_version / label_scheme / new_listing_min_days / neutralize_cols / robust_z / factor_ids`。
**不绑「因子计算代码口径」。**

后果（problem2 实测）：`83aeda0`（2026-06-06）把 close_adj 改为纯后复权后，因子 12+ 个 close 派生列的值全变，但 `factor_version` 仍是 `'v1'`、fs 哈希不变。于是：
- 同一个 `fs_60bc257fb173` 下，特征值在 prod 训练时（旧 close_adj）与重算后（新 close_adj）**定义不同**；
- prod 模型（旧特征训）被喂新特征 → live 排名漂移 ~85%（top-20 重叠 15%，已用 `verify_recompute_inference_drift.py` 复现）；
- 现有 fail-fast 护门（`training/runner.py:434` 样本数 ≥20、推理当日截面非空）**全拦不住**——它们只看"有没有数据"，不看"特征定义有没有变"。

## 2. 为什么不能靠手动版本号

两条"手动"思路——**bump `factor_version` 'v1'→'v2'**、或**新增手动 `FACTOR_CODE_VERSION` 常量**——与当初出 bug 的**失败模式完全相同**：close_adj 改了但没人记得 bump。`factor_version` 还是前端因子库下拉的用户可见字段（语义是"选哪批因子"，非"怎么算"），bump 它会连带前端/`@register`/DB 注册全改、语义被污染。

**结论：版本指纹必须从计算代码自动派生，杜绝依赖人工纪律。**

## 3. 决策：检测型（指纹元数据 + fail-fast）优先于预防型（指纹进 fs id）

| 维度 | 方案A 检测型（**采纳**） | 方案B 预防型（否决） |
|---|---|---|
| 机制 | 物化 fm 时把代码指纹存进 `feature_sets` 新列；训练/推理入口比对**当前代码指纹 vs fm 存储指纹**，不一致 raise | 把代码指纹纳入 `build_feature_set_id` + `feature_sets` 逻辑键，代码一变 fs id 就变 |
| fs id | **不变**，无血缘 churn | **全部重置**，model_runs/scores_daily 等所有引用失效 |
| 全量 fm | 不必重物化 | 必须重物化全部 |
| migration | 轻（加一列） | 重（改唯一索引 + resolve 查询 + 一次性升级兜底） |
| 误触发 | 无（只比对，人工决定何时重物化） | 有（无输出变化的纯重构也会换 id、逼全量重物化） |
| 与项目哲学 | 契合 CLAUDE.md「漂移必 fail-fast 暴露」 | 偏重，超出本研究/回测系统需要 |

方案A 把**静默错配变成响亮报错**，这正是项目数据完整性规范的一贯做法（`.claude/rules/data-integrity.md`）。本项目是回测/研究系统（非实盘），检测型足够。

## 4. 详细设计

### 4.1 指纹覆盖范围（口径承载面）

指纹 = 对以下"影响特征值"的代码做 token 归一化（去注释/空白）后的稳定哈希：

1. **各活跃因子的 `compute` 方法源码**——`registry.list_active(factor_version)`（`registry.py:187`，enabled 因子，与 fs 哈希同源），按 `factor_id` 升序，逐个 `inspect.getsource(type(f).compute)`。
2. **`apply_hfq` 源码**——`labels/_common.py:43`，close_adj/low_adj/high_adj 的唯一真理源（problem2 的直接肇因）。

> **不纳入**（已被 fs 哈希/overlay 覆盖，避免重复计数）：neutralize_cols / robust_z / factor_clip_sigma / label_winsorize 等**参数**。
> **v1 留作扩展候选、本期不纳入**（在 spec 标注，避免悄悄缩范围）：`factors/data_access.py:load_window_data` 与 `runner_window_guard` 的取窗/PIT 装配代码、builder 的中性化**实现代码**。本期聚焦已实证的 close_adj 口径 + 因子 compute 本体。

token 归一化用标准库 `tokenize`：剔除 COMMENT / NL / 纯空白，保留代码语义 token 序列再 `sha256`。这样改注释、换行、加空格**不**误触发；改了实际计算逻辑**必**触发。

### 4.2 新函数

`features/factor_code_fingerprint.py`（新文件）：
```python
def factor_code_fingerprint(factor_ids: Sequence[str], factor_version: str) -> str:
    """对 factor_ids 对应活跃因子的 compute 源码 + apply_hfq 源码做 token 归一化哈希。
    返回 'fcf_<sha12>'。同代码口径 → 同指纹；compute/apply_hfq 逻辑一变即变。"""
```
- 仅哈希**传入 factor_ids 命中**的因子（与 fm 的 factor_ids 对齐），保证训练/推理/物化三侧对同一 fm 算出同一指纹。
- 因子类在 `registry` 缓存中按 `(factor_id, factor_version)` 取；取不到 → raise（fail-fast，不静默跳过）。

### 4.3 存储（migration）

`factors.feature_sets` 加列：
```sql
ALTER TABLE factors.feature_sets ADD COLUMN factor_code_fp text;  -- NULL = 旧 fm（指纹机制前）
```
配套 `.ps1`（内置 `docker exec`，单 `-c`，符合 Windows 约束）。**不进唯一索引/逻辑键**（不影响 resolve 复用，不动 fs id）。

写入点：物化 fm、upsert `feature_sets` 行处（`features/runner.py` 的 build 路径，`resolve_feature_set_id` 之后、写 feature_sets 时）——把 `factor_code_fingerprint(factor_ids, factor_version)` 一并写入 `factor_code_fp`。

### 4.4 护门接入

新增 `features/factor_code_fingerprint.py:assert_fm_code_fingerprint(feature_set_id, factor_ids, factor_version, session)`：
- 读 `feature_sets.factor_code_fp`（按 fs id）。
- `stored IS NULL`（旧 fm）→ `logger.warn`「fm 无代码指纹，建议重物化以纳入护门」**不阻塞**（向后兼容，不打断在跑的系统）。
- `stored != current` → **raise** `FactorCodeFingerprintMismatch`，报文含 fs id / stored / current / 「计算口径已变更，请重物化该 feature_set 后再训练/推理」。
- 相等 → 通过。

接入两处入口：
1. **训练**：`training/runner.py` 解析/加载 feature_matrix 后（`_load_feature_matrix` 调用点附近），训练前调用。
2. **推理**：`inference/runner.py:predict_one_day` 取数前调用。

> 注：fm 的 `factor_ids` 从 `feature_sets.factor_ids` 列读（已存，`array`），无需调用方另传。

### 4.5 向后兼容 + 一次性回填

现有 `feature_sets` 行 `factor_code_fp` 为 NULL → 护门只 warn。
**回填**：`fs_60bc257fb173` 已由重算任务 G（2026-06-07）用**当前代码**重物化，其特征即当前 close_adj 口径——故可安全 stamp 当前指纹：
```sql
UPDATE factors.feature_sets SET factor_code_fp = :current_fp WHERE feature_set_id = 'fs_60bc257fb173';
```
（回填脚本计算 `current_fp` 后执行；其余历史 fm 若不确定口径则保持 NULL → warn，按需重物化。）回填后，Phase 2 的 shadow 与未来推理都受护门保护。

## 5. TDD 测试计划

`tests/unit/test_factor_code_fingerprint.py`：
1. 同 factor_ids + 同代码 → 指纹稳定可复现。
2. token 归一化：对某因子 compute 仅改注释/空白（用 monkeypatch 包一层等价源）→ 指纹**不变**（防误触发）。
3. 改变 compute 逻辑（mock 一个 factor 的 compute 源）→ 指纹**变**。
4. factor_ids 子集 → 只哈希命中因子；factor_id 在缓存缺失 → raise。
5. `assert_fm_code_fingerprint`：stored NULL → warn 不 raise；stored≠current → raise `FactorCodeFingerprintMismatch`；相等 → 通过（用 stub session）。

`tests/integration/`：物化一个小 fm → `feature_sets.factor_code_fp` 被写入且 == `factor_code_fingerprint(...)`；改 mock 口径后训练入口 raise。

全量 pytest 不回归。

## 6. 落地顺序（实现阶段）

1. migration `.sql` + `.ps1`（加列）→ 跑。
2. `factor_code_fingerprint.py`（计算 + 护门）+ 单测（TDD 红→绿）。
3. 写入点接入（features build 路径）。
4. 护门接入训练 + 推理入口。
5. 回填 `fs_60bc257fb173`。
6. 全量 pytest + ruff。
7. 分层提交（migration / 指纹模块 / 护门接入 各一 commit，符合用户分层提交偏好）。

## 7. 硬约束（带走）

- 不假设、暴露权衡、中文（CLAUDE.md）。进硬断言/SQL 前自查实体或真 DB 一条（apply_hfq 位置、list_active 源、feature_sets schema 均已亲核）。
- Windows PowerShell：禁 `&&` 用 `;`；docker exec 单 `-c`。
- migration `.sql` + 同名 `.ps1` 配对（项目约定）。
- 护门对旧 fm 只 warn 不阻塞，避免打断在跑系统；只在**确有口径不一致**时 raise。
- promote prod 仍是人工硬门（本 spec 不涉及 promote）。
