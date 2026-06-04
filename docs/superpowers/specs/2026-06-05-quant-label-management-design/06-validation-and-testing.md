# 06 · 校验与测试

← 回到 [index.md](./index.md)

## 双层校验 + fail-fast（呼应项目数据完整性规则）

```text
后端层（即时反馈）                      Python 层（最终防线）
───────────────────                    ──────────────────────
建标签 POST/PATCH:                      _validate_params（训练时再校验一次）:
 · base_type/classify_mode 合法枚举      · 展开的明文参数组合再校验
 · 组合校验:                             · model × classify_mode 兼容性（见下）
   fwd_ret→horizon≥1 整数               · 非法 → job failed + 明确 error_text
   band→eps>0; strategy_aware→          · 绝不静默继续
   max_hold_days∈[10,30]; tercile→无参
 · 语义字段不可变: PATCH 改 base_*/
   classify_* → 400 提示新建版本

建 job 展开标签 expandForTraining:
 · labelRef 指向 id+version 不存在 / enabled=false
   → fail-fast 拒建 job，禁止静默回退默认
```

呼应现有约束：labels 阶段产出 0 行 → 沿用现有 `failedItems` 机制（不伪装成功）；展开标签
查不到 → fail-fast 不回退；种子标签语义值落 Python 源核对（见
[05-migration-and-seed.md](./05-migration-and-seed.md#种子标签对应原-4-个-scheme开箱即用平滑过渡)）。

## model×classify 兼容矩阵

已核对 `train_e2e_runner.py:43`（`_ALLOWED_MODELS`）+ `training/runner.py:284/305/328`：

| 模型 | 吃连续/离散 | 要求 classify_mode | 不匹配 |
|---|---|---|---|
| `lgb-lambdarank`（runner.py:328 ranking 通路） | 连续（排序） | `NULL` | 误配 raise |
| `lstm`（runner.py:284 独立路径） | 离散（三分类） | 非 NULL（band/tercile/custom） | 误配 raise |
| `lgb-multiclass`（runner.py:305 独立路径） | 离散（三分类） | 非 NULL | 误配 raise |
| `linear` / `gbdt` | — | — | **白名单残留**：在 `_ALLOWED_MODELS` 内但 `runner.py:328` 实际 raise"不支持"，**非本 spec 范围**，不为其定义 classify 配对 |

**fail-closed 的实现位置（尊重现状架构）**：`train_e2e_runner.py:38-41` 注释明确现状
**刻意不在 `_validate_params` 强制 model↔scheme 配对**（松耦合、允许实验组合），靠训练
入口的 label 整数护栏兜误配。本设计**沿用此位置**——分类后移后，护栏语义为：分类模型
（`lstm`/`lgb-multiclass`）入口要求离散 label（`classify_mode` 非 NULL），`lgb-lambdarank`
用连续（`classify_mode`=NULL）；误配在**训练入口 raise**，不静默忽略分类规则（fail-closed
精神保持）。**不在 `_validate_params` 新增配对矩阵**，避免推翻现有松耦合决策。

> ⚠ **落源头核对**：上表模型清单与各自吃连续/离散的事实已 grep `train_e2e_runner.py` /
> `training/runner.py` 核对；实施时若模型集合有变动须同步本表。

## 测试矩阵

| 层 | 用例 | 断言 |
|---|---|---|
| Python 单测 | `classify.py` band 边界 | `r==±ε` 落横盘、`r>ε` 涨、`r<−ε` 跌 |
| Python 单测 | `classify.py` tercile | 每日截面三分、平票稳定处理 |
| Python 单测 | `fwd_ret(h=1)` 一致性 | == 原 dir3 内部次日收益 `close_adj(t+1)/close_adj(t)-1` |
| Python 单测 | `fwd_ret(h=5)` 一致性 | == 原 `fwd_5d_ret` 结果 |
| Python 单测 | `base_scheme_codec` 决定性 | 相同 `(base_type,base_params)`→相同串；h=5→`fwd_5d_ret` legacy 别名 |
| Python 单测 | `feature_set_id` legacy 回归 | 固定输入 hash 与基线不变（守老 feature_set 不漂移） |
| Python 单测 | `_validate_params` | 合法 `base_*`/`classify_*` 组合通过；非法组合 / 缺参 → 抛错 |
| Python 单测 | 训练入口误配护栏 | 分类模型(`lstm`/`lgb-multiclass`)+`classify_mode`=NULL → raise；`lgb-lambdarank`+非 NULL → raise |
| Python 端到端 | **复用验证（守 B 的承诺）** | 同一 `feature_set` 配两个不同 ε 训练，断言 `labels`/`feature_matrix` **不被重算**，只训练阶段离散不同 |
| Python 端到端 | 种子标签全链路 | `next_day_band05` 跑通 labels→features→train |
| 后端 jest | `LabelsService` CRUD | 创建 / 列表过滤 / 详情 |
| 后端 jest | 语义字段不可变 | PATCH `base_type` 被拒 400 |
| 后端 jest | `expandForTraining` | 正确展开；label 不存在 / disabled 时 fail-fast 抛错 |
| 前端 vitest | `LabelEditModal` | `base_type` 切换动态字段、`classify_mode` 切换动态字段 |
| 前端 vitest | `buildParams` | 训练 body 含 `labelRef` |
| 前端构建 | **vite build** + `lint:quant-lines` + 真机 | SFC 编译通过、≤500 行、`/quant/labels` 不白屏 |

## 验证命令

```text
# Python
cd apps/quant-pipeline; uv run pytest tests/unit/test_classify.py tests/unit/test_base_scheme_codec.py -q
# 后端
pnpm --filter @cryptotrading/server exec jest labels
# 前端
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web build          # ← SFC 编译，必跑
pnpm --filter @cryptotrading/web lint:quant-lines
pnpm --filter @cryptotrading/web test
```
