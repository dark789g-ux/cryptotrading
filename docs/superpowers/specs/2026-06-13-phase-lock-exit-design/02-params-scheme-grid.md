# 02 · 参数集、scheme 编码、kelly 网格

[← index](./index.md) · 算法见 [01](./01-algorithm.md) · Python 实现见 [03](./03-python-core-and-labels.md)

## 参数集与默认值

| 参数 | 类型 | 默认 | 含义 | 可配 | kelly 扫描 |
|------|------|------|------|------|-----------|
| `init_factor` | float | `0.999` | 初始止损系数（× `min(recent_lows)`） | ✅ | ✅ |
| `lock_factor` | float | `0.999` | 锁定止损系数（× `MAX(cost, 当日 low)`） | ✅ | ✅ |
| `lookback` | int | `10` | 初始止损回看根数（含 T+1 的非停牌交易日） | ✅ | ✅ |
| `ma5_require_down` | 常量 | `True` | 清仓要求 MA5 下行 | ✗ 钉死 | ✗ |
| `ma5_require_up` | 常量 | `True` | 切换要求 MA5 上行 | ✗ 钉死 | ✗ |
| `max_hold` | — | 无 | 不设硬上限 | ✗ 不提供 | ✗ |

- 默认 `0.999` 对齐 band_lock 习惯（留极小缓冲，避免浮点恰好触线噪声）。
- `init_factor` / `lock_factor` 量化到千分位（round-half-up，`NNNN = floor(ratio*1000 + 0.5)`），与 band_lock 量化算法**完全一致**（两语言对拍）。
- `lookback` 为正整数（≥1）。

### 参数范围（量化校验）

| 参数 | 量化网格 | NNNN 范围 | 备注 |
|------|---------|-----------|------|
| `init_factor` | 千分位 | `[1, 2000]`（ratio ∈ (0, 2.0]） | 允许 >1（极少用，但不禁止） |
| `lock_factor` | 千分位 | `[1, 2000]` | 同上 |
| `lookback` | 整数 | `[1, 250]` | 上界 250 ≈ 一年交易日，防误填巨值 |

> 范围是**设计建议**，实现时由 `phase_lock_scheme.py` 的量化校验函数 fail-fast；具体边界值实现期可微调，但须在 scheme 模块 docstring 写清并与解析正则一致。

## canonical scheme 编码

完全镜像 `band_lock_scheme.py`（已落源头核对，见 [03 §phase_lock_scheme 编码器](./03-python-core-and-labels.md#phase_lock_scheme-编码器d3)）。

**串格式**（固定顺序、4 位定宽 ratio）：

```text
phase_lock[__lb{N}][__if{NNNN}][__lf{NNNN}]
              │         │           │
              │         │           └ lock_factor  NNNN = round_half_up(ratio*1000)
              │         └ init_factor  NNNN = round_half_up(ratio*1000)
              └ lookback 正整数（沿用 band_lock mh 风格，不补零）
   顺序固定：lb → if → lf
```

**回归约束（关键，守哈希不漂移）**：等于默认值的参数一律不进串。

- 全默认 → legacy 别名 `'phase_lock'`（**不是** `'phase_lock__lb10__if0999__lf0999'`）。
- 仅 `lookback=15` → `'phase_lock__lb15'`。
- `init_factor=0.98, lock_factor=1.005, lookback=10`（lookback 默认）→ `'phase_lock__if0980__lf1005'`。

**量化算法（两语言必须一致）**：`NNNN = math.floor(ratio*1000 + 0.5)`（round-half-up，**禁** Python 内建 `round()` 的 banker's；TS 用 `Math.round`，ratio 恒正）。

**默认值对应 NNNN**：`init_factor` / `lock_factor` 默认 `0.999` → NNNN=999（永不作为后缀产出）。`lookback` 默认 10（等于 10 时省略 `lb` 后缀）。

> `phase_lock_scheme.py` 的默认常量**必须钉死共享核 `phase_lock_exit.py` 的硬编码默认**（与 band_lock_scheme.py:38-43 同模式）。两处默认值是同一事实的两个副本，改一处必改另一处，并由 02 与 03 的对拍测试锁住。

## kelly 默认网格

完全镜像 `band_lock_grid` 的 **presence-driven** 机制（见 [04](./04-kelly-sweep.md)）：

- 不进 `exit_families` 白名单；由 `config.phase_lock_grid` **是否存在**驱动。
- 网格 = `lookback × init_factor × lock_factor` 笛卡尔积 + 依赖坍缩去重。

**默认候选集**（前端 `makeDefaultPhaseLockGrid()` / Python `build_phase_lock_grid` 默认）：

| 维度 | 默认候选集 | 数量 |
|------|-----------|------|
| `lookback` | `{5, 10, 15, 20}` | 4 |
| `init_factor` | `{0.97, 0.98, 0.99, 1.00}` | 4 |
| `lock_factor` | `{0.99, 0.999, 1.005}` | 3 |

→ 默认 4×4×3 = **48 组**。可在前端编辑器调整。

**网格爆炸护栏**：phase_lock 族 cfg 数 > 软阈值（建议 200，对齐 band_lock 的护栏阈值）→ `logger.warning`（含各维度候选数 + 总数），不阻断（与 band_lock 一致）。

**_exit_id 格式**（kelly 结果可读唯一标识，镜像 `_band_lock_exit_id`）：

```text
phase_lock(lb=10,if=0.99,lf=0.999)
```

各 ratio 用量化后值（`NNNN/1000`）格式化、保证同量化值产出同 id；`lookback` 始终写出。
**确切的 ratio 格式化规则（去尾零 / 是否定宽）以 `_band_lock_exit_id` 现状为准**（D4 实现期对齐 `_fmt_ratio` 并以测试锁定）；上例 `if=0.99` 即去尾零后的形态，仅作示意。
