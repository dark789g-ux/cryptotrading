# close_adj 改纯后复权（去窗口 max 归一）设计

- 日期：2026-06-06
- 范围：`apps/quant-pipeline`（量化管道）+ 一条 server 侧 DB 文案修正
- 类型：纯局部小改，**零数值变化**，不触发历史数据重算

## 1. 背景与动机

当前后复权列 `close_adj` 的计算口径是「窗口归一」：

```text
close_adj = close × adj_factor / max(adj_factor in window per ts_code)
```

`max(adj_factor)` 基本等于窗口末日的因子，所以这其实是**以窗口末为锚的前复权式归一**，而非函数名 `apply_hfq` 暗示的「后复权」。这带来三个问题：

1. **绝对水平不 PIT 安全**：基准 `max(adj_factor)` 随 `date_range` 变化，同一 `(ts_code, trade_date)` 在不同窗口的 run 里 `close_adj` 绝对值不同，不可跨 run 比较；窗口内 `max` 还可能取自 T 之后的复权事件。
2. **安全靠约定维持**：现在之所以没出前视偏差，是因为所有因子/标签都是**比值口径**（基准约掉）。`data_access.py` 注释明文警告「`close_adj` 只可用于比值，不可作绝对价格」。一旦有人把 `close_adj` 当 level 特征直接用，前视/不可复现立刻回归。
3. **命名/文案自相矛盾**：函数名 `apply_hfq`（后复权）、公式 `/max_af`（前复权式）、migration 种子 `fwd_5d_ret` description（「前复权」）三者口径表述不一致。

**目标**：改成纯后复权 `close_adj = close × adj_factor`（去掉 `/max_af`），让绝对水平也变成 PIT 安全——只依赖各交易日当日已知的 `adj_factor`，不再依赖窗口、不再靠约定。顺手把散落 4 处的复权公式统一到唯一实现 `apply_hfq`。

> 本次是上一轮 labels 整改（`docs/superpowers/specs/2026-05-22-labels-review-remediation-design/01-common-and-adjustment.md` 定下「窗口 max 基准」）的再进一步。

## 2. 数值不变性（为什么零风险）

改动等价于：把每只票的 `close_adj` 整列乘以一个 per-ts_code 常数 `max_af`（旧值 = 新值 / max_af）。

所有 `close_adj` 消费方都是**比值 / 收益率 / 差分**口径，常数在分子分母（或差分）中约掉，输出**完全不变**：

| 消费方 | 用法 | 结论 |
|--------|------|------|
| 13 个价格/行业因子 | `c_t/c_lag-1`、`pct_change`、`log(c).diff()`、`(c−lower)/(upper−lower)` 等 | 比值/差值比，**不变**（注¹） |
| `labels/fallback.py` fwd_ret | `close_adj[t+N]/close_adj[t]-1` | 比值，**不变** |
| `labels/strategy_aware.py` + `exit_rules.py` 模拟 | 入场/止损/出场全是同票 close_adj 派生量，止损阈值 `entry×(1+threshold)` 为相对比例，`value=exit/buy-1` | 比值，**不变** |
| `training/forward_returns.py` oos 收益/IC | 复用 `apply_hfq`，`c_t1/c_t-1` | 比值，**不变** |
| `labels/classify.py` 分类（band/tercile/custom） | 作用在 fwd_ret 收益率上，不碰 close_adj 绝对值 | **不变** |

> 注¹：对 `(C−L)/(U−L)` 型公式（如 `bollinger_position_20d`），设新值 = 旧值 × k，则分子分母各乘 k、比值不变——故仍属「不变」；`log(c).diff()` 同理（`log(c·k)−log(c′·k)=log(c)−log(c′)`）。

**持久化/哈希**：`close_adj` 是内存中间量，不写入任何 DB 列；`features/builder.py::build_feature_set_id` 的哈希 payload 不含 close_adj 基准。已落库特征**不需重算**，`feature_set_id` 不漂移，可复现性不破。

## 3. 改动设计

### 3.1 `apply_hfq` 成为唯一实现（去 groupby）

`labels/_common.py:43-65`：

```text
# before                                    # after
af = to_numeric(out["adj_factor"])          af = to_numeric(out["adj_factor"])
max_af = af.groupby(out["ts_code"])          out["close_adj"] = out["close"] * af
          .transform("max")                  if "low" in out.columns:
out["close_adj"] = out["close"]*af/max_af        out["low_adj"] = out["low"] * af
if "low" in out.columns:                     # NaN warn 原样保留（见 §6）
    out["low_adj"] = out["low"]*af/max_af
```

**关键副作用**：纯后复权是逐行计算，`apply_hfq` **不再读 `ts_code` 列**，因此对「`ts_code` 在 column」（labels 长表）和「`ts_code` 在 MultiIndex level」（factors panel）两种 df 都通用——这正是 4 处能复用同一函数的前提。NaN 处理、`df.copy()`、返回新 df 的语义均不变。

> **实现顺序（重要）**：改动**前**之所以不能直接复用 `apply_hfq`，正是因为第 55 行 `af.groupby(out["ts_code"])` 对 panel（`ts_code` 在 MultiIndex level、不在 column）会 `KeyError`。因此必须**先改 `_common.py`（去 groupby），再替换 4 个调用方**，否则替换后立即报错、难以定位。

### 3.2 四处统一为 `df = apply_hfq(df)`

| 文件:行 | 现状 | 改后 |
|---------|------|------|
| `labels/_common.py:43-65` | 自身，带 groupby | 去 groupby（§3.1） |
| `factors/data_access.py:200-202` | inline `max_af` 块 | `panel = apply_hfq(panel)` |
| `factors/runner_window_guard.py:165-169` | inline `max_af` 块（含 `sub.copy()`） | `sub = apply_hfq(sub)`，去掉本地 `sub.copy()` 避免双拷贝 |
| `tests/unit/conftest.py:132-135` | inline `max_af` 块 | `df = apply_hfq(df)` |

`training/forward_returns.py:120` 已调 `apply_hfq`，**自动跟随**，无需改动。

### 3.3 依赖方向

`factors/{data_access,runner_window_guard}` 新增 `from quant_pipeline.labels._common import apply_hfq`。`_common.py` 是零项目依赖的叶子模块（只 import `logging`/`pandas`），`training` 已有同款跨模块复用先例，**不成环**。

```text
  training ─┐
  factors ──┼─▶ labels/_common.apply_hfq   ← 叶子模块（零项目依赖）
  labels ───┘      纯后复权唯一真理源
```

## 4. 标签管理模块影响：零功能/数值影响

三侧逐一核查（server 标签 CRUD + web 标签库页 + pipeline label_definitions/分类）：

- **pipeline**：4 条种子标签里只有 `fwd_5d_ret:75` 的 description 提「前复权」；分类逻辑作用在 fwd_ret 收益率上，结果不变。
- **server**：`quant-jobs.service.ts::expandForTraining` 只搬 `base_type/base_params/classify_mode/...` 元数据，不碰行情价格。
- **web**：`LabelTable.vue`/`LabelEditModal.vue` 展示标签元数据，无 close_adj 或复权价字段。

**唯一触及点 = `fwd_5d_ret` 那条 description 文案**，正好被 §5 覆盖。

## 5. migration 文案修正（方案 a：两处一致）

`fwd_5d_ret` 的「前复权」文案存在于两处，必须一起改，否则 web 标签库页（读 DB）仍显示旧文案：

1. **源码种子** `20260605_0001_label_definitions.py:75`：`"未来 5 日前复权收益率…"` → `"未来 5 日后复权收益率…"`（只影响未来新部署的库）。
2. **已部署 DB** `factors.label_definitions` 表 `fwd_5d_ret` 行：新增一个 UPDATE migration（description 是普通 TEXT 列，非 jsonb，无 CAST 绑定坑）。

新 migration `20260606_0001_fix_fwd5d_desc_hfq.py`：

```python
revision = "20260606_0001"
down_revision = "20260605_0001"          # 接当前 head

_NEW = "未来 5 日后复权收益率（连续值，适合 LambdaRank/回归模型）"
_OLD = "未来 5 日前复权收益率（连续值，适合 LambdaRank/回归模型）"
_SQL = ("UPDATE factors.label_definitions SET description = :d "
        "WHERE label_id = 'fwd_5d_ret' AND label_version = 'v1'")

def upgrade():
    from sqlalchemy import text
    op.get_bind().execute(text(_SQL), {"d": _NEW})

def downgrade():                 # _SQL 模板与 upgrade 共用，仅 :d 参数换回旧文案
    from sqlalchemy import text
    op.get_bind().execute(text(_SQL), {"d": _OLD})
```

> **alembic 注意**（参考过往 drift 教训）：执行前先 `alembic current` 确认已在 `20260605_0001`，再 `upgrade head`；勿手动跳应用。

## 6. 注释 / 文档同步（约 25 行，纯文本）

| 文件 | 改什么 |
|------|--------|
| `factors/data_access.py:191-199` | 删整段「窗口 max 基准、只能用于比值」警告，改为「纯后复权，绝对价 PIT 安全」 |
| `labels/_common.py:43-65` docstring | **删第 46-50 行整段**（含「收益率对复权基准不敏感…窗口 max 已足够」一句），替换为「纯后复权 `close × adj_factor`；`adj_factor` 为 NULL → `close_adj`/`low_adj` 为 NaN」 |
| `training/forward_returns.py:119` | 已是中性表述（「唯一真理源，只读复用 apply_hfq」），**无需改** |
| `factors/runner.py:13` | `close_adj = close*adj_factor/latest_adj_in_window` → `close_adj = close*adj_factor` |
| `factors/README.md:96-108` | 示例代码与「只可用于比值」说明同步更新 |
| `tests/unit/conftest.py:111-112` | fixture 注释「窗口 max 基准」→「纯后复权」 |
| `tests/unit/test_forward_returns.py:7/55/114/123-125` | 函数名 `test_hfq_basis_uses_window_max_adj_factor` 及注释改口径 |

## 7. 测试

- **改期望值**：`test_labels_common.py:70-73`，`10.0*1.0/2.0`→`10.0*1.0`、`11.0*2.0/2.0`→`11.0*2.0`、`9.8*1.0/2.0`→`9.8*1.0`、`10.8*2.0/2.0`→`10.8*2.0`。
- **应加一条（推荐，不可省略）**：新增 `test_apply_hfq_pure_hfq`，逐行断言 `close_adj[i] == close[i] × adj_factor[i]`（不含 `max_af`），显式锁定纯后复权语义、防止未来悄悄回退到窗口 max。
- **零变化回归**：跑 `test_factors_price.py`（全因子数值不变）、`test_forward_returns.py`、`test_labels_*`、`test_factors_runner*` 全绿。
- 命令：`pnpm --filter ...` 不适用；在 `apps/quant-pipeline` 下用其既有 pytest 入口（uv run pytest）。

## 8. 验收标准 / 不变量

- [ ] `apply_hfq` 不再含 `groupby`/`max_af`，4 处全部改为调用它。
- [ ] 全量 pytest 绿；`test_factors_price.py` 数值与改前一致（零变化回归）。
- [ ] `feature_set_id` 哈希不变（抽查一个已落库 feature_set 的 id 不漂移）。
- [ ] 新增 `test_apply_hfq_pure_hfq` 锁定逐行纯后复权语义并通过。
- [ ] `fwd_5d_ret` description 在源码与 DB 两处均为「后复权」；web 标签库页显示正确。
- [ ] `alembic upgrade head` 成功，`alembic current` = `20260606_0001`。

## 9. 风险与副作用

- **close_adj 量级变大**（每票乘各自 max_af）：代码库内无任何地方依赖其量级（已核 server/web/pipeline 全栈），但**手写 SQL / 调试脚本**若假设「close_adj ≈ 原始 close」需适应。这是换取 level PIT 安全的可接受代价。
- **双拷贝**：`runner_window_guard.py` 原有 `sub.copy()` 与 `apply_hfq` 内部 copy 重复，改动时去掉前者。

## 10. 不做什么（YAGNI 边界）

- 不新建中立 adjustment 模块（复用 `_common.apply_hfq` 即可）。
- 不改 `close_adj` 列名。
- 不重算历史特征（数值不变，无必要）。
- 不动 `strategy_aware` / 因子 / 分类的任何逻辑（仅复权基准一处变化）。
