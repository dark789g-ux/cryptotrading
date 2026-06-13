# 02 · scheme 编解码（band_lock_scheme.py）

> labels 把出场参数编进 `factors.labels.scheme` 串。该串进 `feature_set_id` 哈希
> （[dir3_scheme.py:1-17](../../../../apps/quant-pipeline/src/quant_pipeline/labels/dir3_scheme.py) 明示），
> 所以参数编码不是「可读性」问题，是**哈希稳定性 / 缓存不污染**的硬约束。

## 一、为什么必须进 scheme 串

- 同一 scheme 串 = 同一组参数 = 可复现的标签（增量重算决定性）。
- 若参数不进串：同串不同参数 → 撞缓存 / 标签污染。
- 若默认参数进了串（如把现存 `band_lock` 写成 `band_lock__sr0999__fl1__md1`）→ 现存 band_lock
  标签的 `feature_set_id` 哈希漂移、老特征集变孤儿。

→ 结论：**等于默认值的参数一律不进串**（canonical 回 legacy 别名）；非默认参数按固定顺序追加紧凑后缀。

## 二、现状（只有 max_hold 进串）

[dir3_scheme.py:147-157](../../../../apps/quant-pipeline/src/quant_pipeline/labels/dir3_scheme.py) `base_scheme_codec`：

```text
band_lock + {}/{max_hold:None}  → 'band_lock'
band_lock + {max_hold:N}        → 'band_lock__mh{N}'
```

解析在 [runner.py:76](../../../../apps/quant-pipeline/src/quant_pipeline/labels/runner.py) 手写正则
`_BAND_LOCK_MH_RE = ^band_lock__mh(\d+)$`，只认 max_hold。本设计**用单一源模块取代手写正则**。

## 三、新建 `band_lock_scheme.py`（照 dir3_scheme.py 三件套范式）

放 `apps/quant-pipeline/src/quant_pipeline/labels/band_lock_scheme.py`，与 `dir3_scheme.py` 并列，
作为 band_lock 参数 ↔ scheme 串的**唯一编解码源**。

### 3.1 后缀格式（4 位定宽整数，按固定顺序）

```text
band_lock[__mh{N}][__sr{NNNN}][__fr{NNNN}][__fl{0|1}][__md{0|1}]
            │         │           │          │          │
            │         │           │          │          └ ma5_require_down (0=false)
            │         │           │          └ floor_enabled    (0=false)
            │         │           └ floor_ratio  NNNN = round(ratio*1000)，如 1.020→1020
            │         └ stop_ratio  NNNN = round(ratio*1000)，如 0.997→0997
            └ max_hold 正整数（沿用现状，不补零）

顺序固定：mh → sr → fr → fl → md（与 01 §四 一致）
```

- ratio 量化网格 = 0.001（千分位）。**唯一量化算法（两语言必须一致）**：
  `NNNN = round_half_up(ratio*1000)`，即 Python `math.floor(ratio*1000 + 0.5)`、
  TS `Math.round(ratio*1000)`（均正数 round-half-up，**非** Python 内建 `round()` 的 banker's；ratio 恒正）。
  还原 `ratio = NNNN/1000`。编码时 NNNN 取 4 位定宽零填充。
  - `stop_ratio` → NNNN ∈ `[1, 1000]`（ratio ∈ [0.001, 1.0]）；
    `floor_ratio` → NNNN ∈ `[1, 9999]`（ratio ∈ [0.001, 9.999]，可 > 1000，如 1020）。
- 布尔只在取 `false`（非默认）时出现：`fl0` / `md0`。`true` 默认 → 省略。
- ratio 取默认 0.999 → NNNN=999=默认 → 省略 `sr`/`fr`。
- max_hold 取 None → 省略 `mh`（沿用现状）。

### 3.2 三件套函数

```text
quantize_band_lock_params(params: dict) -> dict
    # 顺序：**先量化后校验**。先 NNNN = round_half_up(ratio*1000)（§3.1 唯一算法），
    # 再校验整数 NNNN：stop_ratio NNNN∈[1,1000]、floor_ratio NNNN∈[1,9999]、
    # 布尔为 bool、max_hold 为正整数或 None。NNNN<1（含输入<0.0005 量化到 0）或越上界 → ValueError。
    # 返回量化后 ratio = NNNN/1000（与编码、与其它入口同一 double）。

canonical_band_lock_scheme(params: dict) -> str
    # 量化 → 逐参数判断是否默认 → 非默认者按固定顺序拼后缀。
    # 全默认 → 'band_lock'；仅 max_hold → 'band_lock__mh{N}'（守现存哈希）。

parse_band_lock_scheme(scheme: str) -> dict | None
    # 'band_lock' / 合法变体 → 完整 params（含默认值回填）；
    # 非 band_lock 家族或畸形后缀 → None（调用方按未知 scheme 报错）。
    # 校验：后缀顺序正确、NNNN 落网格且在范围内、布尔位 ∈ {0,1}、无重复/未知后缀。

is_band_lock_scheme(scheme: str) -> bool
    # = parse_band_lock_scheme(scheme) is not None（与 parse 同口径，畸形不算家族成员）。
```

### 3.3 编解码示例（往返一致）

| params（非默认部分） | scheme 串 |
|----------------------|-----------|
| 全默认 | `band_lock` |
| max_hold=10 | `band_lock__mh10` |
| stop_ratio=0.997 | `band_lock__sr0997` |
| floor_ratio=1.02（锁盈）| `band_lock__fr1020` |
| floor_enabled=false | `band_lock__fl0` |
| ma5_require_down=false | `band_lock__md0` |
| max_hold=10, stop_ratio=0.997, floor_enabled=false, ma5_require_down=false | `band_lock__mh10__sr0997__fl0__md0` |

## 四、改造落点

| 文件 | 改造 |
|------|------|
| **新建** `labels/band_lock_scheme.py` | 三件套 + 常量 + `__all__` |
| `labels/dir3_scheme.py:147-157` | `base_scheme_codec` 的 band_lock 分支改调 `canonical_band_lock_scheme(sp)`（不再就地拼串）。保持 `_VALID_BASE_TYPES` 含 `band_lock`。|
| `labels/runner.py:69-76` | 删 `_BAND_LOCK_MH_RE`，`is_band_lock` 判定 + max_hold 解析改用 `parse_band_lock_scheme`（line 535-541 段）。|
| `labels/runner.py:850-867` | job params 解析新增 `stop_ratio`/`floor_ratio`/`floor_enabled`/`ma5_require_down` 读取 + 校验（透传给 `compute_labels`，见 05）。|

## 五、向后兼容验证点（进 06 测试）

- `canonical_band_lock_scheme({})` == `'band_lock'`（逐字）。
- `canonical_band_lock_scheme({'max_hold':10})` == `'band_lock__mh10'`（逐字，守现存）。
- `parse_band_lock_scheme('band_lock')` 回全默认 params。
- `parse_band_lock_scheme('band_lock__mh10')` 回 `{max_hold:10, ...默认}`。
- 往返：`parse(canonical(p)) == quantize(p)` 对所有合法 p。
- 畸形（`band_lock__sr9999`(>1000 但 stop_ratio 超界)/`band_lock__xx1`/顺序错乱）→ `None`。
