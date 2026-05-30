# A2 · `dir3_band` 横盘阈值 ε 可配（方案①+ 动态编码）

> 入口见 [index.md](./index.md)。本文档定义 A2 的实现设计。

## 问题与约束

`dir3_band` 把「次日收益 `|r| ≤ ε` 判横盘」，ε 固定常量 `DIR3_BAND_EPS=0.005`。
ε 固定**不是疏忽**：`build_feature_set_id` 对包含 `label_scheme` 的元组做确定性哈希
（`features/builder.py`）。若 ε 作为不进哈希的旁路参数，不同 ε 会哈希到**同一**
`feature_set_id` → 缓存污染（不同标签共用一份特征集）。

## 目标

用户**训练前在前端配置 ε**，且**不破坏 `feature_set_id` 决定性**，且**零改动**
`build_feature_set_id` 签名（避免方案②动核心契约的高风险）。

## 核心思路：ε 编进 `label_scheme` 字符串

`label_scheme` **已是** `build_feature_set_id` 的哈希输入之一。所以只要把 ε 规范化后
**编进 scheme 字符串**，决定性天然成立，无需碰哈希签名。

```text
        前端                     后端 _validate_params              下游(逻辑不变)
┌────────────────┐  label_scheme  ┌──────────────────────────┐   canonical scheme
│ label下拉=dir3_ │   ='dir3_band'│ if dir3_band 家族:          │   ='dir3_band'      ┌─────────────┐
│   band          │ ─────────────▶│   eps=params.dir3_band_eps │ ─或─────────────▶  │ compute_    │
│ ε输入框 0.1%步   │  dir3_band_eps│   校验 0<ε≤0.1 且落网格      │   ='dir3_band_     │ labels +    │
│  默认0.5%        │   =0.008      │   canonical_scheme(eps)    │     eps0080'       │ build_      │
└────────────────┘               └──────────────────────────┘                      │ feature_    │
                                   编解码器单一源:dir3_scheme.py                       │ set_id(哈希) │
                                                                                     └─────────────┘
```

## 编解码器 `labels/dir3_scheme.py`（新，单一源）

ε ↔ scheme 字符串的**唯一**编解码点，根除「白名单漏改一处」风险。

```python
# labels/dir3_scheme.py
EPS_GRID: Final[float] = 0.001        # 0.1% 网格步长
EPS_MIN, EPS_MAX = 0.001, 0.1         # 合法范围 0<ε≤0.1
LEGACY_DIR3_BAND: Final[str] = "dir3_band"
LEGACY_EPS: Final[float] = 0.005

def quantize_eps(eps: float) -> float:
    """量化到 0.1% 网格（四舍五入），并校验范围；越界抛 ValueError。"""

def canonical_dir3_band_scheme(eps: float) -> str:
    """eps → scheme 串。量化后若 == 0.005 → 'dir3_band'(legacy 别名)；
    否则 f'dir3_band_eps{round(eps*10000):04d}'，例 0.008 → 'dir3_band_eps0080'。"""

def parse_dir3_band_eps(scheme: str) -> float | None:
    """scheme → eps。'dir3_band'→0.005；正则 r'^dir3_band_eps(\d{4})$'→N/10000；
    非 dir3_band 家族 → None。"""

def is_dir3_band_scheme(scheme: str) -> bool:
    """scheme 是否属 dir3_band 家族（legacy 或 epsNNNN 变体）。"""
```

### 回归约束

> ε=0.005 **必须** canonical 回 legacy 串 `'dir3_band'`（**不是** `'dir3_band_eps0050'`），
> 否则现存 `dir3_band` 的 `feature_set_id` 哈希漂移、老特征集变孤儿。
> 加固定输入→固定 hash 回归断言守住此契约。

格式 `epsNNNN`：`NNNN = round(eps*10000)`，4 位定宽（0.1%→`0010`、1%→`0100`、
2%→`0200`、10%→`1000`）。`0050`(=0.005) 被 legacy 别名抢占，**永不**作为 scheme 串产出。

## 散点白名单家族化（全部改用 `is_dir3_band_scheme`）

当前多处对 scheme 做 exact-match，逐一改为家族判定（单一判定源 = 编解码器）：

| 位置 | 现状 | 改为 |
|------|------|------|
| `train_e2e_runner._validate_params` | `label_scheme not in _ALLOWED_SCHEMES` | 固定集 ∪ `is_dir3_band_scheme(s)`；并读 `dir3_band_eps` 做 ε 校验 + canonical 化 |
| `labels/runner.compute_labels` | `if scheme not in (...)` / `elif scheme in (SCHEME_DIR3_BAND, SCHEME_DIR3_TERCILE)` | 家族判定放行 + 分派 |
| `labels/direction_3class.compute_dir3_labels` | `if scheme not in _SCHEMES` | `is_dir3_band_scheme(scheme)` → `parse_dir3_band_eps` 取 ε 传 `_bucket_band(r, eps)`；tercile 不变 |

`_bucket_band(r, eps)` 已是参数化签名，**无需改**——只是 ε 来源从常量变成解析自 scheme。
`DIR3_BAND_EPS=0.005` 常量保留作 legacy 默认值（供编解码器引用），注释更新为
「legacy 默认；其它 ε 经 dir3_scheme 编解码」。

## ε 来源与流转（前端 → 后端 canonical）

**前端发** `label_scheme='dir3_band'`（家族选择器）**+ 独立字段** `dir3_band_eps`。
**后端 `_validate_params` canonical 化**：`label_scheme=='dir3_band'` 时读
`params['dir3_band_eps']`（缺省 0.005），`quantize_eps` + `canonical_dir3_band_scheme`
得 canonical 串，写入 `ValidatedParams.label_scheme`。此后**全链路用 canonical 串** →
哈希正确、决定性成立。编解码器**只在 Python 一处**，前端不重复实现（避免双源）。

## 前端改动

```text
改 apps/web/src/components/quant/train-modal/TrainE2EFields.vue
   - label_scheme==='dir3_band' 时显示 n-input-number（绑 modelValue.dir3_band_eps，
     step 0.001，min 0.001，max 0.1，默认 0.005，suffix 显示百分比提示）
   - LabelScheme 联合类型不变（dir3_band 仍是家族选择器，ε 是独立字段）
   - 自定义 option 接口照旧 extends SelectOption
改 apps/web/src/components/quant/train-modal/buildParams.ts
   - label_scheme==='dir3_band' 时把 dir3_band_eps 打进 params
```

`LabelScheme` 类型**不枚举** ε 变体（dir3_band 一项即可，ε 走独立字段）→ 不必维护无穷
联合分支。NestJS DTO **无需改**（`params` 不透明透传，见 [index.md](./index.md) 决策表）。

## 错误处理

- ε 越界（`≤0` 或 `>0.1`）/ 非数字 → `_validate_params` 抛 `ValueError`（禁静默）。
  `ε < 半个网格`（< 0.0005）量化后为 0，按 `≤0` 越界报错——故有效最小可表示 ε 即
  `EPS_MIN=0.001`（一个网格），与文字范围 `0<ε≤0.1` 由网格步长天然咬合。
- ε 给了非 `dir3_band` 方案（如 dir3_tercile）→ 忽略（不影响 scheme）。
- `parse_dir3_band_eps` 遇畸形 `dir3_band_epsXXXX` → 返回 None，调用方按未知 scheme 报错。

## 文件域

```text
新 apps/quant-pipeline/src/quant_pipeline/labels/dir3_scheme.py
改 apps/quant-pipeline/src/quant_pipeline/labels/direction_3class.py   (家族判定 + 解析 ε)
改 apps/quant-pipeline/src/quant_pipeline/labels/runner.py             (compute_labels 家族放行/分派)
改 apps/quant-pipeline/src/quant_pipeline/worker/train_e2e_runner.py   (_validate_params 家族 + canonical)
改 apps/web/src/components/quant/train-modal/TrainE2EFields.vue
改 apps/web/src/components/quant/train-modal/buildParams.ts
新 apps/quant-pipeline/tests/unit/test_dir3_scheme.py
改 apps/quant-pipeline/tests/unit/test_direction_3class_labels.py
改 apps/web/src/components/quant/__tests__/buildParamsLstm.spec.ts（含 eps 透传）
```

A2 **不触碰** `training/`（A1 的域）→ 文件域不相交。

## 测试

| 用例 | 断言 |
|------|------|
| 编解码器往返 | `parse(canonical(ε))==quantize(ε)`，覆盖 0.5%/0.8%/1%/2%/10% |
| legacy 别名 | `canonical(0.005)=='dir3_band'`；`parse('dir3_band')==0.005` |
| off-grid 量化 | ε=0.0083 → 量化 0.008 → `'dir3_band_eps0080'` |
| feature_set_id 回归 | 固定输入 `label_scheme='dir3_band'` → hash 与基线不变（守 legacy 不漂移） |
| 分桶边界 | 各 ε 下 `r==±ε` 落横盘、`r>ε` 涨、`r<−ε` 跌 |
| `_validate_params` ε 校验 | 合法 ε canonical 化；越界 / 非数字抛 ValueError |
| 前端 buildParams | dir3_band 时含 `dir3_band_eps`；type-check + lint:quant-lines 通过 |

验证命令见 [03-partition-and-validation.md](./03-partition-and-validation.md#a2-验证)。
